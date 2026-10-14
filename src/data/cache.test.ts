// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Env, runCached } from './cache';

function harness(stored: { body: string; at: number } | null = null) {
  const get = vi.fn().mockResolvedValue(stored);
  const put = vi.fn().mockResolvedValue(undefined);
  const waitUntil = vi.fn();
  const env = { CACHE: { get, put } } as unknown as Env;
  const ctx = { waitUntil } as unknown as ExecutionContext;
  const run = (produce: () => Promise<string | null>) =>
    runCached('core-test', produce, 60, 3600, env, ctx);
  return { get, put, waitUntil, run };
}

afterEach(() => vi.restoreAllMocks());

describe('neutral cache results', () => {
  it('returns a fresh body without producing or writing', async () => {
    const { run, put } = harness({ body: 'cached', at: Date.now() });
    const produce = vi.fn();
    expect(await run(produce)).toEqual({ body: 'cached', status: 200, cache: 'HIT' });
    expect(produce).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each([false, true])('stores a produced body (previous entry: %s)', async (stored) => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { run, put, waitUntil } = harness(stored ? { body: 'old', at: now - 60_000 } : null);
    expect(await run(async () => '<xml/>')).toEqual({
      body: '<xml/>',
      status: 200,
      cache: stored ? 'REVALIDATED' : 'MISS',
    });
    expect(put).toHaveBeenCalledWith('core-test', JSON.stringify({ body: '<xml/>', at: now }), {
      expirationTtl: 3600,
    });
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it('returns 404 for null, even with stale data, without writing', async () => {
    const { run, put } = harness({ body: 'old', at: 0 });
    expect(await run(async () => null)).toEqual({
      body: '{"error":"not found"}',
      status: 404,
      cache: 'MISS',
    });
    expect(put).not.toHaveBeenCalled();
  });

  it.each([false, true])('coalesces failures and releases the key (stored: %s)', async (stored) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = harness(stored ? { body: 'old', at: 0 } : null);
    const gate = Promise.withResolvers<string>();
    const produce = vi.fn(() => gate.promise);
    const first = run(produce);
    const second = run(produce);
    await Promise.resolve();
    gate.reject(new Error('upstream down'));
    const expected = stored
      ? { body: 'old', status: 200, cache: 'STALE' }
      : { body: '{"error":"upstream unavailable"}', status: 502, cache: 'MISS' };
    expect(await Promise.all([first, second])).toEqual([expected, expected]);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(await run(async () => 'recovered')).toEqual({
      body: 'recovered',
      status: 200,
      cache: stored ? 'REVALIDATED' : 'MISS',
    });
  });

  it.each(['get', 'put rejection', 'put throw', 'waitUntil'])(
    'isolates %s failures',
    async (failure) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { run, get, put, waitUntil } = harness();
      const error = new Error('KV unavailable');
      if (failure === 'get') get.mockRejectedValue(error);
      if (failure === 'put rejection') put.mockRejectedValue(error);
      if (failure === 'put throw')
        put.mockImplementation(() => {
          throw error;
        });
      if (failure === 'waitUntil')
        waitUntil.mockImplementation(() => {
          throw error;
        });
      expect(await run(async () => 'new')).toEqual({ body: 'new', status: 200, cache: 'MISS' });
    },
  );
});

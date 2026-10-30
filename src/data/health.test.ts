// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SITE_VERSION } from '../site';
import type { Env } from './api';
import { healthReport } from './health';

// A monitor reads two things: the status code and, when something is wrong,
// which dependency failed. Both are pinned here, including that a Worker which
// cannot read its feed does not report itself healthy.

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

function envWithSnapshot(stored: { body: string; at: number } | null): Env {
  return {
    CACHE: { get: vi.fn(async () => stored), put: vi.fn(async () => {}) },
  } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('healthReport', () => {
  it('reports ok, with the version, when the snapshot is readable', async () => {
    const res = await healthReport(envWithSnapshot({ body: '[]', at: Date.now() }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      status: 'ok',
      version: SITE_VERSION,
      checks: { feed: 'ok', cache: 'present' },
    });
  });

  it('degrades when the feed cannot be read on a cold cache', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    const res = await healthReport(envWithSnapshot(null), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 'degraded',
      checks: { feed: 'error', cache: 'present' },
    });
  });

  it('degrades when the cache binding is absent, without touching the upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await healthReport({} as Env, ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ checks: { feed: 'error', cache: 'missing' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/// <reference types="@cloudflare/workers-types" />
// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Env, json, serveExplore } from '../src/data/api';
import { CURATION_LIMIT } from '../src/feeds/curate';
import { SITE_VERSION } from '../src/site';
import worker from './index';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

function mockEnv(kvData?: { body: string; at: number } | null): Env {
  // The explore cache key embeds the normalized query — tests don't need to
  // reproduce it, so a stored copy is returned regardless of the key asked.
  return {
    CACHE: {
      get: vi.fn(async () => (kvData ? { ...kvData } : null)),
      put: vi.fn(async () => {}),
    },
    DB: mockDb(),
  } as unknown as Env;
}

// D1 mock: prepare() returns an object with both bind() and all() (the
// filters query calls all() without bind), `all` resolved to an empty result
// set unless overridden. `first` serves the health endpoint's single-row reads,
// including the curation queue count.
function mockDb(overrides?: {
  all?: ReturnType<typeof vi.fn>;
  first?: ReturnType<typeof vi.fn>;
}): Env['DB'] {
  const all = overrides?.all ?? vi.fn().mockResolvedValue({ results: [] });
  const first = overrides?.first ?? vi.fn().mockResolvedValue({ pending: 0 });
  return {
    prepare: vi.fn(() => ({ bind: vi.fn(() => ({ all, first })), all, first })),
  } as unknown as Env['DB'];
}

function mockCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(async () => {}),
    passThroughOnException: vi.fn(),
    props: {},
    tracing: {},
  } as unknown as ExecutionContext;
}

// ---- json helper ----

describe('json helper', () => {
  it('creates a Response with JSON content-type', () => {
    const res = json('{"ok":true}', 200, 'MISS');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('x-cache')).toBe('MISS');
  });

  it('does not set cache-control headers (handled by downstream)', () => {
    const res = json('{"ok":true}', 200, 'HIT');
    expect(res.headers.get('cache-control')).toBeNull();
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('x-cache')).toBe('HIT');
  });

  it('handles error status codes', () => {
    const res = json('{"error":"upstream unavailable"}', 502, 'MISS');
    expect(res.status).toBe(502);
  });
});

// ---- runCached semantics via serveExplore ----

describe('serveExplore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns HIT when stored body is fresh', async () => {
    const now = Date.now();
    const env = mockEnv({ body: '{"items":[],"nextCursor":null}', at: now - 30_000 }); // fresh is 60s
    const res = await serveExplore({}, env, mockCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('HIT');
    expect(await res.text()).toBe('{"items":[],"nextCursor":null}');
  });

  it('returns MISS on first query with no stored data', async () => {
    const env = mockEnv(null);
    const res = await serveExplore({}, env, mockCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('MISS');
    expect(await res.text()).toBe('{"items":[],"nextCursor":null}');
  });

  it('treats a KV read failure as a miss and still serves (no 500)', async () => {
    const env = mockEnv(null);
    vi.mocked(env.CACHE.get).mockRejectedValueOnce(new Error('kv down'));
    const res = await serveExplore({}, env, mockCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('MISS');
  });

  it('returns STALE when the DB query fails but a stored copy exists', async () => {
    const now = Date.now();
    const env = mockEnv({ body: '{"items":[],"nextCursor":null}', at: now - 600_000 });
    const failing = vi.fn().mockRejectedValueOnce(new Error('D1 down'));
    env.DB = mockDb({ all: failing });
    const res = await serveExplore({}, env, mockCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('STALE');
  });

  it('returns 502 when the DB query fails and no stored copy exists', async () => {
    const env = mockEnv(null);
    const failing = vi.fn().mockRejectedValueOnce(new Error('D1 down'));
    env.DB = mockDb({ all: failing });
    const res = await serveExplore({}, env, mockCtx());
    expect(res.status).toBe(502);
    expect(res.headers.get('x-cache')).toBe('MISS');
  });

  it('caches the produced body in KV after a MISS', async () => {
    const env = mockEnv(null);
    const ctx = mockCtx();
    await serveExplore({}, env, ctx);
    expect(ctx.waitUntil).toHaveBeenCalled();
    expect((env.CACHE as ReturnType<typeof mockEnv>['CACHE']).put).toHaveBeenCalled();
  });

  it('still serves the body when the cache write fails', async () => {
    // The write is fire-and-forget and used to sit inside the produce try: a
    // throwing put, or a waitUntil that refused because the context was already
    // settled, turned a good read into a 502 (or into STALE, which is worse —
    // it looks like an upstream problem).
    const env = mockEnv(null);
    (env.CACHE as { put: unknown }).put = vi.fn(async () => {
      throw new Error('kv write down');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = mockCtx();

    const res = await serveExplore({}, env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('MISS');
    // Nothing awaits the write, so without the catch attached to it the
    // rejection surfaces as an unhandled rejection with no request to attach it
    // to. The log line is the only evidence it was handled.
    // Asserted before any restore: mockRestore() also clears the recorded calls.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('KV put failed'),
      expect.objectContaining({ message: 'kv write down' }),
    );
  });

  it('still serves the body when the write cannot even be scheduled', async () => {
    const env = mockEnv(null);
    const ctx = mockCtx();
    ctx.waitUntil = vi.fn(() => {
      throw new Error('context settled');
    });

    const res = await serveExplore({}, env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('MISS');
  });

  it('lets N coalesced callers each read the body without `Body is unusable`', async () => {
    // Regression guard for the body-reuse bug: if `inflight` ever stored
    // `Promise<Response>`, the second caller reading `.text()` on the shared
    // body would throw `Body is unusable: Body has already been read`.
    const gate = Promise.withResolvers<void>();
    const slowAll = vi.fn(async () => {
      await gate.promise;
      return { results: [] };
    });
    const env = mockEnv(null);
    env.DB = mockDb({ all: slowAll });

    const N = 10;
    const responses = Array.from({ length: N }, () => serveExplore({}, env, mockCtx()));
    gate.resolve();

    const settled = await Promise.all(responses);
    expect(slowAll).toHaveBeenCalledTimes(1);
    expect(settled).toHaveLength(N);

    const bodies = await Promise.all(settled.map((r) => r.text()));
    expect(bodies.every((b) => b === '{"items":[],"nextCursor":null}')).toBe(true);
  });
});

// ---- fetch routing ----

describe('fetch routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes GET /api/explore through serveExplore', async () => {
    const env = mockEnv(null);
    const res = await worker.fetch(new Request('https://x/api/explore'), env, mockCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('MISS');
  });

  it('routes GET /api/health through healthReport', async () => {
    // The endpoint a monitor hits was unit-tested (health.test.ts) but never
    // driven through the dispatcher that actually serves it, so a renamed path
    // or a missing method guard would have shipped green.
    const env = mockEnv(null);
    const res = await worker.fetch(new Request('https://x/api/health'), env, mockCtx());

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      status: 'ok',
      version: SITE_VERSION,
      checks: {
        d1: 'ok',
        cache: 'present',
        // The dispatcher has to carry the curator's own state, not just
        // liveness: a deployment without the LLM secret answers 200 everywhere
        // while every card shows the publisher's raw teaser.
        // Read from the curator rather than restated: the per-tick batch is a
        // measured constant that has already changed once with the model.
        curation: { configured: false, pending: 0, batch: CURATION_LIMIT },
      },
    });
  });

  it('rejects non-GET on /api/health', async () => {
    const env = mockEnv(null);
    const res = await worker.fetch(
      new Request('https://x/api/health', { method: 'POST' }),
      env,
      mockCtx(),
    );
    expect(res.status).toBe(405);
  });

  it('answers 503 from /api/health when the D1 probe fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = mockEnv(null);
    env.DB = {
      prepare: vi.fn(() => {
        throw new Error('d1 down');
      }),
    } as unknown as Env['DB'];

    const res = await worker.fetch(new Request('https://x/api/health'), env, mockCtx());

    expect(res.status).toBe(503);
    expect(((await res.json()) as { status: string }).status).toBe('degraded');
    expect(logged).toHaveBeenCalledWith('[health] D1 probe failed:', expect.any(Error));
  });

  it('turns an escaping throw into a 500 rather than an unhandled rejection', async () => {
    // Every route handler swallows its own failures, so the dispatcher's last
    // line of defence is only reachable by a throw in the routing itself — and
    // `new URL(request.url)` is the first thing it does. Without the catch this
    // escapes as a platform 500 with no JSON body and no log naming the worker.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = mockEnv(null);
    const broken = {
      get url(): string {
        throw new Error('plumbing failed');
      },
    } as unknown as Request;

    const res = await worker.fetch(broken, env, mockCtx());

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(logged).toHaveBeenCalledWith('[worker] unhandled error:', expect.any(Error));
  });

  it('rejects non-GET on /api/explore', async () => {
    const env = mockEnv(null);
    const res = await worker.fetch(
      new Request('https://x/api/explore', { method: 'POST' }),
      env,
      mockCtx(),
    );
    expect(res.status).toBe(405);
  });

  it('routes /api/explore/filters through serveExploreFilters', async () => {
    // `?category` is tolerated and ignored: the rail is global, and old links
    // carrying the parameter must keep working.
    const env = mockEnv(null);
    const res = await worker.fetch(
      new Request('https://x/api/explore/filters?category=gpu'),
      env,
      mockCtx(),
    );
    expect(res.status).toBe(200);
    // `total` rides along: it counts the rows no hub holds, which the option
    // list cannot express.
    expect(await res.json()).toEqual({ categories: [], total: 0 });
  });

  it('rejects non-GET on /api/explore/filters', async () => {
    const env = mockEnv(null);
    const res = await worker.fetch(
      new Request('https://x/api/explore/filters', { method: 'POST' }),
      env,
      mockCtx(),
    );
    expect(res.status).toBe(405);
  });

  it('404s on an unknown /api/ path', async () => {
    const env = mockEnv(null);
    const res = await worker.fetch(new Request('https://x/api/eng.1/scoreboard'), env, mockCtx());
    expect(res.status).toBe(404);
  });

  it('404s on an unknown api path segment', async () => {
    const env = mockEnv(null);
    const res = await worker.fetch(new Request('https://x/api/nope/scoreboard'), env, mockCtx());
    expect(res.status).toBe(404);
  });

  it('the RSS surface is no longer dispatched from /api/explore/rss', async () => {
    // The RSS feed moved to /rss.xml and /<category>/rss.xml (Astro page
    // endpoints); /api/* is reserved for JSON. A stray /api/explore/rss hit
    // should 404 rather than fall through to JSON or a generic ASSETS miss.
    const env = mockEnv(null);
    const res = await worker.fetch(new Request('https://x/api/explore/rss'), env, mockCtx());
    expect(res.status).toBe(404);
  });

  it('404s on the removed re-enrich endpoint', async () => {
    const env = mockEnv(null);
    const res = await worker.fetch(new Request('https://x/api/re-enrich'), env, mockCtx());
    expect(res.status).toBe(404);
  });

  it('404s on the removed image proxy', async () => {
    const env = mockEnv(null);
    const res = await worker.fetch(
      new Request(
        `https://x/api/img?src=${encodeURIComponent('https://ichef.bbci.co.uk/img.jpg')}&w=400`,
      ),
      env,
      mockCtx(),
    );
    expect(res.status).toBe(404);
  });

  it('does not serve /media/* — that route lives in the deployed entrypoint', async () => {
    // Astro mounts this dispatcher at /api/* only, so a /media/ request never
    // reaches it. Handling media here would be unreachable code; the real route
    // is worker/entrypoint.ts, covered by entrypoint.test.ts. It answers 404
    // itself rather than consulting ASSETS: that fallthrough was reachable for
    // the bare `/api` path alone, where no asset lives either.
    const env = mockEnv(null);
    const res = await worker.fetch(
      new Request('https://x/media/437e368b-c40c-4e02-8e06-2ca5bbcb8055'),
      env,
      mockCtx(),
    );
    expect(res.status).toBe(404);
  });

  it('404s the bare /api path instead of falling through to assets', async () => {
    const env = mockEnv(null);
    const res = await worker.fetch(new Request('https://x/api'), env, mockCtx());
    expect(res.status).toBe(404);
  });
});

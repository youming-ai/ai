/// <reference types="@cloudflare/workers-types" />
// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Env, json, serveExplore } from '../src/data/api';
import { SITE_VERSION } from '../src/site';
import worker from './index';

// The upstream is Poche's RSS, fetched when the KV snapshot is missing or
// stale. One item, so a produced page is distinguishable from a stored one.
const POCHE_RSS =
  '<rss><channel><item><title>Fetched</title><link>https://example.com/a</link>' +
  '<pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>';
const fetchMock = vi.fn(async () => new Response(POCHE_RSS));
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

/** A stored snapshot holding no links: an empty board, but a readable one. */
const EMPTY_SNAPSHOT = '[]';
const EMPTY_PAGE = '{"items":[],"nextCursor":null}';

function mockEnv(kvData?: { body: string; at: number } | null): Env {
  return {
    CACHE: {
      get: vi.fn(async () => (kvData ? { ...kvData } : null)),
      put: vi.fn(async () => {}),
    },
  } as unknown as Env;
}

const fetchedTitles = async (res: Response) =>
  ((await res.json()) as { items: { title: string }[] }).items.map((item) => item.title);

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
    fetchMock.mockImplementation(async () => new Response(POCHE_RSS));
  });

  it('returns HIT when stored body is fresh', async () => {
    const now = Date.now();
    const env = mockEnv({ body: EMPTY_SNAPSHOT, at: now - 30_000 }); // fresh is 10 min
    const res = await serveExplore({}, env, mockCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('HIT');
    expect(await res.text()).toBe(EMPTY_PAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns MISS on first query with no stored data', async () => {
    const env = mockEnv(null);
    const res = await serveExplore({}, env, mockCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('MISS');
    expect(await fetchedTitles(res)).toEqual(['Fetched']);
  });

  it('treats a KV read failure as a miss and still serves (no 500)', async () => {
    const env = mockEnv(null);
    vi.mocked(env.CACHE.get).mockRejectedValueOnce(new Error('kv down'));
    const res = await serveExplore({}, env, mockCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('MISS');
  });

  it('returns STALE when the upstream fails but a stored copy exists', async () => {
    const now = Date.now();
    const env = mockEnv({ body: EMPTY_SNAPSHOT, at: now - 3_600_000 });
    fetchMock.mockRejectedValueOnce(new Error('poche down'));
    const res = await serveExplore({}, env, mockCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('STALE');
  });

  it('returns 502 when the upstream fails and no stored copy exists', async () => {
    const env = mockEnv(null);
    fetchMock.mockRejectedValueOnce(new Error('poche down'));
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
    fetchMock.mockImplementation(async () => {
      await gate.promise;
      return new Response(POCHE_RSS);
    });
    const env = mockEnv(null);

    const N = 10;
    const responses = Array.from({ length: N }, () => serveExplore({}, env, mockCtx()));
    gate.resolve();

    const settled = await Promise.all(responses);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settled).toHaveLength(N);

    const titles = await Promise.all(settled.map(fetchedTitles));
    expect(titles.every((t) => t[0] === 'Fetched')).toBe(true);
  });
});

// ---- fetch routing ----

describe('fetch routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async () => new Response(POCHE_RSS));
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
      checks: { feed: 'ok', cache: 'present' },
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

  it('answers 503 from /api/health when the feed cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error('poche down'));
    const env = mockEnv(null);

    const res = await worker.fetch(new Request('https://x/api/health'), env, mockCtx());

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 'degraded',
      checks: { feed: 'error', cache: 'present' },
    });
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
    // `total` rides along: it counts the links no hub holds, which the option
    // list cannot express — here the one fetched link, which has no category.
    expect(await res.json()).toEqual({ categories: [], total: 1 });
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

// @vitest-environment node
// The wiring between Astro's file-based routes and the modules they delegate to.
//
// Placement is load-bearing twice over. Not under src/pages, because Astro
// treats every .ts file there as a file-based endpoint: a test colocated with
// its subject gets bundled as a deployed route (the build emitted
// dist/server/chunks/bridge_*.mjs), shipping the test inside the Worker and
// shadowing the [...route] catch-all for that path. Not under worker/ either,
// because tsconfig.worker.json compiles worker/** and would then pull an Astro
// route into the worker program, where Astro's Locals augmentation is out of
// scope. The root tsconfig covers both sides; this file lives in it.
//
// `src/pages/api/[...route].ts` is the ONLY path to `worker/index.ts`, and
// nothing tested it: the dispatcher's unit tests call `worker.fetch(...)`
// directly, so deleting or repointing that route file would 404 every
// `/api/explore` call — killing the island's data and its infinite scroll —
// while the suite stayed green. That is the same shape as the P1 this repo
// already shipped once (a /media route sitting in an unreachable file).
//
// The same argument covers the other route modules, which is why they are here
// rather than in a file per route: the modules they delegate to are tested
// thoroughly (serveExploreRss, serveArticleRedirect), but nothing pinned that
// the wrappers pass them the right arguments. A wrapper that dropped `category`
// would still answer 200 — with the global feed.
//
// Executed rather than asserted structurally: `cloudflare:workers` is mocked for
// its `env` binding and the real routes run against the real modules.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SITE_ORIGIN } from './site';

const { fakeEnv, kvGet, dbState } = vi.hoisted(() => {
  const get = vi.fn(async () => null);
  // Mutable per test: `.all()` rows for the feed queries, the `.first()` row for
  // the legacy redirect's point lookup.
  const state = { results: [] as unknown[], first: null as unknown };
  return {
    kvGet: get,
    dbState: state,
    fakeEnv: {
      CACHE: { get, put: vi.fn(async () => {}) },
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(function bind(this: unknown) {
            return this;
          }),
          all: vi.fn(async () => ({
            results: state.results,
            meta: { changes: 0 },
            success: true,
          })),
          first: vi.fn(async () => state.first),
          run: vi.fn(async () => ({ meta: { changes: 0 }, success: true })),
        })),
      },
      ASSETS: { fetch: vi.fn() },
    },
  };
});
vi.mock('cloudflare:workers', () => ({ env: fakeEnv }));

import { ALL } from './pages/api/[...route]';

const cfContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
  tracing: {},
} as unknown as ExecutionContext;

function call(path: string): Promise<Response> {
  return ALL({
    request: new Request(`https://umuo.app${path}`),
    locals: { cfContext },
  } as never) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.results = [];
  dbState.first = null;
});

describe('the /api/* bridge', () => {
  it('reaches the worker dispatcher and its data layer', async () => {
    const res = await call('/api/explore?limit=5');

    expect(res.status).toBe(200);
    // The request arrived at `serveExplore` with its query parsed: the SWR cache
    // was consulted under the current versioned key.
    expect(kvGet).toHaveBeenCalledWith(expect.stringContaining('explore:v5:'), 'json');
    const body = (await res.json()) as { items: unknown[]; nextCursor: unknown };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('exposes the dispatcher’s 404 for an unknown /api path', async () => {
    expect((await call('/api/nope')).status).toBe(404);
  });

  it('rejects a non-GET on the explore endpoint', async () => {
    const res = await ALL({
      request: new Request('https://umuo.app/api/explore', { method: 'POST' }),
      locals: { cfContext },
    } as never);
    expect((res as Response).status).toBe(405);
  });
});

describe('the RSS route endpoints', () => {
  it('serves the global feed at /rss.xml', async () => {
    const { GET } = await import('./pages/rss.xml');
    const res = await GET({ locals: { cfContext } } as never);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8');
    const body = await res.text();
    expect(body).toContain(`<link>${SITE_ORIGIN}/</link>`);
    expect(body).toContain(`<atom:link href="${SITE_ORIGIN}/rss.xml"`);
  });

  it('threads the category into the hub feed', async () => {
    // A wrapper that passed `{}` would answer 200 with the global feed, so the
    // status alone proves nothing: the category has to show up in the document.
    const { GET } = await import('./pages/[category]/rss.xml');
    const res = await GET({ params: { category: 'tools' }, locals: { cfContext } } as never);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<link>${SITE_ORIGIN}/tools</link>`);
    expect(body).toContain(`<atom:link href="${SITE_ORIGIN}/tools/rss.xml"`);
  });

  it('404s an unregistered category before touching the cache', async () => {
    // The registry check is the only thing stopping `/anything/rss.xml` from
    // pinning an arbitrary KV key. The 404 alone would pass with the guard
    // deleted and the feed rendered; the cache never being read is what proves
    // it short-circuits.
    const { GET } = await import('./pages/[category]/rss.xml');
    const res = await GET({ params: { category: 'gpu' }, locals: { cfContext } } as never);

    expect(res.status).toBe(404);
    expect(kvGet).not.toHaveBeenCalled();
  });

  it('404s a category that exists only on Object.prototype', async () => {
    // `CATEGORIES` is a plain object, so an `in`/truthiness gate would accept
    // 'constructor' and serve a hub for it.
    const { GET } = await import('./pages/[category]/rss.xml');
    const res = await GET({ params: { category: 'constructor' }, locals: { cfContext } } as never);

    expect(res.status).toBe(404);
    expect(kvGet).not.toHaveBeenCalled();
  });
});

describe('the legacy /a/<id> redirect route', () => {
  it('301s a stored id to its canonical source, with a cacheable answer', async () => {
    dbState.first = { canonical_url: 'https://example.com/story' };
    const { GET } = await import('./pages/a/[id]');
    const res = await GET({ params: { id: 'abc' } } as never);

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://example.com/story');
    // Bookmarks resolve through here repeatedly; the browser cache is what
    // keeps a redirect from costing a D1 lookup every time.
    expect(res.headers.get('cache-control')).toContain('max-age=86400');
  });

  it('404s an id nobody stored', async () => {
    const { GET } = await import('./pages/a/[id]');
    const res = await GET({ params: { id: 'missing' } } as never);

    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  it('answers HEAD with the same handler as GET', async () => {
    // `export const HEAD = GET` is the whole HEAD support. A second handler
    // would silently drift from the GET's status and headers.
    const mod = await import('./pages/a/[id]');
    expect(mod.HEAD).toBe(mod.GET);
  });
});

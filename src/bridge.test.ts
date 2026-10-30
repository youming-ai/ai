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
// thoroughly (serveExploreRss), but nothing pinned that
// the wrappers pass them the right arguments. A wrapper that dropped `category`
// would still answer 200 — with the global feed.
//
// Executed rather than asserted structurally: `cloudflare:workers` is mocked for
// its `env` binding and the real routes run against the real modules.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SITE_ORIGIN } from './site';

const { fakeEnv, kvGet, snapshot } = vi.hoisted(() => {
  // Mutable per test: the links the KV snapshot holds, served as fresh. `null`
  // is a cold cache, which sends the read to the (stubbed) upstream fetch.
  const state = { articles: [] as unknown[] | null };
  const get = vi.fn(async () =>
    state.articles ? { body: JSON.stringify(state.articles), at: Date.now() } : null,
  );
  return {
    kvGet: get,
    snapshot: state,
    fakeEnv: {
      CACHE: { get, put: vi.fn(async () => {}) },
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
    request: new Request(`${SITE_ORIGIN}${path}`),
    locals: { cfContext },
  } as never) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  snapshot.articles = [];
});

describe('the /api/* bridge', () => {
  it('reaches the worker dispatcher and its data layer', async () => {
    const res = await call('/api/explore?limit=5');

    expect(res.status).toBe(200);
    // The request arrived at `serveExplore`: the snapshot was read.
    expect(kvGet).toHaveBeenCalledWith('poche:snapshot:v1', 'json');
    const body = (await res.json()) as { items: unknown[]; nextCursor: unknown };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('exposes the dispatcher’s 404 for an unknown /api path', async () => {
    expect((await call('/api/nope')).status).toBe(404);
  });

  it('rejects a non-GET on the explore endpoint', async () => {
    const res = await ALL({
      request: new Request(`${SITE_ORIGIN}/api/explore`, { method: 'POST' }),
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

describe('the card fragment endpoint', () => {
  /** One link in the shape the snapshot stores. */
  const row = (id: string, title: string) => ({
    id,
    title,
    description: '',
    url: `https://example.com/${id}`,
    imageUrl: '/og.png',
    isVideo: false,
    imageWidth: 1200,
    imageHeight: 630,
    sourceDomain: 'example.com',
    publishedAt: 1786080856000,
    category: 'tools',
  });

  const get = async (path: string) => {
    const { GET } = await import('./pages/cards.json');
    return (await GET({
      url: new URL(`${SITE_ORIGIN}${path}`),
      locals: { cfContext },
    } as never)) as Response;
  };

  it('returns the page already rendered, in the wrapper the view asks for', async () => {
    // The client appends this with insertAdjacentHTML, so the wrapper has to
    // match the container: <li> goes into the <ol>, <article> into the section.
    snapshot.articles = [row('a', 'First story')];

    const list = await get('/cards.json?view=list&limit=1');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { html: string; count: number };
    expect(body.count).toBe(1);
    expect(body.html).toContain('<li');
    expect(body.html).not.toContain('<article');

    snapshot.articles = [row('a', 'First story')];
    const grid = await get('/cards.json?view=grid&limit=1');
    const gridBody = (await grid.json()) as { html: string };
    expect(gridBody.html).toContain('<article');
  });

  it('falls back to the grid for an unrecognised view', async () => {
    // A stale or hand-edited link should still render cards.
    snapshot.articles = [row('a', 'First story')];
    const res = await get('/cards.json?view=bogus&limit=1');
    expect(((await res.json()) as { html: string }).html).toContain('<article');
  });

  it('answers 502 rather than an empty page when the feed fails', async () => {
    // An empty fragment with a 200 would make the board append nothing and
    // declare the feed finished — the failure would look like the end of the
    // corpus.
    snapshot.articles = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    try {
      const res = await get('/cards.json');
      expect(res.status).toBe(502);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('exports only GET, so no other method can reach the handler', async () => {
    // Astro rejects any method the module does not export, which is what makes
    // the endpoint read-only. Asserted structurally rather than by issuing a
    // POST — the first version of this test fetched the endpoint over the real
    // network, which is neither hermetic nor a statement about this code.
    const mod = await import('./pages/cards.json');
    const methods = Object.keys(mod).filter((key) => /^[A-Z]+$/.test(key));
    expect(methods).toEqual(['GET']);
  });
});

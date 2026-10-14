// @vitest-environment node
// serveExploreRss is the HTTP shell around the pure renderer: it normalises
// the query, goes through the SWR cache, and stamps the feed content type.
// exploreRss.test.ts covers the XML; this covers the wrapper — in particular
// the failure path, where the wrong header turns a 502 into a poisoned feed.
import { describe, expect, it, vi } from 'vitest';
import { SITE_ORIGIN } from '../site';
import type { Env } from './api';
import { EXPLORE_MAX_LIMIT, serveExploreRss } from './api';

function mockCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(async () => {}),
    passThroughOnException: vi.fn(),
    props: {},
    tracing: {},
  } as unknown as ExecutionContext;
}

/** D1 stub that records the LIMIT binding the explore query asks for and
 *  returns no rows. `failing` makes every statement throw, standing in for a
 *  D1 outage with nothing stored in KV. */
function mockEnv(options: { failing?: boolean; stored?: { body: string; at: number } } = {}): {
  env: Env;
  bindings: unknown[][];
} {
  const bindings: unknown[][] = [];
  const env = {
    CACHE: { get: vi.fn(async () => options.stored ?? null), put: vi.fn(async () => {}) },
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(function bind(this: unknown, ...args: unknown[]) {
          bindings.push(args);
          return this;
        }),
        all: vi.fn(async () => {
          if (options.failing) throw new Error('d1 down');
          return { results: [], meta: { changes: 0 }, success: true };
        }),
      })),
    },
  } as unknown as Env;
  return { env, bindings };
}

describe('serveExploreRss', () => {
  it('serves a rendered feed as application/rss+xml', async () => {
    const { env } = mockEnv();
    const res = await serveExploreRss({}, env, mockCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8');
    expect(await res.text()).toContain('<rss version="2.0"');
  });

  // The rendered document is cached under a key carrying only the query, and KV
  // is bound per Worker rather than per hostname: if the origin came from the
  // request, one hit on a preview or workers.dev host would write that host into
  // every subscriber's <link> and <atom:link rel="self">. Composing them from
  // SITE_ORIGIN makes that impossible rather than merely unlikely.
  it('composes its own URLs from SITE_ORIGIN, not from a caller', async () => {
    const { env } = mockEnv();
    const body = await (await serveExploreRss({}, env, mockCtx())).text();
    expect(body).toContain(`<link>${SITE_ORIGIN}/</link>`);
    expect(body).toContain(`<atom:link href="${SITE_ORIGIN}/rss.xml"`);

    const categoryBody = await (
      await serveExploreRss({ category: 'tools' }, env, mockCtx())
    ).text();
    expect(categoryBody).toContain(`<link>${SITE_ORIGIN}/tools</link>`);
    expect(categoryBody).toContain(`<atom:link href="${SITE_ORIGIN}/tools/rss.xml"`);
  });

  // The body is a rendered document, so a format change needs a new key or a
  // warm entry keeps serving the old shape — here, a document whose URLs came
  // from whichever hostname filled it.
  it('reads its document under a versioned key', async () => {
    const { env } = mockEnv();
    await serveExploreRss({}, env, mockCtx());
    expect(vi.mocked(env.CACHE.get)).toHaveBeenCalledWith(
      expect.stringContaining('explore:rss:v2:'),
      'json',
    );
  });

  // Regression: the wrapper used to relabel runCached's JSON error body as
  // application/rss+xml AND stamp it `max-age=300`, so one D1 blip handed
  // every subscriber a parse error pinned in their HTTP cache for 5 minutes.
  it('passes a cold-cache upstream failure through untouched, never as a feed', async () => {
    const { env } = mockEnv({ failing: true });
    const res = await serveExploreRss({}, env, mockCtx());
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBeNull();
    expect(res.headers.get('x-cache')).toBe('MISS');
    expect(await res.json()).toEqual({ error: 'upstream unavailable' });
  });

  it.each(['HIT', 'STALE'] as const)(
    'serves a %s cached XML document with RSS headers',
    async (cache) => {
      const { env } = mockEnv({
        failing: true,
        stored: { body: '<rss/>', at: cache === 'HIT' ? Date.now() : 0 },
      });
      const res = await serveExploreRss({}, env, mockCtx());
      expect(res.status).toBe(200);
      expect(res.headers.get('x-cache')).toBe(cache);
      expect(res.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      expect(await res.text()).toBe('<rss/>');
    },
  );

  // A feed poll should carry more than the web default, and the clamp in
  // normalizedExploreQuery has to stay above it or the request silently shrinks.
  // Asserted through the constant rather than a repeated literal: the page size
  // is a free choice, the invariant is that the RSS path asks for a full one.
  it('asks the query layer for a full RSS page', async () => {
    const { env, bindings } = mockEnv();
    await serveExploreRss({}, env, mockCtx());
    // The explore query binds limit + 1 and never the bare limit: the extra row
    // is how the subject detects that another page exists. So the bound value
    // is the evidence that the RSS path asked for the API's full page — and
    // because both come from EXPLORE_MAX_LIMIT, raising the ceiling cannot
    // leave the feed quietly requesting less than the clamp allows.
    const limits = bindings.flat().filter((value): value is number => typeof value === 'number');
    expect(limits).toContain(EXPLORE_MAX_LIMIT + 1);
  });

  it('scopes the channel link to the category it was given', async () => {
    const { env } = mockEnv();
    const res = await serveExploreRss({ category: 'tools' }, env, mockCtx());
    const xml = await res.text();
    expect(xml).toContain(`<link>${SITE_ORIGIN}/tools</link>`);
    expect(xml).toContain('Tools');
  });
});

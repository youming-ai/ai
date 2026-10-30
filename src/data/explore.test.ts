// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SITE_ORIGIN } from '../site';
import type { ExploreArticle } from '../types';
import {
  EXPLORE_MAX_LIMIT,
  type Env,
  explorePage,
  exploreFilters,
  getExploreFeed,
  getExploreFilters,
  getSitemapNews,
  serveExplore,
  serveExploreRss,
} from './api';

// Every surface reads one KV snapshot of Poche Explore and pages, filters or
// counts it in memory. These tests drive that through a stubbed KV and fetch.

function article(n: number, overrides: Partial<ExploreArticle> = {}): ExploreArticle {
  return {
    id: `id${String(n).padStart(3, '0')}`,
    title: `Link ${n}`,
    description: '',
    url: `https://example.com/${n}`,
    imageUrl: '',
    isVideo: false,
    imageWidth: 0,
    imageHeight: 0,
    sourceDomain: 'example.com',
    publishedAt: 1_790_000_000_000 - n * 60_000,
    category: n % 2 === 0 ? 'tools' : 'design',
    ...overrides,
  };
}

const SNAPSHOT = Array.from({ length: 30 }, (_, n) => article(n));

function mockCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function envWith(stored: { body: string; at: number } | null): Env {
  return {
    CACHE: { get: vi.fn(async () => stored), put: vi.fn(async () => {}) },
  } as unknown as Env;
}

const fresh = (articles: unknown) => envWith({ body: JSON.stringify(articles), at: Date.now() });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('explorePage', () => {
  it('pages newest-first with a keyset cursor that resumes after the last link', () => {
    const first = explorePage(SNAPSHOT, { limit: 10 });
    expect(first.items.map((a) => a.id)).toEqual(SNAPSHOT.slice(0, 10).map((a) => a.id));
    expect(first.nextCursor).toBe(`${SNAPSHOT[9]!.publishedAt}:${SNAPSHOT[9]!.id}`);

    const second = explorePage(SNAPSHOT, { limit: 10, cursor: first.nextCursor! });
    expect(second.items[0]!.id).toBe(SNAPSHOT[10]!.id);

    const last = explorePage(SNAPSHOT, {
      limit: 10,
      cursor: `${SNAPSHOT[19]!.publishedAt}:${SNAPSHOT[19]!.id}`,
    });
    expect(last.items).toHaveLength(10);
    expect(last.nextCursor).toBeNull();
  });

  it('breaks a publishedAt tie by id, the order the snapshot is sorted in', () => {
    const tied = [article(1, { id: 'b', publishedAt: 5 }), article(2, { id: 'a', publishedAt: 5 })];
    const first = explorePage(tied, { limit: 1 });
    expect(first.items[0]!.id).toBe('b');
    expect(explorePage(tied, { limit: 1, cursor: first.nextCursor! }).items[0]!.id).toBe('a');
  });

  it('filters by a registry category and ignores anything else', () => {
    expect(
      explorePage(SNAPSHOT, { category: 'tools', limit: 24 }).items.every(
        (a) => a.category === 'tools',
      ),
    ).toBe(true);
    expect(explorePage(SNAPSHOT, { category: 'constructor', limit: 24 }).items).toHaveLength(24);
  });

  it('clamps the limit and collapses a malformed cursor to page one', () => {
    expect(explorePage(SNAPSHOT, { limit: 999 }).items).toHaveLength(EXPLORE_MAX_LIMIT);
    expect(explorePage(SNAPSHOT, { limit: 5, cursor: 'garbage' }).items[0]!.id).toBe(
      SNAPSHOT[0]!.id,
    );
  });
});

describe('exploreFilters', () => {
  it('counts links per registry hub and totals every link, uncategorised included', () => {
    const filters = exploreFilters([...SNAPSHOT.slice(0, 3), article(99, { category: null })]);
    expect(filters.categories).toEqual(
      [
        { value: 'design', label: 'Design', count: 1 },
        { value: 'tools', label: 'Tools', count: 2 },
      ].sort((a, b) => b.count - a.count),
    );
    expect(filters.total).toBe(4);
  });
});

describe('the snapshot', () => {
  it('is one KV key, whatever the query carries', async () => {
    const env = fresh(SNAPSHOT);
    const ctx = mockCtx();
    await getExploreFeed({ category: 'tools', cursor: '1:abc' }, env, ctx);
    await getExploreFeed({ limit: 3 }, env, ctx);
    await getExploreFilters(env, ctx);
    await getSitemapNews(env, ctx);
    const keys = new Set(vi.mocked(env.CACHE.get).mock.calls.map((call) => call[0]));
    expect([...keys]).toEqual(['poche:snapshot:v1']);
  });

  it('fetches Poche on a cold cache and stores what it parsed', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          `<rss><channel><item><title>Hello</title><link>https://example.com/a?utm_source=x</link>
         <pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate>
         <description>&lt;small&gt;example.com · Tools&lt;/small&gt;</description></item></channel></rss>`,
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env = envWith(null);
    const ctx = mockCtx();
    const feed = await getExploreFeed({}, env, ctx);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({ url: 'https://example.com/a', category: 'tools' });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });

  it('marks the feed unavailable on a cold cache when Poche fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    const feed = await getExploreFeed({}, envWith(null), mockCtx());
    expect(feed).toEqual({ items: [], nextCursor: null, unavailable: true });
  });

  it('never caches an empty parse over the stale snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>maintenance</html>')),
    );
    const env = envWith({ body: JSON.stringify(SNAPSHOT), at: 0 });
    const feed = await getExploreFeed({}, env, mockCtx());
    expect(feed.items).toHaveLength(10);
    expect(env.CACHE.put).not.toHaveBeenCalled();
  });

  it('falls back to the registry rail, with unknown counts, when unreadable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const filters = await getExploreFilters(envWith(null), mockCtx());
    expect(filters.total).toBeNull();
    expect(filters.categories.length).toBe(8);
    expect(filters.categories.every((c) => c.count === null)).toBe(true);
  });

  it('treats a stored entry of the wrong shape as unreadable, not as empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const feed = await getExploreFeed({}, fresh({ items: [] }), mockCtx());
    expect(feed.unavailable).toBe(true);
  });
});

describe('serveExplore', () => {
  it('answers JSON with the snapshot cache state', async () => {
    const res = await serveExplore({ limit: 2 }, fresh(SNAPSHOT), mockCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('HIT');
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(2);
  });
});

describe('serveExploreRss', () => {
  it('serves the head of a hub as RSS, with URLs composed from SITE_ORIGIN', async () => {
    const res = await serveExploreRss({ category: 'tools' }, fresh(SNAPSHOT), mockCtx());
    expect(res.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const body = await res.text();
    expect(body).toContain(`<atom:link href="${SITE_ORIGIN}/tools/rss.xml"`);
    expect(body).toContain(`<link>${SITE_ORIGIN}/tools</link>`);
    expect(body.match(/<item>/g)).toHaveLength(15);
  });

  it('answers a cold-cache outage as a JSON 502, never as a feed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    const res = await serveExploreRss({}, envWith(null), mockCtx());
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});

describe('getSitemapNews', () => {
  it('dates each hub by its newest link', async () => {
    const data = await getSitemapNews(fresh(SNAPSHOT), mockCtx());
    expect(data.hubs).toEqual(
      expect.arrayContaining([
        { category: 'tools', lastmod: new Date(SNAPSHOT[0]!.publishedAt).toISOString() },
        { category: 'design', lastmod: new Date(SNAPSHOT[1]!.publishedAt).toISOString() },
      ]),
    );
    expect(data.hubs).toHaveLength(2);
  });
});

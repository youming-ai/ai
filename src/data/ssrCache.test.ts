// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Env, getExploreFeed, getExploreFilters, getSitemapNews } from './api';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

afterEach(() => vi.unstubAllGlobals());

describe('SSR cache consumers', () => {
  it('reads feed, filters and sitemap without constructing HTTP responses', async () => {
    const ResponseMock = vi.fn(() => {
      throw new Error('SSR must not construct Response');
    });
    vi.stubGlobal('Response', ResponseMock);
    const bodies = [
      { items: [{ id: 'story' }], nextCursor: 'cursor' },
      { categories: [{ value: 'tools', label: 'Tools', count: 1 }], total: 1 },
      { hubs: [{ value: 'tools', count: 1789707171000 }] },
    ];
    const get = vi.fn();
    for (const body of bodies)
      get.mockResolvedValueOnce({ body: JSON.stringify(body), at: Date.now() });
    const env = { CACHE: { get } } as unknown as Env;
    expect(await getExploreFeed({}, env, ctx)).toEqual(bodies[0]);
    expect(await getExploreFilters(env, ctx)).toEqual(bodies[1]);
    expect(await getSitemapNews(env, ctx)).toEqual({
      hubs: [{ category: 'tools', lastmod: new Date(1789707171000).toISOString() }],
    });
    expect(ResponseMock).not.toHaveBeenCalled();
  });

  it('bypasses KV for SSR cursor pages without constructing responses', async () => {
    const ResponseMock = vi.fn(() => {
      throw new Error('SSR must not construct Response');
    });
    vi.stubGlobal('Response', ResponseMock);
    const get = vi.fn();
    const put = vi.fn();
    const all = vi.fn().mockResolvedValue({ results: [] });
    const env = {
      CACHE: { get, put },
      DB: { prepare: () => ({ bind: () => ({ all }) }) },
    } as unknown as Env;
    expect(await getExploreFeed({ cursor: '20530:85:1786080856000:abc123' }, env, ctx)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(all).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(ResponseMock).not.toHaveBeenCalled();
  });
});

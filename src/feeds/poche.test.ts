// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SITE_ORIGIN } from '../site';
import type { FeedItem } from './types';
import { canonicalizeUrl, fetchPocheFeed, toExploreArticles } from './poche';

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    category: 'tools',
    title: 'A tool',
    description: 'Teaser',
    url: 'https://example.com/a',
    imageUrl: '',
    imageWidth: 0,
    imageHeight: 0,
    publishedAt: 1_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canonicalizeUrl', () => {
  it('removes tracking parameters while preserving editorial query parameters', () => {
    expect(
      canonicalizeUrl('HTTPS://WWW.Example.com/story/?utm_source=feed&FBCLID=abc&page=2#comments'),
    ).toBe('https://www.example.com/story?page=2');
  });

  it('drops any scheme that is not http(s), and anything that is not a URL', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBe('');
    expect(canonicalizeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(canonicalizeUrl('not a url')).toBe('');
    expect(canonicalizeUrl('http://example.com/story')).toBe('http://example.com/story');
  });
});

describe('toExploreArticles', () => {
  it('keeps one entry per canonical URL, newest first, capped', async () => {
    const articles = await toExploreArticles(
      [
        item({ url: 'https://example.com/old', publishedAt: 1 }),
        item({ url: 'https://example.com/new', publishedAt: 3 }),
        item({ url: 'https://example.com/new?utm_source=x', publishedAt: 2 }),
        item({ url: 'https://example.com/mid', publishedAt: 2 }),
      ],
      2,
    );
    expect(articles.map((a) => a.url)).toEqual([
      'https://example.com/new',
      'https://example.com/mid',
    ]);
  });

  it('never keeps a link whose scheme is not http(s)', async () => {
    expect(await toExploreArticles([item({ url: 'javascript:alert(1)' })], 50)).toEqual([]);
  });

  it('maps the publisher label to a registry key, and an unknown one to null', async () => {
    const [known, unknown] = await toExploreArticles(
      [
        item({ category: 'web3', publishedAt: 2 }),
        item({ url: 'https://x.test/', category: 'gadgets', publishedAt: 1 }),
      ],
      50,
    );
    expect(known!.category).toBe('crypto');
    expect(unknown!.category).toBeNull();
  });

  it('derives a stable hex id from the canonical URL', async () => {
    const [a] = await toExploreArticles([item({ url: 'https://example.com/a?utm_medium=x' })], 50);
    const [b] = await toExploreArticles(
      [item({ url: 'https://example.com/a', title: 'Renamed' })],
      50,
    );
    expect(a!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(a!.id).toBe(b!.id);
  });
});

describe('fetchPocheFeed', () => {
  it('sends a user-agent naming the site and its real origin', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('<rss><item><title>T</title><link>https://example.com/</link></item></rss>'),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchPocheFeed();
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['user-agent']).toContain(SITE_ORIGIN);
    expect(fetchMock.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws on a non-2xx and on a feed that parses to nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    await expect(fetchPocheFeed()).rejects.toThrow(/404/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html></html>')),
    );
    await expect(fetchPocheFeed()).rejects.toThrow(/no items/);
  });
});

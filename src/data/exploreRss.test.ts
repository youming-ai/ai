// The RSS renderer is a pure function over ExploreFeed. No DB, no env, no
// Worker bindings — these tests run in the default jsdom and execute in
// milliseconds. If the JSON shape ExploreArticle carries ever changes,
// renderExploreRss is the most likely place to feel it first.
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_FEED_LABEL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_RSS_LANGUAGE,
  SITE_TITLE,
} from '../site';
import type { ExploreFeed } from '../types';
import { renderExploreRss } from './exploreRss';

function article(
  overrides: Partial<{
    id: string;
    title: string;
    description: string;
    url: string;
    sourceDomain: string;
    publishedAt: number;
    category: string | null;
  }>,
): ExploreFeed['items'][number] {
  return {
    id: 'id-1',
    title: 'Article title',
    description: '',
    url: 'https://tomshardware.com/pc-components/article',
    imageUrl: '',
    isVideo: false,
    imageWidth: 0,
    imageHeight: 0,
    sourceDomain: 'tomshardware.com',
    publishedAt: 1735689600000, // 2025-01-01T00:00:00Z (a fixed instant so the test is stable)
    category: 'gpu',
    ...overrides,
  };
}

describe('renderExploreRss', () => {
  it('starts with an XML declaration line, then the rss root', () => {
    const xml = renderExploreRss({ items: [], nextCursor: null }, GLOBAL_FEED_LABEL);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
    expect(xml).toContain(`<title>${SITE_TITLE}</title>`);
    expect(xml).toContain(`<description>${SITE_DESCRIPTION}`);
    expect(xml).toContain(`<language>${SITE_RSS_LANGUAGE}</language>`);
    expect(xml).toContain(`<generator>${SITE_NAME}</generator>`);
  });

  it('scopes the channel title to a category when one is provided', () => {
    const xml = renderExploreRss({ items: [], nextCursor: null }, 'GPUs');
    expect(xml).toContain(`<title>${SITE_NAME} \u2014 GPUs links</title>`);
  });

  it('emits one <item> per article with stable guid, RFC 822 date, and categories', () => {
    const xml = renderExploreRss(
      {
        items: [
          article({
            id: 'stable-fingerprint',
            title: 'A new flagship GPU breaks cover',
            sourceDomain: 'tomshardware.com',
          }),
        ],
        nextCursor: null,
      },
      GLOBAL_FEED_LABEL,
    );
    expect(xml).toContain('<item>');
    expect(xml).toContain('<title>A new flagship GPU breaks cover</title>');
    expect(xml).toContain('<guid isPermaLink="false">stable-fingerprint</guid>');
    // RFC 822: month + day + year + time + GMT
    expect(xml).toMatch(
      /<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/,
    );
    expect(xml).toContain('<category>category:gpu</category>');
    expect(xml).toContain('<category>source:tomshardware.com</category>');
    // No `type:` category: the pipeline writes article_type = 'link' for every
    // row, so the element was the same constant on every item in every feed.
    expect(xml).not.toContain('<category>type:');
  });

  it('escapes XML special characters in title, description, and category', () => {
    const xml = renderExploreRss(
      {
        items: [
          article({
            title: 'Nvidia "wins" <3> & forgets the rest',
            description: 'They said "lucky" & left.',
            sourceDomain: 'quotes&brackets.test',
          }),
        ],
        nextCursor: null,
      },
      GLOBAL_FEED_LABEL,
    );
    expect(xml).toContain('Nvidia &quot;wins&quot; &lt;3&gt; &amp; forgets the rest');
    expect(xml).toContain('They said &quot;lucky&quot; &amp; left.');
    expect(xml).toContain('source:quotes&amp;brackets.test');
    // The original characters must not survive into XML as raw bytes.
    expect(xml).not.toContain('"wins"');
    expect(xml).not.toContain('<3>');
  });

  it('uses the publisher description for the item description', () => {
    // The channel itself always has a <description>, so we scope the empty-
    // body assertion to the lone <item>'s content.
    const itemsOnly = (xml: string): string => {
      const start = xml.indexOf('<item>');
      const end = xml.lastIndexOf('</item>');
      return start >= 0 && end >= 0 ? xml.slice(start, end + '</item>'.length) : '';
    };

    const fromDescription = renderExploreRss(
      {
        items: [article({ description: 'publisher copy' })],
        nextCursor: null,
      },
      GLOBAL_FEED_LABEL,
    );
    expect(itemsOnly(fromDescription)).toContain('<description>publisher copy</description>');

    const empty = renderExploreRss(
      { items: [article({ description: '' })], nextCursor: null },
      GLOBAL_FEED_LABEL,
    );
    expect(itemsOnly(empty)).not.toContain('<description>');
  });

  // The renderer holds no cap of its own — `serveExploreRss` asks the query
  // layer for its clamped maximum and the renderer emits exactly that. A cap
  // here would have been dead code the moment the clamp sat below it.
  it('renders every item it is handed', () => {
    const items = Array.from({ length: 120 }, (_, i) => article({ id: `id-${i}` }));
    const xml = renderExploreRss({ items, nextCursor: null }, GLOBAL_FEED_LABEL);
    expect(xml.match(/<item>/g)).toHaveLength(120);
    expect(xml).toContain('<guid isPermaLink="false">id-119</guid>');
  });

  it('renders an Atom self link when given one', () => {
    const xml = renderExploreRss({ items: [], nextCursor: null }, GLOBAL_FEED_LABEL, {
      includeAtomSelfLink: '/rss.xml',
    });
    expect(xml).toContain('<atom:link href="/rss.xml" rel="self" type="application/rss+xml" />');
  });

  it('points the channel link to a per-category hub when one is supplied', () => {
    const xml = renderExploreRss({ items: [], nextCursor: null }, 'GPUs', {
      channelLink: `${SITE_ORIGIN}/gpu`,
    });
    expect(xml).toContain(`<link>${SITE_ORIGIN}/gpu</link>`);
    expect(xml).not.toContain(`<link>${SITE_ORIGIN}/</link>`);
  });

  it('falls back to the global origin when no channel link is supplied', () => {
    const xml = renderExploreRss({ items: [], nextCursor: null }, GLOBAL_FEED_LABEL);
    expect(xml).toContain(`<link>${SITE_ORIGIN}/</link>`);
  });
});

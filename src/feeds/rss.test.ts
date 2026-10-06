import { describe, expect, it, vi } from 'vitest';

// Isolation is a guard against item parsing throwing at all, so the decoder is
// made to throw for one sentinel item: the parser must lose that item alone,
// not the batch. Everything else keeps the real implementation.
vi.mock('../utils/coerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/coerce')>();
  return {
    ...actual,
    decodeEntities: (value: string) => {
      if (value.includes('THROW_ON_THIS_ITEM')) throw new Error('unparseable item');
      return actual.decodeEntities(value);
    },
  };
});

import { parseRss } from './rss';
import type { FeedSource } from './types';

const source: FeedSource = {
  id: 'test-hardware',
  kind: 'rss',
  name: 'Test Hardware',
  url: 'https://example.com/rss.xml',
  authorityScore: 80,
  defaultEnabled: true,
  maxItems: 50,
};

describe('parseRss', () => {
  it('normalizes RSS/Atom fields and strips markup', () => {
    const articles = parseRss(
      `<rss><channel><item>
        <title><![CDATA[GPU &amp; cooling update]]></title>
        <link>https://example.com/story?utm_source=test</link>
        <description><![CDATA[<p>A short <b>hardware</b> report.</p>]]></description>
        <pubDate>Wed, 05 Aug 2026 10:00:00 GMT</pubDate>
        <media:content url="https://example.com/image.jpg" width="800" height="600" />
      </item></channel></rss>`,
      source,
      Date.parse('2026-08-05T12:00:00Z'),
    );

    expect(articles).toEqual([
      expect.objectContaining({
        title: 'GPU & cooling update',
        description: 'A short hardware report.',
        url: 'https://example.com/story?utm_source=test',
        imageUrl: 'https://example.com/image.jpg',
        imageWidth: 800,
        imageHeight: 600,
        publishedAt: Date.parse('2026-08-05T10:00:00Z'),
        category: null,
      }),
    ]);
  });

  it('preserves escaped angle brackets in a title as text', () => {
    const articles = parseRss(
      `<rss><channel><item>
        <title>Guide to &lt;dialog&gt;</title>
        <link>https://example.com/dialog</link>
        <description>A web platform guide.</description>
      </item></channel></rss>`,
      source,
      Date.parse('2026-08-05T12:00:00Z'),
    );
    expect(articles[0]?.title).toBe('Guide to <dialog>');
  });

  it('extracts item category from Poche-style content:encoded or direct category tags', () => {
    const articles = parseRss(
      `<rss><channel><item>
        <title>thonik – Home</title>
        <link>https://thonik.nl/</link>
        <description>Dutch studio thonik.</description>
        <content:encoded><![CDATA[<p>Content</p><p><small><a href="https://thonik.nl/">thonik.nl</a> · Design</small></p>]]></content:encoded>
        <media:thumbnail url="https://example.com/thumb.webp" />
      </item></channel></rss>`,
      source,
      Date.parse('2026-08-05T12:00:00Z'),
    );
    expect(articles[0].category).toBe('design');
    expect(articles[0].imageUrl).toBe('https://example.com/thumb.webp');
  });

  it('takes the trailing segment of a multi-part byline', () => {
    const articles = parseRss(
      `<rss><channel><item>
        <title>A design tool</title>
        <link>https://example.com/tool</link>
        <description>A short report.</description>
        <content:encoded><![CDATA[<p>Content</p><p><small><a href="https://example.com/">example.com</a> · Picks · Tools</small></p>]]></content:encoded>
      </item></channel></rss>`,
      source,
      Date.parse('2026-08-05T12:00:00Z'),
    );
    expect(articles[0].category).toBe('tools');
  });

  it('returns null when the byline has no parseable category', () => {
    const articles = parseRss(
      `<rss><channel><item>
        <title>An uncategorised link</title>
        <link>https://example.com/link</link>
        <description>A short report.</description>
        <content:encoded><![CDATA[<p>Content</p><p><small><a href="https://example.com/">example.com</a></small></p>]]></content:encoded>
      </item></channel></rss>`,
      source,
      Date.parse('2026-08-05T12:00:00Z'),
    );
    expect(articles[0].category).toBeNull();
  });

  it('passes hostile numeric references through a whole batch without losing items', () => {
    // What this pins is the decoder, not the isolation guard: an out-of-range
    // reference used to throw out of `String.fromCodePoint` and take the batch
    // with it. It is now dropped, so all three items survive.
    const articles = parseRss(
      `<rss><channel>
        <item><title>First good link</title><link>https://example.com/one</link></item>
        <item><title>Bad &#1114112; code point</title><link>https://example.com/bad</link></item>
        <item><title>Second good link</title><link>https://example.com/two</link></item>
      </channel></rss>`,
      source,
      Date.parse('2026-08-05T12:00:00Z'),
    );

    expect(articles.map((article) => article.url)).toEqual([
      'https://example.com/one',
      'https://example.com/bad',
      'https://example.com/two',
    ]);
  });

  it('drops only the item that fails to parse', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const articles = parseRss(
      `<rss><channel>
        <item><title>Kept before</title><link>https://example.com/one</link></item>
        <item><title>THROW_ON_THIS_ITEM</title><link>https://example.com/broken</link></item>
        <item><title>Kept after</title><link>https://example.com/two</link></item>
      </channel></rss>`,
      source,
      Date.parse('2026-08-05T12:00:00Z'),
    );

    expect(articles.map((article) => article.url)).toEqual([
      'https://example.com/one',
      'https://example.com/two',
    ]);
    expect(error).toHaveBeenCalledOnce();
  });
});

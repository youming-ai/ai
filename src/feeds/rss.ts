import { decodeEntities } from '../utils/coerce';
import type { FeedSource, RawArticle } from './types';

function stripHtml(value: string): string {
  // Remove real markup before decoding entities. Otherwise an escaped literal
  // such as `&lt;dialog&gt;` becomes a tag and disappears with the markup.
  const withoutCdata = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');
  return decodeEntities(withoutCdata.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValue(block: string, names: string[]): string {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function imageMeta(block: string): { url: string; width: number; height: number } {
  // enclosure/media:content/media:thumbnail all carry the image URL on a
  // url=/href= attribute; width/height are optional sibling attributes.
  const tag =
    block.match(/<enclosure\b[^>]*\burl=['"]([^'"]+)['"][^>]*\btype=['"]image\//i) ||
    block.match(
      /<(?:media:content|media:thumbnail|image)\b[^>]*\b(?:url|href)=['"]([^'"]+)['"][^>]*/i,
    );
  const url = tag?.[1] ? decodeEntities(tag[1]) : '';
  const rawAttrs = tag?.[0] ?? '';
  const width = Number.parseInt(rawAttrs.match(/\bwidth=['"](\d+)['"]/i)?.[1] ?? '', 10);
  const height = Number.parseInt(rawAttrs.match(/\bheight=['"](\d+)['"]/i)?.[1] ?? '', 10);
  return { url, width: width > 0 ? width : 0, height: height > 0 ? height : 0 };
}

function linkValue(block: string): string {
  const href = block.match(/<link\b[^>]*\bhref=['"]([^'"]+)['"]/i);
  if (href?.[1]) return decodeEntities(href[1]);
  return decodeEntities(tagValue(block, ['link', 'guid']));
}

function itemBlocks(xml: string): string[] {
  return [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(
    (match) => match[2] ?? '',
  );
}

function extractCategory(block: string): string | null {
  const direct = decodeEntities(tagValue(block, ['category']));
  if (direct) return direct.trim().toLowerCase();
  // Poche byline heuristic, not a contract: items carry
  // `<small><a>domain</a> · Category</small>` in content:encoded. The category
  // is the segment after the last middot; anything unparseable falls through
  // to null and the source preset. If Poche restyles the byline this silently
  // yields null, so uncategorised stories stay visible on the global board.
  const encoded = decodeEntities(tagValue(block, ['content:encoded', 'description']));
  const match = encoded.match(/·\s*([^<]+)<\/small>/i);
  const last = match?.[1]?.split('·').pop()?.trim().toLowerCase();
  return last ? last : null;
}

export function parseRss(
  xml: string,
  source: FeedSource,
  fetchedAt = Date.now(),
): Omit<RawArticle, 'canonicalUrl' | 'fingerprint'>[] {
  const articles: Omit<RawArticle, 'canonicalUrl' | 'fingerprint'>[] = [];
  // One item at a time, each isolated: a single malformed entry must cost that
  // entry only. When the whole `.map` could throw, one bad item in a rolling
  // feed aborted the entire parse on every tick — the site stopped updating
  // silently, and the item stayed in the feed to fail again 15 minutes later.
  for (const block of itemBlocks(xml)) {
    try {
      const title = stripHtml(tagValue(block, ['title']));
      const url = linkValue(block).trim();
      // A body is HTML, and RSS `<description>` / Atom `type="html"` carry it
      // entity-escaped (`&lt;p&gt;`), so decode once before stripping: stripping
      // first left Product Hunt's, Simon Willison's and Martin Fowler's
      // teasers on the board as literal `<p>`/`<a href>` text. A literal that
      // was meant as text arrives double-escaped and survives as `<dialog>`.
      const description = stripHtml(
        decodeEntities(tagValue(block, ['description', 'content:encoded', 'summary', 'content'])),
      ).slice(0, 4000);
      const publishedRaw = decodeEntities(
        tagValue(block, ['pubDate', 'published', 'updated', 'dc:date']),
      );
      const publishedAt = Date.parse(publishedRaw) || fetchedAt;
      const image = imageMeta(block);
      const category = extractCategory(block);
      if (title.length === 0 || url.length === 0) continue;
      articles.push({
        sourceId: source.id,
        sourceName: source.name,
        sourceAuthority: source.authorityScore,
        category,
        title,
        description,
        url,
        imageUrl: image.url,
        imageWidth: image.width,
        imageHeight: image.height,
        publishedAt,
        fetchedAt,
      });
    } catch (error) {
      console.error('[rss] skipped an unparseable item:', error);
    }
  }
  return articles;
}

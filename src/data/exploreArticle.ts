import { isVideoMediaUrl, proxiedImageUrl } from '../media';
import type { ExploreArticle } from '../types';
import { num } from '../utils/coerce';

// --- Explore row → article mapping (pure: no D1, no KV, no Response) ---
//
// Split out of explore.ts, which had grown to hold the cursor codec, this
// mapping, three SQL statements, the KV policy and the HTTP surface at once.
// This half is the part with no I/O, so it is testable on its own terms.

/** One row of the explore projection, as D1 hands it back: every field is
 *  `unknown` until a coercer has looked at it. */
export interface ExploreRow {
  id: unknown;
  title: unknown;
  description: unknown;
  canonical_url: unknown;
  image_url: unknown;
  image_width: unknown;
  image_height: unknown;
  published_at: unknown;
  category: unknown;
}

/** A `GROUP BY` row from the counts query. */
export interface CountRow {
  value: unknown;
  count: unknown;
}

export const rowString = (v: unknown): string => (typeof v === 'string' ? v : '');
export const rowNumber = num;

function sourceDomain(value: unknown): string {
  try {
    return new URL(rowString(value)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Single source of truth for the article SELECT projection. */
export const EXPLORE_ARTICLE_COLUMNS =
  'a.id, a.title, a.description, a.canonical_url, ' +
  'a.image_url, a.image_width, a.image_height, a.published_at, a.category';

/** Feed markup that reached storage before `parseRss` decoded escaped bodies.
 *  Only common body tags, so a literal like `<dialog>` in prose survives. */
const STORED_FEED_MARKUP =
  /<\/?(?:p|a|br|div|span|img|b|i|strong|em|ul|ol|li|blockquote|figure|figcaption|h[1-6])\b[^>]*>/gi;

function feedText(value: unknown): string {
  const text = rowString(value);
  return text.includes('<')
    ? text.replace(STORED_FEED_MARKUP, ' ').replace(/\s+/g, ' ').trim()
    : text;
}

export function exploreArticle(row: ExploreRow): ExploreArticle {
  // The video judgement reads the URL as the feed delivered it — before the
  // /media rewrite, which can strip the extension the check depends on.
  const rawImageUrl = rowString(row.image_url);
  return {
    id: rowString(row.id),
    title: rowString(row.title),
    description: feedText(row.description),
    url: rowString(row.canonical_url),
    // Upstream-hosted images are rewritten to /media so the feed's own CDN
    // origin never reaches markup, the payload, or og:image.
    imageUrl: proxiedImageUrl(rawImageUrl),
    isVideo: isVideoMediaUrl(rawImageUrl),
    imageWidth: rowNumber(row.image_width),
    imageHeight: rowNumber(row.image_height),
    // Story domain, not feed URL — feeds.bbci.co.uk → bbc.com.
    sourceDomain: sourceDomain(row.canonical_url),
    publishedAt: rowNumber(row.published_at),
    category: rowString(row.category) || null,
  };
}

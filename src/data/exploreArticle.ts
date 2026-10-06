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
  ai_summary: unknown;
  ai_blurb: unknown;
  canonical_url: unknown;
  image_url: unknown;
  image_width: unknown;
  image_height: unknown;
  published_at: unknown;
  day_bucket: unknown;
  category: unknown;
  quality_score: unknown;
  freshness_score: unknown;
  tags?: unknown;
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

function rowTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Live freshness, computed at query time from published_at rather than the
 *  frozen insert-time snapshot the column used to hold. 259200 = 72h in
 *  seconds. Exported to API consumers; the current UI renders no freshness
 *  value, so this is a documented surface rather than a rendered one. */
const LIVE_FRESHNESS =
  "MAX(0, MIN(100, ROUND(100.0 - (CAST(strftime('%s','now') AS REAL) - a.published_at / 1000.0) / 259200.0 * 100.0))) AS freshness_score";

/** Single source of truth for the article SELECT projection.
 *
 *  `article_type` is deliberately absent: the pipeline writes `'link'` for every
 *  row, so it was a constant that cost a column read on every query and a slot
 *  in every cached payload (and was rendered on every card as `LINK / X`). */
export const EXPLORE_ARTICLE_COLUMNS =
  'a.id, a.title, a.description, a.ai_summary, a.ai_blurb, a.canonical_url, ' +
  'a.image_url, a.image_width, a.image_height, ' +
  'a.published_at, a.day_bucket, a.category, a.quality_score, ' +
  `${LIVE_FRESHNESS}, ` +
  "COALESCE((SELECT json_group_array(at.tag) FROM article_tags at WHERE at.article_id = a.id), '[]') AS tags";

export function exploreArticle(row: ExploreRow): ExploreArticle {
  // The video judgement reads the URL as the feed delivered it — before the
  // /media rewrite, which can strip the extension the check depends on.
  const rawImageUrl = rowString(row.image_url);
  return {
    id: rowString(row.id),
    title: rowString(row.title),
    description: rowString(row.description),
    summary: rowString(row.ai_summary),
    blurb: rowString(row.ai_blurb),
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
    freshnessScore: rowNumber(row.freshness_score),
    tags: rowTags(row.tags),
    qualityScore: rowNumber(row.quality_score),
  };
}

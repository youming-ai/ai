import { type ExploreRow, rowNumber, rowString } from './exploreArticle';

// --- Keyset cursor codec (pure) ---

/** Keyset cursor `<day>:<quality>:<published_at>:<id>`. The feed sorts by
 *  recency at day granularity first (newest day wins — an explore feed must not
 *  pin a 75-day-old link above today's), then editorial quality within the
 *  day, then exact time, then id. Every key is immutable (the day bucket is
 *  floor(published_at / 86400000), not a now-relative window), so the keyset
 *  stays stable under the daily ingest inserts. Offset would slide under rows
 *  inserted at the top every ingest tick. */
export function parseExploreCursor(
  value: string | undefined,
): [number, number, number, string] | null {
  if (!value) return null;
  const first = value.indexOf(':');
  if (first <= 0) return null;
  const second = value.indexOf(':', first + 1);
  if (second <= first + 1) return null;
  const third = value.indexOf(':', second + 1);
  if (third <= second + 1) return null;
  const day = Number(value.slice(0, first));
  const qualityScore = Number(value.slice(first + 1, second));
  const publishedAt = Number(value.slice(second + 1, third));
  const id = value.slice(third + 1);
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(qualityScore) ||
    !Number.isFinite(publishedAt) ||
    !id
  )
    return null;
  // Only the field that cannot be negative is rejected. day_bucket and
  // published_at legitimately are for a pre-1970 pubDate, which the feed parser
  // stores as-is and migration 0015 buckets by floor — rejecting those would
  // have made such a row listable but its page unreachable, since every
  // subsequent cursor would collapse to page one. quality_score is a 0-100
  // authority score, so a negative one cannot come from any row.
  if (qualityScore < 0) return null;
  return [day, qualityScore, publishedAt, id];
}

export function exploreCursorFor(row: ExploreRow): string {
  return `${rowNumber(row.day_bucket)}:${rowNumber(row.quality_score)}:${rowNumber(row.published_at)}:${rowString(row.id)}`;
}

export function canonicalCursor(value: string | undefined): string | undefined {
  const parsed = parseExploreCursor(value?.slice(0, 160));
  return parsed ? `${parsed[0]}:${parsed[1]}:${parsed[2]}:${parsed[3]}` : undefined;
}

import { type ExploreRow, rowNumber, rowString } from './exploreArticle';

// --- Keyset cursor codec (pure) ---

/** Keyset cursor `<published_at>:<id>`, matching the feed's newest-first order.
 *  Both keys are immutable, so the keyset stays stable under the inserts every
 *  ingest tick makes at the top; an offset would slide. published_at may be
 *  negative (a pre-1970 pubDate is stored as-is), so only finiteness is checked.
 *  Ids are SHA-256 hex, so an id holding a colon is a pre-v6 four-part cursor
 *  from a page still open in someone's tab: it collapses to page one rather
 *  than being misread as a 1970 timestamp. */
export function parseExploreCursor(value: string | undefined): [number, string] | null {
  if (!value) return null;
  const colon = value.indexOf(':');
  if (colon <= 0) return null;
  const publishedAt = Number(value.slice(0, colon));
  const id = value.slice(colon + 1);
  if (!Number.isFinite(publishedAt) || !id || id.includes(':')) return null;
  return [publishedAt, id];
}

export function exploreCursorFor(row: ExploreRow): string {
  return `${rowNumber(row.published_at)}:${rowString(row.id)}`;
}

export function canonicalCursor(value: string | undefined): string | undefined {
  const parsed = parseExploreCursor(value?.slice(0, 160));
  return parsed ? `${parsed[0]}:${parsed[1]}` : undefined;
}

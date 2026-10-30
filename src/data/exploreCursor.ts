import type { ExploreArticle } from '../types';

// --- Keyset cursor codec (pure) ---

/** Keyset cursor `<publishedAt>:<id>`, matching the feed's newest-first order.
 *  Both keys are immutable per link, so the keyset stays stable when the
 *  snapshot refreshes between two pages; an offset would slide as new links
 *  arrive at the top. publishedAt may be negative (a pre-1970 pubDate is kept
 *  as-is), so only finiteness is checked. Ids are SHA-256 hex, so an id
 *  holding a colon is a malformed cursor and collapses to page one. */
export function parseExploreCursor(value: string | undefined): [number, string] | null {
  if (!value) return null;
  const colon = value.indexOf(':');
  if (colon <= 0) return null;
  const publishedAt = Number(value.slice(0, colon));
  const id = value.slice(colon + 1);
  if (!Number.isFinite(publishedAt) || !id || id.includes(':')) return null;
  return [publishedAt, id];
}

export function exploreCursorFor(article: Pick<ExploreArticle, 'publishedAt' | 'id'>): string {
  return `${article.publishedAt}:${article.id}`;
}

export function canonicalCursor(value: string | undefined): string | undefined {
  const parsed = parseExploreCursor(value?.slice(0, 160));
  return parsed ? `${parsed[0]}:${parsed[1]}` : undefined;
}

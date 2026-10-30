import { CATEGORIES } from '../categories';
import { fetchPocheFeed } from '../feeds/poche';
import { GLOBAL_FEED_LABEL, SITE_ORIGIN } from '../site';
import type { ExploreArticle, ExploreFeed, ExploreFilterOption, ExploreFilterSet } from '../types';
import { type CachedResult, type Env, json, runCached } from './cache';
import { canonicalCursor, exploreCursorFor, parseExploreCursor } from './exploreCursor';
import { renderExploreRss } from './exploreRss';

// --- The Explore feed: one KV snapshot of Poche Explore ---
//
// There is no database. The whole board is Poche's RSS — about fifty links —
// parsed into one KV entry. Every surface (the board, `/cards.json`, the API,
// the RSS feeds, the rail's counts, the sitemap) reads that one entry and
// filters, pages or counts it in memory. That keeps the KV key space at one
// key whatever the request carries: the cursor and category are applied after
// the read, never folded into a key.

interface ExploreQuery {
  category?: string;
  cursor?: string;
  limit?: number;
}

/** Versioned because a warm entry is parsed straight into `ExploreArticle`s, so
 *  a payload-shape change would otherwise be served in the old shape until it
 *  expired. Bump it whenever `ExploreArticle` changes. */
const SNAPSHOT_KEY = 'poche:snapshot:v1';
/** About the cadence the old cron polled at: Poche changes a few times an hour. */
const SNAPSHOT_FRESH_SECONDS = 10 * 60;
/** Long on purpose. With no archive behind it, the stale snapshot is the only
 *  thing between a Poche outage and an empty board. */
const SNAPSHOT_KEEP_SECONDS = 7 * 24 * 60 * 60;

/** The page ceiling every explore query is clamped to, and the page size a feed
 *  poll asks for: the RSS feed deliberately takes the largest page the API
 *  serves. Exported for the test that pins it. */
export const EXPLORE_MAX_LIMIT = 24;

function loadSnapshot(env: Env, ctx: ExecutionContext): Promise<CachedResult> {
  return runCached(
    SNAPSHOT_KEY,
    async () => JSON.stringify(await fetchPocheFeed()),
    SNAPSHOT_FRESH_SECONDS,
    SNAPSHOT_KEEP_SECONDS,
    env,
    ctx,
  );
}

/** The snapshot's articles, or null when it could not be read at all — an
 *  outage on a cold cache, or an entry that is not the shape we write. */
async function readSnapshot(
  env: Env,
  ctx: ExecutionContext,
): Promise<{ articles: ExploreArticle[]; cache: CachedResult['cache'] } | null> {
  try {
    const result = await loadSnapshot(env, ctx);
    if (result.status < 200 || result.status >= 300) return null;
    const parsed: unknown = JSON.parse(result.body);
    if (!Array.isArray(parsed)) return null;
    return { articles: parsed as ExploreArticle[], cache: result.cache };
  } catch (error) {
    console.error('[data] snapshot unreadable:', error);
    return null;
  }
}

function normalizedExploreQuery(
  query: ExploreQuery,
): Required<Pick<ExploreQuery, 'limit'>> & Omit<ExploreQuery, 'limit'> {
  const category =
    query.category && Object.hasOwn(CATEGORIES, query.category) ? query.category : undefined;
  const limit = Number.isInteger(query.limit)
    ? Math.min(EXPLORE_MAX_LIMIT, Math.max(1, query.limit ?? 10))
    : 10;
  // Re-serialised so a malformed cursor collapses to "first page".
  return { category, cursor: canonicalCursor(query.cursor), limit };
}

/** One page of the snapshot. Pure: the snapshot is already newest-first, and
 *  the cursor is "strictly after the last link delivered" in that order. */
export function explorePage(articles: ExploreArticle[], query: ExploreQuery): ExploreFeed {
  const normalized = normalizedExploreQuery(query);
  const cursor = parseExploreCursor(normalized.cursor);
  const matching = articles.filter(
    (article) =>
      (!normalized.category || article.category === normalized.category) &&
      (!cursor ||
        article.publishedAt < cursor[0] ||
        (article.publishedAt === cursor[0] && article.id < cursor[1])),
  );
  const page = matching.slice(0, normalized.limit);
  const hasMore = matching.length > normalized.limit;
  return {
    items: page,
    nextCursor: hasMore && page.length > 0 ? exploreCursorFor(page[page.length - 1]!) : null,
  };
}

export function exploreQueryFromUrl(url: URL): ExploreQuery {
  const limitValue = url.searchParams.get('limit');
  const limit = limitValue === null ? Number.NaN : Number(limitValue);
  return {
    category: url.searchParams.get('category') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  };
}

const UNAVAILABLE = '{"error":"upstream unavailable"}';

export async function serveExplore(
  query: ExploreQuery,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const snapshot = await readSnapshot(env, ctx);
  if (!snapshot) return json(UNAVAILABLE, 502, 'MISS');
  return json(JSON.stringify(explorePage(snapshot.articles, query)), 200, snapshot.cache);
}

export async function getExploreFeed(
  query: ExploreQuery,
  env: Env,
  ctx: ExecutionContext,
): Promise<ExploreFeed> {
  const snapshot = await readSnapshot(env, ctx);
  // `unavailable` is what keeps an outage from rendering as "no links match
  // these filters" — the reader is told the truth and the filters are not
  // blamed for it.
  if (!snapshot) return { items: [], nextCursor: null, unavailable: true };
  return explorePage(snapshot.articles, query);
}

/** RSS 2.0 surface for the Explore feed: the head of the board (no cursor),
 *  per category when one is given. */
export async function serveExploreRss(
  query: ExploreQuery,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const snapshot = await readSnapshot(env, ctx);
  // An error is JSON, not a feed document, and must not get RSS caching headers.
  if (!snapshot) return json(UNAVAILABLE, 502, 'MISS');

  const category =
    query.category && Object.hasOwn(CATEGORIES, query.category) ? query.category : undefined;
  const scopeLabel = category ? (CATEGORIES[category]?.label ?? category) : GLOBAL_FEED_LABEL;
  // Composed from SITE_ORIGIN, never from the request host, so a request on any
  // other hostname cannot write its own host into `<link>` or `<atom:link>`.
  const selfUrl = category ? `${SITE_ORIGIN}/${category}/rss.xml` : `${SITE_ORIGIN}/rss.xml`;
  // Per-category feeds link to /<category> so a reader clicking through lands
  // on the matching hub rather than the global home.
  const channelLink = category ? `${SITE_ORIGIN}/${category}` : `${SITE_ORIGIN}/`;
  const feed = explorePage(snapshot.articles, { category, limit: EXPLORE_MAX_LIMIT });

  return new Response(
    renderExploreRss(feed, scopeLabel, { includeAtomSelfLink: selfUrl, channelLink }),
    {
      headers: {
        'content-type': 'application/rss+xml; charset=utf-8',
        'x-cache': snapshot.cache,
        // Feed readers poll every 30–60 minutes, so a 5-minute edge cache saves
        // origin hits without any reader-visible staleness.
        'cache-control': 'public, max-age=300',
      },
    },
  );
}

/** The rail's options with counts. The registry is the source of truth for
 *  what exists; the snapshot only says how many links each hub holds. */
export function exploreFilters(articles: ExploreArticle[]): ExploreFilterSet {
  const counts = new Map<string, number>();
  for (const article of articles) {
    if (article.category) counts.set(article.category, (counts.get(article.category) ?? 0) + 1);
  }
  const categories: ExploreFilterOption[] = [...counts]
    .filter(([value]) => Object.hasOwn(CATEGORIES, value))
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, label: CATEGORIES[value]!.label, count }));
  // Every link, not the sum of the options: an uncategorised link is on the
  // global board and in no hub.
  return { categories, total: articles.length };
}

/** When the snapshot is unreadable, fall back to the registry with unknown
 *  counts: emptying the navigation removes every route into the site, and
 *  rendering zeros would claim the hubs are empty. */
const FILTERS_FALLBACK: ExploreFilterSet = {
  categories: Object.entries(CATEGORIES).map(([value, category]) => ({
    value,
    label: category.label,
    count: null,
  })),
  total: null,
};

export async function serveExploreFilters(env: Env, ctx: ExecutionContext): Promise<Response> {
  const snapshot = await readSnapshot(env, ctx);
  if (!snapshot) return json(UNAVAILABLE, 502, 'MISS');
  return json(JSON.stringify(exploreFilters(snapshot.articles)), 200, snapshot.cache);
}

export async function getExploreFilters(
  env: Env,
  ctx: ExecutionContext,
): Promise<ExploreFilterSet> {
  const snapshot = await readSnapshot(env, ctx);
  return snapshot ? exploreFilters(snapshot.articles) : FILTERS_FALLBACK;
}

interface SitemapNewsHub {
  category: string;
  /** Newest link in that hub, as an ISO 8601 instant. */
  lastmod: string;
}

export interface SitemapData {
  hubs: SitemapNewsHub[];
  /** The snapshot could not be read rather than holding nothing. A sitemap with
   *  no hubs tells crawlers the site is empty, so an outage must say so. */
  unavailable?: boolean;
}

/** Category hubs for the sitemap: every hub with a link in the snapshot, dated
 *  by its newest one. Hubs are the crawlable surface — cards link straight to
 *  the source. */
export async function getSitemapNews(env: Env, ctx: ExecutionContext): Promise<SitemapData> {
  const snapshot = await readSnapshot(env, ctx);
  if (!snapshot) return { hubs: [], unavailable: true };
  const newest = new Map<string, number>();
  for (const article of snapshot.articles) {
    if (!article.category || !Object.hasOwn(CATEGORIES, article.category)) continue;
    if (article.publishedAt > (newest.get(article.category) ?? 0)) {
      newest.set(article.category, article.publishedAt);
    }
  }
  return {
    hubs: [...newest].map(([category, at]) => ({
      category,
      lastmod: new Date(at).toISOString(),
    })),
  };
}

/** Whether the board can render: the snapshot is readable (fresh, revalidated
 *  or stale). Used by /api/health. */
export async function snapshotReadable(env: Env, ctx: ExecutionContext): Promise<boolean> {
  return (await readSnapshot(env, ctx)) !== null;
}

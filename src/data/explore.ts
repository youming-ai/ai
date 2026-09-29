import { CATEGORIES } from '../categories';
import { isVideoMediaUrl, proxiedImageUrl } from '../media';
import { GLOBAL_FEED_LABEL, SITE_ORIGIN } from '../site';
import type { ExploreArticle, ExploreFeed, ExploreFilterOption, ExploreFilterSet } from '../types';
import { num } from '../utils/coerce';
import { type Env, json, runCached } from './cache';
import { renderExploreRss } from './exploreRss';

// --- Curated Explore feed (D1) ---

interface ExploreQuery {
  category?: string;
  cursor?: string;
  limit?: number;
}

/** The rail's options are D1 counts, but the registry is the source of truth for
 *  what exists. When counting fails, fall back to the registry with unknown
 *  counts: emptying the navigation because a COUNT failed removes every route
 *  into the site, and rendering zeros would claim the hubs are empty. */
const FILTERS_FALLBACK: ExploreFilterSet = {
  categories: Object.entries(CATEGORIES).map(([value, category]) => ({
    value,
    label: category.label,
    count: null,
  })),
  // The registry says which hubs exist, never how many rows there are.
  total: null,
};

interface ExploreRow {
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

function exploreArticle(row: ExploreRow): ExploreArticle {
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

/** Keyset cursor `<day>:<quality>:<published_at>:<id>`. The feed sorts by
 *  recency at day granularity first (newest day wins — an explore feed must not
 *  pin a 75-day-old link above today's), then editorial quality within the
 *  day, then exact time, then id. Every key is immutable (the day bucket is
 *  floor(published_at / 86400000), not a now-relative window), so the keyset
 *  stays stable under the daily ingest inserts. Offset would slide under rows
 *  inserted at the top every ingest tick. */

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
const EXPLORE_ARTICLE_COLUMNS =
  'a.id, a.title, a.description, a.ai_summary, a.ai_blurb, a.canonical_url, ' +
  'a.image_url, a.image_width, a.image_height, ' +
  'a.published_at, a.day_bucket, a.category, a.quality_score, ' +
  `${LIVE_FRESHNESS}, ` +
  "COALESCE((SELECT json_group_array(at.tag) FROM article_tags at WHERE at.article_id = a.id), '[]') AS tags";
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

function exploreCursorFor(row: ExploreRow): string {
  return `${rowNumber(row.day_bucket)}:${rowNumber(row.quality_score)}:${rowNumber(row.published_at)}:${rowString(row.id)}`;
}

function canonicalCursor(value: string | undefined): string | undefined {
  const parsed = parseExploreCursor(value?.slice(0, 160));
  return parsed ? `${parsed[0]}:${parsed[1]}:${parsed[2]}:${parsed[3]}` : undefined;
}

function normalizedExploreQuery(
  query: ExploreQuery,
): Required<Pick<ExploreQuery, 'limit'>> & Omit<ExploreQuery, 'limit'> {
  const category =
    query.category && Object.hasOwn(CATEGORIES, query.category) ? query.category : undefined;
  const limit = Number.isInteger(query.limit)
    ? Math.min(EXPLORE_MAX_LIMIT, Math.max(1, query.limit ?? 10))
    : 10;
  return {
    category,
    // Re-serialised so a malformed cursor collapses to "first page" instead of
    // becoming its own KV key.
    cursor: canonicalCursor(query.cursor),
    limit,
  };
}

async function queryExplore(query: ExploreQuery, env: Env): Promise<ExploreFeed> {
  if (!env.DB) throw new Error('D1 binding is required');
  const normalized = normalizedExploreQuery(query);
  const where = ["a.status = 'published'", 'a.is_on_topic = 1'];
  const bindings: unknown[] = [];

  if (normalized.category) {
    where.push('a.category = ?');
    bindings.push(normalized.category);
  }
  // Strictly after the last row delivered, in the same (day, quality,
  // published_at, id) order the query sorts by. Day bucket is immutable
  // (floor(published_at / 86400000)), so the keyset stays stable.
  //
  // Expressed as one row-value comparison. The four-way OR this replaced was
  // equivalent but not sargable: each branch wrapped day_bucket in an
  // expression, so the planner could not turn the cursor into an index seek and
  // re-sorted the whole partition on every page.
  const cursor = parseExploreCursor(normalized.cursor);
  if (cursor) {
    where.push('(a.day_bucket, a.quality_score, a.published_at, a.id) < (?, ?, ?, ?)');
    bindings.push(...cursor);
  }

  const statement = env.DB.prepare(
    `SELECT ${EXPLORE_ARTICLE_COLUMNS}
       FROM articles a
       WHERE ${where.join(' AND ')}
       ORDER BY a.day_bucket DESC, a.quality_score DESC, a.published_at DESC, a.id DESC
       LIMIT ?`,
  ).bind(...bindings, normalized.limit + 1);
  const result = await statement.all<ExploreRow>();
  const rows = result.results ?? [];
  const hasMore = rows.length > normalized.limit;
  const page = rows.slice(0, normalized.limit);
  return {
    items: page.map(exploreArticle),
    nextCursor: hasMore && page.length > 0 ? exploreCursorFor(page[page.length - 1]!) : null,
  };
}

export function exploreQueryFromUrl(url: URL): ExploreQuery {
  const limitValue = url.searchParams.get('limit');
  const limit = limitValue === null ? Number.NaN : Number(limitValue);
  return {
    category: url.searchParams.get('category') ?? undefined,
    // `source`, `tag` and `q` are not read: the rail dropped the first two, and
    // free-text search was removed with the header's search box. As free-form
    // request input they only widened the KV key space.
    cursor: url.searchParams.get('cursor') ?? undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  };
}

export async function serveExplore(
  query: ExploreQuery,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const normalized = normalizedExploreQuery(query);

  // Deep pages bypass KV — `cursor` is user-controlled, so caching it lets an
  // unauthenticated caller write unlimited KV entries. Re-serialising the cursor
  // is not enough: the id is taken verbatim and the three numbers only have to
  // be finite, so the key space is unbounded either way. Page one — nearly all
  // the traffic — still caches, and later pages of an infinite scroll rarely hit
  // a warm entry.
  if (normalized.cursor) {
    try {
      return json(JSON.stringify(await queryExplore(normalized, env)), 200, 'MISS');
    } catch (error) {
      console.error('[data] explore page failed:', error);
      return json('{"error":"upstream unavailable"}', 502, 'MISS');
    }
  }

  // What is left is bounded: category is checked against CATEGORIES and
  // limit is clamped. `source`/`tag` are not read from the request at all.
  //
  // The key is versioned because a warm KV entry is served verbatim, before any
  // mapper runs, so a payload-shape change would otherwise keep serving the old
  // shape — into the API and the island's hydration markup — until it
  // revalidated (and for the full `keep` window if D1 revalidation failed).
  // Bump this whenever the article payload changes:
  //   v2 dropped `sourceName`; v3 dropped `sourceId` and re-originated imageUrl;
  //   v4 added `isVideo`; v5 dropped `articleType`.
  const key = `explore:v5:${encodeURIComponent(JSON.stringify(normalized))}`;
  return runCached(
    key,
    async () => JSON.stringify(await queryExplore(normalized, env)),
    60,
    3600,
    env,
    ctx,
  );
}

/** The page ceiling every explore query is clamped to, and the page size a feed
 *  poll asks for: the feed deliberately takes the largest page the API serves.
 *  It was two literals — a clamp in `normalizedExploreQuery` and this — so
 *  raising one silently shrank the other. Exported for the test that pins it. */
export const EXPLORE_MAX_LIMIT = 24;

/** RSS 2.0 surface for the Explore feed. Drops `cursor` (subscribers take the
 *  head, not paginate); keeps the category so a per-hub feed stays its own cache
 *  entry. Same SWR freshness/cache as the JSON endpoint. */
export async function serveExploreRss(
  query: ExploreQuery,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // A feed is the head of the query, nothing transient. Drop the cursor before
  // going to KV so the cache key only carries the bookmark-worthy facets.
  const normalized = normalizedExploreQuery({
    ...query,
    cursor: undefined,
    limit: EXPLORE_MAX_LIMIT,
  });

  const scopeLabel = normalized.category
    ? (CATEGORIES[normalized.category]?.label ?? normalized.category)
    : GLOBAL_FEED_LABEL;
  // Composed from SITE_ORIGIN, never from the request host. The rendered
  // document is cached under a key that carries only the query, and KV is bound
  // per Worker rather than per hostname — so a request arriving on any other
  // host routed here (a preview, the workers.dev name) would otherwise write its
  // own host into `<link>` and `<atom:link rel="self">` and serve that to every
  // reader of the canonical feed. Taking the origin as a parameter made that a
  // one-line mistake; not taking it makes it impossible.
  const selfUrl = normalized.category
    ? `${SITE_ORIGIN}/${normalized.category}/rss.xml`
    : `${SITE_ORIGIN}/rss.xml`;
  // Per-category feeds link to /<category> so a reader clicking through lands
  // on the matching hub rather than the global home.
  const channelLink = normalized.category
    ? `${SITE_ORIGIN}/${normalized.category}`
    : `${SITE_ORIGIN}/`;

  // Versioned because the body is a *rendered* document: no mapper runs on
  // read, so a format change keeps being served from a warm entry until it
  // expires. `v1` covers the URLs now being composed from SITE_ORIGIN rather
  // than the request host — an entry written by an earlier deploy through
  // another hostname would otherwise outlive the fix. `v2` drops the constant
  // `type:` category.
  const key = `explore:rss:v2:${encodeURIComponent(JSON.stringify(normalized))}`;
  const cached = await runCached(
    key,
    async () => {
      const feed = await queryExplore(normalized, env);
      return renderExploreRss(feed, scopeLabel, {
        includeAtomSelfLink: selfUrl,
        channelLink,
      });
    },
    60,
    3600,
    env,
    ctx,
  );

  // Pass runCached's non-OK response through untouched: relabelling the JSON
  // error body as application/rss+xml would hand every reader a parse error.
  if (!cached.ok) return cached;

  // Wrap the SWR's JSON-shaped response into the RSS content type. The body is
  // still XML; runCached only inspects the string.
  const xCache = cached.headers.get('x-cache') ?? 'MISS';
  return new Response(cached.body, {
    status: cached.status,
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'x-cache': xCache,
      // Deliberately longer than the KV fresh window (60s): feed readers poll
      // every 30–60 minutes, so a 5-minute edge cache saves origin hits
      // without any reader-visible staleness.
      'cache-control': 'public, max-age=300',
    },
  });
}

export async function getExploreFeed(
  query: ExploreQuery,
  env: Env,
  ctx: ExecutionContext,
): Promise<ExploreFeed> {
  try {
    const response = await serveExplore(query, env, ctx);
    // `unavailable` is what keeps a D1 or KV outage from rendering as "no links
    // match these filters" — the reader is told the truth and the filters are
    // not blamed for it. Composer-only; the cached payload never carries it.
    if (!response.ok) return { items: [], nextCursor: null, unavailable: true };
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { items: [], nextCursor: null, unavailable: true };
    const feed = parsed as Partial<ExploreFeed>;
    // A body without an `items` array is a payload we cannot trust — unlike a
    // 200 that carries `items: []`, which is a real "nothing matched".
    if (!Array.isArray(feed.items)) return { items: [], nextCursor: null, unavailable: true };
    return {
      items: feed.items as ExploreArticle[],
      // String, not number: keyset cursor. While it checked for number it
      // coerced every SSR page to null, so pagination never began.
      nextCursor: typeof feed.nextCursor === 'string' ? feed.nextCursor : null,
    };
  } catch {
    return { items: [], nextCursor: null, unavailable: true };
  }
}

/** Category options for the rail, derived from D1. Cached so a crawler burst
 *  doesn't fan out to D1.
 *
 *  The list is global: every hub stays reachable from every page. It used to
 *  take the caller's category and fold it into the cache key, which stored nine
 *  identical copies of one payload — the parameter was never read here. */
async function queryExploreFilters(env: Env): Promise<ExploreFilterSet> {
  if (!env.DB) throw new Error('D1 binding is required');
  const published = "a.status = 'published' AND a.is_on_topic = 1";
  // NULL is deliberately included. It is not a hub, so it never becomes a rail
  // row, but its count belongs to the "All links" total: an unmapped publisher
  // category is stored as NULL and those stories do appear on the global board.
  const categories = await env.DB.prepare(
    `SELECT a.category AS value, COUNT(*) AS count
       FROM articles a
       WHERE ${published}
       GROUP BY a.category ORDER BY count DESC`,
  ).all<CountRow>();

  // `Object.hasOwn`, like every other registry gate: a stored value equal to an
  // Object.prototype key would otherwise read as a truthy match and surface a
  // label-less row whose count still feeds the "All links" total.
  const rows = categories.results ?? [];
  const categoryOptions: ExploreFilterOption[] = rows.flatMap(
    (row: CountRow): ExploreFilterOption[] => {
      const value = rowString(row.value);
      return Object.hasOwn(CATEGORIES, value)
        ? [{ value, label: CATEGORIES[value]!.label, count: rowNumber(row.count) }]
        : [];
    },
  );

  // Summed over every group, including the one that produced no option.
  const total = rows.reduce((sum, row) => sum + rowNumber(row.count), 0);

  return { categories: categoryOptions, total };
}

export async function serveExploreFilters(env: Env, ctx: ExecutionContext): Promise<Response> {
  // Versioned: the filters payload changed shape once ({competitions,sources,
  // tags} became {categories}) while reusing the same unversioned key, so a
  // warm entry rendered an empty rail with no error. Bump on any payload change
  // — v2 added `total`, so a v1 entry would leave the All row summing options
  // and undercounting again.
  return runCached(
    'explore:filters:v2:',
    async () => JSON.stringify(await queryExploreFilters(env)),
    300,
    3600,
    env,
    ctx,
  );
}

export async function getExploreFilters(
  env: Env,
  ctx: ExecutionContext,
): Promise<ExploreFilterSet> {
  try {
    const response = await serveExploreFilters(env, ctx);
    if (!response.ok) return FILTERS_FALLBACK;
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object') return FILTERS_FALLBACK;
    const filters = parsed as Partial<ExploreFilterSet>;
    // A 200 whose body is not the shape we expect is a cache entry from an
    // older format, not an empty corpus: fall back rather than empty the rail.
    return {
      categories: Array.isArray(filters.categories)
        ? filters.categories
        : FILTERS_FALLBACK.categories,
      // `null` and "absent" mean the same thing to the rail — count unknown —
      // so a v1 cache entry (no field) degrades to the summed options rather
      // than to a wrong number.
      total: typeof filters.total === 'number' ? filters.total : null,
    };
  } catch {
    return FILTERS_FALLBACK;
  }
}

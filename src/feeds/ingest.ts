import type { Env } from '../data/api';
import { SITE_NAME, SITE_ORIGIN } from '../site';
import { sleep } from '../utils/coerce';
import { canonicalCategory, normalizeTitle, storeArticle } from './enrich';
import { parseRss } from './rss';
import { FEED_SOURCES, INGEST_MAX_AGE_MS } from './sources';
import type { FeedSource, RawArticle } from './types';

// D1 caps bound variables per statement, so the fingerprint and canonical URL
// lookup goes out in chunks.
const KNOWN_COLUMN_CHUNK = 90;

// The publisher sees this, so it names the site the reader would reach and the
// origin comes from the one constant that defines it — the previous literal
// spelled the template's name next to this deployment's domain.
const RSS_HEADERS = {
  accept: 'application/rss+xml, application/atom+xml, application/json, text/xml, */*',
  'user-agent': `${SITE_NAME}/1.0 (+${SITE_ORIGIN})`,
};

export function canonicalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    // `new URL('javascript:alert(1)')` parses fine. The result is rendered as
    // the card's href, so anything but http(s) is dropped here — the caller
    // already skips articles with an empty url.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    for (const key of [...url.searchParams.keys()]) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.startsWith('utm_') ||
        ['fbclid', 'gclid', 'ref', 'referrer'].includes(normalizedKey)
      ) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return value.trim();
  }
}

async function fingerprintFor(title: string, description: string, url: string): Promise<string> {
  const parsed = new URL(url);
  const input = `${title.trim().toLowerCase()}\n${description.trim().slice(0, 240).toLowerCase()}\n${parsed.hostname}${parsed.pathname}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchWithRetry(url: string, headers: Record<string, string>): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (r.ok || (r.status < 500 && r.status !== 429)) return r;
      if (attempt === 2) return r;
    } catch (e) {
      if (attempt === 2) throw e;
    }
    await sleep(500 * (attempt + 1));
  }
  throw new Error('feed fetch failed');
}

/** Fetch one source and reduce it to the items this tick may consider.
 *
 *  The order is window-then-cap, and both halves are load-bearing. Several
 *  publishers ship their whole archive (openai.com/news returns 1247 items), so
 *  without the window the first tick stores years of history; without the cap a
 *  single source can still hand the curator a thousand stories it is never going
 *  to get through. Capping before the window would just slice the archive.
 *
 *  Undated items are stamped with `fetchedAt` by `parseRss`, so they pass the
 *  window rather than being dropped. */
async function readSource(
  source: FeedSource,
  fetchedAt: number,
): Promise<{ items: Omit<RawArticle, 'canonicalUrl' | 'fingerprint'>[]; trimmed: number }> {
  const response = await fetchWithRetry(source.url, RSS_HEADERS);
  if (!response.ok) throw new Error(`${source.name} returned ${response.status}`);
  const parsed = parseRss(await response.text(), source, fetchedAt);
  const fresh = parsed
    .filter((item) => item.publishedAt >= fetchedAt - INGEST_MAX_AGE_MS)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, source.maxItems);
  return { items: fresh, trimmed: parsed.length - fresh.length };
}

async function normalizeArticles(
  source: FeedSource,
  articles: Omit<RawArticle, 'canonicalUrl' | 'fingerprint'>[],
): Promise<RawArticle[]> {
  const normalized: RawArticle[] = [];
  const seenUrls = new Set<string>();
  const seenFingerprints = new Set<string>();
  for (const article of articles) {
    const canonicalUrl = canonicalizeUrl(article.url);
    if (!canonicalUrl) continue;
    let fingerprint: string;
    try {
      fingerprint = await fingerprintFor(article.title, article.description, canonicalUrl);
    } catch {
      continue;
    }
    if (seenUrls.has(canonicalUrl) || seenFingerprints.has(fingerprint)) continue;
    seenUrls.add(canonicalUrl);
    seenFingerprints.add(fingerprint);
    normalized.push({ ...article, sourceId: source.id, canonicalUrl, fingerprint });
  }
  return normalized;
}

async function ensureSources(db: D1Database): Promise<void> {
  const now = Date.now();
  await db.batch(
    FEED_SOURCES.map((source) =>
      db
        .prepare(
          `INSERT INTO sources (id, kind, name, url, authority_score, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind,
             name = excluded.name,
             url = excluded.url,
             authority_score = excluded.authority_score,
             updated_at = excluded.updated_at`,
        )
        .bind(
          source.id,
          source.kind,
          source.name,
          source.url,
          source.authorityScore,
          source.defaultEnabled ? 1 : 0,
          now,
          now,
        ),
    ),
  );
}

async function enabledSources(db: D1Database): Promise<FeedSource[]> {
  const result = await db
    .prepare('SELECT id FROM sources WHERE enabled = 1')
    .all<{ id: unknown }>();
  const enabled = new Set(
    (result.results ?? []).map((row) => (typeof row.id === 'string' ? row.id : '')).filter(Boolean),
  );
  return FEED_SOURCES.filter((source) => enabled.has(source.id));
}

async function knownColumn(
  db: D1Database,
  column: 'fingerprint' | 'canonical_url',
  values: string[],
): Promise<Set<string>> {
  const known = new Set<string>();
  for (let offset = 0; offset < values.length; offset += KNOWN_COLUMN_CHUNK) {
    const chunk = values.slice(offset, offset + KNOWN_COLUMN_CHUNK);
    const result = await db
      .prepare(
        `SELECT ${column} FROM articles WHERE ${column} IN (${chunk.map(() => '?').join(',')})`,
      )
      .bind(...chunk)
      .all<Record<string, unknown>>();
    for (const row of result.results ?? []) {
      const value = row[column];
      if (typeof value === 'string') known.add(value);
    }
  }
  return known;
}

/** Drop fingerprints already in `articles` so a tick only stores new work. */
export async function knownFingerprints(
  db: D1Database,
  fingerprints: string[],
): Promise<Set<string>> {
  return knownColumn(db, 'fingerprint', fingerprints);
}

/** Drop canonical URLs already stored so a rewritten headline on the same URL
 *  isn't stored again. Fingerprint includes the title, so a headline change
 *  looks like a new story; without this the INSERT would collide on the URL. */
export async function knownCanonicalUrls(db: D1Database, urls: string[]): Promise<Set<string>> {
  return knownColumn(db, 'canonical_url', urls);
}

/** Find candidates whose normalized title already belongs to another source.
 *  A same-source title match is allowed: one curated source can legitimately
 *  contain distinct links titled "Home" or "C++". */
async function knownCrossSourceTitles(
  db: D1Database,
  articles: RawArticle[],
): Promise<Set<string>> {
  const titles = [...new Set(articles.map((article) => normalizeTitle(article.title)))];
  const sourceIdsByTitle = new Map<string, Set<string>>();
  for (let offset = 0; offset < titles.length; offset += KNOWN_COLUMN_CHUNK) {
    const chunk = titles.slice(offset, offset + KNOWN_COLUMN_CHUNK);
    const result = await db
      .prepare(
        `SELECT title_norm, source_id FROM articles WHERE title_norm IN (${chunk.map(() => '?').join(',')})`,
      )
      .bind(...chunk)
      .all<{ title_norm: unknown; source_id: unknown }>();
    for (const row of result.results ?? []) {
      if (typeof row.title_norm !== 'string' || typeof row.source_id !== 'string') continue;
      const sourceIds = sourceIdsByTitle.get(row.title_norm) ?? new Set<string>();
      sourceIds.add(row.source_id);
      sourceIdsByTitle.set(row.title_norm, sourceIds);
    }
  }

  const blocked = new Set<string>();
  for (const article of articles) {
    const title = normalizeTitle(article.title);
    const sourceIds = sourceIdsByTitle.get(title);
    if (sourceIds && (sourceIds.size > 1 || !sourceIds.has(article.sourceId))) {
      blocked.add(`${article.sourceId}\u0000${title}`);
    }
  }
  return blocked;
}

interface IngestReport {
  sources: number;
  fetched: number;
  /** Parsed items dropped by the freshness window or the per-source cap before
   *  any dedupe ran. Worth reporting: a publisher switching to a full-archive
   *  feed shows up here as a jump, not as a silently longer tick. */
  trimmed: number;
  /** Already stored or deduplicated, so never written again. */
  skipped: number;
  /** Newly normalized and stored in this tick. */
  stored: number;
  /** Fetched items whose *publisher* category is not a registry value. Since
   *  the curator assigns the stored category from the story text, this is a
   *  publisher-taxonomy signal, not a hole in the board — the scheduled handler
   *  logs it at info level for that reason. */
  uncategorized: number;
  /** Distinct raw publisher categories behind `uncategorized`, so a taxonomy
   *  drift upstream is diagnosable from the log instead of only countable. */
  unmappedCategories: string[];
  failed: string[];
}

/** Fetch every source, drop stored duplicates, then persist the survivors in
 *  one scheduled handler pass. A failed article is not stored, so the next tick
 *  re-fetches it. */
export async function ingestAllSources(env: Env, _ctx?: ExecutionContext): Promise<IngestReport> {
  if (!env.DB) throw new Error('D1 binding is required');
  await ensureSources(env.DB);
  const sources = await enabledSources(env.DB);

  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        const { items, trimmed } = await readSource(source, Date.now());
        const articles = await normalizeArticles(source, items);
        return { source, articles, trimmed, error: '' };
      } catch (error) {
        console.error(`[ingest] ${source.id} failed:`, error);
        return { source, articles: [], trimmed: 0, error: source.id };
      }
    }),
  );

  const fetched = results.flatMap((result) => result.articles);
  const unmapped = fetched.filter((article) => !canonicalCategory(article.category));
  const unmappedCategories = [
    ...new Set(unmapped.map((article) => article.category ?? '(none)')),
  ].sort();
  const [known, knownUrls] = await Promise.all([
    knownFingerprints(
      env.DB,
      fetched.map((article) => article.fingerprint),
    ),
    knownCanonicalUrls(
      env.DB,
      fetched.map((article) => article.canonicalUrl),
    ),
  ]);
  let articles = fetched.filter(
    (article) => !known.has(article.fingerprint) && !knownUrls.has(article.canonicalUrl),
  );

  // Cross-source dedup: the same story syndicated across outlets has a
  // different fingerprint (hostname is part of it), so drop by normalized
  // title. Keep same-source title collisions because a title alone does not
  // prove two links are the same story. First cross-source occurrence wins —
  // FEED_SOURCES order puts high-authority outlets first.
  const firstSourceByTitle = new Map<string, string>();
  articles = articles.filter((article) => {
    const title = normalizeTitle(article.title);
    const firstSource = firstSourceByTitle.get(title);
    if (!firstSource) {
      firstSourceByTitle.set(title, article.sourceId);
      return true;
    }
    return firstSource === article.sourceId;
  });
  const storedTitles = await knownCrossSourceTitles(env.DB, articles);
  articles = articles.filter(
    (article) => !storedTitles.has(`${article.sourceId}\u0000${normalizeTitle(article.title)}`),
  );

  let stored = 0;
  // A row the insert itself discarded (a conflict the pre-filters could not see)
  // is a duplicate, not a store — counting it as stored overstated every tick.
  let conflicted = 0;
  for (const article of articles) {
    try {
      if (await storeArticle(env, article)) stored += 1;
      else conflicted += 1;
    } catch (error) {
      console.error(`[ingest] ${article.sourceId} store failed:`, error);
    }
  }

  return {
    sources: sources.length,
    fetched: fetched.length,
    trimmed: results.reduce((sum, result) => sum + result.trimmed, 0),
    skipped: fetched.length - articles.length + conflicted,
    stored,
    uncategorized: unmapped.length,
    unmappedCategories,
    failed: results.map((result) => result.error).filter(Boolean),
  };
}

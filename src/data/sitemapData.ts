import { CATEGORIES } from '../categories';
import { type Env, runCached } from './cache';
import { type CountRow, rowNumber, rowString } from './exploreArticle';

interface SitemapNewsHub {
  category: string;
  /** Newest published article in that hub, as an ISO 8601 instant. */
  lastmod: string;
}

export interface SitemapData {
  hubs: SitemapNewsHub[];
  /** The lookup failed rather than finding nothing. A sitemap with no hubs is a
   *  claim about the site — "there is nothing here" — and answering a D1 outage
   *  that way hands crawlers an empty document to believe. */
  unavailable?: boolean;
}

/** Category hubs for the sitemap, derived from D1.
 *
 *  The site is a link feed: readers go straight to the source, so hubs are the
 *  only pages worth crawling — the per-link summary pages are gone. Degrades to
 *  an empty list — a sitemap missing hubs is survivable; a 500 on /sitemap.xml
 *  is not. */
export async function getSitemapNews(env: Env, ctx: ExecutionContext): Promise<SitemapData> {
  try {
    const response = await runCached(
      'sitemap:news:v3',
      async () => {
        if (!env.DB) throw new Error('D1 binding is required');
        const hubs = await env.DB.prepare(
          `SELECT category AS value, MAX(published_at) AS count
             FROM articles
            WHERE status = 'published' AND is_on_topic = 1
              AND category IS NOT NULL
            GROUP BY category`,
        ).all<CountRow>();
        return JSON.stringify({ hubs: hubs.results ?? [] });
      },
      3600,
      86400,
      env,
      ctx,
    );
    if (!response.ok) return { hubs: [], unavailable: true };
    const raw = (await response.json()) as { hubs: CountRow[] };
    const hubs: SitemapNewsHub[] = raw.hubs
      .map((row) => ({ category: rowString(row.value), newest: rowNumber(row.count) }))
      .filter((row) => Object.hasOwn(CATEGORIES, row.category) && row.newest > 0)
      .map((row) => ({ category: row.category, lastmod: new Date(row.newest).toISOString() }));
    return { hubs };
  } catch (error) {
    console.error('[data] sitemap lookup failed:', error);
    return { hubs: [], unavailable: true };
  }
}

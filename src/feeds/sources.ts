import type { FeedSource } from './types';

/** Items older than this never enter the corpus.
 *
 *  The window exists because several publishers ship their entire archive in the
 *  feed: probed on 2026-10-06, `openai.com/news` returned 1247 items and
 *  `huggingface.co/blog` 874. Without it, the first tick after this pipeline
 *  shipped would insert years of history, and the curator — capped per tick by
 *  design — would spend days working through the backlog while the board stayed
 *  stale. Seven days is this desk's latency budget: at a 15-minute cron, a story
 *  older than a week is no longer "latest".
 *
 *  An item whose date does not parse is stamped with the fetch time by
 *  `parseRss`, so it passes the window rather than being dropped silently. */
export const INGEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Sources for a discovery desk: useful products, design, software craft and AI.
 *
 * Measured with the real parseRss and the ingest user agent on 2026-10-19.
 * Window first, cap second; the caps also keep launch feeds and vendor blogs
 * from dominating quieter editorial sources. Order is editorial authority and
 * determines which source wins cross-source deduplication.
 *
 * Source retirement only removes an entry here: existing stories and the D1
 * enabled override are preserved. Poche is a taste reference, not an upstream.
 * Codrops returned 403, Figma's candidate feed returned 404, and the current
 * DeepMind feed carried no teaser text for the curator, so none is registered.
 */
const FEED_SOURCE_DEFS: FeedSource[] = [
  {
    // 30 parsed, 18 within a week, median 2068 characters.
    id: 'simon-willison',
    kind: 'rss',
    name: 'Simon Willison',
    url: 'https://simonwillison.net/atom/everything/',
    authorityScore: 92,
    defaultEnabled: true,
    maxItems: 15,
  },
  {
    // 10 parsed, 6 fresh, median 263 characters.
    id: 'github-blog',
    kind: 'rss',
    name: 'GitHub Blog',
    url: 'https://github.blog/feed/',
    authorityScore: 90,
    defaultEnabled: true,
    maxItems: 10,
  },
  {
    // 20 parsed, 9 fresh, median 195 characters; all fresh items have images.
    id: 'cloudflare-blog',
    kind: 'rss',
    name: 'Cloudflare Blog',
    url: 'https://blog.cloudflare.com/rss/',
    authorityScore: 90,
    defaultEnabled: true,
    maxItems: 10,
  },
  {
    // 1299 parsed, 12 fresh, median 140 characters: apply the window before cap.
    id: 'openai-news',
    kind: 'rss',
    name: 'OpenAI News',
    url: 'https://openai.com/news/rss.xml',
    authorityScore: 88,
    defaultEnabled: true,
    maxItems: 10,
  },
  {
    // 18 parsed, 11 fresh, median 361 characters; hardware is a supporting beat.
    id: 'nvidia-blog',
    kind: 'rss',
    name: 'NVIDIA Blog',
    url: 'https://blogs.nvidia.com/feed/',
    authorityScore: 88,
    defaultEnabled: true,
    maxItems: 5,
  },
  {
    // 30 parsed, 4 fresh, median 827 characters.
    id: 'martin-fowler',
    kind: 'rss',
    name: 'Martin Fowler',
    url: 'https://martinfowler.com/feed.atom',
    authorityScore: 88,
    defaultEnabled: true,
    maxItems: 6,
  },
  {
    // 1683 parsed, 31 fresh, median 1465 characters: another archive-sized feed.
    id: 'vercel-blog',
    kind: 'rss',
    name: 'Vercel Blog',
    url: 'https://vercel.com/atom',
    authorityScore: 86,
    defaultEnabled: true,
    maxItems: 10,
  },
  {
    // 20 parsed and fresh, median 105 characters; individual curated links.
    id: 'sidebar',
    kind: 'rss',
    name: 'Sidebar',
    url: 'https://sidebar.io/feed.xml',
    authorityScore: 85,
    defaultEnabled: true,
    maxItems: 15,
  },
  {
    // 40 parsed, 1 fresh, 200 characters with an image.
    id: 'smashing-magazine',
    kind: 'rss',
    name: 'Smashing Magazine',
    url: 'https://www.smashingmagazine.com/feed/',
    authorityScore: 84,
    defaultEnabled: true,
    maxItems: 8,
  },
  {
    // 50 parsed, 40 fresh, median 323 characters. Launch copy is a candidate,
    // not a recommendation: the curator must reject thin promotional entries.
    id: 'product-hunt',
    kind: 'rss',
    name: 'Product Hunt',
    url: 'https://www.producthunt.com/feed',
    authorityScore: 75,
    defaultEnabled: true,
    maxItems: 8,
  },
];

export const FEED_SOURCES = [...FEED_SOURCE_DEFS] satisfies FeedSource[];

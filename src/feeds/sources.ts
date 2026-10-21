import type { FeedSource } from './types';

/** Items older than this never enter the corpus.
 *
 *  The window exists because several publishers ship their entire archive in the
 *  feed: probed on 2026-10-06, `openai.com/news` returned 1247 items and
 *  `huggingface.co/blog` 874. Without it, the first tick after this pipeline
 *  shipped would insert years of history. Seven days is this desk's latency budget: at a 15-minute cron, a story
 *  older than a week is no longer "latest".
 *
 *  An item whose date does not parse is stamped with the fetch time by
 *  `parseRss`, so it passes the window rather than being dropped silently. */
export const INGEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The desk's single upstream: Poche Explore, already curated by its community.
 *  Its categories ride in each item's `· Category` footer, which `parseRss` reads.
 *  Measured on 2026-10-20: 50 items, newest first. */
const FEED_SOURCE_DEFS: FeedSource[] = [
  {
    id: 'poche-explore',
    kind: 'rss',
    name: 'Poche Explore',
    url: 'https://poche.app/explore/rss',
    maxItems: 50,
  },
];

export const FEED_SOURCES = [...FEED_SOURCE_DEFS] satisfies FeedSource[];

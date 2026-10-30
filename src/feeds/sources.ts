/** The desk's single upstream: Poche Explore, already curated by its community.
 *  Its categories ride in each item's `· Category` footer, which `parseRss` reads.
 *  Measured on 2026-10-20: 50 items, newest first.
 *
 *  `maxItems` is a guard, not a page size: some feeds ship their whole archive
 *  (openai.com/news returned 1247 items when the desk was built), and the whole
 *  parsed feed becomes one KV entry, so the snapshot keeps the newest N. */
export const POCHE_FEED = {
  name: 'Poche Explore',
  url: 'https://poche.app/explore/rss',
  maxItems: 50,
} as const;

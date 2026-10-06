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

/** The desk's sources.
 *
 *  Every URL here was probed with the real parser before it was registered
 *  (`bun run feeds:probe`, which reads this list) — the checks are liveness,
 *  items that actually parse, enough text per item for the curator to judge,
 *  and recent publication. Order matters twice over: it is the authority order
 *  cross-source dedupe resolves in (`ingestAllSources` keeps the first source
 *  to claim a title), and the order the rail's counts are read in.
 *
 *  `maxItems` is the per-tick cap after the freshness window. It is measured,
 *  not guessed: the item counts in the comments are what each feed returned on
 *  2026-10-06, and the cap is set to the newest slice that keeps a tick's
 *  ingestion bounded (worst case here is ~235 items across all sources, most of
 *  which are already stored, so a tick writes a handful of rows).
 *
 *  Deliberately NOT registered, with the reason measured:
 *   - `videocardz.com/feed`, `hpcwire.com/feed` — HTTP 403 to our user agent.
 *   - `blog.google/technology/ai/rss` — no response inside 15s.
 *   - `export.arxiv.org/rss/cs.AR` — RSS 1.0/RDF; `parseRss` (regex, RSS 2.0 /
 *     Atom shaped) extracts 0 items from it.
 *   - `huggingface.co/blog/feed.xml`, `nextplatform.com/feed` — median item text
 *     0 characters, so the curator would be judging `(none)`.
 *   - `hexus.net/rss`, `tftcentral.co.uk/feed` — parsed fine but nothing
 *     published in the last 7 days: zombie feeds.
 *   - `keyboard-newswire.com`, `kbd.news`, `reddit.com/r/MechanicalKeyboards` —
 *     off-beat for an AI-hardware desk (peripherals-only), kept out rather than
 *     relied on to be filtered after paying for them. */
const FEED_SOURCE_DEFS: FeedSource[] = [
  {
    // 50 items, 148 median chars, publisher category on every item.
    id: 'toms-hardware',
    kind: 'rss',
    name: "Tom's Hardware",
    url: 'https://www.tomshardware.com/feeds.xml',
    authorityScore: 92,
    defaultEnabled: true,
    maxItems: 30,
  },
  {
    // 111 items, 1164 median chars — the richest text of any source here.
    id: 'techpowerup-news',
    kind: 'rss',
    name: 'TechPowerUp News',
    url: 'https://www.techpowerup.com/rss/news',
    authorityScore: 90,
    defaultEnabled: true,
    maxItems: 30,
  },
  {
    // Vendor primary source; 18 items, 373 median chars.
    id: 'nvidia-blog',
    kind: 'rss',
    name: 'NVIDIA Blog',
    url: 'https://blogs.nvidia.com/feed/',
    authorityScore: 90,
    defaultEnabled: true,
    maxItems: 15,
  },
  {
    // 50 items, 291 median chars, all with images.
    id: 'techpowerup-reviews',
    kind: 'rss',
    name: 'TechPowerUp Reviews',
    url: 'https://www.techpowerup.com/rss/reviews',
    authorityScore: 88,
    defaultEnabled: true,
    maxItems: 15,
  },
  {
    // 1247 items — the archive case the freshness window and cap exist for.
    id: 'openai-news',
    kind: 'rss',
    name: 'OpenAI News',
    url: 'https://openai.com/news/rss.xml',
    authorityScore: 88,
    defaultEnabled: true,
    maxItems: 20,
  },
  {
    // 100 items, 95 median chars: thin, so the cap is small too.
    id: 'deepmind-blog',
    kind: 'rss',
    name: 'Google DeepMind',
    url: 'https://deepmind.google/blog/rss.xml',
    authorityScore: 88,
    defaultEnabled: true,
    maxItems: 15,
  },
  {
    // 10 items, 531 median chars; the chip-industry beat others do not cover.
    id: 'semiengineering',
    kind: 'rss',
    name: 'Semiconductor Engineering',
    url: 'https://semiengineering.com/feed/',
    authorityScore: 87,
    defaultEnabled: true,
    maxItems: 15,
  },
  {
    // 6 items, 242 median chars: a small but well-targeted server/NAS feed.
    id: 'servethehome',
    kind: 'rss',
    name: 'ServeTheHome',
    url: 'https://www.servethehome.com/feed/',
    authorityScore: 86,
    defaultEnabled: true,
    maxItems: 10,
  },
  {
    // 20 items, 217 median chars, no images: text-only but on-beat.
    id: 'guru3d',
    kind: 'rss',
    name: 'Guru3D',
    url: 'https://www.guru3d.com/rss.xml',
    authorityScore: 85,
    defaultEnabled: true,
    maxItems: 20,
  },
  {
    // 30 items, 331 median chars.
    id: 'kitguru',
    kind: 'rss',
    name: 'KitGuru',
    url: 'https://www.kitguru.net/feed/',
    authorityScore: 85,
    defaultEnabled: true,
    maxItems: 25,
  },
  {
    // 10 items, 346 median chars. Broad on purpose: the curator filters, and a
    // desktop-relevant Verge story is one the hardware feeds miss.
    id: 'theverge',
    kind: 'rss',
    name: 'The Verge',
    url: 'https://www.theverge.com/rss/index.xml',
    authorityScore: 82,
    defaultEnabled: true,
    maxItems: 20,
  },
  {
    // 20 items, 607 median chars, largely leaks — hence the low authority and
    // the small cap, not exclusion: a leak is a real story, just a cheap one.
    id: 'wccftech',
    kind: 'rss',
    name: 'Wccftech',
    url: 'https://wccftech.com/feed/',
    authorityScore: 78,
    defaultEnabled: true,
    maxItems: 20,
  },
];

export const FEED_SOURCES = [...FEED_SOURCE_DEFS] satisfies FeedSource[];

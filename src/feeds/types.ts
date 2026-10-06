type FeedSourceKind = 'rss';

export interface FeedSource {
  id: string;
  kind: FeedSourceKind;
  name: string;
  url: string;
  authorityScore: number;
  defaultEnabled: boolean;
  /** Newest-N cap applied per tick, after the freshness window. Several
   *  publishers ship their whole archive in the feed — openai.com/news returns
   *  1247 items — and without a cap the first tick stores the archive while the
   *  curator's per-tick budget is spent on old stories. Measured per source with
   *  `scripts/feed-probe.ts`. */
  maxItems: number;
}

// Ingest messages are deliberately plain data — they cross the Worker boundary
// and must remain structured-clone serializable.
export interface RawArticle {
  sourceId: string;
  sourceName: string;
  sourceAuthority: number;
  category: string | null;
  title: string;
  description: string;
  url: string;
  canonicalUrl: string;
  imageUrl: string;
  imageWidth: number; // 0 when unknown
  imageHeight: number; // 0 when unknown
  publishedAt: number;
  fetchedAt: number;
  fingerprint: string;
}

/** Story shapes the curator may assign. Kept narrow on purpose: an open list
 *  makes the card's own vocabulary meaningless, and `article_type` is stored. */
export const ARTICLE_TYPES = [
  'news',
  'review',
  'deal',
  'leak',
  'analysis',
  'guide',
  'video',
] as const;

export type ArticleType = (typeof ARTICLE_TYPES)[number];

/** What the model returns for one story, after validation. Every field maps to
 *  a column that already exists in `articles`/`article_tags`; nothing here is
 *  invented for the pipeline's convenience. */
export interface ArticleEnrichment {
  /** false means the curator judged the story off-beat: stored as `filtered`,
   *  never shown. The desk's feeds are broad (The Verge, TechCrunch publish EVs
   *  and game studios), so this is the gate that keeps the board on-beat. */
  isOnTopic: boolean;
  /** A key from CURATOR_CATEGORY_KEYS, or '' for cross-beat stories. */
  category: string;
  articleType: ArticleType;
  tags: string[];
  /** One factual sentence, ≤280 chars. */
  summary: string;
  /** Editorial blurb, ≤700 chars — what the card actually renders
   *  (`articleDeck`: blurb → summary → description). */
  blurb: string;
  /** Editorial quality of THIS story, 0–100: the card's 2px signal meter. */
  qualityScore: number;
}

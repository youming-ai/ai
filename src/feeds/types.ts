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
   *  1247 items — and without a cap the first tick stores the archive. Measured per source with
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

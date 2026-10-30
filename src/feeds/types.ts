/** One item as `parseRss` reads it off the feed, before URL canonicalisation
 *  and before it becomes an `ExploreArticle`. */
export interface FeedItem {
  /** The publisher's raw category label, lower-cased; null when absent. */
  category: string | null;
  title: string;
  description: string;
  url: string;
  imageUrl: string;
  imageWidth: number; // 0 when unknown
  imageHeight: number; // 0 when unknown
  publishedAt: number;
}

// --- Explore content (the Poche snapshot in KV) ---

export interface ExploreArticle {
  id: string;
  title: string;
  description: string;
  url: string;
  imageUrl: string;
  /** True when `imageUrl` is a playable video rather than an image. Judged on
   *  the URL as the feed delivered it, before the /media rewrite — that rewrite
   *  can strip the extension the judgement depends on. */
  isVideo: boolean;
  imageWidth: number; // 0 when the feed gave no dimensions
  imageHeight: number;
  sourceDomain: string;
  publishedAt: number;
  /** Canonical category key from src/categories.ts, null when unattributed. */
  category: string | null;
}

export interface ExploreFeed {
  items: ExploreArticle[];
  /** Opaque; pass back as `cursor` for the next page. null when exhausted. */
  nextCursor: string | null;
  /** Set by the SSR composer when the feed could not be read at all, so the
   *  page can say so rather than blaming the reader's filters. Never part of
   *  the API payload. */
  unavailable?: boolean;
}

export interface ExploreFilterOption {
  value: string;
  label: string;
  /** `null` when the counts could not be read. An outage must not render as a
   *  confident zero — the rail still links to the hub. */
  count: number | null;
}

export interface ExploreFilterSet {
  categories: ExploreFilterOption[];
  /** Every link the board can show, which is not the sum of the per-category
   *  counts: a link whose publisher category is not in the registry has
   *  `category: null`, so it appears on the global board and in no hub.
   *  `null` means the count could not be read. */
  total?: number | null;
}

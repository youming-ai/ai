import { canonicalCategory } from '../categories';
import { isVideoMediaUrl, proxiedImageUrl } from '../media';
import { CRAWLER_USER_AGENT } from '../site';
import type { ExploreArticle } from '../types';
import { parseRss } from './rss';
import { POCHE_FEED } from './sources';
import type { FeedItem } from './types';

// The publisher sees this, so it names the site the reader would reach; the
// string itself lives in src/site.ts, shared with the probes in scripts/.
export const RSS_HEADERS = {
  accept: 'application/rss+xml, application/atom+xml, application/json, text/xml, */*',
  'user-agent': CRAWLER_USER_AGENT,
};

/** One attempt, bounded. The fetch runs on a reader's request when the KV
 *  snapshot has gone stale, so a retry loop would be paid by that reader; a
 *  failure serves the stale snapshot instead, and the next request tries again. */
const FETCH_TIMEOUT_MS = 8_000;

export function canonicalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    // `new URL('javascript:alert(1)')` parses fine. The result is rendered as
    // the card's href, so anything but http(s) is dropped here — the caller
    // skips articles with an empty url.
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
    return '';
  }
}

/** Stable identity for a link: SHA-256 of its canonical URL. It is the RSS
 *  `<guid>` and the cursor's tiebreak, so it must not change while the link
 *  stays in the feed — the URL is the one field Poche never rewrites. */
async function articleId(canonicalUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalUrl));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function exploreArticle(item: FeedItem, id: string, url: string): ExploreArticle {
  return {
    id,
    title: item.title,
    description: item.description,
    url,
    // Upstream-hosted images are rewritten to /media so the feed's own CDN
    // origin never reaches markup, the payload, or og:image.
    imageUrl: proxiedImageUrl(item.imageUrl),
    // Judged on the URL as the feed delivered it — the /media rewrite can strip
    // the extension the check depends on.
    isVideo: isVideoMediaUrl(item.imageUrl),
    imageWidth: item.imageWidth,
    imageHeight: item.imageHeight,
    sourceDomain: sourceDomain(url),
    publishedAt: item.publishedAt,
    category: canonicalCategory(item.category),
  };
}

/** Parsed items → the board's corpus: canonical http(s) URLs only, one entry
 *  per URL, newest first (ties broken by id, the cursor's order), capped. */
export async function toExploreArticles(
  items: FeedItem[],
  maxItems: number,
): Promise<ExploreArticle[]> {
  const seen = new Set<string>();
  const articles: ExploreArticle[] = [];
  for (const item of items) {
    const url = canonicalizeUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    articles.push(exploreArticle(item, await articleId(url), url));
  }
  articles.sort((a, b) => b.publishedAt - a.publishedAt || (a.id < b.id ? 1 : -1));
  return articles.slice(0, maxItems);
}

/** Fetch Poche Explore and return the whole board, newest first.
 *
 *  Throws rather than returning nothing: the caller caches what this returns,
 *  so an empty parse — Poche restyling its feed, an HTML error page with a 200
 *  — must not replace a good snapshot with an empty board. */
export async function fetchPocheFeed(): Promise<ExploreArticle[]> {
  const response = await fetch(POCHE_FEED.url, {
    headers: RSS_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${POCHE_FEED.name} returned ${response.status}`);
  const articles = await toExploreArticles(parseRss(await response.text()), POCHE_FEED.maxItems);
  if (articles.length === 0) throw new Error(`${POCHE_FEED.name} parsed to no items`);
  return articles;
}

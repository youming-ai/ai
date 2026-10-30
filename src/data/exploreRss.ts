// RSS 2.0 renderer for the Explore feed. Pure: no DOM, no KV, no Worker
// bindings — importable by both the API handler and the SSR pages.
import {
  GLOBAL_FEED_LABEL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_RSS_LANGUAGE,
  SITE_TITLE,
} from '../site';
import type { ExploreArticle, ExploreFeed } from '../types';
import { escapeXml } from '../utils/coerce';

// Bound to the `atom:` prefix; the only Atom element is <atom:link rel="self">.
const ATOM_XMLNS = 'http://www.w3.org/2005/Atom';

// RFC 822 with explicit `GMT` — some readers ignore <pubDate> quietly, and an
// omit-zone date string fails to parse elsewhere.
function rfc822(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  return new Date(timestamp).toUTCString();
}

function categoriesFor(article: ExploreArticle): string[] {
  const categories: string[] = [];
  if (article.category) categories.push(`category:${article.category}`);
  if (article.sourceDomain) categories.push(`source:${article.sourceDomain}`);
  return categories;
}

function renderItem(article: ExploreArticle): string {
  const parts = [
    '    <item>',
    `      <title>${escapeXml(article.title)}</title>`,
    `      <link>${escapeXml(article.url)}</link>`,
    // isPermaLink=false: the article *id* (a hash of the canonical URL) is
    // the stable identity.
    `      <guid isPermaLink="false">${escapeXml(article.id)}</guid>`,
    `      <pubDate>${rfc822(article.publishedAt)}</pubDate>`,
  ];
  // Plain text after parseRss, so XML-escaping is sufficient.
  const description = article.description;
  if (description) parts.push(`      <description>${escapeXml(description)}</description>`);
  // <author> is specified as an email address; the publisher's domain is all
  // we can honestly put in it.
  const fallbackHost = (() => {
    try {
      return new URL(SITE_ORIGIN).hostname;
    } catch {
      return 'example.com';
    }
  })();
  parts.push(`      <author>noreply@${escapeXml(article.sourceDomain || fallbackHost)}</author>`);
  for (const category of categoriesFor(article)) {
    parts.push(`      <category>${escapeXml(category)}</category>`);
  }
  parts.push('    </item>');
  return parts.join('\n');
}

/** Render an `ExploreFeed` as an RSS 2.0 document. `scopeLabel` is 'All
 *  links' for the global feed, a category label for a hub feed.
 *  `channelLink` lets the per-category feed jump a reader into the matching
 *  hub. */
export function renderExploreRss(
  feed: ExploreFeed,
  scopeLabel: string,
  options: { includeAtomSelfLink?: string; channelLink?: string } = {},
): string {
  const channelTitle =
    scopeLabel === GLOBAL_FEED_LABEL ? SITE_TITLE : `${SITE_NAME} — ${scopeLabel} links`;
  const channelLink = options.channelLink ?? `${SITE_ORIGIN}/`;
  const channelDescription = SITE_DESCRIPTION;
  const published = new Date().toUTCString();
  const items = feed.items.map(renderItem).join('\n');
  const atomLink = options.includeAtomSelfLink
    ? `\n    <atom:link href="${escapeXml(options.includeAtomSelfLink)}" rel="self" type="application/rss+xml" />`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="${ATOM_XMLNS}">
  <channel>
    <title>${escapeXml(channelTitle)}</title>
    <link>${escapeXml(channelLink)}</link>
    <description>${escapeXml(channelDescription)}</description>
    <language>${SITE_RSS_LANGUAGE}</language>
    <lastBuildDate>${published}</lastBuildDate>
    <generator>${SITE_NAME}</generator>${atomLink}
${items}
  </channel>
</rss>
`;
}

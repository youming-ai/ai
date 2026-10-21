// Canonical production origin. Single source of truth for absolute URLs
// (canonical/og tags, sitemap <loc>). Pure string — compiles under both
// tsconfigs. TODO(template): replace with your domain.
export const SITE_ORIGIN = 'https://ai.um1ng.me';

// Brand-facing copy. Single source of truth: the layout <title>/description
// defaults and the RSS channel description import from here, so a rebrand
// or positioning change edits one file, not three. The title is the name
// alone; the description says what the desk covers.
export const SITE_NAME = 'AI Desk';
export const SITE_TITLE = SITE_NAME;
/** What every fetch the desk makes calls itself: ingest, and every probe in
 *  scripts/, which must be answered the way ingest is. The product token is the
 *  host rather than SITE_NAME, because a token cannot hold the name's spaces.
 *  Measured against the name-based token it replaced: all 12 sources answered
 *  this string with the same status and item count. */
export const CRAWLER_USER_AGENT = `${new URL(SITE_ORIGIN).host}/1.0 (+${SITE_ORIGIN})`;
export const SITE_DESCRIPTION =
  'Useful tools, thoughtful design, software craft and AI worth exploring — picked by the Poche community for what you can use, learn or make.';

/** Scope label for the global (uncategorised) feed: the rail's All row and the
 *  RSS channel-title marker. Single source of truth so the marker comparison in
 *  exploreRss.ts can't drift. */
export const GLOBAL_FEED_LABEL = 'All links';
/** Reported by /api/health so a deployed Worker can be identified without the
 *  dashboard. Duplicated from package.json, which a Worker cannot import —
 *  `index.css.test.ts` holds the two together, the way retention.cron.test.ts
 *  holds PRUNE_CRON to wrangler.toml. */
export const SITE_VERSION = '0.1.0';

export const SITE_LOCALE = 'en_US';
export const SITE_LANGUAGE = 'en';
/** RSS <language> uses the RFC 1766 tag form, not og:locale's underscore form.
 *  Declared here rather than inline in the renderer so the three spellings of
 *  "this site is English" all come from one file. */
export const SITE_RSS_LANGUAGE = 'en-us';

/** Card-stream teaser policy: blurb first (the curated one-liner), then the
 *  summary, then the publisher's own teaser. The card is the only consumer —
 *  the second mode that existed for the per-link pages went with them. */
export function articleDeck(article: {
  summary?: string;
  blurb?: string;
  description?: string;
}): string {
  return article.blurb || article.summary || article.description || '';
}

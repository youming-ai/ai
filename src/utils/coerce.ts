// Text helpers for the feed parser and the RSS renderer.

/** Shared HTML entity decoder for rss.
 *
 *  Numeric references are attacker-controlled: `String.fromCodePoint` throws a
 *  RangeError for anything outside `0..0x10FFFF`, and one such reference used to
 *  abort the whole parse — every refresh, forever, on the same feed item.
 *  Out-of-range and surrogate code points decode to nothing instead. */
export function decodeEntities(value: string): string {
  const codePoint = (n: number): string =>
    Number.isFinite(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
      ? String.fromCodePoint(n)
      : '';
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&#(\d+);/g, (_m, c: string) => codePoint(Number(c)))
    .replace(/&#x([\da-f]+);/gi, (_m, c: string) => codePoint(Number.parseInt(c, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&[lr]dquo;/g, '"')
    .replace(/&[lr]squo;/g, "'")
    .replace(/&hellip;/g, '\u2026')
    .replace(/&middot;/g, '\u00b7')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Characters XML 1.0 forbids outright: C0 controls other than tab/LF/CR, plus
 *  the two non-characters. A lone surrogate is illegal too. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: naming the characters XML forbids is the point here
const XML_ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;
const LONE_HIGH = /[\ud800-\udbff](?![\udc00-\udfff])/g;
const LONE_LOW = /(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Escape XML special characters for RSS/sitemaps.
 *
 *  Escaping is not enough on its own: a stored title can carry characters that
 *  XML 1.0 cannot represent at all (numeric references decode to them, and JS
 *  `\s` — all `stripHtml` collapses — does not cover most of them). One such
 *  character makes the whole document non-well-formed, so every subscriber
 *  loses the feed. They are dropped here rather than at ingest, because the
 *  stored title and description feed the dedupe fingerprint. */
export function escapeXml(value: string): string {
  return value
    .replace(XML_ILLEGAL, '')
    .replace(LONE_HIGH, '')
    .replace(LONE_LOW, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

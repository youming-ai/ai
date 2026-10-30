// Feed probe: fetch Poche Explore the way the Worker does and run the real
// parser and normaliser over the bytes.
//
//   bun run feeds:probe
//
// The board is whatever this feed parses to, so run it before changing the
// source, the cap, or the parser. It reports liveness, how many items parse,
// how many the board keeps (canonical http(s) URLs, one per URL, capped), how
// much text each carries (the card's deck — a feed with none renders bare
// titles), and how many keep an image and a registry category.
import { canonicalCategory } from '../src/categories';
import { RSS_HEADERS, toExploreArticles } from '../src/feeds/poche';
import { parseRss } from '../src/feeds/rss';
import { POCHE_FEED } from '../src/feeds/sources';

const started = Date.now();
const response = await fetch(POCHE_FEED.url, {
  headers: RSS_HEADERS,
  signal: AbortSignal.timeout(15_000),
});
const text = await response.text();
const parsed = parseRss(text);
const kept = await toExploreArticles(parsed, POCHE_FEED.maxItems);
const lengths = kept.map((article) => article.description.length).sort((a, b) => a - b);
const unmapped = [
  ...new Set(
    parsed.flatMap((item) =>
      item.category && !canonicalCategory(item.category) ? [item.category] : [],
    ),
  ),
];

console.log(`${POCHE_FEED.name}  ${POCHE_FEED.url}`);
console.log(`http        ${response.status} ${response.headers.get('content-type') ?? ''}`);
console.log(`size        ${Math.round(text.length / 1024)} KB in ${Date.now() - started} ms`);
console.log(`parsed      ${parsed.length}`);
console.log(`kept        ${kept.length} (cap ${POCHE_FEED.maxItems})`);
console.log(`median deck ${lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0} chars`);
console.log(`images      ${kept.filter((article) => article.imageUrl).length}`);
console.log(`categorised ${kept.filter((article) => article.category).length}`);
if (unmapped.length > 0)
  console.log(`unmapped    ${unmapped.join(', ')} (add to src/categories.ts)`);
console.log(`newest      ${kept[0]?.title ?? '(none)'}`);

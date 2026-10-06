// Does the publishers' own CDN already resize for free?
//
// The paid resizing entitlement is off the table (see #158), so the remaining
// bytes lever is that most of these hosts ship their own transform parameters.
// That is not something to guess at: this measures it, per host, against the
// live feed — the same URLs ingest would store, resolved through the real
// `parseRss`.
//
// For each host it tries the conventions that host is known to accept and
// reports the smallest response that is still an image and still a 200. A host
// absent from the output does not resize for free, and must keep being served
// 1:1.
//
// Requests are `Range: bytes=0-0`, so this reads Content-Length and one byte
// rather than downloading the corpus.
//
// Run: bun scripts/perf-image-transform-probe.ts
import { parseRss } from '../src/feeds/rss';
import { FEED_SOURCES } from '../src/feeds/sources';
import { SITE_NAME, SITE_ORIGIN } from '../src/site';

const HEADERS = {
  accept: 'application/rss+xml, application/atom+xml, application/json, text/xml, */*',
  'user-agent': `${SITE_NAME}/1.0 (+${SITE_ORIGIN})`,
};

/** The card slot is ~450 CSS px wide in the three-column desktop layout, and at
 *  2x DPR that is 900 physical pixels. Ask for that, not 450, or the board
 *  looks soft on every laptop. */
const TARGET_WIDTH = 900;

/** Parameters each host is documented (or widely observed) to accept. Order
 *  matters only for reporting; the smallest valid response wins. */
const CANDIDATES: Array<{ host: RegExp; params: string[] }> = [
  {
    // Contentful: ?w=&h=&fm=&q=
    host: /(^|\.)ctfassets\.net$/,
    params: [`?w=${TARGET_WIDTH}&fm=webp&q=75`, `?w=${TARGET_WIDTH}&fm=webp`, `?w=${TARGET_WIDTH}`],
  },
  {
    // Sanity: ?w=&fm=&q=. `auto=format` is their own content negotiation.
    host: /(^|\.)sanity\.io$/,
    params: [`?w=${TARGET_WIDTH}&fm=webp&q=75`, `?w=${TARGET_WIDTH}&auto=format`],
  },
  {
    // Vercel's image CDN, used by next/image-backed sites.
    host: /(^|\.)vercel\.com$/,
    params: [`?w=${TARGET_WIDTH}&q=75`, `?w=${TARGET_WIDTH}`],
  },
  {
    // Shopify: ?width=&height=&crop=
    host: /(^|\.)shopify\.com$/,
    params: [
      `?width=${TARGET_WIDTH}`,
      `?width=${TARGET_WIDTH}&height=${Math.round((TARGET_WIDTH * 9) / 16)}`,
    ],
  },
  {
    // Framer's CDN.
    host: /(^|\.)framerusercontent\.com$/,
    params: [`?scale-down-to=${TARGET_WIDTH}`, `?scale-down-to=1024`],
  },
  {
    // Twitter/X media: named variants rather than widths.
    host: /(^|\.)twimg\.com$/,
    params: ['?name=small', '?format=webp&name=small', '?name=medium'],
  },
  {
    // Webflow assets.
    host: /(^|\.)website-files\.com$/,
    params: [`?w=${TARGET_WIDTH}`, `?width=${TARGET_WIDTH}`],
  },
  {
    // Squarespace / generic "w=" conventions.
    host: /(^|\.)squarespace-cdn\.com$/,
    params: [`?format=${TARGET_WIDTH}w`, `?format=1000w`],
  },
  {
    // WordPress (and anything using Jetpack/Photon-style params).
    host: /(^|\.)wp\.com$/,
    params: [`?w=${TARGET_WIDTH}`, `?resize=${TARGET_WIDTH}`],
  },
];

interface Measurement {
  bytes: number;
  type: string;
}

async function measure(url: string): Promise<Measurement | null> {
  try {
    const res = await fetch(url, {
      headers: { ...HEADERS, range: 'bytes=0-0' },
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
    if (!res.ok && res.status !== 206) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0];
    const range = res.headers.get('content-range');
    const bytes = range
      ? Number(range.split('/')[1])
      : Number(res.headers.get('content-length') ?? 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    return { bytes, type };
  } catch {
    return null;
  }
}

const source = FEED_SOURCES[0];
if (!source) {
  console.error('perf-image-transform-probe: no source in the registry');
  process.exit(1);
}
const response = await fetch(source.url, { headers: HEADERS });
if (!response.ok) {
  console.error(`perf-image-transform-probe: feed returned ${response.status}`);
  process.exit(1);
}
const articles = parseRss(await response.text(), source);

// One sample per host keeps this polite: the question is whether the convention
// works for that host, not how every image behaves.
const sampleByHost = new Map<string, string>();
for (const article of articles) {
  if (!article.imageUrl) continue;
  try {
    const host = new URL(article.imageUrl).hostname;
    if (!sampleByHost.has(host)) sampleByHost.set(host, article.imageUrl);
  } catch {
    /* not a URL we can reason about */
  }
}

const kb = (bytes: number): string => `${Math.round(bytes / 1024)} KB`;

// `--all` measures every image in the feed against the rules that a per-host
// sample proved work, which is the number that decides whether a table is worth
// carrying: how much of the corpus and of the fold those hosts actually cover.
const ALL = process.argv.includes('--all');
/** Only rules a sample above actually reduced. Anything else stays untouched. */
const PROVEN = new Map<string, string[]>([
  ['ctfassets.net', [`?w=${TARGET_WIDTH}&fm=webp&q=75`]],
  ['twimg.com', ['?format=webp&name=small']],
  ['shopify.com', [`?width=${TARGET_WIDTH}&height=${Math.round((TARGET_WIDTH * 9) / 16)}`]],
]);

function provenParams(host: string): string[] | null {
  for (const [suffix, params] of PROVEN) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return params;
  }
  return null;
}

if (ALL) {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const article of articles) {
    if (article.imageUrl && !seen.has(article.imageUrl)) {
      seen.add(article.imageUrl);
      unique.push(article.imageUrl);
    }
  }
  let originalTotal = 0;
  let transformedTotal = 0;
  let originalFold = 0;
  let transformedFold = 0;
  let matched = 0;
  for (const [index, url] of unique.entries()) {
    const original = await measure(url);
    if (!original) continue;
    const host = new URL(url).hostname;
    const params = provenParams(host);
    let best = original.bytes;
    if (params) {
      for (const candidate of params) {
        const attempt = await measure(`${url}${candidate}`);
        if (attempt?.type.startsWith('image/') && attempt.bytes < best) {
          best = attempt.bytes;
        }
      }
      if (best < original.bytes) matched += 1;
    }
    originalTotal += original.bytes;
    transformedTotal += best;
    if (index < 10) {
      originalFold += original.bytes;
      transformedFold += best;
    }
  }
  console.log(`\nall ${unique.length} unique images, proven rules only\n`);
  console.log(
    `  whole feed    ${kb(originalTotal)} -> ${kb(transformedTotal)}  (-${Math.round((1 - transformedTotal / originalTotal) * 100)}%)`,
  );
  console.log(
    `  first 10      ${kb(originalFold)} -> ${kb(transformedFold)}  (-${Math.round((1 - transformedFold / originalFold) * 100)}%)`,
  );
  console.log(`  images the rules touch: ${matched} of ${unique.length}\n`);
  process.exit(0);
}
const rows: string[] = [];
let saved = 0;
let total = 0;

for (const [host, url] of sampleByHost) {
  const rule = CANDIDATES.find((c) => c.host.test(host));
  const original = await measure(url);
  if (!original) continue;
  total += original.bytes;

  if (!rule) {
    rows.push(`  ${host.padEnd(30)} ${kb(original.bytes).padStart(8)}   (no known free transform)`);
    continue;
  }

  let best: { bytes: number; params: string } | null = null;
  for (const params of rule.params) {
    const attempt = await measure(`${url}${params}`);
    if (!attempt?.type.startsWith('image/')) continue;
    if (!best || attempt.bytes < best.bytes) best = { bytes: attempt.bytes, params };
  }
  if (best && best.bytes < original.bytes) {
    saved += original.bytes - best.bytes;
    const pct = Math.round((1 - best.bytes / original.bytes) * 100);
    rows.push(
      `  ${host.padEnd(30)} ${kb(original.bytes).padStart(8)} -> ${kb(best.bytes).padStart(7)}  (-${pct}%)  ${best.params}`,
    );
  } else {
    rows.push(
      `  ${host.padEnd(30)} ${kb(original.bytes).padStart(8)}   (no candidate helped${rule ? `: tried ${rule.params.length}` : ''})`,
    );
  }
}

rows.sort();
console.log(`\nfree transform check — ${sampleByHost.size} host(s) sampled at ${TARGET_WIDTH}px\n`);
for (const row of rows) console.log(row);
console.log(
  `\n  one sample per host: ${kb(total)} measured, ${kb(saved)} would be saved by the rows above`,
);
console.log('  (a per-host table is only worth adding where a row shows a reduction)\n');

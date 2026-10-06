// What the board would actually download: audits the live feed's card images.
//
// Why this exists: the render harness seeds a hermetic board of 75KB images so
// that byte counts are stable, but that fixture is two orders of magnitude
// lighter than production. Measured against the live feed, the first screen's
// images alone came to ~9MB — which no amount of client-side tuning fixes, and
// which the hermetic fixture would never have shown.
//
// The extraction is the *real* one: this imports `parseRss`, the same function
// the cron uses, so the audit cannot drift from what ingest stores. Only the
// measurement is new.
//
// Run: bun run perf:images   (needs the network; the feed is external)
import { parseRss } from '../src/feeds/rss';
import { FEED_SOURCES } from '../src/feeds/sources';
import { SITE_NAME, SITE_ORIGIN } from '../src/site';

// Mirrors the headers in src/feeds/ingest.ts, which are module-private there.
// A different UA here would measure a different response than ingest gets.
const HEADERS = {
  accept: 'application/rss+xml, application/atom+xml, application/json, text/xml, */*',
  'user-agent': `${SITE_NAME}/1.0 (+${SITE_ORIGIN})`,
};

/** Content-Length for a URL, via a one-byte ranged GET.
 *  HEAD is not usable: CDNs answer it without a body length often enough that
 *  the first version of this returned zero for every image. */
async function sizeOf(url: string): Promise<{ bytes: number; type: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { ...HEADERS, range: 'bytes=0-0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 206) return null;
    const range = res.headers.get('content-range');
    const bytes = range
      ? Number(range.split('/')[1])
      : Number(res.headers.get('content-length') ?? 0);
    await res.body?.cancel();
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    return { bytes, type: (res.headers.get('content-type') ?? '?').split(';')[0] };
  } catch {
    return null;
  }
}

function format(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

const url = FEED_SOURCES[0] ? FEED_SOURCES[0].url : '';
if (!url) {
  console.error('perf-image-audit: no source in the registry');
  process.exit(1);
}

const res = await fetch(url, { headers: HEADERS });
if (!res.ok) {
  console.error(`perf-image-audit: feed returned ${res.status}`);
  process.exit(1);
}
const articles = parseRss(await res.text(), FEED_SOURCES[0]!);

// Dedupe in feed order: the first screen is the first N items, so order matters.
const seen = new Set<string>();
const ordered = articles.filter((a) => {
  if (!a.imageUrl || seen.has(a.imageUrl)) return false;
  seen.add(a.imageUrl);
  return true;
});

const measured: Array<{ bytes: number; type: string; host: string; url: string }> = [];
for (const article of ordered) {
  const size = await sizeOf(article.imageUrl);
  if (size)
    measured.push({ ...size, host: new URL(article.imageUrl).hostname, url: article.imageUrl });
}

if (measured.length === 0) {
  console.error('perf-image-audit: no image resolved — network, or the feed changed shape');
  process.exit(1);
}

const sorted = [...measured].sort((a, b) => b.bytes - a.bytes);
const total = measured.reduce((sum, m) => sum + m.bytes, 0);
const over = (n: number) => sorted.filter((m) => m.bytes > n).length;
const types = measured.reduce<Record<string, number>>((acc, m) => {
  acc[m.type] = (acc[m.type] ?? 0) + 1;
  return acc;
}, {});
// The card slot is ~450px wide in the three-column desktop layout, so this is
// what a resize to the rendered size would target.
const firstScreen = measured.slice(0, 10).reduce((sum, m) => sum + m.bytes, 0);

console.log(`\ncard images in ${url}`);
console.log(`  resolved            ${measured.length} of ${ordered.length} unique`);
console.log(`  total               ${format(total)}`);
console.log(`  median              ${format(sorted[Math.floor(sorted.length / 2)]!.bytes)}`);
console.log(`  largest             ${format(sorted[0]!.bytes)}  (${sorted[0]!.host})`);
console.log(`  over 300 KB         ${over(300 * 1024)} of ${measured.length}`);
console.log(`  over 1 MB           ${over(1024 * 1024)}`);
console.log(
  `  formats             ${Object.entries(types)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ')}`,
);
console.log(`  first 10 (the fold) ${format(firstScreen)}`);
console.log('\n  largest 10:');
for (const m of sorted.slice(0, 10)) {
  console.log(`    ${format(m.bytes).padStart(9)}  ${m.type.padEnd(11)} ${m.host}`);
}
console.log('');

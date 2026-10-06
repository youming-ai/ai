// Feed probe: fetch every registered source the way ingest does and run the
// real parseRss over the bytes.
//
//   bun run feeds:probe
//
// This exists because AGENTS.md's first gotcha is "probe the exact URL with
// RSS_HEADERS before changing parser or storage code" — and because the source
// list itself is only as good as the last measurement. It reports, per source:
// liveness, how many items actually parse, how much text each item carries (that
// is the curator's input, and a feed with none is a source that costs a model
// call to learn nothing), whether images and publisher categories survive, how
// many items fall inside the freshness window, and the newest headline.
//
// It reads FEED_SOURCES rather than its own list on purpose: the point is to
// check what is deployed, so a source that has since gone 403 or stopped
// publishing is visible here and not only in production logs.
import { parseRss } from '../src/feeds/rss';
import { FEED_SOURCES, INGEST_MAX_AGE_MS } from '../src/feeds/sources';
import { SITE_NAME, SITE_ORIGIN } from '../src/site';
import type { FeedSource } from '../src/feeds/types';

const RSS_HEADERS = {
  accept: 'application/rss+xml, application/atom+xml, application/json, text/xml, */*',
  'user-agent': `${SITE_NAME}/1.0 (+${SITE_ORIGIN})`,
};

interface Probe {
  id: string;
  status: number;
  type: string;
  kb: number;
  items: number;
  kept: number;
  medianChars: number;
  images: number;
  categories: number;
  ms: number;
  note: string;
}

async function probe(source: FeedSource, now: number): Promise<Probe> {
  const started = Date.now();
  const base: Probe = {
    id: source.id,
    status: 0,
    type: 'ERR',
    kb: 0,
    items: 0,
    kept: 0,
    medianChars: 0,
    images: 0,
    categories: 0,
    ms: 0,
    note: '',
  };
  try {
    const response = await fetch(source.url, {
      headers: RSS_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    const parsed = parseRss(text, source, now);
    const fresh = parsed.filter((item) => item.publishedAt >= now - INGEST_MAX_AGE_MS);
    const lengths = fresh.map((item) => item.description.length).sort((a, b) => a - b);
    return {
      id: source.id,
      status: response.status,
      type: (response.headers.get('content-type') ?? '').split(';')[0] ?? '',
      kb: Math.round(text.length / 1024),
      items: parsed.length,
      // What ingest would actually hand the curator: window first, cap second.
      kept: Math.min(fresh.length, source.maxItems),
      medianChars: lengths.length ? lengths[Math.floor(lengths.length / 2)]! : 0,
      images: fresh.filter((item) => item.imageUrl).length,
      categories: fresh.filter((item) => item.category).length,
      ms: Date.now() - started,
      note: fresh[0]?.title.slice(0, 56) ?? '',
    };
  } catch (error) {
    return {
      ...base,
      ms: Date.now() - started,
      note: String((error as Error).message).slice(0, 56),
    };
  }
}

const now = Date.now();
const results: Probe[] = [];
for (const source of FEED_SOURCES) results.push(await probe(source, now));

const pad = (value: string | number, width: number) => String(value).padEnd(width);
console.log(
  `${pad('id', 22)}${pad('http', 6)}${pad('KB', 6)}${pad('parsed', 8)}${pad('kept', 6)}` +
    `${pad('medChars', 10)}${pad('img', 5)}${pad('cat', 5)}${pad('ms', 7)}newest headline`,
);
for (const result of results) {
  console.log(
    pad(result.id, 22) +
      pad(result.status, 6) +
      pad(result.kb, 6) +
      pad(result.items, 8) +
      pad(result.kept, 6) +
      pad(result.medianChars, 10) +
      pad(result.images, 5) +
      pad(result.categories, 5) +
      pad(result.ms, 7) +
      result.note,
  );
}

const live = results.filter((r) => r.status === 200 && r.kept > 0);
const thin = results.filter((r) => r.status === 200 && r.kept > 0 && r.medianChars < 40);
console.log(`\nlive and contributing: ${live.length}/${results.length}`);
console.log(`would be trimmed to nothing (stale or over-cap): ${results.length - live.length}`);
console.log(
  `thin text (median under 40 chars, the curator's minimum): ${thin.map((r) => r.id).join(', ') || '(none)'}`,
);
if (results.some((r) => r.status !== 200)) {
  console.log(
    `not answering: ${results
      .filter((r) => r.status !== 200)
      .map((r) => `${r.id}(${r.status})`)
      .join(', ')}`,
  );
}

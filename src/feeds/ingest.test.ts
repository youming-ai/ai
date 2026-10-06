import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../data/api';
import { SITE_NAME, SITE_ORIGIN } from '../site';
import { sleep } from '../utils/coerce';
import { canonicalizeUrl, ingestAllSources, knownCanonicalUrls, knownFingerprints } from './ingest';

// File-scoped, not inside a describe. Two blocks here stub `fetch`, and a hook
// bound to one of them let the other's stub outlive its test — the next case
// added below it would have inherited a mock.
afterEach(() => {
  vi.unstubAllGlobals();
});

// fetchWithRetry sleeps 500ms then 1000ms between attempts. Real timers would
// add 1.5s to every retry case in a suite that runs serially, so the sleep is
// stubbed: what these tests pin is when a retry happens, not how long it waits.
// The rest of the module is the real thing — rss.ts imports decodeEntities from
// here, and a wholesale mock would hand it undefined.
vi.mock('../utils/coerce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/coerce')>()),
  sleep: vi.fn(async () => {}),
}));

/** One distilled article, so a test's feed is a template string away. */
const ONE_ITEM = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0"><channel>
    <item><title>Story</title><link>https://example.com/story</link>
      <description>x</description></item>
  </channel></rss>`;

function feedOf(...items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items.join(
    '',
  )}</channel></rss>`;
}

function item(title: string, link: string, description = 'x'): string {
  return `<item><title>${title}</title><link>${link}</link><description>${description}</description></item>`;
}

/** The D1 surface ingestAllSources actually uses: the source upsert, the two
 *  dedupe lookups, and the article insert. `inserted` records the bindings of
 *  every article INSERT so a test can assert on what reached the database
 *  rather than on what the report claims. */
function ingestDb(
  { changes = 1, enabled = ['toms-hardware'] }: { changes?: number; enabled?: string[] } = {},
  stored: { fingerprints?: string[]; urls?: string[] } = {},
) {
  const inserted: unknown[][] = [];
  const db = {
    batch: vi.fn(async () => []),
    prepare: vi.fn((sql: string) => {
      if (sql.includes('SELECT id FROM sources')) {
        return { all: async () => ({ results: enabled.map((id) => ({ id })) }) };
      }
      if (sql.includes('FROM articles') && sql.includes(' IN (')) {
        return {
          bind: vi.fn((...params: string[]) => ({
            all: async () => ({
              results: params
                .filter((p) => stored.fingerprints?.includes(p) || stored.urls?.includes(p))
                .map((value) => ({ fingerprint: value, canonical_url: value })),
            }),
          })),
        };
      }
      return {
        bind: vi.fn((...params: unknown[]) => {
          if (sql.includes('INSERT INTO articles')) inserted.push(params);
          return {
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes } }),
          };
        }),
      };
    }),
  };
  return { db: db as unknown as D1Database, inserted };
}

function envWith(db: D1Database): Env {
  return { DB: db } as unknown as Env;
}

describe('canonicalizeUrl', () => {
  it('removes tracking parameters while preserving editorial query parameters', () => {
    expect(
      canonicalizeUrl('HTTPS://WWW.Example.com/story/?utm_source=feed&FBCLID=abc&page=2#comments'),
    ).toBe('https://www.example.com/story?page=2');
  });

  it('returns non-URL input without throwing', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
  });

  it('drops any scheme that is not http(s)', () => {
    // `new URL('javascript:alert(1)')` parses, and the result is rendered as the
    // card's href. An empty string here makes normalizeArticles skip the
    // article entirely.
    expect(canonicalizeUrl('javascript:alert(1)')).toBe('');
    expect(canonicalizeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(canonicalizeUrl('http://example.com/story')).toBe('http://example.com/story');
  });
});

function fakeLookupDb(stored: string[], column: 'fingerprint' | 'canonical_url') {
  const chunks: string[][] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: string[]) => {
        chunks.push(params);
        return {
          all: async () => ({
            results: params.filter((p) => stored.includes(p)).map((value) => ({ [column]: value })),
          }),
        };
      },
      sql,
    }),
  };
  return { db: db as unknown as D1Database, chunks };
}

describe('knownFingerprints', () => {
  it('returns only the fingerprints already stored', async () => {
    const { db } = fakeLookupDb(['b', 'd'], 'fingerprint');
    const known = await knownFingerprints(db, ['a', 'b', 'c', 'd']);
    expect([...known].sort()).toEqual(['b', 'd']);
  });

  it('chunks the lookup so a full tick stays under D1 parameter limits', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `fp-${i}`);
    const { db, chunks } = fakeLookupDb([], 'fingerprint');
    await knownFingerprints(db, ids);

    expect(chunks.length).toBe(3);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(90);
    expect(chunks.flat().length).toBe(200);
  });

  it('does not query at all when a tick fetched nothing', async () => {
    const { db, chunks } = fakeLookupDb([], 'fingerprint');
    expect((await knownFingerprints(db, [])).size).toBe(0);
    expect(chunks).toHaveLength(0);
  });
});

describe('knownCanonicalUrls', () => {
  it('returns only the canonical URLs already stored', async () => {
    const { db } = fakeLookupDb(
      ['https://example.com/b', 'https://example.com/d'],
      'canonical_url',
    );
    const known = await knownCanonicalUrls(db, [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
    ]);
    expect([...known].sort()).toEqual(['https://example.com/b', 'https://example.com/d']);
  });

  it('does not query at all when a tick fetched nothing', async () => {
    const { db, chunks } = fakeLookupDb([], 'canonical_url');
    expect((await knownCanonicalUrls(db, [])).size).toBe(0);
    expect(chunks).toHaveLength(0);
  });
});

describe('ingestAllSources', () => {
  it('fetches, normalises, and stores curated articles directly', async () => {
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <item>
            <title>thonik – Home</title>
            <link>https://thonik.nl/</link>
            <description>From politics to culture.</description>
            <content:encoded><![CDATA[<p><small><a href="https://thonik.nl/">thonik.nl</a> · Design</small></p>]]></content:encoded>
            <media:thumbnail url="https://example.com/thumb.webp" />
          </item>
          <item>
            <title>C</title>
            <link>https://example.com/c</link>
            <description>A programming language.</description>
          </item>
          <item>
            <title>C++</title>
            <link>https://example.com/cpp</link>
            <description>Another programming language.</description>
          </item>
        </channel>
      </rss>`;

    const fetchMock = vi.fn().mockResolvedValue(new Response(rssXml, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const report = await ingestAllSources(envWith(ingestDb().db));

    expect(report.sources).toBe(1);
    expect(report.stored).toBe(3);
    expect(report.uncategorized).toBe(2);
    expect(report.failed).toHaveLength(0);
  });

  it('drops a second entry for a URL the same feed already gave', async () => {
    // The same story listed twice under different titles: the titles differ, so
    // the fingerprint differs with them and only the in-batch view of seen URLs
    // catches it. Without that set this tick would insert two rows.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            feedOf(
              item('Story one', 'https://example.com/story'),
              item('Story one, again', 'https://example.com/story'),
            ),
            { status: 200 },
          ),
        ),
    );

    const { db, inserted } = ingestDb();
    const report = await ingestAllSources(envWith(db));

    expect(report.fetched).toBe(1);
    expect(report.stored).toBe(1);
    expect(inserted).toHaveLength(1);
  });

  it('never stores a link whose scheme is not http(s)', async () => {
    // Pinned as an outcome, not as one guard: two defences drop this item — the
    // canonicalize step returns '' and, were that removed, fingerprinting throws
    // on `new URL('')` and the item is skipped anyway. Both are observable only
    // as "it was not stored", so this catches the regression that removes both
    // (a dead `javascript:` link reaching the board) rather than either alone.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            feedOf(item('Script', 'javascript:alert(1)'), item('Real', 'https://example.com/real')),
            { status: 200 },
          ),
        ),
    );

    const { db, inserted } = ingestDb();
    const report = await ingestAllSources(envWith(db));

    expect(report.fetched).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.[2]).toBe('https://example.com/real');
  });
});

describe('the fetch retry policy', () => {
  // AGENTS.md names the 429/5xx retry as a gotcha, and every other case in this
  // file stubs a 200 — so the whole retry path was unverified. Deleting the
  // retry, inverting the status test, or dropping the deadline shipped green.

  it('retries a 5xx and stores the articles from the attempt that worked', async () => {
    const slept = vi.mocked(sleep);
    slept.mockClear();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('down', { status: 500 }))
      .mockResolvedValueOnce(new Response('still down', { status: 502 }))
      .mockResolvedValueOnce(new Response(ONE_ITEM, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const report = await ingestAllSources(envWith(ingestDb().db));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(report.failed).toEqual([]);
    expect(report.stored).toBe(1);
    // Backoff between attempts, and none after the successful one. Stubbed
    // above, so this costs nothing and pins the intervals a removal would drop.
    expect(slept.mock.calls).toEqual([[500], [1000]]);
  });

  it('retries 429 — a rate limit is transient, not an answer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(new Response(ONE_ITEM, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const report = await ingestAllSources(envWith(ingestDb().db));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(report.failed).toEqual([]);
    expect(report.stored).toBe(1);
  });

  it('does not retry a 4xx — the feed is gone, not busy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const report = await ingestAllSources(envWith(ingestDb().db));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(report.failed).toEqual(['toms-hardware']);
    expect(report.fetched).toBe(0);
  });

  it('gives up after three attempts and reports the source as failed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const report = await ingestAllSources(envWith(ingestDb().db));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(report.failed).toEqual(['toms-hardware']);
    expect(report.fetched).toBe(0);
  });

  it('retries a network throw, then lets the third one fail the source', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket hang up'));
    vi.stubGlobal('fetch', fetchMock);

    const report = await ingestAllSources(envWith(ingestDb().db));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(report.failed).toEqual(['toms-hardware']);
  });

  it('bounds every attempt with the same deadline', async () => {
    // Without a signal a hanging upstream holds the tick until the platform
    // gives up, and the site silently stops updating. Pinned to the value so a
    // changed ceiling has to be a deliberate edit here too.
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockResolvedValue(new Response(ONE_ITEM, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await ingestAllSources(envWith(ingestDb().db));

    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fetchMock.mock.calls[0]?.[1]).toHaveProperty('signal');
  });
});

describe('the upstream request identifies this site', () => {
  // The publisher reads this header. It used to spell the template's product
  // name beside this deployment's domain, with the origin typed in a second
  // place; both now derive from src/site.ts, and this pins the result.
  it('sends a user-agent naming the site and its real origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(feedOf(), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await ingestAllSources(envWith(ingestDb({ changes: 0 }).db));

    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['user-agent']).toBe(`${SITE_NAME}/1.0 (+${SITE_ORIGIN})`);
    // The feed parser needs to be told what it is asking for.
    expect(headers?.accept).toContain('application/rss+xml');
  });
});

describe('the report does not overstate what it stored', () => {
  it('counts a row the insert discarded as skipped, not stored', async () => {
    // storeArticle is ON CONFLICT DO NOTHING: a conflict the pre-filters cannot
    // see (another tick racing the same story) inserts nothing, and counting it
    // as stored made every such tick report work it had not done.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(ONE_ITEM, { status: 200 })));

    const { db, inserted } = ingestDb({ changes: 0 });
    const report = await ingestAllSources(envWith(db));

    expect(report.fetched).toBe(1);
    // Without this the test would pass on a path that never inserted at all.
    expect(inserted).toHaveLength(1);
    expect(report.stored).toBe(0);
    expect(report.skipped).toBe(1);
  });
});

describe('sources that are disabled', () => {
  it('fetches nothing when no source is enabled, without calling upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const report = await ingestAllSources(envWith(ingestDb({ enabled: [] }).db));

    expect(report.sources).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the freshness window and the per-source cap', () => {
  /** An item with a real pubDate, so the window has something to measure. */
  function datedItem(index: number, daysAgo: number): string {
    const published = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toUTCString();
    return `<item><title>Story ${index}</title><link>https://example.com/${index}</link><description>Text for story ${index}.</description><pubDate>${published}</pubDate></item>`;
  }

  it('drops items older than the window before anything else happens', async () => {
    // Nine of the desk's twelve feeds are archives: openai.com/news returned
    // 1247 items on the day this shipped. Without the window the first tick
    // stores years of history.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(feedOf(datedItem(1, 0), datedItem(2, 30), datedItem(3, 400)), {
          status: 200,
        }),
      ),
    );

    const { db, inserted } = ingestDb();
    const report = await ingestAllSources(envWith(db));

    expect(report.fetched).toBe(1);
    expect(report.trimmed).toBe(2);
    expect(report.stored).toBe(1);
    expect(inserted).toHaveLength(1);
  });

  it('keeps the newest maxItems and reports the rest as trimmed', async () => {
    // toms-hardware is capped at 30 and returned 50 items when the desk was
    // built; the cap is what bounds a tick.
    const items = Array.from({ length: 35 }, (_, index) => datedItem(index, index * 0.01));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(feedOf(...items), { status: 200 })),
    );

    const { db, inserted } = ingestDb();
    const report = await ingestAllSources(envWith(db));

    expect(report.fetched).toBe(30);
    expect(report.trimmed).toBe(5);
    // Newest first: story 0 is the freshest and must survive the cap, the five
    // oldest must not.
    const urls = inserted.map((params) => params[2]);
    expect(urls).toContain('https://example.com/0');
    expect(urls).not.toContain('https://example.com/34');
    expect(urls).toHaveLength(30);
  });

  it('reports fetched and trimmed as one population', async () => {
    // The two counts together are what the source actually offered; a tick that
    // silently dropped items without saying so is what the log line is for.
    const items = [
      ...Array.from({ length: 32 }, (_, index) => datedItem(index, 0)),
      datedItem(99, 90),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(feedOf(...items), { status: 200 })),
    );

    const report = await ingestAllSources(envWith(ingestDb().db));

    expect(report.fetched + report.trimmed).toBe(33);
    expect(report.fetched).toBe(30);
  });
});

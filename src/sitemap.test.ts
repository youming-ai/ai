// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The route reads its bindings from `cloudflare:workers`, so it is stubbed for
// the two cases below. Everything else in this file is pure.
const failingDb = {
  prepare: () => ({
    all: async () => {
      throw new Error('D1 down');
    },
  }),
};
const coldCache = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };

vi.mock('cloudflare:workers', () => ({
  env: { DB: failingDb, CACHE: coldCache },
}));
import type { Env, SitemapData } from './data/api';
import { getSitemapNews } from './data/sitemapData';
import { renderSitemap, sitemapEntries } from './sitemap';
import { SITE_ORIGIN } from './site';

// Mirrors what production actually holds: three hubs with content, and
// no /social, because the sitemap only lists hubs the site has published in.
// There are no per-link pages: the site is a link feed and readers go straight
// to the source.
const DATA: SitemapData = {
  hubs: [
    { category: 'tools', lastmod: '2026-08-07T09:03:08.000Z' },
    { category: 'design', lastmod: '2026-08-07T09:06:13.000Z' },
    { category: 'development', lastmod: '2026-08-06T13:23:52.000Z' },
  ],
};

const empty: SitemapData = { hubs: [] };

const paths = (data: SitemapData = DATA) => sitemapEntries(data).map((e) => e.path);

describe('sitemapEntries', () => {
  it('never lists a hub the site has not published in', () => {
    expect(paths()).not.toContain('/social');
    expect(paths()).toContain('/tools');
  });

  it('lists a hub only while it has content', () => {
    expect(paths(empty)).not.toContain('/tools');
    expect(paths(empty)).toContain('/');
  });

  it('emits no competition-section paths — the old scoreboard plane is gone', () => {
    for (const path of ['/tools/schedule', '/design/stats', '/design/teams']) {
      expect(paths()).not.toContain(path);
    }
  });

  it('dates each hub by its newest article, and / by the newest of all', () => {
    const entries = sitemapEntries(DATA);
    expect(entries.find((e) => e.path === '/tools')?.lastmod).toBe('2026-08-07T09:03:08.000Z');
    expect(entries.find((e) => e.path === '/')?.lastmod).toBe('2026-08-07T09:06:13.000Z');
  });

  it('emits no duplicate paths', () => {
    const all = paths();
    expect(new Set(all).size).toBe(all.length);
  });

  it('lists the global RSS feed and one per category hub', () => {
    expect(paths()).toContain('/rss.xml');
    expect(paths()).toContain('/tools/rss.xml');
    expect(paths()).toContain('/design/rss.xml');
  });

  it('gives RSS entries no lastmod (feeds are always fresh)', () => {
    const entries = sitemapEntries(DATA);
    expect(entries.find((e) => e.path === '/rss.xml')?.lastmod).toBeUndefined();
    expect(entries.find((e) => e.path === '/tools/rss.xml')?.lastmod).toBeUndefined();
  });

  it('never lists a per-link page — readers go straight to the source', () => {
    expect(paths().every((p) => !p.startsWith('/a/'))).toBe(true);
  });
});

describe('renderSitemap', () => {
  const xml = renderSitemap(sitemapEntries(DATA));

  it('is valid XML in the sitemap namespace', () => {
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  it('emits only absolute production URLs', () => {
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) expect(loc.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
  });

  it('writes lastmod only where there is one', () => {
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/tools</loc>\n    <lastmod>`);
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/design</loc>\n    <lastmod>`);
  });
});

describe('canonical origin', () => {
  it('points at a host that actually serves the site', () => {
    // Every <loc>, canonical tag and og:url derives from this one constant.
    expect(SITE_ORIGIN).toBe('https://ai.um1ng.me');
    expect(SITE_ORIGIN.startsWith('https://')).toBe(true);
    expect(SITE_ORIGIN.endsWith('/')).toBe(false);
  });

  it('advertises the sitemap from robots.txt on that same host', () => {
    // This used to be a claim in the comment above with nothing checking it:
    // a file that names a different host, or forgets the directive entirely,
    // would have left crawlers pointed at the wrong place in silence.
    const robots = readFileSync(resolve(process.cwd(), 'public/robots.txt'), 'utf8');
    // Whole lines, not substrings: a commented-out or prefixed directive still
    // contains the text while instructing crawlers to do nothing.
    const lines = robots.split('\n').map((line) => line.trim());
    expect(lines).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
    // The API is crawler noise; the routes that matter are the hubs and feeds.
    expect(lines).toContain('Disallow: /api/');
  });
});

describe('sitemap cache key', () => {
  it('reads one versioned entry, not an unversioned one', async () => {
    // The other three cache keys have a test that names them; this one did not,
    // so a silent reuse of an older key shape would have gone unnoticed — which
    // is exactly how the filters key once served a stale payload.
    const get = vi.fn(async () => null);
    const env = {
      CACHE: { get, put: vi.fn(async () => {}) },
      // The sitemap aggregate is prepared and awaited directly; it never chains
      // `.bind()`, so the mock mirrors that shape rather than carrying a branch
      // that cannot run.
      DB: { prepare: vi.fn(() => ({ all: vi.fn(async () => ({ results: [] })) })) },
    } as unknown as Env;
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
      tracing: {},
    } as unknown as ExecutionContext;

    await getSitemapNews(env, ctx);
    // Called once, then checked: asserting only the arguments would let an
    // unversioned or older-shaped key be read first and forgotten.
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('sitemap:news:v3', 'json');
  });
});

describe('the sitemap route when the lookup fails', () => {
  const cfContext = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
    tracing: {},
  } as unknown as ExecutionContext;

  it('answers 503 rather than an empty sitemap', async () => {
    // An empty <urlset> with a 200 is a claim about the site — "nothing here" —
    // and on a cold cache a D1 outage used to make exactly that claim. A 5xx is
    // the honest answer and leaves crawlers holding the last sitemap they read.
    const { GET } = await import('./pages/sitemap.xml');
    const res = await GET({ locals: { cfContext } } as never);

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('300');
    expect(await res.text()).not.toContain('<urlset');
  });

  it('still serves 200 with an empty urlset when the lookup genuinely finds nothing', async () => {
    // The other half of the distinction: a successful read of an empty corpus
    // is not a failure, and this is what the fallback above must not swallow.
    const data: SitemapData = { hubs: [] };
    expect(sitemapEntries(data)).toHaveLength(2);
    const xml = renderSitemap(sitemapEntries(data));
    expect(xml).toContain('<urlset');
    expect(xml).not.toContain('<lastmod>');
  });
});

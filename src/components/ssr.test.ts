// @vitest-environment node
// The board renders on the server, in workerd, so it must produce real HTML
// without touching window/document. Node environment on purpose: `document` is
// undefined here, exactly like workerd.
import { expect, it } from 'vitest';
import { CATEGORIES } from '../categories';
import { SITE_ORIGIN } from '../site';
import ExploreView, { ABOVE_THE_FOLD_CARDS } from './explore/ExploreView';

it('renders the Explore shell server-side without touching browser globals', () => {
  const html = ExploreView({
    initialData: { items: [], nextCursor: null },
    initialFilters: { categories: [] },
  }).value;
  expect(html).toContain('All links'); // the rail's global row
  // The theme control is available in both desktop and mobile layouts.
  expect(html).toContain('aria-label="Theme"');
});

it('renders article cards server-side', () => {
  const html = ExploreView({
    initialData: {
      items: [
        {
          id: '1',
          title: 'New flagship GPU beats its predecessor',
          description: '',
          summary: 'The new flagship GPU wins every benchmark.',
          blurb: '',
          url: 'https://tomshardware.com/pc-components',
          imageUrl: '',
          isVideo: false,
          imageWidth: 0,
          imageHeight: 0,
          sourceDomain: 'tomshardware.com',
          publishedAt: 1786080856000,
          category: 'tools',
          tags: ['tools'],
          qualityScore: 82,
          freshnessScore: 60,
        },
      ],
      nextCursor: null,
    },
    initialFilters: { categories: [] },
  }).value;
  expect(html).toContain('New flagship GPU beats its predecessor');
  expect(html).toContain('tomshardware.com');
  // The card leads with the category now; the type label it used to lead with
  // was the constant 'link', which said nothing on every card at once.
  expect(html).toContain('Tools');
  expect(html).not.toContain('>link<');
});

it('renders a feed-supplied video as a <video> element, never as an <img>', () => {
  // Regression: the 豆包 launch item carried a 556MB .mp4 in its image field,
  // which an <img> cannot render — the browser downloaded the whole file and
  // only then fired onerror.
  const html = ExploreView({
    initialData: {
      items: [
        {
          id: 'v1',
          title: 'Launch film',
          description: '',
          summary: '',
          blurb: '',
          url: 'https://o.doubao.com/',
          imageUrl: 'https://cdn.example.com/hero_1080p_video.mp4',
          isVideo: true,
          imageWidth: 0,
          imageHeight: 0,
          sourceDomain: 'o.doubao.com',
          publishedAt: 1789434835000,
          category: 'tools',
          tags: ['tools'],
          qualityScore: 90,
          freshnessScore: 100,
        },
      ],
      nextCursor: null,
    },
    initialFilters: { categories: [] },
  }).value;
  expect(html).toContain('<video');
  expect(html).toContain('hero_1080p_video.mp4');
  expect(html).not.toContain('<img');
  // A rendered `autoplay` would start before `board.ts` has checked reduced
  // motion — cached media or slow JS would expose reduced-motion readers to the
  // loop the script is supposed to suppress. Playback begins from the script.
  expect(html).not.toContain('autoplay');
  expect(html).toContain('muted');
  expect(html).toContain('loop=""');
  expect(html).toContain('playsinline=""');
});

it("says the feed is unavailable rather than blaming the reader's filters", () => {
  // The failure this pins: with the feed unreadable the page asserted "No links
  // match these filters. Clear one to widen the explore feed." — a D1 or KV
  // outage presented as the reader's own doing, with an HTTP 200 and nothing
  // else to notice.
  const html = ExploreView({
    initialData: { items: [], nextCursor: null, unavailable: true },
    initialFilters: { categories: [] },
  }).value;

  expect(html).toContain('temporarily unavailable');
  expect(html).not.toContain('No links match these filters');
});

it('keeps every hub reachable when the counts are unknown', () => {
  const html = ExploreView({
    initialData: { items: [], nextCursor: null, unavailable: true },
    initialFilters: {
      categories: Object.entries(CATEGORIES).map(([value, category]) => ({
        value,
        label: category.label,
        count: null,
      })),
    },
  }).value;

  for (const value of Object.keys(CATEGORIES)) {
    expect(html, value).toContain(`href="/${value}"`);
  }
});

it('renders a zero total for a successful empty count, and nothing when it is unknown', () => {
  // The distinction the rail has to keep: a count of zero is a fact about an
  // empty corpus, while a null count means the count could not be read. `every`
  // on an empty array is vacuously true, so without the explicit empty case the
  // successful-empty corpus renders as "unknown" and loses its 0.
  const succeeded = ExploreView({
    initialData: { items: [], nextCursor: null },
    initialFilters: { categories: [] },
  }).value;
  expect(succeeded).toContain('All links');
  expect(succeeded).toMatch(/All links<\/span><span[^>]*>0<\/span>/);

  const unknown = ExploreView({
    initialData: { items: [], nextCursor: null, unavailable: true },
    initialFilters: {
      categories: [{ value: 'tools', label: 'Tools', count: null }],
    },
  }).value;
  expect(unknown).toMatch(/Tools<\/span><\/a>/);
});

it('keeps the looping thumbnail honest for assistive tech', () => {
  // The preview autoplays silently and offers no controls, so it must be
  // decorative: no name, no announcement, no preloading on metered silence.
  const html = ExploreView({
    initialData: {
      items: [
        {
          id: 'v1',
          title: 'Launch film',
          description: '',
          summary: '',
          blurb: '',
          url: 'https://o.doubao.com/',
          imageUrl: 'https://cdn.example.com/hero_1080p_video.mp4',
          isVideo: true,
          imageWidth: 0,
          imageHeight: 0,
          sourceDomain: 'o.doubao.com',
          publishedAt: 1789434835000,
          category: 'tools',
          tags: ['tools'],
          qualityScore: 90,
          freshnessScore: 100,
        },
      ],
      nextCursor: null,
    },
    initialFilters: { categories: [] },
  }).value;
  // Assert on the video tag itself: a page-wide `aria-hidden` (the theme
  // switcher's icons have one too) would satisfy the loose form while the
  // preview stayed exposed to assistive tech.
  const tag = html.match(/<video[^>]*>/)?.[0] ?? '';
  expect(tag, 'video tag rendered').not.toBe('');
  expect(tag).toContain('aria-hidden="true"');
  expect(tag).not.toContain('aria-label');
});

it('renders rail rows tall enough to tap', () => {
  // SC 2.5.8: pointer targets need 24 CSS px. py-1 on 11px caption text yields
  // ~21.75px rows; py-1.5 takes them to ~24px while the count stays tabbable.
  const html = ExploreView({
    initialData: { items: [], nextCursor: null },
    initialFilters: {
      categories: [{ value: 'tools', label: 'Tools', count: 1 }],
    },
  }).value;
  // Asserted on the filter link itself: `min-h-7` also appears on the Grid and
  // List buttons (four of them, two per rail render site), so a page-wide match
  // stays green even if the rail rows lose it.
  const link = html.match(/<a[^>]*href="\/tools"[^>]*>/)?.[0] ?? '';
  expect(link, 'tools filter link rendered').not.toBe('');
  expect(link).toContain('min-h-7');
});

it('shows Web3 for historical crypto filters while keeping their links compatible', () => {
  const markup = ExploreView({
    initialData: { items: [], nextCursor: null },
    initialFilters: { categories: [{ value: 'crypto', label: 'Crypto', count: 3 }] },
    initialCategory: 'crypto',
  }).value;
  expect(markup).toContain('>Web3</span>');
  expect(markup).not.toContain('>Crypto<');
  expect(markup).toContain('href="/crypto"');
});

it.each(['grid', 'list'] as const)('preserves the %s layout across category navigation', (view) => {
  const markup = ExploreView({
    initialData: { items: [], nextCursor: null },
    initialFilters: { categories: [{ value: 'tools', label: 'Tools', count: 1 }] },
    initialCategory: 'tools',
    initialView: view,
  }).value;
  const suffix = view === 'list' ? '?view=list' : '';
  expect(markup.match(new RegExp(`href="/tools${suffix.replace('?', '\\?')}"`, 'g'))).toHaveLength(
    2,
  );
  expect(markup).toContain(`href="/${suffix}"`);
});

it('serves our own media route as a root-relative path', () => {
  // The bug this pins: card images were rendered as
  // `https://<canonical-origin>/media/<id>`, and on the deployed host the
  // canonical origin had no DNS record at all — so every proxied image was
  // broken while the same path on the serving host answered 200. Third-party
  // images keep their absolute URL, because we do not own those.
  const feedImage = (id: string, imageUrl: string) => ({
    id,
    title: `Story ${id}`,
    description: '',
    summary: '',
    blurb: '',
    url: `https://example.com/${id}`,
    imageUrl,
    isVideo: false,
    imageWidth: 0,
    imageHeight: 0,
    sourceDomain: 'example.com',
    publishedAt: 1786080856000,
    category: 'tools',
    tags: ['tools'],
    qualityScore: 82,
    freshnessScore: 60,
  });

  const html = ExploreView({
    initialData: {
      items: [
        feedImage('a', `${SITE_ORIGIN}/media/437e368b-c40c-4e02-8e06-2ca5bbcb8055`),
        feedImage('b', 'https://images.ctfassets.net/a/b/photo.png'),
      ],
      nextCursor: null,
    },
    initialFilters: { categories: [] },
  }).value;

  expect(html).toContain('src="/media/437e368b-c40c-4e02-8e06-2ca5bbcb8055"');
  expect(html).not.toContain(`src="${SITE_ORIGIN}/media/`);
  // And the third-party one is still absolute — that is not ours to re-point.
  expect(html).toContain('src="https://images.ctfassets.net/a/b/photo.png"');
});

it.each([
  'https://images.ctfassets.net/a/b/photo.png',
  'https://cdn.shopify.com/s/files/1/photo.jpg',
  'https://pbs.twimg.com/media/abc.jpg',
])('uses the feed image URL unchanged: %s', (imageUrl) => {
  const html = ExploreView({
    initialData: {
      items: [
        {
          id: '1',
          title: 'Story',
          description: '',
          summary: '',
          blurb: '',
          url: 'https://example.com/story',
          imageUrl,
          isVideo: false,
          imageWidth: 0,
          imageHeight: 0,
          sourceDomain: 'example.com',
          publishedAt: 1786080856000,
          category: 'tools',
          tags: ['tools'],
          qualityScore: 82,
          freshnessScore: 60,
        },
      ],
      nextCursor: null,
    },
    initialFilters: { categories: [] },
  }).value;

  expect(html).toContain(`src="${imageUrl}"`);
  expect(html).not.toContain('data-original-src');
});

it('keeps mobile controls outside the disclosure and desktop controls below the rail', () => {
  const html = ExploreView({
    initialData: { items: [], nextCursor: null },
    initialFilters: { categories: [] },
  }).value;

  expect(html.match(/aria-label="Theme"/g)).toHaveLength(2);
  expect(html.match(/>Grid</g)).toHaveLength(2);
  expect(html.match(/>List</g)).toHaveLength(2);
  // Mobile controls precede the disclosure; desktop controls follow the rail.
  const railRows = [...html.matchAll(/Topics/g)].map((match) => match.index ?? 0);
  const themes = [...html.matchAll(/aria-label="Theme"/g)].map((match) => match.index ?? 0);
  expect(railRows).toHaveLength(2);
  expect(themes.length).toBe(2);
  expect(themes[0]).toBeGreaterThan(railRows[0]!);
  expect(themes[1]).toBeLessThan(html.indexOf('<details'));
  expect(html).toContain('group-open:rotate-180');
  // The removed bar was the only backdrop-blurred surface in the markup.
  expect(html).not.toContain('backdrop-blur');
});

it('loads only the first cards eagerly, at high priority', () => {
  // The board is a wall of images on a bandwidth-limited link. Measured at
  // Slow-4G, the LCP element was a card image that was still `loading="lazy"`
  // and queued behind nine siblings, for LCP 3.2s. Above-the-fold cards load
  // eagerly at high priority; everything below stays lazy so the first screen
  // is not competing with twenty images nobody has scrolled to yet.
  const items = Array.from({ length: 6 }, (_, index) => ({
    id: `c${index}`,
    title: `Story ${index}`,
    description: '',
    summary: '',
    blurb: '',
    url: `https://example.com/${index}`,
    imageUrl: `/img-${index}.png`,
    isVideo: false,
    imageWidth: 1200,
    imageHeight: 630,
    sourceDomain: 'example.com',
    publishedAt: 1786080856000,
    category: 'tools',
    tags: ['tools'],
    qualityScore: 82,
    freshnessScore: 60,
  }));

  const html = ExploreView({
    initialData: { items, nextCursor: null },
    initialFilters: { categories: [] },
  }).value;

  const eager = html.match(/loading="eager"/g) ?? [];
  const lazy = html.match(/loading="lazy"/g) ?? [];
  // Lowercase and exact: a camelCase spelling would only *happen* to work in a
  // browser, whose HTML parser lowercases attribute names.
  const high = html.match(/fetchpriority="high"/g) ?? [];
  expect(high).toHaveLength(ABOVE_THE_FOLD_CARDS);
  expect(eager).toHaveLength(ABOVE_THE_FOLD_CARDS);
  expect(lazy).toHaveLength(items.length - ABOVE_THE_FOLD_CARDS);
  // A knob, not a contract — but one that stops being a hint if it grows to
  // cover the page, which is the failure this guards.
  expect(ABOVE_THE_FOLD_CARDS).toBeGreaterThanOrEqual(1);
  expect(ABOVE_THE_FOLD_CARDS).toBeLessThanOrEqual(8);

  // Position matters, not just the count: the eager ones have to be the first
  // cards, or the priority hints land on images nobody sees first.
  const firstLazy = html.indexOf('loading="lazy"');
  const lastEager = html.lastIndexOf('loading="eager"');
  expect(lastEager).toBeLessThan(firstLazy);
  expect(html.indexOf('fetchpriority="high"')).toBeLessThan(firstLazy);
});

it('escapes feed text in the page exactly as in the appended fragment', () => {
  // The page and /cards.json share one card function; this pins the page side
  // of the escaping contract that React used to own (exploreCards.test.ts pins
  // the fragment side). The cursor is in here too: it carries an article id.
  const html = ExploreView({
    initialData: {
      items: [
        {
          id: 'x',
          title: '<script>alert(1)</script>',
          description: '',
          summary: '',
          blurb: '',
          url: 'https://example.com/a?b=1&c=2',
          imageUrl: '',
          isVideo: false,
          imageWidth: 0,
          imageHeight: 0,
          sourceDomain: 'x" onmouseover="alert(3)',
          publishedAt: 1786080856000,
          category: 'tools',
          tags: [],
          qualityScore: 82,
          freshnessScore: 60,
        },
      ],
      nextCursor: '"><script>alert(4)</script>',
    },
    initialFilters: { categories: [] },
  }).value;
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('" onmouseover="');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
  expect(html).toContain('data-cursor="&quot;&gt;&lt;script&gt;alert(4)&lt;/script&gt;"');
});

// @vitest-environment node
// The content islands render on the server (client:load), so they must produce
// real HTML without touching window/document — and must produce it identically
// on both sides, since a hydration mismatch throws the SSR markup away. Node
// environment on purpose: `document` is undefined here, exactly like workerd.
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { CATEGORIES } from '../categories';
import ExploreView, { ABOVE_THE_FOLD_CARDS } from './explore/ExploreView';

it('renders the Explore shell server-side without touching browser globals', () => {
  const html = renderToString(
    <ExploreView
      initialData={{ items: [], nextCursor: null }}
      initialFilters={{ categories: [] }}
    />,
  );
  expect(html).toContain('All links'); // the rail's global row
  // The theme switcher SSRs as an icon-less button; localStorage stays
  // unread at render time so the hydration pass always agrees.
  expect(html).toContain('aria-label="Theme"');
});

it('renders article cards server-side', () => {
  const html = renderToString(
    <ExploreView
      initialData={{
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
      }}
      initialFilters={{ categories: [] }}
    />,
  );
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
  const html = renderToString(
    <ExploreView
      initialData={{
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
      }}
      initialFilters={{ categories: [] }}
    />,
  );
  expect(html).toContain('<video');
  expect(html).toContain('hero_1080p_video.mp4');
  expect(html).not.toContain('<img');
  // A rendered `autoplay` would start before the island hydrates — cached media
  // or slow JS would expose reduced-motion readers to the loop the effect is
  // supposed to suppress. Playback begins from the effect instead.
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
  const html = renderToString(
    <ExploreView
      initialData={{ items: [], nextCursor: null, unavailable: true }}
      initialFilters={{ categories: [] }}
    />,
  );

  expect(html).toContain('temporarily unavailable');
  expect(html).not.toContain('No links match these filters');
});

it('keeps every hub reachable when the counts are unknown', () => {
  const html = renderToString(
    <ExploreView
      initialData={{ items: [], nextCursor: null, unavailable: true }}
      initialFilters={{
        categories: Object.entries(CATEGORIES).map(([value, category]) => ({
          value,
          label: category.label,
          count: null,
        })),
      }}
    />,
  );

  for (const value of Object.keys(CATEGORIES)) {
    expect(html, value).toContain(`href="/${value}"`);
  }
});

it('renders a zero total for a successful empty count, and nothing when it is unknown', () => {
  // The distinction the rail has to keep: a count of zero is a fact about an
  // empty corpus, while a null count means the count could not be read. `every`
  // on an empty array is vacuously true, so without the explicit empty case the
  // successful-empty corpus renders as "unknown" and loses its 0.
  const succeeded = renderToString(
    <ExploreView
      initialData={{ items: [], nextCursor: null }}
      initialFilters={{ categories: [] }}
    />,
  );
  expect(succeeded).toContain('All links');
  expect(succeeded).toMatch(/All links<\/span><span[^>]*>0<\/span>/);

  const unknown = renderToString(
    <ExploreView
      initialData={{ items: [], nextCursor: null, unavailable: true }}
      initialFilters={{
        categories: [{ value: 'tools', label: 'Tools', count: null }],
      }}
    />,
  );
  expect(unknown).toMatch(/Tools<\/span><\/a>/);
});

it('keeps the looping thumbnail honest for assistive tech', () => {
  // The preview autoplays silently and offers no controls, so it must be
  // decorative: no name, no announcement, no preloading on metered silence.
  const html = renderToString(
    <ExploreView
      initialData={{
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
      }}
      initialFilters={{ categories: [] }}
    />,
  );
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
  const html = renderToString(
    <ExploreView
      initialData={{ items: [], nextCursor: null }}
      initialFilters={{
        categories: [{ value: 'tools', label: 'Tools', count: 1 }],
      }}
    />,
  );
  // Asserted on the filter link itself: `min-h-7` also appears on the Grid and
  // List buttons (four of them, two per rail render site), so a page-wide match
  // stays green even if the rail rows lose it.
  const link = html.match(/<a[^>]*href="\/tools"[^>]*>/)?.[0] ?? '';
  expect(link, 'tools filter link rendered').not.toBe('');
  expect(link).toContain('min-h-7');
});

it('asks the publisher CDN for a card-sized image, keeping the original as a fallback', () => {
  // Through the real renderer, so the transform is pinned where it is applied
  // rather than only in src/images.ts. The fallback attribute is what
  // src/scripts/board.ts retries with.
  const html = renderToString(
    <ExploreView
      initialData={{
        items: [
          {
            id: '1',
            title: 'Story',
            description: '',
            summary: '',
            blurb: '',
            url: 'https://example.com/story',
            // A host whose convention was measured (1241 KB -> 58 KB).
            imageUrl: 'https://images.ctfassets.net/a/b/photo.png',
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
      }}
      initialFilters={{ categories: [] }}
    />,
  );

  expect(html).toContain(
    'src="https://images.ctfassets.net/a/b/photo.png?w=900&amp;fm=webp&amp;q=75"',
  );
  expect(html).toContain('data-original-src="https://images.ctfassets.net/a/b/photo.png"');
});

it('renders the layout and theme controls with the rail, not in a toolbar', () => {
  // The toolbar was removed: the rail is the only chrome, and the controls sit
  // at its foot so they exist in both places it renders — the desktop column
  // and the mobile disclosure. One copy would strand them on the other side of
  // the `lg` breakpoint; a toolbar would put them back above the board.
  const html = renderToString(
    <ExploreView
      initialData={{ items: [], nextCursor: null }}
      initialFilters={{ categories: [] }}
    />,
  );

  expect(html.match(/aria-label="Theme"/g)).toHaveLength(2);
  expect(html.match(/>Grid</g)).toHaveLength(2);
  expect(html.match(/>List</g)).toHaveLength(2);
  // At the foot of each rail, not above it: the controls follow the last filter
  // row in both render sites (2 "Topics" headings, 2 control groups).
  const railRows = [...html.matchAll(/Topics/g)].map((match) => match.index ?? 0);
  const themes = [...html.matchAll(/aria-label="Theme"/g)].map((match) => match.index ?? 0);
  expect(railRows).toHaveLength(2);
  expect(themes.length).toBe(2);
  expect(themes[0]).toBeGreaterThan(railRows[0]!);
  expect(themes[1]).toBeGreaterThan(railRows[1]!);
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

  const html = renderToString(
    <ExploreView initialData={{ items, nextCursor: null }} initialFilters={{ categories: [] }} />,
  );

  const eager = html.match(/loading="eager"/g) ?? [];
  const lazy = html.match(/loading="lazy"/g) ?? [];
  // Lowercase, and exact: React 18 warns on the camelCase `fetchPriority` prop
  // (React 19 accepts it), so the attribute is spread in lowercase — which this
  // asserts, because a regression to the camelCase spelling reintroduces an
  // error-level line in `astro dev` and only *happens* to work in a browser,
  // whose HTML parser lowercases attribute names.
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

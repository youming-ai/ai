// @vitest-environment node
// The content islands render on the server (client:load), so they must produce
// real HTML without touching window/document — and must produce it identically
// on both sides, since a hydration mismatch throws the SSR markup away. Node
// environment on purpose: `document` is undefined here, exactly like workerd.
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { CATEGORIES } from '../categories';
import ExploreView from './explore/ExploreView';

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
  // List buttons in every fixture, so a page-wide match stays green even if the
  // rail rows lose it.
  const link = html.match(/<a[^>]*href="\/tools"[^>]*>/)?.[0] ?? '';
  expect(link, 'tools filter link rendered').not.toBe('');
  expect(link).toContain('min-h-7');
});

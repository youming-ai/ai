// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ExploreArticle } from '../types';
import { renderExploreCards } from './exploreCards';

function article(overrides: Partial<ExploreArticle> = {}): ExploreArticle {
  return {
    id: 'a',
    title: 'A story',
    description: '',
    url: 'https://example.com/story',
    imageUrl: '/og.png',
    isVideo: false,
    imageWidth: 1200,
    imageHeight: 630,
    sourceDomain: 'example.com',
    publishedAt: 1786080856000,
    category: 'tools',
    ...overrides,
  };
}

describe('renderExploreCards', () => {
  it('renders the grid wrapper for the grid view', () => {
    const html = renderExploreCards([article()], 'grid');
    expect(html).toContain('<article');
    expect(html).toContain('data-board-page="true"');
    expect(html).not.toContain('<li');
  });

  it('renders list items for the list view', () => {
    // The two views have different root elements, and the board appends into a
    // <section> for one and an <ol> for the other — the wrong wrapper is invalid
    // markup inside the list.
    const html = renderExploreCards([article()], 'list');
    expect(html).toContain('<li');
    expect(html).not.toContain('<article');
    expect(html).not.toContain('data-board-page');
  });

  it('renders bare stacked cards for the deck view', () => {
    // The deck appends behind its last card, so no page wrapper and no <li>.
    const html = renderExploreCards([article({ id: 'id-1' })], 'deck');
    expect(html).toContain('data-deck-card="true"');
    expect(html).toContain('data-id="id-1"');
    expect(html).toContain('data-url="https://example.com/story"');
    expect(html).not.toContain('data-board-page');
    expect(html).not.toContain('<li');
  });

  it('escapes the data attributes the deck saves, not only the visible text', () => {
    // deck.ts reads data-title and data-url back into localStorage and the saved
    // panel, so a quote in a feed title must not end the attribute.
    const html = renderExploreCards(
      [article({ title: 'x" onmouseover="alert(1)', sourceDomain: '<b>d</b>' })],
      'deck',
    );
    expect(html).toContain('data-title="x&quot; onmouseover=&quot;alert(1)"');
    expect(html).toContain('data-domain="&lt;b&gt;d&lt;/b&gt;"');
    expect(html).not.toContain('" onmouseover="');
  });

  it('appended cards are never treated as above the fold', () => {
    // Priority is for the first screen only; a card appended by scrolling is
    // below the fold by definition, and asking for high priority there would
    // compete with images the reader can actually see.
    const html = renderExploreCards([article()], 'grid');
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain('fetchpriority');
  });

  it('escapes a hostile title rather than injecting it', () => {
    // The fragment is inserted with insertAdjacentHTML, so an unescaped title
    // would be an XSS hole fed by the upstream feed. The `html` template escapes
    // every interpolation — this pins that the fragment goes through it rather
    // than through string concatenation, in text and in attributes alike.
    const html = renderExploreCards(
      [
        article({
          title: '<script>alert(1)</script>',
          description: '<img src=x onerror=alert(2)>',
          sourceDomain: 'x" onmouseover="alert(3)',
        }),
      ],
      'grid',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain('title="Source: x&quot; onmouseover=&quot;alert(3)"');
    expect(html).toContain('&lt;script&gt;');
    // Asserted as the whole escaped string, not as the absence of "onerror": the
    // escaped text legitimately contains that substring, and it is inert there.
    // What matters is that the feed's markup became text.
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  it('renders every item it is given, in order', () => {
    const html = renderExploreCards(
      [article({ id: 'a', title: 'First story' }), article({ id: 'b', title: 'Second story' })],
      'grid',
    );
    expect(html.match(/<article/g)).toHaveLength(2);
    expect(html.indexOf('First story')).toBeLessThan(html.indexOf('Second story'));
  });

  it('renders nothing for an empty page', () => {
    expect(renderExploreCards([], 'grid')).toBe('');
  });

  it('keeps mobile list titles and sources readable', () => {
    const markup = renderExploreCards(
      [article({ title: 'A long headline about new hardware' })],
      'list',
    );
    expect(markup).toContain('line-clamp-2');
    expect(markup).toContain('sm:truncate');
    expect(markup).toMatch(/<span class="truncate">example.com<\/span>/);
  });

  it.each(['grid', 'list'] as const)('includes relative and full UTC dates in %s', (view) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-19T12:00:00Z'));
    const markup = renderExploreCards(
      [article({ publishedAt: Date.parse('2026-10-19T10:00:00Z') })],
      view,
    );
    expect(markup).toContain('2h ago');
    expect(markup).toContain('datetime="2026-10-19T10:00:00.000Z"');
    expect(markup).toContain('title="2026-10-19 10:00 UTC"');
  });
});

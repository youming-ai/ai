// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ExploreArticle } from '../types';
import { renderExploreCards } from './exploreCards';

function article(overrides: Partial<ExploreArticle> = {}): ExploreArticle {
  return {
    id: 'a',
    title: 'A story',
    description: '',
    summary: '',
    blurb: '',
    url: 'https://example.com/story',
    imageUrl: '/og.png',
    isVideo: false,
    imageWidth: 1200,
    imageHeight: 630,
    sourceDomain: 'example.com',
    publishedAt: 1786080856000,
    category: 'tools',
    tags: ['tools'],
    qualityScore: 82,
    freshnessScore: 60,
    ...overrides,
  };
}

describe('renderExploreCards', () => {
  it('renders the grid wrapper for the grid view', () => {
    const html = renderExploreCards([article()], 'grid');
    expect(html).toContain('<article');
    expect(html).not.toContain('<li');
  });

  it('renders list items for the list view', () => {
    // The two views have different root elements, and the board appends into a
    // <section> for one and an <ol> for the other — the wrong wrapper is invalid
    // markup inside the list.
    const html = renderExploreCards([article()], 'list');
    expect(html).toContain('<li');
    expect(html).not.toContain('<article');
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
    // would be an XSS hole fed by the upstream feed. React escapes on render —
    // this pins that the fragment goes through React rather than string
    // concatenation.
    const html = renderExploreCards(
      [
        article({
          title: '<script>alert(1)</script>',
          description: '<img src=x onerror=alert(2)>',
        }),
      ],
      'grid',
    );
    expect(html).not.toContain('<script>');
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
});

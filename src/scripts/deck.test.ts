import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ExploreView from '../components/explore/ExploreView';
import type { ExploreArticle } from '../types';
import { decide, initDeck, readSaved } from './deck';

// Gestures themselves are checked in Chrome (jsdom has no layout to drag in);
// what is pinned here is where a release lands and what the deck does once it
// knows: the buttons and arrow keys drive the same commit a swipe does.

function card(id: string, title = `Story ${id}`): ExploreArticle {
  return {
    id,
    title,
    description: 'Teaser',
    url: `https://example.com/${id}`,
    imageUrl: '',
    isVideo: false,
    imageWidth: 0,
    imageHeight: 0,
    sourceDomain: 'example.com',
    publishedAt: Date.now(),
    category: 'tools',
  };
}

function mountDeck(items: ExploreArticle[], total = items.length): HTMLElement {
  document.body.innerHTML = ExploreView({
    initialData: { items, nextCursor: null },
    initialFilters: { categories: [], total },
    initialView: 'deck',
  }).value;
  const deck = document.querySelector<HTMLElement>('[data-view="deck"]')!;
  // Reduced motion: cards leave at once, so no timer has to run.
  initDeck(deck, null, () => true);
  return deck;
}

const topTitle = () => document.querySelector<HTMLElement>('[data-deck-card]')?.dataset.title;
const progress = () => document.querySelector('[data-deck-progress]')?.textContent;
const press = (action: string) =>
  document.querySelector<HTMLElement>(`[data-deck-action="${action}"]`)!.click();

beforeEach(() => localStorage.clear());
afterEach(() => {
  document.body.innerHTML = '';
});

describe('decide', () => {
  const W = 300;
  const H = 500;

  it('springs back from a short drag', () => {
    expect(decide(80, 10, W, H)).toBeNull();
    expect(decide(0, -100, W, H)).toBeNull();
  });

  it('saves right and skips left past 30% of the width', () => {
    expect(decide(91, 0, W, H)).toBe('save');
    expect(decide(-91, 0, W, H)).toBe('skip');
  });

  it('shares on a mostly-upward drag past 25% of the height', () => {
    expect(decide(20, -126, W, H)).toBe('share');
    // A sideways flick that drifts upward is still a save.
    expect(decide(200, -150, W, H)).toBe('save');
    // Down is never an action.
    expect(decide(0, 300, W, H)).toBeNull();
  });
});

describe('the deck', () => {
  it('skips and saves through its buttons, counting as it goes', () => {
    mountDeck([card('a'), card('b'), card('c')]);
    expect(progress()).toBe('1 / 3');

    press('skip');
    expect(topTitle()).toBe('Story b');
    expect(readSaved()).toEqual([]);

    press('save');
    expect(topTitle()).toBe('Story c');
    expect(progress()).toBe('3 / 3');
    expect(readSaved().map((link) => link.url)).toEqual(['https://example.com/b']);
    expect(document.querySelector('[data-deck-saved-count]')?.textContent).toBe('1');
  });

  it('answers the arrow keys on the stack', () => {
    mountDeck([card('a'), card('b')]);
    const stack = document.querySelector<HTMLElement>('[data-deck-stack]')!;
    stack.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(topTitle()).toBe('Story b');
    expect(readSaved()).toHaveLength(1);
    stack.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(topTitle()).toBeUndefined();
  });

  it('says it is done once the last card is gone and nothing more can load', () => {
    mountDeck([card('a')]);
    const done = document.querySelector<HTMLElement>('[data-deck-done]')!;
    expect(done.hidden).toBe(true);
    press('skip');
    expect(done.hidden).toBe(false);
  });

  it('keeps one saved entry per link, newest first', () => {
    mountDeck([card('a'), card('b')]);
    press('save');
    press('save');
    expect(readSaved().map((link) => link.id)).toEqual(['b', 'a']);
  });

  it('builds the saved list as text, and drops a stored link that is not http(s)', () => {
    // Storage is the reader's own and can be edited: a stored title is never
    // parsed as markup, and a javascript: URL never becomes an href.
    localStorage.setItem(
      'ai-desk:saved',
      JSON.stringify([
        {
          id: 'x',
          title: '<img src=x onerror=alert(1)>',
          url: 'https://ok.test/',
          domain: 'ok.test',
        },
        { id: 'y', title: 'evil', url: 'javascript:alert(2)', domain: 'evil' },
      ]),
    );
    mountDeck([card('a')]);
    const panel = document.querySelector<HTMLDetailsElement>('[data-deck-saved]')!;
    panel.open = true;
    panel.dispatchEvent(new Event('toggle'));

    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('[data-deck-saved-list] a'),
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.href).toBe('https://ok.test/');
    expect(links[0]!.querySelector('img')).toBeNull();
    expect(links[0]!.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('survives storage that is not JSON', () => {
    localStorage.setItem('ai-desk:saved', '{not json');
    mountDeck([card('a')]);
    expect(readSaved()).toEqual([]);
    press('save');
    expect(readSaved()).toHaveLength(1);
  });
});

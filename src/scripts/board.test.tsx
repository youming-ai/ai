// The board's client-side behaviour — everything that used to be React.
//
// The script executes on import (it is a browser module, shipped by Astro as
// one), so each test renders the real component tree, then imports the module
// fresh with `vi.resetModules()`. Rendering the actual `ExploreView` rather than
// a hand-written fixture is deliberate: a fixture would drift from the markup
// the script looks for, which is the failure this file exists to catch.
import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExploreArticle, ExploreFeed } from '../types';
import ExploreView from '../components/explore/ExploreView';

function card(id: string, title: string, isVideo = false): ExploreArticle {
  return {
    id,
    title,
    description: '',
    summary: '',
    blurb: '',
    url: `https://example.com/${id}`,
    imageUrl: isVideo ? 'https://cdn.example.com/clip.mp4' : '/og.png',
    isVideo,
    imageWidth: 0,
    imageHeight: 0,
    sourceDomain: 'example.com',
    publishedAt: 1786080856000,
    category: 'tools',
    tags: ['tools'],
    qualityScore: 82,
    freshnessScore: 60,
  };
}

function feed(items: ExploreArticle[], nextCursor: string | null): ExploreFeed {
  return { items, nextCursor };
}

/** The icon's computed display — `style.display` is how the script shows and
 *  hides it, since `hidden` is not a property of SVG elements. */
function iconDisplay(button: Element, theme: 'dark' | 'light'): string {
  return (button.querySelector(`[data-theme-icon="${theme}"]`) as SVGElement).style.display;
}

/** IntersectionObserver callbacks, so a test can fire the scroll path. */
let observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];

class FakeIntersectionObserver {
  root = null;
  rootMargin = '';
  thresholds = [];
  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    observers.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  return {
    flip(next: boolean) {
      Object.defineProperty(query, 'matches', { value: next, configurable: true });
      for (const listener of listeners) listener();
    },
  };
}

// jsdom has no media implementation; the originals are restored in afterEach
// because a direct defineProperty is invisible to `vi.restoreAllMocks()`.
const MEDIA_METHODS = ['play', 'pause', 'load'] as const;
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();

function stubPlayback() {
  const play = vi.fn(async () => {});
  const pause = vi.fn();
  const load = vi.fn();
  for (const [name, value] of [
    ['play', play],
    ['pause', pause],
    ['load', load],
  ] as const) {
    if (!originalDescriptors.has(name)) {
      originalDescriptors.set(
        name,
        Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, name),
      );
    }
    Object.defineProperty(window.HTMLMediaElement.prototype, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  return { play, pause, load };
}

/** The script runs on import, so this is how a test starts it against the DOM it
 *  just rendered. */
async function startBoard(): Promise<void> {
  await import('./board');
}

beforeEach(() => {
  observers = [];
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
  vi.resetModules();
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  // jsdom implements neither of these, and the script touches both on import —
  // stubbing them is the environment's job, not a concession in the code.
  stubMatchMedia(false);
});

afterEach(() => {
  for (const name of MEDIA_METHODS) {
    const descriptor = originalDescriptors.get(name);
    if (descriptor) {
      Object.defineProperty(window.HTMLMediaElement.prototype, name, descriptor);
    } else {
      delete (window.HTMLMediaElement.prototype as unknown as Record<string, unknown>)[name];
    }
  }
  originalDescriptors.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('board appends the next page', () => {
  it('fetches the next page from the button and inserts the server-rendered HTML', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ html: '<article>second story</article>', nextCursor: null }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <ExploreView
        initialData={feed([card('a', 'first story')], 'cur-1')}
        initialFilters={{ categories: [] }}
        initialCategory="tools"
      />,
    );
    await startBoard();

    fireEvent.click(container.querySelector('[data-board-more]')!);

    await waitFor(() => {
      expect(container.querySelector('[data-board]')?.innerHTML).toContain('second story');
    });
    const requested = String(fetchMock.mock.calls[0]?.[0]);
    expect(requested).toContain('cursor=cur-1');
    expect(requested).toContain('view=grid');
    // Scoped to the hub, or a category page would append the global board.
    expect(requested).toContain('category=tools');
  });

  it('loads the same page from the sentinel, which is the scroll path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ html: '<article>second story</article>', nextCursor: null }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <ExploreView
        initialData={feed([card('a', 'first story')], 'cur-1')}
        initialFilters={{ categories: [] }}
      />,
    );
    await startBoard();

    const intersect = observers.at(-1);
    expect(intersect, 'an observer was installed for the sentinel').toBeDefined();
    intersect?.([{ isIntersecting: true }]);

    await waitFor(() => {
      expect(container.querySelector('[data-board]')?.innerHTML).toContain('second story');
    });
  });

  it('asks for the list wrapper when the page is the list view', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ html: '<li>row</li>', nextCursor: null }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <ExploreView
        initialData={feed([card('a', 'first story')], 'cur-1')}
        initialFilters={{ categories: [] }}
        initialView="list"
      />,
    );
    await startBoard();

    fireEvent.click(container.querySelector('[data-board-more]')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // The appended markup has to match the container it lands in: <li> into the
    // list, <article> into the masonry section.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('view=list');
    expect(container.querySelector('[data-board]')?.tagName).toBe('OL');
  });

  it('keeps the page and reports the failure when a page cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })));

    const { container } = render(
      <ExploreView
        initialData={feed([card('a', 'first story')], 'cur-1')}
        initialFilters={{ categories: [] }}
      />,
    );
    await startBoard();

    fireEvent.click(container.querySelector('[data-board-more]')!);

    const failed = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('[data-board-error]');
      expect(element?.hidden).toBe(false);
      return element;
    });
    expect(failed?.textContent).toMatch(/unavailable/i);
    // The reader keeps what they already had, and the button can be retried.
    expect(container.querySelector('[data-board]')?.innerHTML).toContain('first story');
    expect(container.querySelector<HTMLButtonElement>('[data-board-more]')?.disabled).toBe(false);
  });

  it('shows the end of the feed once the last page arrives, and does not fetch again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ html: '<article>last</article>', nextCursor: null }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <ExploreView
        initialData={feed([card('a', 'first story')], 'cur-1')}
        initialFilters={{ categories: [] }}
      />,
    );
    await startBoard();

    fireEvent.click(container.querySelector('[data-board-more]')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    observers.at(-1)?.([{ isIntersecting: true }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders the end of the feed and no button when the first page is the last', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <ExploreView
        initialData={feed([card('a', 'only story')], null)}
        initialFilters={{ categories: [] }}
      />,
    );
    await startBoard();

    expect(container.querySelector('[data-board-more]')).toBeNull();
    expect(container.textContent).toContain('End of the feed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('theme', () => {
  it('applies the stored choice and keeps both rail instances in step', async () => {
    const { container } = render(
      <ExploreView
        initialData={feed([card('a', 'story')], null)}
        initialFilters={{ categories: [] }}
      />,
    );
    await startBoard();

    const buttons = Array.from(container.querySelectorAll('[data-theme-toggle]'));
    expect(buttons).toHaveLength(2);
    expect(document.documentElement.dataset.theme).toBe('dark');
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')).toBe('Dark theme');
      // The icon the server could not choose is revealed by the script — via
      // style, because `hidden` is an HTML attribute and these are SVGs (the
      // first implementation wrote `icon.hidden`, which silently did nothing).
      expect(iconDisplay(button, 'dark')).not.toBe('none');
      expect(iconDisplay(button, 'light')).toBe('none');
    }

    fireEvent.click(buttons[0]!);

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
    // Both instances, not only the one that was clicked: they render in the
    // desktop column and the mobile disclosure, and only one is ever visible.
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')).toBe('Light theme');
      expect(iconDisplay(button, 'light')).not.toBe('none');
    }
  });

  it('adopts a persisted light theme on load', async () => {
    localStorage.setItem('theme', 'light');
    render(
      <ExploreView
        initialData={feed([card('a', 'story')], null)}
        initialFilters={{ categories: [] }}
      />,
    );
    await startBoard();

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.querySelector('[data-theme-toggle]')?.getAttribute('aria-label')).toBe(
      'Light theme',
    );
  });
});

describe('card media', () => {
  it('plays a video preview when motion is allowed', async () => {
    stubMatchMedia(false);
    const { play } = stubPlayback();

    render(
      <ExploreView
        initialData={feed([card('v', 'launch film', true)], null)}
        initialFilters={{ categories: [] }}
      />,
    );
    await startBoard();

    expect(play).toHaveBeenCalledOnce();
  });

  it('leaves a reduced-motion reader paused on a loaded frame', async () => {
    stubMatchMedia(true);
    const { play, pause, load } = stubPlayback();

    const { container } = render(
      <ExploreView
        initialData={feed([card('v', 'launch film', true)], null)}
        initialFilters={{ categories: [] }}
      />,
    );
    await startBoard();

    expect(play).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalled();
    // preload="none" would leave the paused video with nothing to paint.
    expect(load).toHaveBeenCalled();
    expect(container.querySelector('video')?.getAttribute('preload')).toBe('metadata');
  });

  it('follows a preference change while the page is open', async () => {
    const media = stubMatchMedia(true);
    const { play } = stubPlayback();

    render(
      <ExploreView
        initialData={feed([card('v', 'launch film', true)], null)}
        initialFilters={{ categories: [] }}
      />,
    );
    await startBoard();
    expect(play).not.toHaveBeenCalled();

    media.flip(false);
    expect(play).toHaveBeenCalledOnce();
  });

  it('hides an image that fails to load', async () => {
    // The feed is third-party, so failures are normal — and a broken-image icon
    // where a story should be is a documented thing this board does not do.
    const { container } = render(
      <ExploreView
        initialData={feed([card('a', 'story')], null)}
        initialFilters={{ categories: [] }}
      />,
    );
    await startBoard();

    const image = container.querySelector<HTMLImageElement>('img[data-card-media]');
    expect(image).not.toBeNull();
    image!.dispatchEvent(new Event('error'));

    expect(image!.style.display).toBe('none');
    expect(container.querySelector('[data-image-frame]')?.classList.contains('animate-pulse')).toBe(
      false,
    );
  });
});

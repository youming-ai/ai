// The board's client-side behaviour.
//
// The script executes on import (it is a browser module, shipped by Astro as
// one), so each test renders the real board markup, then imports the module
// fresh with `vi.resetModules()`. Rendering the actual `ExploreView` rather than
// a hand-written fixture is deliberate: a fixture would drift from the markup
// the script looks for, which is the failure this file exists to catch.
import { fireEvent, waitFor } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExploreView from '../components/explore/ExploreView';
import type { Html } from '../components/html';
import { renderExploreCards } from '../data/exploreCards';
import type { ExploreArticle, ExploreFeed } from '../types';

/** Mounts the server-rendered board the way the browser receives it. */
function render(markup: Html): { container: HTMLElement } {
  const container = document.createElement('div');
  container.innerHTML = markup.value;
  document.body.appendChild(container);
  return { container };
}

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

function stubMatchMedia(matches: boolean, light = false) {
  const listeners = new Set<() => void>();
  const query = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) =>
      media === '(prefers-color-scheme: light)'
        ? { matches: light, addEventListener: vi.fn() }
        : query,
    ),
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
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
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
  it.each(['grid', 'list'] as const)('uses %s placeholders matching the active layout', (view) => {
    const { container } = render(
      ExploreView({
        initialData: feed([card('a', 'story')], 'cur-1'),
        initialFilters: { categories: [] },
        initialView: view,
      }),
    );
    const loading = container.querySelector<HTMLElement>('[data-board-loading]')!;
    expect(loading.hidden).toBe(true);
    const placeholders = loading.querySelector('[aria-hidden="true"]')!;
    expect(placeholders.children).toHaveLength(view === 'list' ? 3 : 4);
    expect(placeholders.classList.contains('grid')).toBe(view === 'grid');
  });

  it.each(['grid', 'list'] as const)(
    'continues scrolling in %s when the sentinel stays in range after an append',
    async (view) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              html: renderExploreCards([card('b', 'second story')], view),
              nextCursor: 'cur-2',
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              html: renderExploreCards([card('c', 'last story')], view),
              nextCursor: null,
            }),
          ),
        );
      vi.stubGlobal('fetch', fetchMock);
      // A new observation reports the current intersection even when the
      // sentinel never left the viewport between pages.
      vi.spyOn(FakeIntersectionObserver.prototype, 'observe').mockImplementation(() => {
        queueMicrotask(() => observers.at(-1)?.([{ isIntersecting: true }]));
      });
      const { container } = render(
        ExploreView({
          initialData: feed([card('a', 'first story')], 'cur-1'),
          initialFilters: { categories: [] },
          initialView: view,
        }),
      );
      const board = container.querySelector('[data-board]')!;
      const firstPage = board.firstElementChild!;
      const originalCards = Array.from(firstPage.children);
      await startBoard();

      await waitFor(() => {
        expect(container.querySelector('[data-board]')?.textContent).toContain('last story');
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(board.firstElementChild).toBe(firstPage);
      // Existing pages retain their own column formatting context. New pages
      // must be siblings, so appending cannot rebalance the original page.
      if (view === 'grid') {
        expect(board.querySelectorAll(':scope > [data-board-page]')).toHaveLength(3);
        expect(Array.from(firstPage.children)).toEqual(originalCards);
      } else {
        expect(board.querySelectorAll(':scope > li')).toHaveLength(3);
      }
      expect(container.querySelector('[data-board-more]')).toBeNull();
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain('cursor=cur-2');
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`view=${view}`);
    },
  );

  it('automatically fetches the next page and inserts the server-rendered HTML', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ html: '<article>second story</article>', nextCursor: null }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      ExploreView({
        initialData: feed([card('a', 'first story')], 'cur-1'),
        initialFilters: { categories: [] },
        initialCategory: 'tools',
      }),
    );
    await startBoard();

    observers.at(-1)?.([{ isIntersecting: true }]);

    await waitFor(() => {
      expect(container.querySelector('[data-board]')?.innerHTML).toContain('second story');
    });
    const requested = String(fetchMock.mock.calls[0]?.[0]);
    expect(requested).toContain('cursor=cur-1');
    expect(requested).toContain('view=grid');
    expect(container.querySelector('[data-board-more]')).toBeNull();
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
      ExploreView({
        initialData: feed([card('a', 'first story')], 'cur-1'),
        initialFilters: { categories: [] },
      }),
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
      ExploreView({
        initialData: feed([card('a', 'first story')], 'cur-1'),
        initialFilters: { categories: [] },
        initialView: 'list',
      }),
    );
    await startBoard();

    observers.at(-1)?.([{ isIntersecting: true }]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // The appended markup has to match the container it lands in: <li> into the
    // list, <article> into the masonry section.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('view=list');
    expect(container.querySelector('[data-board]')?.tagName).toBe('OL');
  });

  it('says the feed has ended once the last page arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ html: '<article>last</article>', nextCursor: null }), {
          status: 200,
        }),
      ),
    );

    const { container } = render(
      ExploreView({
        initialData: feed([card('a', 'first story')], 'cur-1'),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();

    const note = container.querySelector<HTMLElement>('[data-board-end]');
    expect(note, 'the end note is in the markup').not.toBeNull();
    expect(note!.hidden, 'hidden while another page exists').toBe(true);

    observers.at(-1)?.([{ isIntersecting: true }]);

    await waitFor(() => expect(note!.hidden).toBe(false));
    expect(container.querySelector('[data-board-more]')).toBeNull();
    expect(note!.textContent).toContain('End of the feed');
  });

  it('automatically retries the same cursor after a temporary failure', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ html: '<article>second story</article>', nextCursor: null })),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(
      ExploreView({
        initialData: feed([card('a', 'first story')], 'cur-1'),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();
    observers.at(-1)?.([{ isIntersecting: true }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('[data-board-error]')?.textContent).toContain('Retrying');
    // Repeated intersections during the delay must not bypass the backoff.
    observers.at(-1)?.([{ isIntersecting: true }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(fetchMock.mock.calls[1]?.[0]);
    expect(container.querySelector('[data-board]')?.textContent).toContain('second story');
    expect(container.querySelector<HTMLElement>('[data-board-error]')?.hidden).toBe(true);
  });

  it('stops retrying after two retries and waits for another scroll or connection recovery', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('nope', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(
      ExploreView({
        initialData: feed([card('a', 'first story')], 'cur-1'),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();
    observers.at(-1)?.([{ isIntersecting: true }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[data-board-error]')?.textContent).toContain('Scroll away');
    expect(container.querySelector('[data-board]')?.textContent).toContain('first story');
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry off-screen or after leaving the page', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('nope', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      ExploreView({
        initialData: feed([card('a', 'first story')], 'cur-1'),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();
    observers.at(-1)?.([{ isIntersecting: true }]);
    await vi.advanceTimersByTimeAsync(0);
    observers.at(-1)?.([{ isIntersecting: false }]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    observers.at(-1)?.([{ isIntersecting: true }]);
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the page and reports the failure when a page cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })));

    const { container } = render(
      ExploreView({
        initialData: feed([card('a', 'first story')], 'cur-1'),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();

    observers.at(-1)?.([{ isIntersecting: true }]);

    const failed = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('[data-board-error]');
      expect(element?.hidden).toBe(false);
      return element;
    });
    expect(failed?.textContent).toMatch(/unavailable/i);
    // A failure preserves the existing stories.
    expect(container.querySelector('[data-board]')?.innerHTML).toContain('first story');
    expect(container.querySelector('[data-board-more]')).toBeNull();
  });

  it('shows the end of the feed once the last page arrives, and does not fetch again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ html: '<article>last</article>', nextCursor: null }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      ExploreView({
        initialData: feed([card('a', 'first story')], 'cur-1'),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();

    observers.at(-1)?.([{ isIntersecting: true }]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    observers.at(-1)?.([{ isIntersecting: true }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders the end of the feed and no button when the first page is the last', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      ExploreView({
        initialData: feed([card('a', 'only story')], null),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();

    expect(container.querySelector('[data-board-more]')).toBeNull();
    expect(container.textContent).toContain('End of the feed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('theme', () => {
  it.each([true, false])('defaults to the system preference (light: %s)', async (light) => {
    stubMatchMedia(false, light);
    render(
      ExploreView({
        initialData: feed([card('a', 'story')], null),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();

    expect(document.documentElement.dataset.theme).toBe(light ? 'light' : 'dark');
    expect(localStorage.getItem('theme')).toBeNull();
  });

  it('follows system changes until the reader manually chooses a theme', async () => {
    let onChange = () => {};
    const system = {
      matches: true,
      addEventListener: (_: string, fn: () => void) => (onChange = fn),
    };
    const motion = { matches: false, addEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', (media: string) =>
      media === '(prefers-color-scheme: light)' ? system : motion,
    );
    const { container } = render(
      ExploreView({
        initialData: feed([card('a', 'story')], null),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();
    system.matches = false;
    onChange();
    expect(document.documentElement.dataset.theme).toBe('dark');

    fireEvent.click(container.querySelector('[data-theme-toggle]')!);
    system.matches = true;
    onChange();
    system.matches = false;
    onChange();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('applies the stored choice and keeps both rail instances in step', async () => {
    const { container } = render(
      ExploreView({
        initialData: feed([card('a', 'story')], null),
        initialFilters: { categories: [] },
      }),
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
      ExploreView({
        initialData: feed([card('a', 'story')], null),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.querySelector('[data-theme-toggle]')?.getAttribute('aria-label')).toBe(
      'Light theme',
    );
  });
});

describe('card media', () => {
  it('collapses an image frame when the image failed before the script started', async () => {
    const { container } = render(
      ExploreView({
        initialData: feed([card('a', 'story')], null),
        initialFilters: { categories: [] },
      }),
    );
    const image = container.querySelector('img')!;
    vi.spyOn(image, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(image, 'naturalWidth', 'get').mockReturnValue(0);
    await startBoard();
    expect(container.querySelector<HTMLElement>('[data-image-frame]')!.style.display).toBe('none');
  });

  it('plays a video preview when motion is allowed', async () => {
    stubMatchMedia(false);
    const { play } = stubPlayback();

    render(
      ExploreView({
        initialData: feed([card('v', 'launch film', true)], null),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();

    expect(play).toHaveBeenCalledOnce();
  });

  it('leaves a reduced-motion reader paused on a loaded frame', async () => {
    stubMatchMedia(true);
    const { play, pause, load } = stubPlayback();

    const { container } = render(
      ExploreView({
        initialData: feed([card('v', 'launch film', true)], null),
        initialFilters: { categories: [] },
      }),
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
      ExploreView({
        initialData: feed([card('v', 'launch film', true)], null),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();
    expect(play).not.toHaveBeenCalled();

    media.flip(false);
    expect(play).toHaveBeenCalledOnce();
  });

  it('wires the media inside an appended page, not only the first one', async () => {
    // Regression: `wireMedia` ran once at startup, so cards from page 2 onwards
    // had no broken-image handling and a video preview
    // that never started. The React version could not have this bug — every
    // appended card mounted its own effects.
    const { play } = stubPlayback();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            // Wrapped in <article> the way a real card is: the frame sits
            // inside the card, which is what wireMedia walks.
            html:
              '<article><div data-image-frame><img data-card-media src="/broken.png"></div></article>' +
              '<article><div data-image-frame><video data-preview data-card-media ' +
              'preload="none"></video></div></article>',
            nextCursor: null,
          }),
          { status: 200 },
        ),
      ),
    );

    const { container } = render(
      ExploreView({
        initialData: feed([card('a', 'first story')], 'cur-1'),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();

    observers.at(-1)?.([{ isIntersecting: true }]);
    await waitFor(() =>
      expect(container.querySelector('[data-board]')?.innerHTML).toContain('broken.png'),
    );

    // Broken images are hidden on appended pages too.
    const appended = container.querySelector<HTMLImageElement>('img[src="/broken.png"]');
    expect(appended).not.toBeNull();
    appended!.dispatchEvent(new Event('error'));
    expect(appended!.closest<HTMLElement>('[data-image-frame]')!.style.display).toBe('none');

    // And the appended video preview is started, not left as a dark box.
    const video = container.querySelector<HTMLVideoElement>('video[data-card-media]');
    expect(video).not.toBeNull();
    await waitFor(() => expect(play).toHaveBeenCalled());
  });

  it('hides an image that fails to load', async () => {
    // The feed is third-party, so failures are normal — and a broken-image icon
    // where a story should be is a documented thing this board does not do.
    const { container } = render(
      ExploreView({
        initialData: feed([card('a', 'story')], null),
        initialFilters: { categories: [] },
      }),
    );
    await startBoard();

    const image = container.querySelector<HTMLImageElement>('img[data-card-media]');
    expect(image).not.toBeNull();
    image!.dispatchEvent(new Event('error'));

    expect(image!.closest<HTMLElement>('[data-image-frame]')!.style.display).toBe('none');
    expect(container.querySelector('[data-image-frame]')?.classList.contains('animate-pulse')).toBe(
      false,
    );
  });
});

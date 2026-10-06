// The board's client-side behaviour. Replaces the React island that used to own
// this page: ~46KB gzip of React, react-dom and the component tree shipped to a
// page whose first paint is already complete HTML, to do three small jobs.
//
// Measured before removing it (perf-probe, 20x CPU throttle): the island cost
// 25ms of TBT and one long task, with LCP unchanged. So this is not a speed
// change — it is a data-size one, and the byte budget in scripts/perf-budget.mjs
// is what holds it.
//
// Everything here is progressive enhancement: with JavaScript off the board
// still renders, the rail still navigates, and "Load more" becomes a link-less
// button that does nothing. Nothing is hidden until JS runs.

const LOAD_MORE_LABEL = 'Load more stories';

/** Infinite scroll, driven by one sentinel. The server renders the page; this
 *  appends the next one's HTML rather than rendering anything itself, so the
 *  cards cannot drift from the server-rendered ones. */
function initAppend(board: HTMLElement): void {
  const found = document.querySelector<HTMLElement>('[data-board-sentinel]');
  if (!found) return;
  // Bound to a non-nullable const so the narrowing survives into `load`, which
  // runs later and writes the cursor back onto the sentinel.
  const sentinel: HTMLElement = found;

  const more = sentinel.querySelector<HTMLButtonElement>('[data-board-more]');
  const loading = sentinel.querySelector<HTMLElement>('[data-board-loading]');
  const failed = sentinel.querySelector<HTMLElement>('[data-board-error]');
  const end = sentinel.querySelector<HTMLElement>('[data-board-end]');

  const view = board.dataset.view === 'list' ? 'list' : 'grid';
  const category = board.dataset.category ?? '';
  let cursor = sentinel.dataset.cursor ?? '';
  let busy = false;

  const showEnd = () => {
    if (more) more.hidden = true;
    if (end) end.hidden = false;
  };
  const showMore = () => {
    if (more) {
      more.hidden = false;
      more.disabled = false;
      more.textContent = LOAD_MORE_LABEL;
    }
    if (end) end.hidden = true;
  };

  if (!cursor) {
    showEnd();
    return;
  }

  async function load(): Promise<void> {
    if (busy || !cursor) return;
    busy = true;
    if (more) {
      more.disabled = true;
      more.textContent = 'Loading…';
    }
    if (loading) loading.hidden = false;
    if (failed) failed.hidden = true;

    try {
      const params = new URLSearchParams({ view, cursor, limit: '24' });
      if (category) params.set('category', category);
      const response = await fetch(`/cards.json?${params}`);
      if (!response.ok) throw new Error('The news feed is temporarily unavailable.');
      const page = (await response.json()) as { html: string; nextCursor: string | null };

      // beforeend on the board itself: <article> into the masonry section,
      // <li> into the list. Both are what the server would have produced.
      board.insertAdjacentHTML('beforeend', page.html);
      cursor = page.nextCursor ?? '';
      sentinel.dataset.cursor = cursor;
      if (cursor) showMore();
      else showEnd();
    } catch (error) {
      // The reader keeps what they already had, and is told what happened —
      // 502 from the endpoint, or no network at all.
      if (failed) {
        failed.hidden = false;
        failed.textContent =
          error instanceof Error ? error.message : 'Could not load the news feed.';
      }
      if (more) {
        more.disabled = false;
        more.textContent = LOAD_MORE_LABEL;
      }
    } finally {
      busy = false;
      if (loading) loading.hidden = true;
    }
  }

  more?.addEventListener('click', () => void load());
  // rootMargin so the next page starts arriving before the reader reaches the
  // bottom; appending rows fires no new intersection event, but the sentinel
  // keeps moving, so the same observer fires again.
  new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load();
    },
    { rootMargin: '600px' },
  ).observe(sentinel);
}

/** Theme switching for every instance on the page (the rail renders the control
 *  twice). `data-theme` on the root is the single source of truth — which is
 *  also what the inline script in Layout.astro reads to keep the theme-color
 *  meta tag in step. */
function initTheme(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]'));
  if (buttons.length === 0) return;

  const root = document.documentElement;
  const stored = (): string | null => {
    try {
      return localStorage.getItem('theme');
    } catch {
      return null; // private mode / storage disabled
    }
  };
  const current = (): 'dark' | 'light' => {
    const applied = root.dataset.theme;
    if (applied === 'dark' || applied === 'light') return applied;
    return stored() === 'light' ? 'light' : 'dark';
  };

  const paint = (): void => {
    const theme = current();
    const label = theme === 'dark' ? 'Dark theme' : 'Light theme';
    for (const button of buttons) {
      button.setAttribute('aria-label', label);
      button.title = label;
      for (const icon of button.querySelectorAll<SVGElement>('[data-theme-icon]')) {
        // `style.display`, not the `hidden` attribute or `icon.hidden`: `hidden`
        // is defined for HTML elements, React's SVG props reject it, and on an
        // SVG the IDL property does not exist at all — assigning it sets a
        // plain JS field and the icon never appears. (board.test.tsx pins it.)
        icon.style.display = icon.getAttribute('data-theme-icon') === theme ? '' : 'none';
      }
    }
  };

  // Adopt the stored choice once, so the attribute the observer watches is
  // always set — the server cannot know it, so it renders no icon.
  const initial = current();
  if (root.dataset.theme !== initial) root.dataset.theme = initial;
  paint();
  new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const next = current() === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem('theme', next);
      } catch {
        /* private mode / storage disabled */
      }
      root.dataset.theme = next;
      paint();
    });
  }
}

/** Card media: images and looping video thumbnails. Both were React effects.
 *
 *  Two of these are load-bearing rather than cosmetic:
 *  - a feed image that fails to load must be hidden, or the board shows broken
 *    image icons where a story should be (a documented behaviour, and the feed
 *    is third-party so failures are normal);
 *  - a looping video must not start before reduced motion has been checked,
 *    which is why the markup carries no `autoplay` attribute at all.
 *  The shimmer is the cosmetic third: it only engages for an image that is still
 *  loading, so a cached image never flashes. */
function initMedia(): void {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hide = (element: HTMLElement): void => {
    // `style.display` rather than the `hidden` attribute, because the element
    // carries layout classes that would win over the UA's [hidden] rule.
    element.style.display = 'none';
  };
  const settle = (frame: HTMLElement, media: HTMLElement): void => {
    frame.classList.remove('animate-pulse');
    media.classList.remove('opacity-0');
    media.classList.add('opacity-100');
  };

  const videos: HTMLVideoElement[] = [];
  for (const frame of document.querySelectorAll<HTMLElement>('[data-image-frame]')) {
    const media = frame.querySelector<HTMLElement>('[data-card-media]');
    if (!media) continue;

    if (media instanceof HTMLVideoElement) {
      videos.push(media);
      media.addEventListener('error', () => hide(media), { once: true });
      continue;
    }
    if (!(media instanceof HTMLImageElement)) continue;

    if (!media.complete) {
      frame.classList.add('animate-pulse');
      media.classList.remove('opacity-100');
      media.classList.add('opacity-0');
    }
    // One retry with the URL the feed gave us, then give up. The card asks the
    // publisher's CDN for a card-sized image (src/images.ts), and a publisher
    // that changes its parameters answers 404/400 rather than serving the
    // original — measured, which is why this exists instead of trusting the
    // rewrite. Not `{ once: true }`: the retry needs this same handler.
    let retried = false;
    const onError = () => {
      const original = media.dataset.originalSrc;
      if (!retried && original && media.getAttribute('src') !== original) {
        retried = true;
        media.setAttribute('src', original);
        return;
      }
      frame.classList.remove('animate-pulse');
      hide(media);
    };
    media.addEventListener('load', () => {
      media.removeEventListener('error', onError);
      settle(frame, media);
    });
    media.addEventListener('error', onError);
  }

  if (videos.length === 0) return;
  const sync = (): void => {
    for (const video of videos) {
      if (query.matches) {
        // Pause on a real frame: a paused video with preload="none" has fetched
        // nothing, so ask for metadata explicitly.
        video.preload = 'metadata';
        video.load();
        video.pause();
      } else {
        void video.play().catch(() => {
          /* autoplay blocked after all — the first frame still shows */
        });
      }
    }
  };
  sync();
  query.addEventListener('change', sync);
}

// There is exactly one board per document; the sentinel is its sibling, not a
// descendant, which is why these are document-level lookups.
const board = document.querySelector<HTMLElement>('[data-board]');
if (board) initAppend(board);
initTheme();
initMedia();
export {};

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
// still renders and the rail still navigates. Scrolling loads subsequent pages
// when JavaScript is available.

/** Column counts of the server's grid page (`ExploreGridPage`: md:columns-2,
 *  xl:columns-3, 2xl:columns-4), widest first. */
const LANE_BREAKPOINTS: [query: string, lanes: number][] = [
  ['(min-width: 96rem)', 4],
  ['(min-width: 80rem)', 3],
  ['(min-width: 48rem)', 2],
];

function laneCount(): number {
  return LANE_BREAKPOINTS.find(([query]) => window.matchMedia(query).matches)?.[1] ?? 1;
}

/** Masonry lanes for the grid view. The server renders each page as its own
 *  CSS-columns block — right for the first paint and without JavaScript — but
 *  stacked blocks leave a gap: page two starts below page one's tallest column.
 *  So on the first append the cards move into one flex lane per column, each
 *  keeping the column it was painted in (nothing visibly moves), and every
 *  later card goes to the shortest lane. A breakpoint change re-deals them all
 *  in feed order.
 *
 *  ponytail: lane heights read off-screen cards at their content-visibility
 *  estimate (400px), so lanes can end a few hundred pixels uneven at the very
 *  bottom; they never leave a gap between cards. */
function createLanes(board: HTMLElement): { add(cards: HTMLElement[]): void } {
  const cards: HTMLElement[] = [];
  let lanes: HTMLElement[] = [];

  function shortest(): HTMLElement {
    return lanes.reduce((low, lane) => (lane.offsetHeight < low.offsetHeight ? lane : low));
  }

  function build(count: number): HTMLElement {
    const row = document.createElement('div');
    row.dataset.boardLanes = 'true';
    row.className = 'flex items-start gap-3';
    lanes = Array.from({ length: count }, () => {
      const lane = document.createElement('div');
      lane.className = 'min-w-0 flex-1';
      row.appendChild(lane);
      return lane;
    });
    return row;
  }

  function convert(): void {
    const painted = Array.from(board.querySelectorAll<HTMLElement>('[data-board-page] > article'));
    // Cards in one CSS column share an offsetLeft, so its rank is the column.
    // Read every position before moving any card: each move rebalances the
    // columns the remaining cards are still in.
    const positions = painted.map((card) => card.offsetLeft);
    const lefts = [...new Set(positions)].sort((a, b) => a - b);
    const row = build(laneCount());
    painted.forEach((card, index) => {
      lanes[Math.min(lefts.indexOf(positions[index]!), lanes.length - 1)]!.appendChild(card);
    });
    board.replaceChildren(row);
    cards.push(...painted);
  }

  function reflow(): void {
    if (cards.length === 0) return;
    const row = build(laneCount());
    board.replaceChildren(row);
    for (const card of cards) shortest().appendChild(card);
  }

  for (const [query] of LANE_BREAKPOINTS) {
    window.matchMedia(query).addEventListener('change', reflow);
  }

  return {
    add(added) {
      if (cards.length === 0) convert();
      for (const card of added) shortest().appendChild(card);
      cards.push(...added);
    },
  };
}

/** Infinite scroll, driven by one sentinel. The server renders the page; this
 *  appends the next one's HTML rather than rendering anything itself, so the
 *  cards cannot drift from the server-rendered ones. */
function initAppend(board: HTMLElement): void {
  const found = document.querySelector<HTMLElement>('[data-board-sentinel]');
  if (!found) return;
  // Bound to a non-nullable const so the narrowing survives into `load`, which
  // runs later and writes the cursor back onto the sentinel.
  const sentinel: HTMLElement = found;

  const loading = sentinel.querySelector<HTMLElement>('[data-board-loading]');
  const failed = sentinel.querySelector<HTMLElement>('[data-board-error]');
  const end = sentinel.querySelector<HTMLElement>('[data-board-end]');

  const view = board.dataset.view === 'list' ? 'list' : 'grid';
  const category = board.dataset.category ?? '';
  let cursor = sentinel.dataset.cursor ?? '';
  let busy = false;
  let inRange = false;
  let stopped = false;
  let failures = 0;
  let retryTimer: number | undefined;

  if (!cursor) return;
  const lanes = view === 'grid' ? createLanes(board) : null;

  async function load(): Promise<void> {
    if (busy || !cursor || stopped || retryTimer !== undefined) return;
    busy = true;
    if (loading) loading.hidden = false;
    if (failed) failed.hidden = true;

    try {
      // Matches EXPLORE_MAX_LIMIT (src/data/explore.ts). Written out rather than
      // imported: that module pulls the D1/KV layer into the browser bundle.
      const params = new URLSearchParams({ view, cursor, limit: '24' });
      if (category) params.set('category', category);
      const response = await fetch(`/cards.json?${params}`);
      if (!response.ok) throw new Error('The news feed is temporarily unavailable.');
      const page = (await response.json()) as { html: string; nextCursor: string | null };
      if (stopped) return;

      // Grid page wrappers and list rows both arrive as server-rendered HTML.
      // Wire only what arrived. The React version got this for free — every
      // appended card mounted its own effects — and forgetting it meant page 2
      // onwards had no broken-image handling or playing video previews.
      if (lanes) {
        const parsed = document.createElement('template');
        parsed.innerHTML = page.html;
        const cards = Array.from(parsed.content.querySelectorAll<HTMLElement>('article'));
        lanes.add(cards);
        wireMedia(cards);
      } else {
        const existing = board.children.length;
        board.insertAdjacentHTML('beforeend', page.html);
        wireMedia(Array.from(board.children).slice(existing));
      }
      cursor = page.nextCursor ?? '';
      failures = 0;
      sentinel.dataset.cursor = cursor;
      if (end) end.hidden = Boolean(cursor);
    } catch (error) {
      // The reader keeps what they already had, and is told what happened —
      // 502 from the endpoint, or no network at all.
      if (stopped) return;
      failures += 1;
      const retryDelay = failures <= 2 ? failures * 2000 : 0;
      if (failed) {
        failed.hidden = false;
        const message = error instanceof Error ? error.message : 'Could not load the news feed.';
        failed.textContent = retryDelay
          ? `${message} Retrying in ${retryDelay / 1000} seconds…`
          : `${message} Scroll away and back to try again.`;
      }
      if (retryDelay) {
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined;
          if (inRange) void load();
        }, retryDelay);
      }
      return;
    } finally {
      busy = false;
      if (loading) loading.hidden = true;
    }

    // Appending can leave the sentinel inside the preload margin, especially
    // on wide grids or short pages. Recheck its position after each successful
    // append; failures use bounded delays instead of rearming immediately.
    observer?.unobserve(sentinel);
    if (cursor) observer?.observe(sentinel);
    else observer?.disconnect();
  }

  // Start fetching before the reader reaches the bottom.
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            inRange = entries.some((entry) => entry.isIntersecting);
            if (inRange) void load();
            else failures = 0;
          },
          { rootMargin: '600px' },
        );
  observer?.observe(sentinel);
  const resume = () => {
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
    failures = 0;
    if (inRange) void load();
  };
  window.addEventListener('online', resume);
  window.addEventListener(
    'pagehide',
    (event) => {
      // A page in the back/forward cache resumes with its existing observers.
      if (event.persisted) return;
      stopped = true;
      observer?.disconnect();
      window.clearTimeout(retryTimer);
      window.removeEventListener('online', resume);
    },
    { once: true },
  );
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
  const systemTheme = window.matchMedia('(prefers-color-scheme: light)');
  const choice = stored();
  let manualChoice: 'light' | 'dark' | null =
    choice === 'light' || choice === 'dark' ? choice : null;
  const preferred = (): 'dark' | 'light' =>
    manualChoice ?? (systemTheme.matches ? 'light' : 'dark');
  const current = (): 'dark' | 'light' => {
    const applied = root.dataset.theme;
    if (applied === 'dark' || applied === 'light') return applied;
    return preferred();
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

  // Match the pre-paint script: use a saved choice or the system preference.
  const initial = preferred();
  if (root.dataset.theme !== initial) root.dataset.theme = initial;
  paint();
  new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  systemTheme.addEventListener('change', () => {
    if (manualChoice) return;
    root.dataset.theme = preferred();
    paint();
  });

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const next = current() === 'light' ? 'dark' : 'light';
      manualChoice = next;
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
/** Previews collected across the initial render and every appended page, so one
 *  motion-preference listener governs all of them. */
const previewVideos: HTMLVideoElement[] = [];
let reducedMotion: MediaQueryList | null = null;

/** Wire card media inside `roots`: images and video thumbnails. Called once for
 *  the server-rendered cards and again for each appended page. */
/** `Element | Document` rather than `ParentNode`: the DOM lib gives `Element`
 *  an `append` overload set that is not assignable to `ParentNode`'s, so a plain
 *  `Element[]` will not typecheck against it. Both members have the one method
 *  this needs. */
function wireMedia(roots: (Element | Document)[]): void {
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

  for (const frame of roots.flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLElement>('[data-image-frame]')),
  )) {
    const media = frame.querySelector<HTMLElement>('[data-card-media]');
    if (!media) continue;

    if (media instanceof HTMLVideoElement) {
      previewVideos.push(media);
      media.addEventListener('error', () => hide(frame), { once: true });
      continue;
    }
    if (!(media instanceof HTMLImageElement)) continue;

    if (!media.complete) {
      frame.classList.add('animate-pulse');
      media.classList.remove('opacity-100');
      media.classList.add('opacity-0');
    }
    const onError = () => {
      frame.classList.remove('animate-pulse');
      hide(frame);
    };
    if (media.complete) {
      if (media.naturalWidth > 0) settle(frame, media);
      else onError();
    }
    media.addEventListener('load', () => {
      media.removeEventListener('error', onError);
      settle(frame, media);
    });
    media.addEventListener('error', onError);
  }

  syncPreviews();
}

/** Play or hold every preview collected so far, per the reader's motion
 *  preference. Shared by the initial cards and every appended page. */
function syncPreviews(): void {
  if (!reducedMotion) return;
  for (const video of previewVideos) {
    if (reducedMotion.matches) {
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
}

// There is exactly one board per document; the sentinel is its sibling, not a
// descendant, which is why these are document-level lookups.
reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
reducedMotion.addEventListener('change', syncPreviews);
wireMedia([document]);

const board = document.querySelector<HTMLElement>('[data-board]');
if (board) initAppend(board);
initTheme();

// The mobile category sheet opens as a native <details>; this adds what a
// sheet is expected to do on the way out. A tap on the backdrop lands on the
// <details> element itself (the backdrop is its ::before).
const sheet = document.querySelector<HTMLDetailsElement>('[data-category-sheet]');
const sheetPanel = sheet?.querySelector<HTMLElement>('.ds-sheet-panel');
if (sheet && sheetPanel) {
  const SHEET_OUT_MS = 240;
  let closing = 0;
  const finish = () => {
    window.clearTimeout(closing);
    closing = 0;
    sheet.open = false;
    delete sheet.dataset.closing;
    sheetPanel.style.transform = '';
    sheetPanel.style.transition = '';
  };
  // A <details> on its own vanishes in one frame, so play the way out first.
  // It slides from wherever the panel is, so a drag finishes from the finger.
  const close = () => {
    if (!sheet.open || closing) return;
    if (reducedMotion?.matches) {
      finish();
      return;
    }
    sheet.dataset.closing = 'true';
    closing = window.setTimeout(finish, SHEET_OUT_MS);
  };

  sheet.querySelector('summary')?.addEventListener('click', (event) => {
    if (!sheet.open) return;
    event.preventDefault();
    close();
  });
  document.addEventListener('click', (event) => {
    if (sheet.open && (event.target === sheet || !sheet.contains(event.target as Node))) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sheet.open) {
      close();
      sheet.querySelector('summary')?.focus();
    }
  });
  // Chrome skips styling a closed <details>' content, so the motion keyed on
  // [open] would play only the first time. Clearing it for one frame of style
  // resolution restarts it on every open.
  sheet.addEventListener('toggle', () => {
    if (!sheet.open) return;
    for (const part of sheet.querySelectorAll<HTMLElement>('.ds-sheet-panel')) {
      part.style.animation = 'none';
      void part.offsetWidth;
      part.style.animation = '';
    }
  });

  // The grab handle drags the panel down; past a quarter of its height, or on
  // a quick flick, it goes, and otherwise it settles back.
  const grip = sheet.querySelector<HTMLElement>('[data-sheet-grip]');
  let drag: { y: number; dy: number; at: number } | null = null;
  grip?.addEventListener('pointerdown', (event) => {
    drag = { y: event.clientY, dy: 0, at: performance.now() };
    grip.setPointerCapture?.(event.pointerId);
    sheetPanel.style.transition = 'none';
  });
  grip?.addEventListener('pointermove', (event) => {
    if (!drag) return;
    drag.dy = Math.max(0, event.clientY - drag.y);
    sheetPanel.style.transform = `translateY(${drag.dy}px)`;
  });
  const release = () => {
    if (!drag) return;
    const { dy, at } = drag;
    drag = null;
    const flicked = dy > 24 && dy / (performance.now() - at) > 0.6;
    if (dy > sheetPanel.offsetHeight / 4 || flicked) {
      close();
    } else {
      sheetPanel.style.transition = `transform ${SHEET_OUT_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`;
      sheetPanel.style.transform = '';
    }
  };
  grip?.addEventListener('pointerup', release);
  grip?.addEventListener('pointercancel', release);
}

export {};

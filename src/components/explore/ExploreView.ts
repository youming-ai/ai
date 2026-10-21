import { CATEGORIES, CATEGORY_GROUPS } from '../../categories';
import { GLOBAL_FEED_LABEL } from '../../site';
import type { ExploreFeed, ExploreFilterOption, ExploreFilterSet } from '../../types';
import { attr, type Html, html } from '../html';
import ExploreCard from './ExploreCard';
import ExploreGridPage from './ExploreGridPage';

/** How many cards are treated as above the fold: eager, and high fetch
 *  priority. The rest stay lazy.
 *
 *  Kept small on purpose. The board fills column-major, so the visually
 *  topmost card is not always the first in DOM order and a wide viewport shows
 *  the tops of three or four columns at once; marking a whole column would
 *  dilute the hint into what the browser already does for free. Measured
 *  before this: LCP 3.2s at Slow-4G, with the LCP element being a card image
 *  that was still `lazy` and queued behind nine siblings. Exported so the test
 *  that pins the eager/lazy boundary cannot drift from the value. */
export const ABOVE_THE_FOLD_CARDS = 4;

export type ViewMode = 'grid' | 'list';

const SKELETON_CARD = html`<div class="h-56 animate-pulse rounded-card bg-overlay/5"></div>`;

/** The theme control. The markup ships both icons hidden and no label beyond
 *  "Theme", and `src/scripts/board.ts` reveals the right one after paint: the
 *  page renders this control twice (desktop rail foot and mobile bar), and
 *  `data-theme` on the root element is the one source of truth for both, which
 *  the inline script in Layout.astro reads as well. Showing an icon from the
 *  server would be a guess until the script runs; hiding them keeps the
 *  button's box (min-w/min-h) stable meanwhile. Inline moon/sun (lucide paths):
 *  two icons don't justify a dependency. */
const THEME_TOGGLE = html`<button type="button" data-theme-toggle="true" aria-label="Theme" title="Theme" class="flex min-h-9 min-w-9 items-center justify-center rounded-pill text-chalkdim transition-colors hover:bg-overlay/10 hover:text-chalk ds-press">
  <svg data-theme-icon="dark" style="display:none" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4" aria-hidden="true">
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>
  </svg>
  <svg data-theme-icon="light" style="display:none" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4" aria-hidden="true">
    <circle cx="12" cy="12" r="4"></circle>
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>
  </svg>
</button>`;

/** One category link in the rail. */
function filterRow(label: string, count: number | null, active: boolean, href: string): Html {
  const className = `flex w-full items-center gap-2 rounded-card-inset px-2 py-1.5 text-left ds-caption min-h-7 ${
    active
      ? 'bg-pitch/15 font-bold text-pitch'
      : 'text-chalkdim hover:bg-overlay/5 hover:text-chalk'
  }`;
  return html`<a href="${href}"${attr('aria-current', active && 'page')} class="${className}">
    <span class="min-w-0 flex-1 truncate">${label}</span>
    ${count !== null && html`<span class="shrink-0 tabular-nums opacity-70">${count}</span>`}
  </a>`;
}

/** Category rail: one All row, then the registry's group sections in display
 *  order. */
function categoryRail(
  options: ExploreFilterOption[],
  value: string,
  /** From the payload; undefined on a cache entry written before v2. */
  providedTotal: number | null | undefined,
  view: ViewMode,
): Html {
  const { hrefFor, total, groups } = railModel(options, providedTotal, view);
  return html`<div>
    <div>
      <p class="px-2 pb-1 ds-micro uppercase tracking-caption text-chalkdim">Topics</p>
      ${filterRow(GLOBAL_FEED_LABEL, total, !value, hrefFor(''))}
    </div>
    ${groups.map(
      (group) => html`<div>
        <p class="px-2 pt-3 pb-1 ds-micro uppercase tracking-caption text-chalkdim">${group.label}</p>
        ${group.options.map((option) =>
          filterRow(
            CATEGORIES[option.value]?.label ?? option.label,
            option.count,
            value === option.value,
            hrefFor(option.value),
          ),
        )}
      </div>`,
    )}
  </div>`;
}

/** What the desktop rail and the mobile fan both show: the links keep the
 *  current view, the All count, and the registry's groups in display order. */
function railModel(
  options: ExploreFilterOption[],
  providedTotal: number | null | undefined,
  view: ViewMode,
) {
  const hrefFor = (v: string) => `${v ? `/${v}` : '/'}${view === 'list' ? '?view=list' : ''}`;
  // Unknown counts sum to null, not zero: an outage should leave the label bare
  // rather than assert the site holds no links. An empty list is the opposite
  // case — a successful count over an empty corpus — and is known to be zero,
  // which `every` on an empty array would otherwise report as "all unknown".
  const known = options.map((option) => option.count);
  const summed =
    options.length === 0
      ? 0
      : known.every((count) => count === null)
        ? null
        : known.reduce<number>((sum, count) => sum + (count ?? 0), 0);
  const total = providedTotal ?? summed;
  const groups = CATEGORY_GROUPS.map((group) => ({
    ...group,
    options: options.filter((option) => CATEGORIES[option.value]?.group === group.key),
  })).filter((group) => group.options.length > 0);
  return { hrefFor, total, groups };
}

/** The mobile categories: one button at the bottom centre that opens like a
 *  folding fan. Each hub is a wedge-shaped segment pivoting on the button,
 *  spread evenly across at most ±60°, with its label running along it: segments
 *  right of centre read outward from the button, those left of it read inward,
 *  so no label is ever upside down. The counts stay on the button and the
 *  desktop rail; a segment has no room for one on a 320px screen. `<details>` toggles it with no script; `board.ts` closes it on
 *  an outside tap or Escape and replays the opening swing. */
function categoryFan(
  options: ExploreFilterOption[],
  value: string,
  providedTotal: number | null | undefined,
  view: ViewMode,
): Html {
  const { hrefFor, total, groups } = railModel(options, providedTotal, view);
  const items = [
    { label: GLOBAL_FEED_LABEL, count: total, key: '' },
    ...groups
      .flatMap((group) => group.options)
      .map((option) => ({
        label: CATEGORIES[option.value]?.label ?? option.label,
        count: option.count,
        key: option.value,
      })),
  ];
  const current =
    items.find((item) => item.key === value) ??
    (Object.hasOwn(CATEGORIES, value)
      ? { label: CATEGORIES[value]!.label, count: total === null ? null : 0 }
      : items[0]!);
  // Segment angle from vertical: 15° apart, never wider than ±60°.
  const step = items.length > 1 ? Math.min(15, 120 / (items.length - 1)) : 0;
  return html`<details data-category-fan="true" class="ds-fan fixed bottom-4 z-20 lg:hidden">
    <summary aria-label="Categories: ${current.label}" class="relative z-10 flex min-h-11 list-none items-center gap-2 border border-line/40 bg-panel px-3 shadow-float ds-caption font-bold text-chalk [&::-webkit-details-marker]:hidden">
      ${current.label}${current.count !== null && html`<span class="tabular-nums opacity-70">${current.count}</span>`}
    </summary>
    <nav aria-label="Categories">
      ${items.map((item, index) => {
        const active = item.key === value;
        const angle = (index - (items.length - 1) / 2) * step;
        // Left of centre the segment hangs from its right end and its label
        // reads toward the button; from centre rightward, from its left end.
        const side = angle < 0 ? 'l' : 'r';
        const turn = side === 'l' ? angle + 90 : angle - 90;
        return html`<a href="${hrefFor(item.key)}" style="--a:${turn}deg;--i:${index}" data-side="${side}"${attr('aria-current', active && 'page')} class="ds-fan-item flex items-center whitespace-nowrap px-3 ds-caption bg-panel ${active ? 'font-bold text-pitch' : 'text-chalk'}">${item.label}</a>`;
      })}
    </nav>
  </details>`;
}

/** The board.
 *
 *  Rendered on the server, and nothing in the browser renders it again:
 *  `src/scripts/board.ts` handles the three things that need to happen after
 *  paint — appending the next page (fetching HTML the server already
 *  rendered), switching the theme, and starting the looping video thumbnails.
 *  Everything else here is markup.
 *
 *  That is why `view` is an argument rather than state: the toggle is two
 *  links, so switching layout is a document navigation like every other link
 *  on the page, and the URL carries the choice. */
export default function ExploreView({
  initialData,
  initialFilters,
  initialCategory = '',
  initialView = 'grid',
}: {
  initialData: ExploreFeed;
  initialFilters: ExploreFilterSet;
  initialCategory?: string;
  initialView?: ViewMode;
}): Html {
  const cursor = initialData.nextCursor ?? '';
  const hasItems = initialData.items.length > 0;

  // The payload's total counts the rows no hub holds — an unmapped publisher
  // category is stored as NULL and shows on the global board only. Older cached
  // payloads and the registry fallback carry none, so the sum is still the
  // fallback.
  const rail = categoryRail(
    initialFilters.categories,
    initialCategory,
    initialFilters.total,
    initialView,
  );
  const fan = categoryFan(
    initialFilters.categories,
    initialCategory,
    initialFilters.total,
    initialView,
  );

  const cards =
    initialView === 'list'
      ? html`<ol data-board="true" data-view="list" data-category="${initialCategory}" class="divide-y divide-line/30 border-b border-line/30" aria-label="Explore links">
          ${initialData.items.map((article) => ExploreCard({ article, variant: 'list' }))}
        </ol>`
      : html`<section data-board="true" data-view="grid" data-category="${initialCategory}" class="px-3 pt-3" aria-label="Explore links">
          ${ExploreGridPage(initialData.items, ABOVE_THE_FOLD_CARDS)}
        </section>`;

  const feed = hasItems
    ? cards
    : // An outage is what the server was handed; a client append failure is
      // announced in the sentinel instead, and never reaches this branch.
      html`<p class="p-16 text-center ds-body text-chalkdim">${
        initialData.unavailable
          ? 'The explore feed is temporarily unavailable. Reload in a moment.'
          : 'No links match these filters. Clear one to widen the explore feed.'
      }</p>`;

  // Controls stay at the foot of the desktop rail and form the mobile top bar.
  //
  // `justify-between` puts the layout toggle at the row's left edge and the
  // theme control at its right, which is the rail's own inner edge in the
  // desktop column. The two are the only children, so nothing sits between them
  // for the free space to split around.
  const controls = html`<div class="flex items-center justify-between gap-2">
    <nav class="ds-segmented shrink-0" aria-label="Feed layout">
      ${(['grid', 'list'] as const).map(
        (view) =>
          html`<a href="?view=${view}"${attr('aria-current', initialView === view && 'true')} class="ds-seg-tab min-h-9 px-2.5 text-xs ${initialView === view ? 'ds-seg-tab-active' : 'ds-seg-tab-inactive'}">${view === 'grid' ? 'Grid' : 'List'}</a>`,
      )}
    </nav>
    ${THEME_TOGGLE}
  </div>`;

  // Desktop: the rail is h-screen and scrolls on its own, with the controls
  // pinned at its foot. Mobile: the controls are a sticky top bar, and the
  // categories are the fan in the bottom-left corner.
  //
  // `#explore-results` is the skip link's target. It has to exist in every
  // state, including the empty and unavailable ones, so it lives on this
  // wrapper rather than on the grid/list inside `feed`. tabindex -1 keeps it out
  // of the tab order while letting the link move focus here.
  //
  // The sentinel drives automatic scrolling in both layouts. Loading and
  // failure messages are announced here; the end note is revealed after the
  // final page and is already visible when the initial page is the last.
  return html`<div class="desk-shell">
    <div class="flex">
      <aside class="no-scrollbar sticky top-0 hidden h-screen w-52 shrink-0 self-start flex-col border-r border-line/40 lg:flex">
        <div class="min-h-0 flex-1 overflow-y-auto p-2">${rail}</div>
        <div class="shrink-0 border-t border-line/40 p-2">${controls}</div>
      </aside>
      <div class="min-w-0 flex-1">
        <div class="sticky top-0 z-20 border-b border-line/40 bg-night px-3 py-2 lg:hidden">${controls}</div>
        <div id="explore-results" tabindex="-1" class="scroll-mt-14 lg:scroll-mt-4">${feed}</div>
        ${
          hasItems &&
          html`<div data-board-sentinel="true" data-cursor="${cursor}" class="flex flex-col items-center gap-2 px-3 py-6" aria-live="polite">
            <div data-board-loading="true" hidden="" class="w-full" role="status">
              <span class="sr-only">Loading more stories</span>
              ${
                initialView === 'list'
                  ? html`<div class="space-y-3" aria-hidden="true">${[1, 2, 3].map(() => html`<div class="h-16 animate-pulse border-b border-line/30 bg-overlay/5 sm:h-10"></div>`)}</div>`
                  : html`<div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-hidden="true">${[SKELETON_CARD, SKELETON_CARD, SKELETON_CARD, SKELETON_CARD]}</div>`
              }
            </div>
            <p data-board-error="true" hidden="" role="alert" class="ds-caption text-live"></p>
            <p data-board-end="true"${attr('hidden', cursor !== '')} class="ds-caption uppercase tracking-caption text-chalkdim">End of the feed</p>
          </div>`
        }
      </div>
    </div>
    ${fan}
  </div>`;
}

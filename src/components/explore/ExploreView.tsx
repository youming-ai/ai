import type { ReactNode } from 'react';
import { CATEGORIES, CATEGORY_GROUPS } from '../../categories';
import { GLOBAL_FEED_LABEL } from '../../site';
import type { ExploreFeed, ExploreFilterOption, ExploreFilterSet } from '../../types';
import ThemeSwitcher from '../ThemeSwitcher';
import ExploreCard from './ExploreCard';

// Multi-column masonry approximation. column-fill: balance evens the column
// heights as items are appended; tailwind has no built-in for it.
const MASONRY_CLASS =
  'columns-1 gap-3 p-3 [column-fill:balance] md:columns-2 xl:columns-3 2xl:columns-4';

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

/** One category link in the rail. */
function SkeletonCards({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: skeleton items have no identity
        <div key={index} className="mb-3 h-56 animate-pulse rounded-card bg-overlay/5" />
      ))}
    </>
  );
}

function FilterRow({
  label,
  count,
  active,
  href,
}: {
  label: string;
  count: number | null;
  active: boolean;
  href: string;
}) {
  const className = `flex w-full items-center gap-2 rounded-card-inset px-2 py-1.5 text-left ds-caption min-h-7 ${
    active
      ? 'bg-pitch/15 font-bold text-pitch'
      : 'text-chalkdim hover:bg-overlay/5 hover:text-chalk'
  }`;
  return (
    <a href={href} aria-current={active ? 'page' : undefined} className={className}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== null && <span className="shrink-0 tabular-nums opacity-70">{count}</span>}
    </a>
  );
}

/** Category rail: one All row, then the registry's group sections in display
 *  order. Registry joins are static on both server and client, so SSR and
 *  hydration render identically. */
function CategoryRail({
  options,
  value,
  total: providedTotal,
  hrefFor,
}: {
  options: ExploreFilterOption[];
  value: string;
  /** From the payload; undefined on a cache entry written before v2. */
  total?: number | null;
  hrefFor: (value: string) => string;
}) {
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
  return (
    <div>
      <div>
        <p className="px-2 pb-1 ds-micro uppercase tracking-caption text-chalkdim">Topics</p>
        <FilterRow label={GLOBAL_FEED_LABEL} count={total} active={!value} href={hrefFor('')} />
      </div>
      {groups.map((group) => (
        <div key={group.key}>
          <p className="px-2 pt-3 pb-1 ds-micro uppercase tracking-caption text-chalkdim">
            {group.label}
          </p>
          {group.options.map((option) => (
            <FilterRow
              key={option.value}
              label={option.label}
              count={option.count}
              active={value === option.value}
              href={hrefFor(option.value)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The board.
 *
 *  Server-rendered and **not hydrated**: `src/scripts/board.ts` handles the
 *  three things that need to happen after paint — appending the next page
 *  (fetching HTML the server already rendered), switching the theme, and
 *  starting the looping video thumbnails. Everything else here is markup.
 *
 *  That is why `view` is a prop rather than state: the toggle is two links, so
 *  switching layout is a document navigation like every other link on the page,
 *  and the URL carries the choice. */
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
}) {
  const scopeLabel = initialCategory ? (CATEGORIES[initialCategory]?.label ?? initialCategory) : '';
  const cursor = initialData.nextCursor ?? '';
  const hasItems = initialData.items.length > 0;

  const rail: ReactNode = (
    <CategoryRail
      options={initialFilters.categories}
      // The payload's total counts the rows no hub holds — an unmapped publisher
      // category is stored as NULL and shows on the global board only. Older
      // cached payloads and the registry fallback carry none, so the sum is
      // still the fallback.
      total={initialFilters.total}
      value={initialCategory}
      hrefFor={(value) => (value ? `/${value}` : '/')}
    />
  );

  const boardClass =
    initialView === 'list' ? 'divide-y divide-line/30 border-b border-line/30' : MASONRY_CLASS;
  const cards =
    initialView === 'list' ? (
      <ol
        data-board
        data-view="list"
        data-category={initialCategory}
        className={boardClass}
        aria-label="Explore links"
      >
        {initialData.items.map((article) => (
          <ExploreCard key={article.id} article={article} variant="list" />
        ))}
      </ol>
    ) : (
      // Native CSS multi-column, not a masonry lib. Fills column-major
      // (items 1..n down column 1); swap in an SSR round-robin split if
      // reading order ever has to be exact.
      <section
        data-board
        data-view="grid"
        data-category={initialCategory}
        className={boardClass}
        aria-label="Explore links"
      >
        {initialData.items.map((article, index) => (
          <ExploreCard key={article.id} article={article} priority={index < ABOVE_THE_FOLD_CARDS} />
        ))}
      </section>
    );

  const feed = !hasItems ? (
    // An outage is what SSR was handed; a client append failure is announced in
    // the sentinel instead, and never reaches this branch.
    <p className="p-16 text-center ds-body text-chalkdim">
      {initialData.unavailable
        ? 'The explore feed is temporarily unavailable. Reload in a moment.'
        : 'No links match these filters. Clear one to widen the explore feed.'}
    </p>
  ) : (
    cards
  );

  // The layout and theme controls live at the foot of the rail, so they appear
  // in the desktop column and at the bottom of the mobile disclosure — the two
  // places the rail is rendered. The theme control exists twice for the same
  // reason, and `src/scripts/board.ts` keeps both copies in step through
  // `data-theme` on the root.
  //
  // `justify-between` puts the layout toggle at the row's left edge and the
  // theme control at its right, which is the rail's own inner edge in the
  // desktop column. The two are the only children, so nothing sits between them
  // for the free space to split around.
  const controls: ReactNode = (
    <div className="flex items-center justify-between gap-2">
      <nav className="ds-segmented shrink-0" aria-label="Feed layout">
        {(['grid', 'list'] as const).map((view) => (
          <a
            key={view}
            href={`?view=${view}`}
            aria-current={initialView === view ? 'true' : undefined}
            className={`ds-seg-tab min-h-7 px-3 text-xs ${initialView === view ? 'ds-seg-tab-active' : 'ds-seg-tab-inactive'}`}
          >
            {view === 'grid' ? 'Grid' : 'List'}
          </a>
        ))}
      </nav>

      <ThemeSwitcher />
    </div>
  );

  return (
    <div className="desk-shell">
      <div className="flex">
        {/* h-screen, not 100vh minus a bar: there is no bar any more. The rail
            scrolls on its own and the controls stay pinned at its foot. */}
        <aside className="no-scrollbar sticky top-0 hidden h-screen w-52 shrink-0 self-start flex-col border-r border-line/40 lg:flex">
          <div className="min-h-0 flex-1 overflow-y-auto p-2">{rail}</div>
          <div className="shrink-0 border-t border-line/40 p-2">{controls}</div>
        </aside>

        <div className="min-w-0 flex-1">
          {/* <details> is the native disclosure — no state, no outside-click handler. */}
          <details className="border-b border-line/40 lg:hidden">
            <summary className="cursor-pointer list-none px-3 py-2 ds-caption uppercase tracking-caption text-chalkdim [&::-webkit-details-marker]:hidden">
              Categories {initialCategory ? `· ${scopeLabel}` : ''}
            </summary>
            <div className="p-2">
              {rail}
              <div className="mt-3 border-t border-line/40 pt-3">{controls}</div>
            </div>
          </details>

          {/* The skip link's target. It has to exist in every state, including
              the empty and unavailable ones, so it lives on this wrapper rather
              than on the grid/list inside `feed`. tabIndex -1 keeps it out of
              the tab order while letting the link move focus here. */}
          <div id="explore-results" tabIndex={-1} className="scroll-mt-4">
            {feed}
          </div>

          {/* Everything below is written for `src/scripts/board.ts`, which is why
              it is present but inert in the HTML: with JavaScript off the button
              does nothing rather than being a dead-looking hidden control, and
              the end-of-feed note stays server-rendered and correct. */}
          {hasItems && (
            <div
              data-board-sentinel
              data-cursor={cursor}
              className="flex flex-col items-center gap-2 py-6"
              aria-live="polite"
            >
              {/* Auto-load covers scrolling; the button is the keyboard / no-IO path. */}
              <div data-board-loading hidden className={MASONRY_CLASS} role="status">
                <span className="sr-only">Loading more stories</span>
                <SkeletonCards count={4} />
              </div>
              {cursor !== '' && (
                <button type="button" data-board-more className="ds-btn-secondary">
                  Load more stories
                </button>
              )}
              <p data-board-error hidden role="alert" className="ds-caption text-live" />
              {/* Rendered whenever there is a board, and merely hidden while
                  more pages exist: the script reveals it when the last page
                  arrives, and it cannot reveal an element that is not there. */}
              <p
                data-board-end
                hidden={cursor !== ''}
                className="ds-caption uppercase tracking-caption text-chalkdim"
              >
                End of the feed
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

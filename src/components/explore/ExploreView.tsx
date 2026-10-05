import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { CATEGORIES, CATEGORY_GROUPS } from '../../categories';
import { GLOBAL_FEED_LABEL } from '../../site';
import type { ExploreFeed, ExploreFilterOption, ExploreFilterSet } from '../../types';
import ThemeSwitcher from '../ThemeSwitcher';
import ExploreCard from './ExploreCard';

// Multi-column masonry approximation. column-fill: balance evens the column
// heights as items are appended; tailwind has no built-in for it.
const MASONRY_CLASS =
  'columns-1 gap-3 p-3 [column-fill:balance] md:columns-2 xl:columns-3 2xl:columns-4';

type ViewMode = 'grid' | 'list';

/** One API page: the hub's head when `cursor` is empty, that page of it
 *  otherwise. */
function apiUrl(category: string, cursor: string): string {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (cursor) params.set('cursor', cursor);
  params.set('limit', '24');
  return `/api/explore?${params}`;
}

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

export default function ExploreView({
  initialData,
  initialFilters,
  initialCategory = '',
}: {
  initialData: ExploreFeed;
  initialFilters: ExploreFilterSet;
  initialCategory?: string;
}) {
  // One axis of client-side state, because only one can vary without a document
  // load: the rail renders <a href> links, so switching hub remounts this island
  // with a fresh SSR payload. `cursor` is therefore the only thing that changes
  // here, and '' doubles as "the SSR'd first page is what is on screen" — which
  // is what lets the fetch effect below skip its mount run.
  const [cursor, setCursor] = useState('');
  const [items, setItems] = useState(initialData.items);
  const [nextCursor, setNextCursor] = useState(initialData.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Category pages carry a scope label for the mobile disclosure.
  const scopeLabel = initialCategory ? (CATEGORIES[initialCategory]?.label ?? initialCategory) : '';

  useEffect(() => {
    // '' is the page SSR already rendered, so the first fetch is the first
    // append. Everything below is the append path only.
    if (!cursor) return;

    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetch(apiUrl(initialCategory, cursor), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('The news feed is temporarily unavailable.');
        return (await response.json()) as ExploreFeed;
      })
      .then((feed) => {
        if (controller.signal.aborted) return;
        setItems((previous) => [...previous, ...feed.items]);
        setNextCursor(feed.nextCursor);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setError(reason instanceof Error ? reason.message : 'Could not load the news feed.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cursor, initialCategory]);

  // Infinite scroll: re-running on [nextCursor, loading] is what makes it
  // repeat. Appending rows fires no new intersection event, so the observer is
  // rebuilt after each page.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || nextCursor === null || loading) return;
    const next = nextCursor;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setCursor(next);
      },
      { rootMargin: '600px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loading, nextCursor]);

  // An outage is either what SSR was handed ("unavailable") or what a client
  // fetch reported (its message set in `error`) — neither is an empty corpus.
  const unavailable = Boolean(initialData.unavailable) || (error !== '' && items.length === 0);

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

  const feed =
    loading && items.length === 0 ? (
      <div className={MASONRY_CLASS} role="status">
        <span className="sr-only">Loading explore links</span>
        <SkeletonCards count={8} />
      </div>
    ) : items.length === 0 && unavailable ? (
      <p className="p-16 text-center ds-body text-chalkdim">
        The explore feed is temporarily unavailable. Reload in a moment.
      </p>
    ) : items.length === 0 ? (
      <p className="p-16 text-center ds-body text-chalkdim">
        No links match these filters. Clear one to widen the explore feed.
      </p>
    ) : viewMode === 'list' ? (
      <ol className="divide-y divide-line/30 border-b border-line/30" aria-label="Explore links">
        {items.map((article) => (
          <ExploreCard key={article.id} article={article} variant="list" />
        ))}
      </ol>
    ) : (
      // Native CSS multi-column, not a masonry lib. Fills column-major
      // (items 1..n down column 1); swap in an SSR round-robin split if
      // reading order ever has to be exact.
      <section className={MASONRY_CLASS} aria-label="Explore links">
        {items.map((article) => (
          <ExploreCard key={article.id} article={article} />
        ))}
      </section>
    );

  // The layout and theme controls live at the foot of the rail, so they appear
  // in the desktop column and at the bottom of the mobile disclosure — the two
  // places the rail is rendered. Both instances read one `viewMode`, and
  // ThemeSwitcher keeps its own copies in step through `data-theme`.
  const controls: ReactNode = (
    <div className="flex items-center gap-2">
      <fieldset className="ds-segmented shrink-0">
        <legend className="sr-only">Feed layout</legend>
        <button
          type="button"
          aria-pressed={viewMode === 'grid'}
          onClick={() => setViewMode('grid')}
          className={`ds-seg-tab min-h-7 px-3 text-xs ${viewMode === 'grid' ? 'ds-seg-tab-active' : 'ds-seg-tab-inactive'}`}
        >
          Grid
        </button>
        <button
          type="button"
          aria-pressed={viewMode === 'list'}
          onClick={() => setViewMode('list')}
          className={`ds-seg-tab min-h-7 px-3 text-xs ${viewMode === 'list' ? 'ds-seg-tab-active' : 'ds-seg-tab-inactive'}`}
        >
          List
        </button>
      </fieldset>

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

          {/* Only for the append path: a first-page failure is the empty state
              below, and showing both would say the same thing twice. */}
          {error && items.length > 0 && (
            <p role="alert" className="px-3 py-2 ds-caption text-live">
              {error}
            </p>
          )}

          {/* The skip link's target. It has to exist in every state, including
              the empty and unavailable ones, so it lives on this wrapper rather
              than on the grid/list inside `feed`. tabIndex -1 keeps it out of
              the tab order while letting the link move focus here. */}
          <div id="explore-results" tabIndex={-1} className="scroll-mt-4">
            {feed}
          </div>

          {/* First-load skeleton lives inside `feed`; this covers the append
              path during infinite scroll (items still present, rootMargin fires
              well before the bottom button). */}
          {loading && items.length > 0 && (
            <div className={MASONRY_CLASS} role="status" aria-live="polite">
              <span className="sr-only">Loading more stories</span>
              <SkeletonCards count={4} />
            </div>
          )}

          {/* Auto-load covers scrolling; the button is the keyboard / no-IO path. */}
          <div ref={sentinelRef} className="flex justify-center py-6" aria-live="polite">
            {nextCursor !== null ? (
              <button
                type="button"
                onClick={() => setCursor(nextCursor)}
                disabled={loading}
                className="ds-btn-secondary"
              >
                {loading ? 'Loading…' : 'Load more stories'}
              </button>
            ) : items.length > 0 ? (
              <p className="ds-caption uppercase tracking-caption text-chalkdim">End of the feed</p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

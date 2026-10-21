import ExploreCard from '../components/explore/ExploreCard';
import ExploreGridPage from '../components/explore/ExploreGridPage';
import type { ViewMode } from '../components/explore/ExploreView';
import { html } from '../components/html';
import type { ExploreArticle } from '../types';

// --- Server-rendered card fragments ---
//
// The board appends pages of cards as the reader scrolls. That used to be a
// React island's job: it fetched JSON and rendered the next page in the
// browser, which was the only reason ~46KB gzip of React shipped to a page
// whose first paint is already complete HTML.
//
// Rendering the appended cards on the server instead keeps ONE card
// implementation — the same function the first page uses, so a card cannot
// drift between the two paths the way a hand-written client template would.
// Measured cost of the alternative: at 20x CPU throttling the island produced
// 25ms of TBT, so this is a data-size trade, not a speed one.
//
// Grid pages balance independently; list items append directly into the <ol>.

/** One page of cards as HTML, ready to append. `view` picks the grid page, the
 *  list `<li>`s or the deck's stacked cards; appended cards are never above the
 *  fold, so they never get the eager/high-priority image treatment. */
export function renderExploreCards(items: ExploreArticle[], view: ViewMode): string {
  if (items.length === 0) return '';
  return view === 'grid'
    ? ExploreGridPage(items).value
    : html`${items.map((article) => ExploreCard({ article, variant: view }))}`.value;
}

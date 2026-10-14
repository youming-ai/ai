import ExploreCard from '../components/explore/ExploreCard';
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
// The fragment is deliberately *just the cards*: the caller appends them into
// the `<section>` or `<ol>` the first page already rendered.

/** One page of cards as HTML, ready to append. `view` picks the list `<li>` or
 *  the grid `<article>`; appended cards are never above the fold, so they never
 *  get the eager/high-priority image treatment. */
export function renderExploreCards(items: ExploreArticle[], view: 'grid' | 'list'): string {
  return items.map((article) => ExploreCard({ article, variant: view }).value).join('');
}

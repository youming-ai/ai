import type { ExploreArticle } from '../../types';
import { type Html, html } from '../html';
import ExploreCard from './ExploreCard';

const GRID_PAGE_CLASS =
  'columns-1 gap-3 [column-fill:balance] md:columns-2 xl:columns-3 2xl:columns-4';

/** Balance each page independently so an append cannot redistribute earlier cards. */
export default function ExploreGridPage(items: ExploreArticle[], priorityCount = 0): Html {
  return html`<div data-board-page="true" class="${GRID_PAGE_CLASS}">
    ${items.map((article, index) => ExploreCard({ article, priority: index < priorityCount }))}
  </div>`;
}

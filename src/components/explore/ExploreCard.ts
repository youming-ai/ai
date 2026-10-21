import { categoryLabel } from '../../categories';
import { sameOriginAsset, withTemporalFragment } from '../../media';
import type { ExploreArticle } from '../../types';
import { attr, type Html, html } from '../html';

/** Relative labels for recent stories; the full UTC date is always available. */
function publishedTime(timestamp: number): Html {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return html``;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return html``;
  const iso = date.toISOString();
  const age = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(age / 60_000);
  const hours = Math.floor(age / 3_600_000);
  const label =
    minutes < 1
      ? 'Just now'
      : minutes < 60
        ? `${minutes}m ago`
        : hours < 48
          ? `${hours}h ago`
          : `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
  return html`<time datetime="${iso}" title="${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC" class="shrink-0 tabular-nums">${label}</time>`;
}

export default function ExploreCard({
  article,
  variant = 'grid',
  priority = false,
}: {
  article: ExploreArticle;
  variant?: 'grid' | 'list';
  /** Above the fold: load eagerly and ask for a high fetch priority. The board
   *  is a wall of images on a bandwidth-limited link, and with every one of them
   *  lazy they queue behind each other — measured LCP was 3.2s at Slow-4G with
   *  the LCP element being a card image that had not started until layout. */
  priority?: boolean;
}): Html {
  const date = publishedTime(article.publishedAt);
  const domain = article.sourceDomain || 'source';
  const description = article.description;

  // Root-relative for our own media route (see sameOriginAsset): an <img> pinned
  // to the canonical origin breaks on any other host serving this app.
  const imageUrl = sameOriginAsset(article.imageUrl);

  // Engage the shimmer only when the image is genuinely still loading — cached
  // / already-complete images stay visible and never flash. Rendered with no
  // shimmer and no hidden state; `src/scripts/board.ts` adds it after paint,
  // which is also where a broken image gets hidden (a documented behaviour: a
  // dead feed image must not leave a broken-image icon in the board).

  if (variant === 'list') {
    // The whole row is the outbound link: with no summary page, the card's job
    // is to hand the reader straight to the source.
    return html`<li class="group px-3 py-3 hover:bg-overlay/5 sm:py-2">
      <a href="${article.url}" target="_blank" rel="noopener noreferrer" class="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-baseline sm:gap-3">
        <span class="order-2 flex min-w-0 items-baseline justify-between gap-3 ds-caption text-chalkdim sm:order-1 sm:w-44 sm:shrink-0">
          <span class="truncate">${domain}</span>
          <span class="shrink-0 sm:hidden">${date}</span>
        </span>
        <span class="order-1 line-clamp-2 min-w-0 font-display text-lead text-chalk transition-colors group-hover:text-pitch sm:order-2 sm:block sm:flex-1 sm:truncate">${article.title}</span>
        <span class="order-4 hidden ds-caption text-chalkdim sm:inline">${date}</span>
        <span class="sr-only">Opens in a new tab.</span>
      </a>
    </li>`;
  }

  // Reserve aspect-ratio so the column doesn't shift when the image loads.
  // Natural ratio when the feed gave width+height, else 16:9. object-cover
  // crops to fill; ragged card heights still come from text length + presence
  // of image.
  const frameStyle =
    article.imageWidth > 0 && article.imageHeight > 0
      ? `aspect-ratio:${article.imageWidth} / ${article.imageHeight}`
      : undefined;
  const media = article.isVideo
    ? // The feed handed us a video file, so the thumbnail is the video itself:
      // a muted loop is the only thumbnail that guarantees something visible —
      // a metadata-only preload leaves a dark box on browsers that do not paint
      // a frame from metadata alone. Muted is what makes the playback
      // permissible; nothing has audio to surprise a reader. No `autoplay`
      // attribute: playback starts from `src/scripts/board.ts`, which checks
      // reduced motion first, so a cached video cannot start looping before
      // that check runs. aria-hidden is safe here: without `controls` the
      // element is not focusable, and the wrapping link already carries the
      // article title as its name.
      html`<video data-preview="true" data-card-media="true" src="${withTemporalFragment(imageUrl)}" muted="" loop="" playsinline="" preload="none" aria-hidden="true" class="h-full w-full object-cover"></video>`
    : html`<img data-card-media="true"${attr('fetchpriority', priority && 'high')} src="${imageUrl}" alt="" decoding="async" class="h-full w-full object-cover transition-opacity duration-300 opacity-100" loading="${priority ? 'eager' : 'lazy'}"/>`;

  return html`<article class="ds-card contain-layout mb-3 overflow-hidden break-inside-avoid rounded-card border border-line/40 bg-panel/70">
    <a href="${article.url}" target="_blank" rel="noopener noreferrer" class="group block">
      <div class="flex min-w-0 items-center justify-between gap-2 border-b border-line/40 px-3 py-2 ds-caption text-chalkdim">
        <span class="truncate" title="Source: ${domain}">${domain}</span>
        <span aria-hidden="true" class="shrink-0">↗</span>
        <span class="sr-only">Opens in a new tab.</span>
      </div>
      ${imageUrl && html`<div data-image-frame="true" class="aspect-video w-full overflow-hidden bg-overlay/5"${attr('style', frameStyle)}>${media}</div>`}
      <div class="p-3">
        <h2 class="font-display text-lead font-bold leading-lead text-chalk transition-colors duration-150 group-hover:text-pitch">${article.title}</h2>
        ${description && html`<p class="mt-1.5 ds-body line-clamp-3 text-chalkdim">${description}</p>`}
        ${article.category && html`<p class="mt-3 ds-caption uppercase tracking-data text-pitch">${categoryLabel(article.category)}</p>`}
        <p class="mt-2 flex justify-end ds-caption text-chalkdim">${date}</p>
      </div>
    </a>
  </article>`;
}

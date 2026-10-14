import { categoryLabel } from '../../categories';
import { transformedFeedImage } from '../../images';
import { sameOriginAsset, withTemporalFragment } from '../../media';
import { articleDeck } from '../../site';
import type { ExploreArticle } from '../../types';
import { attr, type Html, html } from '../html';

/** UTC-only, so the server's time zone never leaks into the markup. */
function publishedDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const d = new Date(timestamp);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

function scoreValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Accent for a 0–100 signal. The top strip is editorial quality, the bottom
 *  strip is freshness — same colour language reads across both. */
function signalAccent(score: number): 'pitch' | 'amber' | 'live' {
  if (score >= 75) return 'pitch';
  if (score >= 45) return 'amber';
  return 'live';
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
  const date = publishedDate(article.publishedAt);
  const score = scoreValue(article.qualityScore);
  const domain = article.sourceDomain || 'source';
  const description = articleDeck(article);

  // The publisher's CDN is asked for a card-sized image where that is known to
  // work (see src/images.ts for the measurements). The original is carried
  // alongside whenever the two differ, because a rule that rots answers 404/400
  // rather than degrading — `src/scripts/board.ts` retries it once.
  // Root-relative for our own media route (see sameOriginAsset): an <img> pinned
  // to the canonical origin breaks on any other host serving this app.
  const imageUrl = sameOriginAsset(article.imageUrl);
  const imageSrc = transformedFeedImage(imageUrl);
  const imageFallback = imageSrc === imageUrl ? undefined : imageUrl;

  // Engage the shimmer only when the image is genuinely still loading — cached
  // / already-complete images stay visible and never flash. Rendered with no
  // shimmer and no hidden state; `src/scripts/board.ts` adds it after paint,
  // which is also where a broken image gets hidden (a documented behaviour: a
  // dead feed image must not leave a broken-image icon in the board).

  if (variant === 'list') {
    // The whole row is the outbound link: with no summary page, the card's job
    // is to hand the reader straight to the source.
    return html`<li class="group flex items-baseline gap-3 px-3 py-2 hover:bg-overlay/5">
      <a href="${article.url}" target="_blank" rel="noopener noreferrer" class="flex min-w-0 flex-1 items-baseline gap-3">
        <span class="ds-caption hidden w-44 shrink-0 truncate text-pitch sm:block"><span aria-hidden="true">&gt;_ </span>${domain}</span>
        <span class="min-w-0 flex-1 truncate font-display text-lead text-chalk transition-colors group-hover:text-pitch">${article.title}</span>
        <span aria-hidden="true" class="hidden h-2 w-2 shrink-0 rounded-pill sm:inline-block" style="background-color:rgb(var(--c-${signalAccent(score)}))"></span>
        <span class="ds-caption shrink-0 tabular-nums text-chalkdim">${date}</span>
        <span class="sr-only">Curated signal ${score} of 100, published ${date}</span>
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
    : html`<img data-card-media="true"${attr('fetchpriority', priority && 'high')} src="${imageSrc}"${attr('data-original-src', imageFallback)} alt="" decoding="async" class="h-full w-full object-cover transition-opacity duration-300 opacity-100" loading="${priority ? 'eager' : 'lazy'}"/>`;

  return html`<article class="ds-signal contain-layout mb-3 overflow-hidden break-inside-avoid rounded-card border border-line/40 bg-panel/70" style="--signal:${score}%;--signal-accent:var(--c-${signalAccent(score)})">
    <div class="flex items-center justify-between border-b border-line/40 px-3 py-1.5 ds-caption text-pitch">
      <div class="flex min-w-0 items-center gap-2"><span aria-hidden="true">&gt;_</span><span class="truncate">${domain}</span></div>
      <span class="inline-flex items-center gap-1 text-chalkdim" title="Source: ${domain}"><span class="hidden text-[10px] tracking-tight sm:inline">source</span><span aria-hidden="true">↗</span></span>
    </div>
    <a href="${article.url}" target="_blank" rel="noopener noreferrer" class="group block">
      ${imageUrl && html`<div data-image-frame="true" class="aspect-video w-full overflow-hidden bg-overlay/5"${attr('style', frameStyle)}>${media}</div>`}
      <div class="p-3">
        <h2 class="font-display text-lead font-bold leading-lead text-chalk transition-colors duration-150 group-hover:text-pitch">${article.title}</h2>
        ${description && html`<p class="mt-1.5 ds-body line-clamp-3 text-chalkdim">${description}</p>`}
        ${
          (article.category || article.tags.length > 0) &&
          html`<p class="mt-3 ds-caption uppercase tracking-data text-pitch">${article.category && categoryLabel(article.category)}${
            article.tags.length > 0 &&
            html`<span class="text-chalkdim">${article.category ? ' · ' : ''}${article.tags.slice(0, 3).join(', ')}</span>`
          }</p>`
        }
        <p class="mt-1 flex items-center gap-2 ds-caption text-chalkdim"><span class="ml-auto shrink-0 tabular-nums">${date}</span><span class="sr-only">Curated signal ${score} of 100, published ${date}</span></p>
      </div>
    </a>
  </article>`;
}

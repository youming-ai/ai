import { useEffect, useRef, useState } from 'react';
import { categoryLabel } from '../../categories';
import { withTemporalFragment } from '../../media';
import { articleDeck } from '../../site';
import type { ExploreArticle } from '../../types';

/** UTC-only so the SSR string and the hydrated string always match. */
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
}) {
  const date = publishedDate(article.publishedAt);
  const score = scoreValue(article.qualityScore);
  const domain = article.sourceDomain || 'source';
  const description = articleDeck(article);

  // Lowercase, and spread rather than written as `fetchPriority`: React 18 does
  // not know that spelling and logs "React does not recognize the
  // `fetchPriority` prop on a DOM element" — an error-level line in `astro dev`
  // — before passing it through as a custom attribute anyway. React 19 accepts
  // both, and the lowercase form is the one it forwards to the DOM. The cast is
  // only because @types/react 18 declares the camelCase name.
  const priorityAttrs = priority
    ? ({ fetchpriority: 'high' } as React.ImgHTMLAttributes<HTMLImageElement>)
    : {};

  // Engage the shimmer only when the image is genuinely still loading at
  // hydration — cached / already-complete images stay visible and never flash.
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgLoading, setImgLoading] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  useEffect(() => {
    const img = imgRef.current;
    if (img && !img.complete) setImgLoading(true);
  }, []);
  const showShimmer = imgLoading && !imgLoaded;
  // Motion runs only when the reader allows it. SSR (and the first hydration
  // pass) render the video paused with *no* `autoplay` attribute: a rendered
  // `autoplay` can start before the island hydrates, so cached media or slow
  // JavaScript would otherwise expose reduced-motion readers to the looping
  // motion this guard intends to suppress.
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      if (query.matches) {
        // Pause on a real frame, not an empty box: a paused video with
        // preload="none" loads nothing, so fetch metadata explicitly.
        video.preload = 'metadata';
        video.load();
        video.pause();
        return;
      }
      void video.play().catch(() => {
        /* autoplay blocked after all — the first frame still shows */
      });
    };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  if (variant === 'list') {
    // The whole row is the outbound link: with no summary page, the card's job
    // is to hand the reader straight to the source.
    return (
      <li className="group flex items-baseline gap-3 px-3 py-2 hover:bg-overlay/5">
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 flex-1 items-baseline gap-3"
        >
          <span className="ds-caption hidden w-44 shrink-0 truncate text-pitch sm:block">
            <span aria-hidden="true">&gt;_ </span>
            {domain}
          </span>
          <span className="min-w-0 flex-1 truncate font-display text-lead text-chalk transition-colors group-hover:text-pitch">
            {article.title}
          </span>
          <span
            aria-hidden="true"
            className="hidden h-2 w-2 shrink-0 rounded-pill sm:inline-block"
            style={{ backgroundColor: `rgb(var(--c-${signalAccent(score)}))` }}
          />
          <span className="ds-caption shrink-0 tabular-nums text-chalkdim">{date}</span>
          <span className="sr-only">
            Curated signal {score} of 100, published {date}
          </span>
        </a>
      </li>
    );
  }

  const accent = signalAccent(score);
  return (
    <article
      className="ds-signal contain-layout mb-3 overflow-hidden break-inside-avoid rounded-card border border-line/40 bg-panel/70"
      style={
        {
          '--signal': `${score}%`,
          '--signal-accent': `var(--c-${accent})`,
        } as React.CSSProperties
      }
    >
      <div className="flex items-center justify-between border-b border-line/40 px-3 py-1.5 ds-caption text-pitch">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true">&gt;_</span>
          <span className="truncate">{domain}</span>
        </div>
        <span className="inline-flex items-center gap-1 text-chalkdim" title={`Source: ${domain}`}>
          <span className="hidden text-[10px] tracking-tight sm:inline">source</span>
          <span aria-hidden="true">↗</span>
        </span>
      </div>

      <a href={article.url} target="_blank" rel="noopener noreferrer" className="group block">
        {article.imageUrl && (
          // Reserve aspect-ratio so the column doesn't shift when the image
          // loads. Natural ratio when the feed gave width+height, else 16:9.
          // object-cover crops to fill; ragged card heights still come from
          // text length + presence of image.
          <div
            className={`aspect-video w-full overflow-hidden bg-overlay/5${showShimmer ? ' animate-pulse' : ''}`}
            style={
              article.imageWidth > 0 && article.imageHeight > 0
                ? { aspectRatio: `${article.imageWidth} / ${article.imageHeight}` }
                : undefined
            }
          >
            {article.isVideo ? (
              // The feed handed us a video file, so the thumbnail is the video
              // itself: a muted loop is the only thumbnail that guarantees
              // something visible — a metadata-only preload leaves a dark box
              // on browsers that do not paint a frame from metadata alone.
              // Muted is what makes the playback permissible; nothing has audio
              // to surprise a reader. It starts from an effect (never an
              // `autoplay` attribute — see above) so reduced-motion readers are
              // never exposed, even before hydration. aria-hidden is safe here:
              // without `controls` the element is not focusable, and the
              // wrapping link already carries the article title as its name.
              // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a control-less <video> is not in the tab order
              <video
                ref={videoRef}
                src={withTemporalFragment(article.imageUrl)}
                muted
                loop
                playsInline
                preload="none"
                aria-hidden="true"
                onError={(event) => {
                  event.currentTarget.style.display = 'none';
                }}
                className="h-full w-full object-cover"
              />
            ) : (
              <img
                ref={imgRef}
                {...priorityAttrs}
                src={article.imageUrl}
                alt=""
                decoding="async"
                className={`h-full w-full object-cover transition-opacity duration-300${showShimmer ? ' opacity-0' : ' opacity-100'}`}
                loading={priority ? 'eager' : 'lazy'}
                onLoad={() => setImgLoaded(true)}
                onError={(event) => {
                  event.currentTarget.style.display = 'none';
                }}
              />
            )}
          </div>
        )}
        <div className="p-3">
          <h2 className="font-display text-lead font-bold leading-lead text-chalk transition-colors duration-150 group-hover:text-pitch">
            {article.title}
          </h2>
          {description && (
            <p className="mt-1.5 ds-body line-clamp-3 text-chalkdim">{description}</p>
          )}

          {(article.category || article.tags.length > 0) && (
            <p className="mt-3 ds-caption uppercase tracking-data text-pitch">
              {article.category && categoryLabel(article.category)}
              {article.tags.length > 0 && (
                <span className="text-chalkdim">
                  {article.category ? ' · ' : ''}
                  {article.tags.slice(0, 3).join(', ')}
                </span>
              )}
            </p>
          )}
          <p className="mt-1 flex items-center gap-2 ds-caption text-chalkdim">
            <span className="ml-auto shrink-0 tabular-nums">{date}</span>
            <span className="sr-only">
              Curated signal {score} of 100, published {date}
            </span>
          </p>
        </div>
      </a>
    </article>
  );
}

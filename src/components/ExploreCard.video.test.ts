import { describe, expect, it } from 'vitest';
import type { ExploreArticle } from '../types';
import ExploreCard from './explore/ExploreCard';
import type { Html } from './html';

/** Parses the rendered card the way the browser receives it. */
function render(markup: Html): { container: HTMLElement } {
  const container = document.createElement('div');
  container.innerHTML = markup.value;
  return { container };
}

// The card's video preview is the one place the app animates without the reader
// asking. What can be pinned here is the markup: the looping attributes that
// make the playback permissible, and the *absence* of `autoplay` — a rendered
// autoplay can start before the script that checks reduced motion has run.
//
// The playback behaviour itself (start, pause on reduced motion, follow a
// preference change) is `src/scripts/board.ts` now and is tested there; this
// card is rendered on the server and nothing in the browser renders it again.

const video: ExploreArticle = {
  id: 'v1',
  title: 'Launch film',
  description: '',
  url: 'https://o.doubao.com/',
  imageUrl: 'https://cdn.example.com/hero_1080p_video.mp4',
  isVideo: true,
  imageWidth: 0,
  imageHeight: 0,
  sourceDomain: 'o.doubao.com',
  publishedAt: 1789434835000,
  category: 'tools',
};

describe('ExploreCard video preview markup', () => {
  it('never renders an autoplay attribute, and preloads nothing', () => {
    // The markup is the string that ships, so the looping attributes are real
    // attributes here — `muted` included, which React never rendered.
    const { container } = render(ExploreCard({ article: video }));
    const element = container.querySelector('video');

    expect(element).not.toBeNull();
    // A rendered autoplay would start the loop before the script that checks
    // reduced motion has run.
    expect(element!.hasAttribute('autoplay')).toBe(false);
    expect(element!.getAttribute('preload')).toBe('none');
    for (const name of ['muted', 'loop', 'playsinline']) {
      expect(element!.hasAttribute(name), name).toBe(true);
    }
  });

  it('marks the preview for the script that starts it', () => {
    // Without this hook a video thumbnail would never play: the component is
    // rendered once, on the server, so there is nothing else to start it.
    const { container } = render(ExploreCard({ article: video }));
    expect(container.querySelector('video')?.hasAttribute('data-preview')).toBe(true);
    expect(container.querySelector('[data-image-frame]')).not.toBeNull();
  });

  it('keeps the preview decorative', () => {
    // A control-less, loop-only video has nothing to announce, and the wrapping
    // link already carries the article title.
    const { container } = render(ExploreCard({ article: video }));
    const element = container.querySelector('video');
    expect(element!.getAttribute('aria-hidden')).toBe('true');
    expect(element!.hasAttribute('aria-label')).toBe(false);
  });

  it('seeks to a first frame rather than starting at zero', () => {
    // A metadata-only preload paints nothing on some browsers unless the URL
    // asks for a moment past the start.
    const { container } = render(ExploreCard({ article: video }));
    expect(container.querySelector('video')!.getAttribute('src')).toContain('#t=0.1');
  });
});

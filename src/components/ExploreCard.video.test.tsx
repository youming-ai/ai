import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ExploreArticle } from '../types';
import ExploreCard from './explore/ExploreCard';

// The card's video preview is the one place the app animates without the reader
// asking. What can be pinned here is the markup: the looping attributes that
// make the playback permissible, and the *absence* of `autoplay` — a rendered
// autoplay can start before the script that checks reduced motion has run.
//
// The playback behaviour itself (start, pause on reduced motion, follow a
// preference change) is `src/scripts/board.ts` now and is tested there; this
// component is server-rendered and never hydrated.

const video: ExploreArticle = {
  id: 'v1',
  title: 'Launch film',
  description: '',
  summary: '',
  blurb: '',
  url: 'https://o.doubao.com/',
  imageUrl: 'https://cdn.example.com/hero_1080p_video.mp4',
  isVideo: true,
  imageWidth: 0,
  imageHeight: 0,
  sourceDomain: 'o.doubao.com',
  publishedAt: 1789434835000,
  category: 'tools',
  tags: ['tools'],
  qualityScore: 90,
  freshnessScore: 100,
};

describe('ExploreCard video preview markup', () => {
  it('never renders an autoplay attribute, and preloads nothing', () => {
    // `muted`/`loop`/`playsInline` are asserted against the *server-rendered*
    // markup in ssr.test.tsx — that is what ships. React sets them as DOM
    // properties on the client, so `hasAttribute` is false here even though the
    // rendered HTML carries them, and asserting it here would be a lie about
    // what the browser receives.
    const { container } = render(<ExploreCard article={video} />);
    const element = container.querySelector('video');

    expect(element).not.toBeNull();
    // A rendered autoplay would start the loop before the script that checks
    // reduced motion has run.
    expect(element!.hasAttribute('autoplay')).toBe(false);
    expect(element!.getAttribute('preload')).toBe('none');
  });

  it('marks the preview for the script that starts it', () => {
    // Without this hook a video thumbnail would never play: the component is
    // not hydrated, so there is nothing else to start it.
    const { container } = render(<ExploreCard article={video} />);
    expect(container.querySelector('video')?.hasAttribute('data-preview')).toBe(true);
    expect(container.querySelector('[data-image-frame]')).not.toBeNull();
  });

  it('keeps the preview decorative', () => {
    // A control-less, loop-only video has nothing to announce, and the wrapping
    // link already carries the article title.
    const { container } = render(<ExploreCard article={video} />);
    const element = container.querySelector('video');
    expect(element!.getAttribute('aria-hidden')).toBe('true');
    expect(element!.hasAttribute('aria-label')).toBe(false);
  });

  it('seeks to a first frame rather than starting at zero', () => {
    // A metadata-only preload paints nothing on some browsers unless the URL
    // asks for a moment past the start.
    const { container } = render(<ExploreCard article={video} />);
    expect(container.querySelector('video')!.getAttribute('src')).toContain('#t=0.1');
  });
});

import { describe, expect, it } from 'vitest';
import { feedImageTransform, transformedFeedImage } from './images';

// The table is a set of promises about somebody else's CDN. Each assertion here
// records a measurement from `bun scripts/perf-image-transform-probe.ts`, so a
// change to a host's convention fails here rather than in production.

describe('transformedFeedImage', () => {
  it('asks Contentful for webp at the card width', () => {
    // Measured: 1241 KB PNG -> 58 KB webp. All three parameters matter — `?w=900`
    // alone returned 665 KB and `?w=900&fm=webp` 533 KB.
    expect(transformedFeedImage('https://images.ctfassets.net/a/b/photo.png')).toBe(
      'https://images.ctfassets.net/a/b/photo.png?w=900&fm=webp&q=75',
    );
  });

  it('asks Shopify for the width only, never a height', () => {
    // `&height=` measured 106 KB against 122 KB, and crops to do it. A
    // letterboxing transform is not worth 16 KB on a card.
    const out = transformedFeedImage('https://cdn.shopify.com/s/files/1/photo.jpg');
    expect(out).toBe('https://cdn.shopify.com/s/files/1/photo.jpg?width=900');
    expect(out).not.toContain('height');
  });

  it('uses the named variant for Twitter, because no width works there', () => {
    // Measured: 44 KB jpeg -> 9 KB webp. Every width-shaped parameter tested
    // answered 404 on this host.
    expect(transformedFeedImage('https://pbs.twimg.com/media/abc.jpg')).toBe(
      'https://pbs.twimg.com/media/abc.jpg?format=webp&name=small',
    );
  });

  it('appends to an existing query with & rather than a second ?', () => {
    // Feed URLs routinely carry tracking parameters; a stray second `?` would
    // make the whole parameter string part of the first value.
    expect(transformedFeedImage('https://images.ctfassets.net/a/b/photo.png?v=2')).toBe(
      'https://images.ctfassets.net/a/b/photo.png?v=2&w=900&fm=webp&q=75',
    );
  });

  it('matches subdomains of a measured host', () => {
    expect(feedImageTransform('https://images.eu.ctfassets.net/a/b.png')).not.toBeNull();
  });

  it('leaves every host it has not measured exactly as it was', () => {
    // The default has to be "do nothing": a rewriter that guesses would break
    // hosts nobody has checked. These are the biggest images in the live feed,
    // and all of them measured as un-transformable.
    for (const url of [
      'https://storage.ghost.io/c/1/2/photo.png',
      'https://storage.googleapis.com/bucket/photo.png',
      'https://cdn.sanity.io/images/p/d/photo.png',
      'https://assets.vercel.com/image/photo.png',
      'https://framerusercontent.com/images/photo.png',
      'https://cdn.prod.website-files.com/1/photo.png',
    ]) {
      expect(transformedFeedImage(url), url).toBe(url);
    }
  });

  it('returns non-URL input untouched instead of throwing', () => {
    for (const value of ['', 'not a url', '/og.png', 'data:image/png;base64,AAAA']) {
      expect(transformedFeedImage(value), value).toBe(value);
    }
  });

  it('is idempotent, so a URL cannot collect the parameters twice', () => {
    // The first page and an appended fragment both render the same article. If
    // this appended on every call, a URL that had already been through it would
    // grow a second copy of the parameters, which a host is free to reject.
    for (const url of [
      'https://images.ctfassets.net/a/b/photo.png',
      'https://cdn.shopify.com/s/files/1/photo.jpg',
      'https://pbs.twimg.com/media/abc.jpg',
    ]) {
      const once = transformedFeedImage(url);
      expect(transformedFeedImage(once), url).toBe(once);
    }
  });
});

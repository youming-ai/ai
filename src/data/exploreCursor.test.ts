// @vitest-environment node
import { describe, expect, it } from 'vitest';
// The module under test, imported directly rather than through the src/data/api
// facade — which does not re-export the codec at all: the facade deliberately
// exposes `explore.ts` and `sitemapData.ts` and leaves these two pure halves
// internal, so importing the seam is the only way in as well as the point of it.
import { parseExploreCursor } from './exploreCursor';

describe('parseExploreCursor', () => {
  it('splits a cursor into its published_at and id parts', () => {
    expect(parseExploreCursor('1785991006396:abc123')).toEqual([1785991006396, 'abc123']);
  });

  it('returns null for anything unusable, so the caller falls back to page one', () => {
    for (const bad of [
      undefined,
      '',
      'nocolon',
      ':abc',
      '1785991006396:',
      'abc:def',
      // The pre-v6 `<day>:<quality>:<published_at>:<id>` cursor from a page
      // still open in a tab must collapse, not read as a 1970 timestamp.
      '20530:91:1785991006396:abc123',
    ]) {
      expect(parseExploreCursor(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('rejects the old numeric offset cursors rather than misreading them', () => {
    // Pre-keyset clients sent "12"/"36". Those must not parse into a boundary.
    expect(parseExploreCursor('12')).toBeNull();
    expect(parseExploreCursor('36')).toBeNull();
  });

  it('keeps a negative published_at, which a pre-1970 pubDate legitimately is', () => {
    // parseRss stores such a date as-is; rejecting it would make the row
    // listable while its next page collapsed to page one.
    expect(parseExploreCursor('-315619200000:abc')).toEqual([-315619200000, 'abc']);
    expect(parseExploreCursor('0:abc')).toEqual([0, 'abc']);
  });
});

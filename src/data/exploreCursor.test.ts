// @vitest-environment node
import { describe, expect, it } from 'vitest';
// The module under test, not the facade: reachable via src/data/api.ts too, but
// importing the seam directly is what makes the split worth having.
import { parseExploreCursor } from './exploreCursor';

describe('parseExploreCursor', () => {
  it('splits a cursor into its day, quality, published_at, and id parts', () => {
    expect(parseExploreCursor('20530:91:1785991006396:abc123')).toEqual([
      20530,
      91,
      1785991006396,
      'abc123',
    ]);
  });

  it('keeps colons that belong to the id', () => {
    // Article ids are SHA-256 hex today, but splitting on the first three colons
    // means an id that ever contains one still round-trips.
    expect(parseExploreCursor('20530:70:1700000000000:a:b:c')).toEqual([
      20530,
      70,
      1700000000000,
      'a:b:c',
    ]);
  });

  it('returns null for anything unusable, so the caller falls back to page one', () => {
    for (const bad of [
      undefined,
      '',
      'nocolon',
      ':abc',
      '91:1785991006396:abc123', // legacy 3-part cursor — must collapse, not misread
      '20530:91:1785991006396:',
      '20530:91::abc',
      'abc:def:ghi:jkl',
    ]) {
      expect(parseExploreCursor(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('rejects the old numeric offset cursors rather than misreading them', () => {
    // Pre-keyset clients sent "12"/"36". Those must not parse into a boundary.
    expect(parseExploreCursor('12')).toBeNull();
    expect(parseExploreCursor('36')).toBeNull();
  });

  it('rejects the one part that cannot be negative, and keeps the ones that can', () => {
    // quality_score is a 0-100 authority score, so a negative one is not a row
    // this corpus can produce.
    expect(parseExploreCursor('20714:-1:1789707171000:abc')).toBeNull();

    // day_bucket and published_at are legitimately negative for a pre-1970
    // pubDate, which parseRss stores as-is and migration 0015 buckets by floor.
    // Treating those as impossible would make such a row listable while its
    // next page collapsed to page one — an unfinishable pagination.
    expect(parseExploreCursor('-1:80:-315619200000:abc')).toEqual([-1, 80, -315619200000, 'abc']);
    // And the epoch boundary itself.
    expect(parseExploreCursor('0:0:0:abc')).toEqual([0, 0, 0, 'abc']);
  });
});

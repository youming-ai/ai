import { describe, expect, it } from 'vitest';
import { FEED_SOURCES, INGEST_MAX_AGE_MS } from './sources';

describe('feed sources', () => {
  it('has unique ids and https urls', () => {
    expect(new Set(FEED_SOURCES.map((source) => source.id)).size).toBe(FEED_SOURCES.length);
    for (const source of FEED_SOURCES) {
      expect(source.url.startsWith('https://'), source.id).toBe(true);
      expect(source.authorityScore).toBeGreaterThan(0);
      expect(source.authorityScore).toBeLessThanOrEqual(100);
    }
  });

  it('caps every source, so no tick can be handed an unbounded feed', () => {
    // The cap is not decorative: openai.com/news returned 1247 items when the
    // desk was built, and without a cap the first tick stores the whole archive.
    // A missing cap would be `slice(0, undefined)` — i.e. no cap at all — which is why the
    // field is required by the type rather than optional with a default.
    for (const source of FEED_SOURCES) {
      expect(source.maxItems, `${source.id} has a cap`).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps the freshness window at a week', () => {
    // The number is the desk's latency budget. Pinned so a
    // change is deliberate rather than incidental.
    expect(INGEST_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('files the desk under ids the registry can render', () => {
    for (const source of FEED_SOURCES) {
      // The id is a D1 key and appears in run logs and health output.
      expect(source.id, source.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(source.name.length).toBeGreaterThan(0);
      expect(source.kind).toBe('rss');
      expect(new URL(source.url).protocol).toBe('https:');
    }
  });

  it('reads Poche Explore as the only upstream', () => {
    expect(FEED_SOURCES.map((source) => source.id)).toEqual(['poche-explore']);
  });
});

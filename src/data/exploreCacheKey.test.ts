// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './api';
import { serveExplore } from './api';

// The explore cache key embeds the whole normalised query, so any part of it a
// caller controls freely is a part of the KV keyspace they control freely.
// `q` used to be one: four requests varying only it left four keys behind —
//   explore:{"q":"aaa13317","limit":1} … explore:{"q":"probe19102","limit":1}
// Nothing authenticates /api/explore, so that was an unbounded write amplifier.
// Free-text search is gone now; the cursor is the remaining caller-controlled
// field, and these tests keep it out of the key space.

function harness(rows: unknown[] = []) {
  const puts: string[] = [];
  const env = {
    CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(async (key: string) => {
        puts.push(key);
      }),
    },
    DB: {
      prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }),
    },
  } as unknown as Env;
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      void p;
    },
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
  return { env, ctx, puts };
}

afterEach(() => vi.restoreAllMocks());

describe('explore cache keys', () => {
  it('still caches the queries the rail generates', async () => {
    const { env, ctx, puts } = harness();
    await serveExplore({ category: 'tools' }, env, ctx);
    expect(puts).toHaveLength(1);
    expect(decodeURIComponent(puts[0]!)).toContain('"category":"tools"');
  });

  it('collapses a malformed cursor onto the first page instead of a new key', async () => {
    const { env, ctx, puts } = harness();
    for (const cursor of [
      'garbage',
      'x'.repeat(120),
      '12',
      ':abc',
      '',
      '1786080856000:abc123',
      '85:1786080856000:abc123',
    ]) {
      await serveExplore({ cursor }, env, ctx);
    }
    // Every one normalises to no cursor, so they share the single page-one key.
    expect(new Set(puts).size).toBe(1);
    expect(decodeURIComponent(puts[0]!)).not.toContain('cursor');
  });

  it('never writes a KV entry for a request that carries a cursor', async () => {
    // Regression: a well-formed cursor used to land in the cache key verbatim.
    // Re-serialising it is not a bound — the id is taken as-is and the three
    // numbers only have to be finite — so an unauthenticated caller could grind
    // /api/explore?cursor=… and mint a fresh KV key per request. Deep pages now
    // go straight to D1.
    const { env, ctx, puts } = harness();
    for (const cursor of [
      '20530:85:1786080856000:abc123',
      '20530:85:1786080856000:zzzz',
      '20530.5:85:1786080856000:abc123',
    ]) {
      await serveExplore({ cursor }, env, ctx);
    }
    expect(puts).toHaveLength(0);
  });
});

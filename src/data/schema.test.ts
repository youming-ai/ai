// @vitest-environment node
// The one suite that executes real SQL.
//
// Every other test hands the data layer a `vi.fn()` that never parses a
// statement and always succeeds, so a renamed column, a missing index or a
// 20-vs-21 placeholder mismatch ships green — the same shape of gap that once
// let a /media route sit in an unreachable file while the suite passed. Here the
// migrations build a real SQLite database, a thin D1 shim puts it behind
// `env.DB`, and the production functions run their own statements against it.
//
// `node:sqlite` is unflagged from Node 22.13, and Bun implements it too; the
// floor is declared in package.json `engines`, because an older runtime cannot
// collect this file at all. `bun:sqlite` would avoid the floor but ships no
// types, and this repo typechecks its tests.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { storeArticle } from '../feeds/enrich';
import type { RawArticle } from '../feeds/types';
import type { ExploreFeed } from '../types';
import type { Env } from './api';
import { getExploreFeed, getExploreFilters, getSitemapNews } from './api';
// Not re-exported by the facade: the legacy-redirect module is imported directly
// by its route, so this suite imports it the same way the route does.
import { serveArticleRedirect } from './article';

const MIGRATIONS_DIR = resolve(process.cwd(), 'db/migrations');

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of files) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8'));
  }
  // `articles.source_id` is a real foreign key, so a row cannot exist without
  // its source. (The stubbed tests never notice; this one does.)
  db.prepare(
    `INSERT INTO sources (id, kind, name, url, authority_score, enabled, created_at, updated_at)
     VALUES ('poche-explore', 'rss', 'Poche Explore', 'https://poche.app/explore/rss', 90, 1, ?, ?)`,
  ).run(PUBLISHED_AT, PUBLISHED_AT);
  return db;
}

/** The D1 surface the app actually uses (prepare/bind/all/first/run/batch).
 *  Every prepared statement is recorded so a test can EXPLAIN the real SQL
 *  rather than a copy of it that would not move when the source changes. */
function envFor(db: DatabaseSync, prepared: string[] = []): Env {
  const prepare = (sql: string) => {
    prepared.push(sql);
    const statement = db.prepare(sql);
    const api = {
      params: [] as unknown[],
      bind(...params: unknown[]) {
        api.params = params;
        return api;
      },
      async all() {
        return { results: statement.all(...(api.params as never[])) };
      },
      async first() {
        return (statement.get(...(api.params as never[])) ?? null) as never;
      },
      async run() {
        const result = statement.run(...(api.params as never[]));
        return { meta: { changes: Number(result.changes) } };
      },
    };
    return api;
  };
  return {
    DB: {
      prepare,
      // D1 runs a batch as one transaction, so a later failure leaves no earlier
      // write behind. `Promise.all` would let an ingest test observe partial
      // writes production can never produce.
      async batch(statements: { all(): Promise<unknown> }[]) {
        db.exec('BEGIN');
        try {
          const results: unknown[] = [];
          for (const statement of statements) results.push(await statement.all());
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    },
    CACHE: { get: async () => null, put: async () => undefined },
  } as unknown as Env;
}

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const PUBLISHED_AT = Date.parse('2026-09-10T09:00:00Z');

function seed(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: 'f'.repeat(64),
    source_id: 'poche-explore',
    canonical_url: 'https://example.com/story',
    fingerprint: 'f'.repeat(64),
    title: 'A seeded story',
    title_norm: 'a seeded story',
    description: 'Teaser',
    ai_summary: 'Teaser',
    ai_blurb: 'Teaser',
    image_url: '',
    image_width: 0,
    image_height: 0,
    published_at: PUBLISHED_AT,
    fetched_at: PUBLISHED_AT,
    category: 'tools',
    article_type: 'link',
    is_on_topic: 1,
    quality_score: 90,
    freshness_score: 0,
    status: 'published',
    created_at: PUBLISHED_AT,
    updated_at: PUBLISHED_AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO articles (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...(Object.values(row) as never[]));
}

describe('migrations', () => {
  it('apply in order to an empty database', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    expect(() => migratedDatabase()).not.toThrow();
  });

  it('build the indexes the hot queries are planned against', () => {
    const db = migratedDatabase();
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((row) => row.name);
    // Not decoration: the feed's predicate and the ingest dedupe are planned
    // against these, and a migration that drops one silently turns a seek into
    // a scan.
    expect(indexes).toContain('idx_articles_published');
    expect(indexes).toContain('idx_articles_category');
    expect(indexes).toContain('idx_articles_source');
    // Nothing reads title_norm or the curator's queue any more (0021).
    expect(indexes).not.toContain('idx_articles_title_norm');
    expect(indexes).not.toContain('idx_articles_pending_curation');
    // The feed's sort and keyset seek are planned against these.
    expect(indexes).toContain('idx_feed_global');
    expect(indexes).toContain('idx_feed_category');
  });

  it('buckets by floor, including pre-1970 timestamps', () => {
    // 0014 divided with `/`, which truncates toward zero: a negative timestamp
    // landed one bucket low and could intermix with the epoch day. Those inputs
    // are reachable (`Date.parse` accepts a pre-1970 date), and the documented
    // contract is floor, so this walks both sides of every boundary.
    const db = migratedDatabase();
    const DAY = 86_400_000;
    for (const ms of [0, DAY, DAY + 1, -1, -DAY, -DAY + 1, -DAY - 1, -2 * DAY, 1_789_707_171_000]) {
      seed(db, {
        id: `b${ms}`,
        fingerprint: `fp-b${ms}`,
        canonical_url: `https://example.com/b/${ms}`,
        published_at: ms,
      });
    }

    const rows = db.prepare('SELECT published_at, day_bucket FROM articles').all() as {
      published_at: number;
      day_bucket: number;
    }[];
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row.day_bucket, `published_at=${row.published_at}`).toBe(
        Math.floor(row.published_at / DAY),
      );
    }
  });
});

describe('the explore queries run against the migrated schema', () => {
  it('returns a seeded published row through the real projection and mapper', async () => {
    const db = migratedDatabase();
    seed(db);
    const feed = await getExploreFeed({}, envFor(db), ctx);

    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      id: 'f'.repeat(64),
      title: 'A seeded story',
      url: 'https://example.com/story',
      category: 'tools',
      isVideo: false,
      publishedAt: PUBLISHED_AT,
    });
    expect(feed.nextCursor).toBeNull();
  });

  it('excludes rows the feed must not show', async () => {
    const db = migratedDatabase();
    seed(db, {
      id: 'a'.repeat(64),
      fingerprint: 'a'.repeat(64),
      canonical_url: 'https://example.com/archived',
      status: 'archived',
    });
    seed(db, {
      id: 'b'.repeat(64),
      fingerprint: 'b'.repeat(64),
      canonical_url: 'https://example.com/filtered',
      status: 'filtered',
    });
    const feed = await getExploreFeed({}, envFor(db), ctx);
    expect(feed.items).toHaveLength(0);
  });

  it('runs the filters aggregate', async () => {
    const db = migratedDatabase();
    seed(db);
    const filters = await getExploreFilters(envFor(db), ctx);
    expect(filters.categories).toEqual([expect.objectContaining({ value: 'tools', count: 1 })]);
  });

  it('runs the sitemap aggregate and maps its timestamp', async () => {
    const db = migratedDatabase();
    seed(db);
    const { hubs } = await getSitemapNews(envFor(db), ctx);
    expect(hubs).toEqual([{ category: 'tools', lastmod: new Date(PUBLISHED_AT).toISOString() }]);
  });

  it('runs the legacy redirect lookup', async () => {
    const db = migratedDatabase();
    seed(db);
    const response = await serveArticleRedirect('f'.repeat(64), envFor(db));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://example.com/story');
  });
});

describe('the D1 shim', () => {
  it('rolls a whole batch back when one statement fails', async () => {
    // D1's batch is transactional. If the shim were `Promise.all`, an ingest
    // test could observe a partial write that production can never produce —
    // and `ensureSources` writes its sources through `batch`.
    const db = migratedDatabase();
    const env = envFor(db) as unknown as { DB: { prepare(sql: string): unknown } };
    const insert = (id: string, name: string) =>
      (
        env.DB.prepare(
          `INSERT INTO sources (id, kind, name, url, authority_score, enabled, created_at, updated_at)
         VALUES (?, 'rss', ?, 'https://example.com/rss', 80, 1, ?, ?)`,
        ) as { bind(...params: unknown[]): unknown }
      ).bind(id, name, PUBLISHED_AT, PUBLISHED_AT);

    const statements = [
      insert('first', 'First'),
      // Same primary key: the second insert cannot succeed.
      insert('first', 'Duplicate'),
    ];
    await expect(
      (env.DB as unknown as { batch(s: unknown[]): Promise<unknown> }).batch(statements),
    ).rejects.toThrow();

    const count = db.prepare("SELECT COUNT(*) AS n FROM sources WHERE id = 'first'").get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });
});

describe('storeArticle', () => {
  const article: RawArticle = {
    sourceId: 'poche-explore',
    sourceName: 'Poche Explore',
    category: 'Tools',
    title: 'A stored story',
    description: 'Teaser',
    url: 'https://example.com/stored',
    canonicalUrl: 'https://example.com/stored',
    imageUrl: '',
    imageWidth: 0,
    imageHeight: 0,
    publishedAt: PUBLISHED_AT,
    fetchedAt: PUBLISHED_AT,
    fingerprint: 'c'.repeat(64),
  };

  it('writes a row the feed can read back', async () => {
    // This is the placeholder-count assertion: 21 columns against 21 binds is
    // invisible to a stubbed `prepare`.
    const db = migratedDatabase();
    const env = envFor(db);
    // Returns whether a row landed: the statement is ON CONFLICT DO NOTHING, so
    // this is the only way the caller can report what it stored.
    await expect(storeArticle(env, article)).resolves.toBe(true);

    const feed = await getExploreFeed({}, env, ctx);
    expect(feed.items.map((item) => item.title)).toEqual(['A stored story']);
  });

  it('is idempotent on a repeated fingerprint, and says so', async () => {
    const db = migratedDatabase();
    const env = envFor(db);
    expect(await storeArticle(env, article)).toBe(true);
    // The second insert conflicts, writes nothing, and must not be reported as
    // stored — that overcount is what the report carried before.
    expect(await storeArticle(env, article)).toBe(false);
    const count = db.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('the rail total counts the rows no hub holds', () => {
  it('includes the NULL-category row that appears only on the global board', async () => {
    // The bug this pins: the query filtered `category IS NOT NULL`, so a story
    // whose publisher category is not in the registry — stored as NULL, shown
    // on the global board — was missing from "All links". The rail then
    // undercounted the board it sits next to, for as long as the drift lasted.
    const db = migratedDatabase();
    const env = envFor(db);
    seed(db, {
      id: 'mapped',
      fingerprint: 'fp-mapped',
      canonical_url: 'https://example.com/mapped',
      category: 'tools',
    });
    seed(db, {
      id: 'unmapped',
      fingerprint: 'fp-unmapped',
      canonical_url: 'https://example.com/unmapped',
      // What storeArticle writes for an unrecognised publisher category.
      category: null,
    });

    const filters = await getExploreFilters(env, ctx);
    expect(filters.categories.map((option) => option.value)).toEqual(['tools']);
    expect(filters.categories[0]?.count).toBe(1);
    // Both rows, not just the one with a hub.
    expect(filters.total).toBe(2);
  });
});

describe('the feed query is planned against the index', () => {
  // The shape that was broken once: when the sort key was an expression,
  // neither the ORDER BY nor the keyset predicate could use an index — every
  // page sorted the whole live partition in a temp B-tree.
  //
  // The statement under test is the one queryExplore actually prepared, captured
  // off the D1 shim. A copy written here would keep passing after the source it
  // mirrors changed, which is the failure this whole file exists to avoid.
  const FEED_CURSOR = '1789634400000:x';

  it('seeks instead of sorting the partition, with and without a category', async () => {
    for (const query of [{}, { category: 'tools' }]) {
      const db = migratedDatabase();
      const prepared: string[] = [];
      const env = envFor(db, prepared);
      await getExploreFeed({ ...query, limit: 5 }, env, ctx);
      await getExploreFeed({ ...query, limit: 5, cursor: FEED_CURSOR }, env, ctx);

      const feedStatements = prepared.filter(
        (sql) => sql.includes('FROM articles a') && sql.includes('ORDER BY'),
      );
      // Both the first page and the cursor page were exercised.
      expect(feedStatements.length, 'feed statement prepared').toBeGreaterThanOrEqual(2);
      expect(feedStatements.some((sql) => sql.includes('(a.published_at, a.id) < (?, ?)'))).toBe(
        true,
      );

      for (const sql of feedStatements) {
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
          .map((row) => row.detail)
          .join(' | ');
        expect(plan, `plan: ${plan}`).toContain('USING INDEX idx_feed_');
        expect(plan, `plan: ${plan}`).not.toContain('TEMP B-TREE');
        expect(plan, `plan: ${plan}`).not.toContain('SCAN');
      }
    }
  });
});

describe('keyset pagination over real rows', () => {
  const TIE = Date.parse('2026-09-10T09:00:00Z');

  /** Ties on every sort key but the id, which is where a keyset can skip or repeat. */
  function seedCorpus(db: DatabaseSync, count: number): void {
    for (let i = 0; i < count; i += 1) {
      seed(db, {
        id: `id-${String(i).padStart(3, '0')}`,
        fingerprint: `fp-${String(i).padStart(3, '0')}`,
        canonical_url: `https://example.com/${i}`,
        // Same published_at for all: only the id breaks the tie.
        published_at: TIE,
      });
    }
  }

  it('walks every row exactly once across pages', async () => {
    const db = migratedDatabase();
    const env = envFor(db);
    seedCorpus(db, 7);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const feed: ExploreFeed = await getExploreFeed(
        cursor ? { limit: 2, cursor } : { limit: 2 },
        env,
        ctx,
      );
      seen.push(...feed.items.map((item) => item.id));
      cursor = feed.nextCursor;
      pages += 1;
      if (pages > 10) throw new Error('pagination did not terminate');
    } while (cursor !== null);

    // No repeats and no gaps: the row-value comparison must be the strict
    // successor of the same ordering the query sorts by.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(7);
  });

  it('continues correctly across a day boundary', async () => {
    const db = migratedDatabase();
    const env = envFor(db);
    const boundary = Math.floor(TIE / 86_400_000) * 86_400_000;
    seed(db, {
      id: 'before',
      fingerprint: 'fp-before',
      canonical_url: 'https://example.com/before',
      published_at: boundary - 1,
    });
    seed(db, {
      id: 'after',
      fingerprint: 'fp-after',
      canonical_url: 'https://example.com/after',
      published_at: boundary,
    });

    const first = await getExploreFeed({ limit: 1 }, env, ctx);
    expect(first.items.map((item) => item.id)).toEqual(['after']);
    const second = await getExploreFeed({ limit: 1, cursor: first.nextCursor! }, env, ctx);
    expect(second.items.map((item) => item.id)).toEqual(['before']);
  });
});

import type { Env } from '../data/api';

const DAY_MS = 86_400_000;

/** The cron that runs this sweep, as written in void.config.ts. Both schedules
 *  arrive at the same scheduled() handler, so this string is the only thing
 *  telling a sweep apart from an ingest tick. retention.cron.test.ts holds the
 *  two copies together. */
export const PRUNE_CRON = '17 3 * * *';

/** Articles are archived, never deleted — dropping a row takes its
 *  canonical_url and fingerprint with it, and the next tick would re-ingest
 *  and store the same story again. */
export const ARTICLE_ARCHIVE_DAYS = 90;

interface RetentionReport {
  articlesArchived: number;
}

export async function pruneOldRecords(env: Env, now = Date.now()): Promise<RetentionReport> {
  if (!env.DB) throw new Error('D1 binding is required');
  // Both published and filtered rows age out — filtered stories were never
  // cleaned before, so they accumulated indefinitely. Their fingerprints still
  // guard against re-ingest, so archiving is safe.
  const result = await env.DB.prepare(
    `UPDATE articles SET status = 'archived', updated_at = ?
      WHERE status IN ('published', 'filtered') AND published_at < ?`,
  )
    .bind(now, now - ARTICLE_ARCHIVE_DAYS * DAY_MS)
    .run();

  return { articlesArchived: result.meta.changes ?? 0 };
}

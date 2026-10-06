import type { Env } from '../data/api';
import { applyEnrichment, markCurationSkipped } from './enrich';
import {
  CuratorTimeoutError,
  MIN_CURATOR_TEXT_CHARS,
  type CuratorArticle,
  enrichBatchWithLLM,
  enrichWithLLM,
} from './llm';
import type { ArticleEnrichment } from './types';

// The curator: what turns a stored row into a publishable story. Split out of
// ingest on purpose — ingest answers "what arrived", this answers "what is it",
// and the two fail independently: a model outage must not stop the desk from
// collecting, and a feed outage must not spend model budget re-judging nothing.

/** Stories one tick may curate. Set from measured latency, and it is the dial
 *  that bounds the tick's *tail*, not its average.
 *
 *  The typical tick is one model call: mimo-v2.6-flash measures 25s for a single
 *  story and 56–130s for a batch of eight, so a healthy tick is one to two
 *  minutes plus the ingest that runs first (measured: 93s, 218s, 394s).
 *
 *  The tail is a batch whose reply fails validation — one story's summary over
 *  the 280-character limit rejects the whole batch — after which the curator
 *  falls back to one call per story. That is the tick that measured 394s. Since
 *  the fallback costs `CURATION_LIMIT × per-story latency`, this number *is* the
 *  worst-case bound. The alternative, dropping the fallback, would trade a long
 *  tick for a batch that can never recover from a single bad story.
 *
 *  Four per tick is ~380 stories/day against the ~180 the feeds deliver. A
 *  backlog drains in hours rather than minutes — visible as
 *  `checks.curation.pending`, which is the reason that field exists. */
export const CURATION_LIMIT = 4;

/** Batch size. Bigger is more efficient per story on this model (25s for one,
 *  16s each for eight), so this is not the dial to turn down when a tick gets
 *  long — `CURATION_LIMIT` is. */
export const CURATION_BATCH_SIZE = 8;

/** How many times a story may fail before the curator stops picking it up.
 *
 *  Without a cap a permanently unjudgeable story (a feed that returns 200 with a
 *  truncated body, say) would be retried every 15 minutes forever, spending a
 *  model call each time and never leaving the queue. The count is read from
 *  `agent_runs`, so the cap is durable across ticks and isolates. */
export const MAX_CURATION_ATTEMPTS = 3;

export interface CurationReport {
  /** false when LLM_API_KEY / LLM_BASE_URL / LLM_MODEL are not all configured:
   *  the desk keeps ingesting and the queue grows, visibly, instead of failing. */
  configured: boolean;
  selected: number;
  /** Judgeable and on-beat: `status` stays published, fields replaced. */
  curated: number;
  /** Judged off-beat: `status = 'filtered'`, kept for its dedupe guards. */
  filtered: number;
  /** Too little text to judge; left published with its feed teaser. */
  skipped: number;
  failed: number;
}

type RunStatus = 'stored' | 'filtered' | 'skipped' | 'failed';

interface PendingArticle extends CuratorArticle {
  sourceId: string;
}

/** Select the work: newest uncurated published rows, minus anything that has
 *  already burned its attempts.
 *
 *  `agent_runs.article_fingerprint` is `articles.id` — `storeArticle` uses the
 *  fingerprint as the primary key — so the failure tally joins on the id. */
async function pendingArticles(env: Env, limit: number): Promise<PendingArticle[]> {
  const result = await env.DB.prepare(
    `SELECT a.id, a.source_id AS source_id, s.name AS source_name, a.title, a.description,
            a.canonical_url AS url
     FROM articles a
     JOIN sources s ON s.id = a.source_id
     LEFT JOIN (
       SELECT article_fingerprint, COUNT(*) AS failures
       FROM agent_runs
       WHERE status = 'failed'
       GROUP BY article_fingerprint
     ) f ON f.article_fingerprint = a.id
     WHERE a.enriched_at IS NULL
       AND a.status = 'published'
       AND COALESCE(f.failures, 0) < ?
     ORDER BY a.published_at DESC
     LIMIT ?`,
  )
    .bind(MAX_CURATION_ATTEMPTS, limit)
    .all<Record<string, unknown>>();

  const strings = (row: Record<string, unknown>) => ({
    id: typeof row.id === 'string' ? row.id : '',
    sourceId: typeof row.source_id === 'string' ? row.source_id : '',
    sourceName: typeof row.source_name === 'string' ? row.source_name : '',
    title: typeof row.title === 'string' ? row.title : '',
    description: typeof row.description === 'string' ? row.description : '',
    url: typeof row.url === 'string' ? row.url : '',
  });

  return (result.results ?? [])
    .map(strings)
    .filter((row) => row.id !== '' && row.sourceId !== '' && row.title !== '');
}

/** Append to the run log. One row per story per outcome, which is what the
 *  failure cap reads back and what makes "did the AI run, and what happened to
 *  this story" answerable from D1 rather than from logs that have aged out. */
async function recordRun(
  env: Env,
  article: PendingArticle,
  status: RunStatus,
  model: string,
  error: string,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO agent_runs (
       id, article_fingerprint, source_id, status, model, article_id, error, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      article.id,
      article.sourceId,
      status,
      model,
      article.id,
      error.slice(0, 500),
      now,
      now,
    )
    .run();
}

interface Outcome {
  article: PendingArticle;
  enrichment?: ArticleEnrichment;
  error?: string;
}

/** One batch, with the fallback that makes a batch safe to attempt: if the call
 *  or its validation fails as a whole, each story is retried on its own. A
 *  single story the model refuses to answer must not cost the other seven, and
 *  the per-story path is also what gives each failure its own message.
 *
 *  A **timeout** is the exception, and it is the expensive one to get wrong: at
 *  this model's latency, answering eight stories one at a time costs the same
 *  per story (~25s each) while spending the entire tick, and the next tick would
 *  find the queue exactly as it left it. So a batch that ran out of time is
 *  reported as failed for every story in it and retried whole, later. */
async function curateBatch(
  apiKey: string,
  baseUrl: string,
  model: string,
  batch: PendingArticle[],
): Promise<Outcome[]> {
  try {
    const enrichments = await enrichBatchWithLLM(apiKey, baseUrl, model, batch);
    return batch.map((article, index) => ({ article, enrichment: enrichments[index] }));
  } catch (batchError) {
    const message = batchError instanceof Error ? batchError.message : String(batchError);
    if (batchError instanceof CuratorTimeoutError) {
      console.warn(`[curate] batch of ${batch.length} timed out; leaving it for the next tick`);
      return batch.map((article) => ({ article, error: message }));
    }
    console.warn(`[curate] batch of ${batch.length} failed, retrying story by story:`, message);
  }

  const outcomes: Outcome[] = [];
  for (const article of batch) {
    try {
      outcomes.push({ article, enrichment: await enrichWithLLM(apiKey, baseUrl, model, article) });
    } catch (error) {
      outcomes.push({
        article,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

function partition<T>(items: T[], predicate: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (predicate(item) ? yes : no).push(item);
  return [yes, no];
}

/** Drain up to CURATION_LIMIT stories from the queue. Safe to call every tick:
 *  it selects, judges and writes back, and anything it could not finish stays
 *  pending for the next one. */
export async function curatePending(env: Env): Promise<CurationReport> {
  if (!env.DB) throw new Error('D1 binding is required');
  const apiKey = env.LLM_API_KEY ?? '';
  const baseUrl = env.LLM_BASE_URL ?? '';
  const model = env.LLM_MODEL ?? '';
  const report: CurationReport = {
    configured: Boolean(apiKey && baseUrl && model),
    selected: 0,
    curated: 0,
    filtered: 0,
    skipped: 0,
    failed: 0,
  };
  // Not configured is a resting state, not an error: the site is designed to
  // serve uncurated rows (the feed teaser is the deck and the source's authority
  // is the score), so a deployment without the secret degrades to the pre-LLM
  // behaviour and says so in the report.
  if (!report.configured) return report;

  const pending = await pendingArticles(env, CURATION_LIMIT);
  report.selected = pending.length;
  if (pending.length === 0) return report;

  const [judgeable, thin] = partition(
    pending,
    (article) => article.description.trim().length >= MIN_CURATOR_TEXT_CHARS,
  );
  for (const article of thin) {
    try {
      await markCurationSkipped(env, article.id);
      await recordRun(env, article, 'skipped', model, 'too little text to curate');
      report.skipped += 1;
    } catch (error) {
      console.error(`[curate] ${article.id} skip write failed:`, error);
      report.failed += 1;
    }
  }

  for (let offset = 0; offset < judgeable.length; offset += CURATION_BATCH_SIZE) {
    const batch = judgeable.slice(offset, offset + CURATION_BATCH_SIZE);
    for (const outcome of await curateBatch(apiKey, baseUrl, model, batch)) {
      const { article, enrichment, error } = outcome;
      if (!enrichment) {
        report.failed += 1;
        console.error(`[curate] ${article.id} failed:`, error);
        await recordRun(env, article, 'failed', model, error ?? 'unknown error');
        continue;
      }
      try {
        await applyEnrichment(env, article.id, enrichment);
        const status: RunStatus = enrichment.isOnTopic ? 'stored' : 'filtered';
        await recordRun(env, article, status, model, '');
        if (enrichment.isOnTopic) report.curated += 1;
        else report.filtered += 1;
      } catch (writeError) {
        // The row keeps its pre-curation values and `enriched_at` stays NULL, so
        // the next tick retries it; the run row makes the retry countable.
        report.failed += 1;
        console.error(`[curate] ${article.id} write failed:`, writeError);
        await recordRun(
          env,
          article,
          'failed',
          model,
          writeError instanceof Error ? writeError.message : String(writeError),
        );
      }
    }
  }

  return report;
}

/** How many stories are waiting for the curator (including ones that have burned
 *  their attempts). Reported by /api/health: a queue that only grows is the one
 *  failure mode of a store-first pipeline that no reader would otherwise see. */
export async function pendingCurationCount(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    `SELECT COUNT(*) AS pending
     FROM articles a
     JOIN sources s ON s.id = a.source_id
     WHERE a.enriched_at IS NULL AND a.status = 'published'`,
  ).first<{ pending: unknown }>();
  const pending = result?.pending;
  return typeof pending === 'number' ? pending : 0;
}

import type { Env } from '../data/api';
import {
  CURATION_BATCH_SIZE,
  CURATION_LEASE_MS,
  CURATION_LIMIT,
  CurationBudget,
  CurationBudgetError,
  CuratorTimeoutError,
  MAX_CURATION_ATTEMPTS,
  MIN_CURATOR_TEXT_CHARS,
} from './curationPolicy';
import { applyEnrichment, markCurationSkipped } from './enrich';
import { type CuratorArticle, enrichBatchWithLLM, enrichWithLLM } from './llm';

// Preserve existing health/test imports; the policy module is the source of truth.
export {
  CURATION_BATCH_SIZE,
  CURATION_LEASE_MS,
  CURATION_LIMIT,
  MAX_CURATION_ATTEMPTS,
} from './curationPolicy';

import type { ArticleEnrichment } from './types';

// The curator: what turns a stored row into a publishable story. Split out of
// ingest on purpose — ingest answers "what arrived", this answers "what is it",
// and the two fail independently: a model outage must not stop the desk from
// collecting, and a feed outage must not spend model budget re-judging nothing.

/** A story some invocation may take now: still uncurated, under the attempt cap,
 *  and not held by a live claim. Correlated on `a.id` so both lookups ride the
 *  (article_fingerprint, status) index for the handful of pending rows instead of
 *  aggregating the whole run log. Binds: MAX_CURATION_ATTEMPTS, lease cutoff. */
const CLAIMABLE = `a.enriched_at IS NULL
       AND a.status = 'published'
       AND (SELECT COUNT(*) FROM agent_runs r
             WHERE r.article_fingerprint = a.id AND r.status = 'processing') < ?
       AND NOT EXISTS (SELECT 1 FROM agent_runs r
             WHERE r.article_fingerprint = a.id AND r.status = 'processing' AND r.started_at > ?)`;

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

/** Select the work: newest claimable rows. Only a candidate list — two
 *  invocations can read the same rows here, and `claim` is what decides.
 *
 *  `agent_runs.article_fingerprint` is `articles.id` — `storeArticle` uses the
 *  fingerprint as the primary key — so the run log joins on the id. */
async function pendingArticles(env: Env, limit: number, now: number): Promise<PendingArticle[]> {
  const result = await env.DB.prepare(
    `SELECT a.id, a.source_id AS source_id, s.name AS source_name, a.title, a.description,
            a.canonical_url AS url
     FROM articles a
     JOIN sources s ON s.id = a.source_id
     WHERE ${CLAIMABLE}
     ORDER BY a.published_at DESC
     LIMIT ?`,
  )
    .bind(MAX_CURATION_ATTEMPTS, now - CURATION_LEASE_MS, limit)
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

/** Take a story for this invocation, atomically: one INSERT … SELECT that only
 *  writes a 'processing' row when the story is still claimable. D1 runs
 *  statements one at a time, so of two invocations racing for the same row
 *  exactly one sees `changes = 1` — measured before this existed, 21% of
 *  production runs were a second, concurrent judgement of an already-taken story.
 *
 *  The claim is also the attempt: the cap counts 'processing' rows, so an
 *  invocation the platform kills mid-batch — before any outcome is written —
 *  still spends the attempt, and a story that keeps killing ticks parks after
 *  MAX_CURATION_ATTEMPTS instead of being re-selected forever. */
async function claim(env: Env, article: PendingArticle, model: string, now: number) {
  const result = await env.DB.prepare(
    `INSERT INTO agent_runs (
       id, article_fingerprint, source_id, status, model, article_id, error, started_at
     )
     SELECT ?, a.id, a.source_id, 'processing', ?, a.id, '', ?
     FROM articles a
     WHERE a.id = ? AND ${CLAIMABLE}`,
  )
    .bind(
      crypto.randomUUID(),
      model,
      now,
      article.id,
      MAX_CURATION_ATTEMPTS,
      now - CURATION_LEASE_MS,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Prepare an outcome beside its claim. Successful completion batches this
 *  with the article write; failures run it separately and leave the row pending. */
function prepareRun(
  env: Env,
  article: PendingArticle,
  status: RunStatus,
  model: string,
  error: string,
): D1PreparedStatement {
  const now = Date.now();
  return env.DB.prepare(
    `INSERT INTO agent_runs (
       id, article_fingerprint, source_id, status, model, article_id, error, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    article.id,
    article.sourceId,
    status,
    model,
    article.id,
    error.slice(0, 500),
    now,
    now,
  );
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
  budget: CurationBudget,
): Promise<Outcome[]> {
  try {
    const enrichments = await enrichBatchWithLLM(apiKey, baseUrl, model, batch, budget);
    return batch.map((article, index) => ({ article, enrichment: enrichments[index] }));
  } catch (batchError) {
    const message = batchError instanceof Error ? batchError.message : String(batchError);
    if (batchError instanceof CuratorTimeoutError || batchError instanceof CurationBudgetError) {
      console.warn(`[curate] batch of ${batch.length}: ${message}; leaving it for the next tick`);
      return batch.map((article) => ({ article, error: message }));
    }
    console.warn(`[curate] batch of ${batch.length} failed, retrying story by story:`, message);
  }

  const outcomes: Outcome[] = [];
  for (const article of batch) {
    // Every story already participated in the batch, so retain its claim and
    // audit a failure even when its individual fallback cannot start.
    if (budget.exhausted) {
      outcomes.push({ article, error: new CurationBudgetError().message });
      continue;
    }
    try {
      outcomes.push({
        article,
        enrichment: await enrichWithLLM(apiKey, baseUrl, model, article, budget),
      });
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
  // serve uncurated rows (the feed teaser is the deck and the score is 0, so
  // they sort below curated stories), so a deployment without the secret degrades to the pre-LLM
  // behaviour and says so in the report.
  if (!report.configured) return report;

  const budget = new CurationBudget();
  const candidates = await pendingArticles(env, CURATION_LIMIT, Date.now());
  const [judgeable, thin] = partition(
    candidates,
    (article) => article.description.trim().length >= MIN_CURATOR_TEXT_CHARS,
  );
  for (const article of thin) {
    if (budget.exhausted) break;
    if (!(await claim(env, article, model, Date.now()))) continue;
    report.selected += 1;
    // Finish an acquired skip atomically even if the claim consumed the budget.
    try {
      await markCurationSkipped(
        env,
        article.id,
        prepareRun(env, article, 'skipped', model, 'too little text to curate'),
      );
      report.skipped += 1;
    } catch (error) {
      console.error(`[curate] ${article.id} skip write failed:`, error);
      report.failed += 1;
    }
  }

  for (let offset = 0; offset < judgeable.length; offset += CURATION_BATCH_SIZE) {
    if (budget.exhausted) break;
    // Claim just this batch, not later work that may never start. Do not unclaim:
    // a claim acquired as the deadline passes still spends an attempt and gets
    // a failed outcome below, with no model request and no article mutation.
    const batch: PendingArticle[] = [];
    for (const article of judgeable.slice(offset, offset + CURATION_BATCH_SIZE)) {
      if (budget.exhausted) break;
      if (await claim(env, article, model, Date.now())) {
        batch.push(article);
        report.selected += 1;
      }
    }
    if (batch.length === 0) continue;
    for (const outcome of await curateBatch(apiKey, baseUrl, model, batch, budget)) {
      const { article, enrichment, error } = outcome;
      if (!enrichment) {
        report.failed += 1;
        console.error(`[curate] ${article.id} failed:`, error);
        await prepareRun(env, article, 'failed', model, error ?? 'unknown error').run();
        continue;
      }
      try {
        const status: RunStatus = enrichment.isOnTopic ? 'stored' : 'filtered';
        await applyEnrichment(
          env,
          article.id,
          enrichment,
          prepareRun(env, article, status, model, ''),
        );
        if (enrichment.isOnTopic) report.curated += 1;
        else report.filtered += 1;
      } catch (writeError) {
        // The row keeps its pre-curation values and `enriched_at` stays NULL, so
        // the next tick retries it; the claim already counted this attempt.
        report.failed += 1;
        console.error(`[curate] ${article.id} write failed:`, writeError);
        await prepareRun(
          env,
          article,
          'failed',
          model,
          writeError instanceof Error ? writeError.message : String(writeError),
        ).run();
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

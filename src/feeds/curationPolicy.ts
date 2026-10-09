import { sleep } from '../utils/coerce';

// Every number that bounds a curation tick, in one place. They are measured, not
// chosen, and they move together: the per-tick limit, the timeouts, the attempts
// and the deadline jointly decide how long a tick can take, and swapping the
// model invalidates all of them at once — re-measure before trusting a tick.

/** Stories one tick may curate: the throughput dial. mimo-v2.6-flash measures
 *  25s for a single story and 56–130s for a batch of eight, so a healthy tick is
 *  one model call — one to two minutes plus the ingest that runs first
 *  (measured: 93s, 218s, 394s). Four per tick is ~380 stories/day against the
 *  ~180 the feeds deliver; a backlog drains in hours, visible as
 *  `checks.curation.pending`.
 *
 *  It no longer bounds the tail on its own. A batch whose reply fails validation
 *  (one summary over 280 characters rejects all of it) falls back to one call per
 *  story — the tick that measured 394s — and retries compound that; the deadline
 *  below is what bounds a tick now. */
export const CURATION_LIMIT = 4;

/** Bigger is more efficient per story on this model (25s for one, 16s each for
 *  eight), so this is not the dial to turn down when a tick gets long. */
export const CURATION_BATCH_SIZE = 8;

/** How many times a story may be attempted before the curator stops picking it
 *  up — without a cap a story the model can never judge would spend a call every
 *  15 minutes forever. The count is of claims in `agent_runs` (see `claim` in
 *  curate.ts), so it is durable across ticks and isolates, and an attempt is
 *  spent even when the platform kills the invocation before its outcome. */
export const MAX_CURATION_ATTEMPTS = 3;

/** How long a claim keeps other invocations off a story. It must outlive the
 *  scheduled invocation itself (Cloudflare's 15-minute wall clock), not merely
 *  the model budget, so a claim can never lapse while its holder is alive. */
export const CURATION_LEASE_MS = 20 * 60_000;

/** Below this the model has nothing to judge and the tick would spend a call on
 *  a title alone; such a story keeps its pre-curation deck and leaves the queue
 *  as a `skipped` run. Measured feeds carry 95–1164 median characters, so this
 *  only fires on the genuinely empty ones. */
export const MIN_CURATOR_TEXT_CHARS = 40;

/** Conservative new ceiling, shared from queue selection through all model work.
 * Six minutes accommodates the existing two timeouts (150s + 165s + 500ms),
 * but bounds validation retries and single-story fallback too. It leaves room
 * in the scheduled invocation for preceding ingest and subsequent D1 completion;
 * it is NOT a deadline for ingest or a cancellation of atomic database writes.
 * Slow D1 operations may outlive it; no new model work/claims start afterwards. */
export const CURATION_BUDGET_MS = 6 * 60_000;

// The two numbers that gate every call are measured, and they have already been
// wrong once: a batch of 8 took ~27s on the previous provider's model, so the
// ceiling was 60s, and mimo-v2.6-flash then measured 130s for the same batch.
// Every call timed out, and a timed-out batch is indistinguishable from a broken
// model — each story burns an attempt and leaves the queue uncurated for good.
// Raise these when the model changes, not after.
const REQUEST_TIMEOUT_MS = 150_000;
const TIMEOUT_BACKOFF_MS = 15_000;

/** Two attempts, not three. At the measured latency two timeouts already cost
 *  five minutes; a batch that fails twice is retried by the *next* tick, which
 *  is a better retry than a longer one. */
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 500;
export const MODEL_MAX_TOKENS = 8192;

/** Thrown when a call ran out of time rather than out of contract. The curator
 *  treats the two differently on purpose: a timeout means the model is slow, and
 *  answering the same stories one at a time costs the same per story while
 *  spending the whole tick, so it does not fan out. */
export class CuratorTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} timed out`);
    this.name = 'CuratorTimeoutError';
  }
}

export class CurationBudgetError extends Error {
  constructor() {
    super('curation time budget exhausted');
    this.name = 'CurationBudgetError';
  }
}

/** One invocation-local deadline. Pass the same instance to every batch/fallback.
 * The attempt timer covers fetch AND body consumption and is always disposed. */
export class CurationBudget {
  private readonly deadline = Date.now() + CURATION_BUDGET_MS;
  private stopped = false;

  get exhausted(): boolean {
    return this.remaining() <= 0;
  }

  private remaining(): number {
    return this.stopped ? 0 : this.deadline - Date.now();
  }

  async run<T>(work: (signal: AbortSignal) => Promise<T>, label: string): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const remaining = this.remaining();
      if (remaining <= 0) throw new CurationBudgetError();
      const timeout = REQUEST_TIMEOUT_MS + attempt * TIMEOUT_BACKOFF_MS;
      const budgetLimited = remaining <= timeout;
      const controller = new AbortController();
      const timer = setTimeout(
        () =>
          controller.abort(
            budgetLimited ? new CurationBudgetError() : new CuratorTimeoutError(label),
          ),
        Math.min(remaining, timeout),
      );
      try {
        const value = await work(controller.signal);
        // Also guard body/parse work that finishes after the deadline without
        // yielding to the timer (or a transport that resolves despite abort).
        if (this.exhausted) throw new CurationBudgetError();
        if (controller.signal.aborted) throw controller.signal.reason;
        return value;
      } catch (error) {
        if (this.exhausted || error instanceof CurationBudgetError) throw new CurationBudgetError();
        const failure = controller.signal.aborted ? controller.signal.reason : error;
        if (attempt === MAX_ATTEMPTS - 1) {
          if (failure instanceof Error && failure.name === 'TimeoutError') {
            throw new CuratorTimeoutError(label);
          }
          throw failure;
        }
      } finally {
        clearTimeout(timer);
      }
      const delay = RETRY_BACKOFF_MS * (attempt + 1);
      // Do not spend the tail sleeping when no retry could start afterwards.
      if (this.remaining() <= delay) {
        this.stopped = true;
        throw new CurationBudgetError();
      }
      await sleep(delay);
    }
    throw new Error(`${label} failed`);
  }
}

-- agent_runs comes back, because something reads it now.
--
-- 0005 dropped this table as a write-only audit trail: written on every insert
-- and failure, swept by the daily job, and never SELECTed. That was true of the
-- pipeline it was written for, and dropping it was right. The curator makes the
-- same table load-bearing in two ways that did not exist then:
--
--   1. the per-story attempt cap. `curatePending` counts rows with
--      status = 'failed' per fingerprint and stops selecting a story after
--      MAX_CURATION_ATTEMPTS. Without it, a story the model can never judge — a
--      feed that answers 200 with a truncated body, say — would be retried every
--      15 minutes forever, spending a model call each time.
--   2. "what happened to this story". One row per outcome (stored / filtered /
--      skipped / failed) is the only durable answer once console logs have aged
--      out, and it is what makes a spike in failures countable rather than
--      anecdotal.
--
-- Shaped as 0002 declared it, with one index instead of two: both reads key on
-- the fingerprint, so a single composite index serves the failure tally and the
-- per-story history. `status` is the CHECK from 0002 — 'processing' is kept even
-- though the curator writes outcomes only, because a future queued write path
-- would want it and a CHECK constraint cannot be widened cheaply.
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  article_fingerprint TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('processing', 'stored', 'filtered', 'skipped', 'failed')),
  model TEXT NOT NULL,
  article_id TEXT,
  error TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_fingerprint_status
  ON agent_runs (article_fingerprint, status);

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

CREATE INDEX IF NOT EXISTS idx_agent_runs_fingerprint
  ON agent_runs (article_fingerprint, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status
  ON agent_runs (status, started_at DESC);

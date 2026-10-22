-- The curator's queue marker: `enriched_at IS NULL` means "stored, not yet
-- curated".
--
-- Every row `storeArticle` inserts is NULL by default, and the curator sets it
-- when it has either applied an enrichment or decided the story has too little
-- text to spend a model call on. Without a column of its own the curator would
-- have to anti-join agent_runs on every tick to find its work, and a story it
-- deliberately skipped would look the same as one it never tried.
ALTER TABLE articles ADD COLUMN enriched_at INTEGER;

-- The archive is not the curator's backlog.
--
-- Rows already stored when this pipeline shipped came from the Poche feed and
-- predate the AI-hardware prompt: running them through the new curator would
-- spend every tick's budget re-judging off-beat archive stories, and the ones it
-- rejected would be set to `filtered` — silently deleting the site's existing
-- content from every read path. Stamping them as settled keeps them published and
-- keeps the queue to genuinely new rows. `updated_at` is when the row was stored,
-- which is the honest approximation of when it was last handled.
UPDATE articles SET enriched_at = COALESCE(updated_at, created_at) WHERE enriched_at IS NULL;

-- Partial index over the queue read only. The curator's query is
-- "newest-published uncurated row first", and it has to stay cheap as the corpus
-- grows; because it is partial it holds only what is still pending, so it shrinks
-- back to nothing once a backlog has drained.
CREATE INDEX IF NOT EXISTS idx_articles_pending_curation
  ON articles (published_at DESC)
  WHERE enriched_at IS NULL AND status = 'published';

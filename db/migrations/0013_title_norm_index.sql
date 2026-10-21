-- Index the title-normalised dedupe key added in 0008. ingest checks
-- `WHERE title_norm IN (...)` on every tick, and articles is never deleted
-- (retention archives), so without this the dedupe scan grows with the table.
CREATE INDEX IF NOT EXISTS idx_articles_title_norm ON articles (title_norm, source_id);

-- Hardware pivot: the desk moves from football to PC hardware & peripherals.
-- The stored semantics change, so the columns follow: comp → category,
-- is_football → is_on_topic, and the single-value sport column goes away.
-- Renames are metadata-only in SQLite; index definitions referencing the old
-- names are rewritten automatically, but the two indexes that pin the old
-- column shapes are rebuilt anyway so the query planner sees fresh stats.

-- idx_articles_published references is_football; rename would rewrite it, but
-- dropping first keeps the migration order explicit and lets the replacement
-- use the new names.
DROP INDEX IF EXISTS idx_articles_published;
DROP INDEX IF EXISTS idx_articles_comp;

ALTER TABLE articles RENAME COLUMN is_football TO is_on_topic;
ALTER TABLE articles RENAME COLUMN comp TO category;
-- sport carried exactly one value ('soccer') and is filtered by no reader
-- anymore; the is_on_topic flag covers topic gating on its own.
ALTER TABLE articles DROP COLUMN sport;

CREATE INDEX idx_articles_published
  ON articles (status, is_on_topic, published_at DESC, quality_score DESC);
CREATE INDEX idx_articles_category
  ON articles (status, category, published_at DESC);

-- Same rename on the source registry. Nothing reads sources.sport.
ALTER TABLE sources RENAME COLUMN comp TO category;
ALTER TABLE sources DROP COLUMN sport;

-- Soft-offline the football corpus. Retention archives, never deletes, for the
-- usual reason: dropping a row frees its fingerprint/canonical_url and invites
-- a paid re-ingest. Marking every legacy row archived hides it from every
-- published query permanently while keeping the dedupe guards intact — the
-- football feeds are gone from the registry, so nothing will ever try to
-- re-ingest them, and the rows age in place at zero cost.
UPDATE articles SET status = 'archived' WHERE status IN ('published', 'filtered');

-- Old feed rows are left alone: the ingest fan-out intersects D1-enabled ids
-- with the code registry, so football rows are inert the moment the new
-- registry deploys. `enabled` is an operator override, not a registry mirror —
-- ensureSources deliberately never rewrites it, so do not bulk-flip it here.
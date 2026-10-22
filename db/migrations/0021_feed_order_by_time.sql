-- void:allow-destructive
-- Destructive by design; applied in production before Void deployed this Worker.
-- The feed orders by (published_at, id) alone now that nothing writes a
-- quality score or an off-topic flag, so the seek indexes lose those columns.
-- The curator's queue index and the cross-source title index have no reader.
DROP INDEX IF EXISTS idx_feed_global;
DROP INDEX IF EXISTS idx_feed_category;
DROP INDEX IF EXISTS idx_articles_pending_curation;
DROP INDEX IF EXISTS idx_articles_title_norm;

CREATE INDEX IF NOT EXISTS idx_feed_global
  ON articles (status, published_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_feed_category
  ON articles (status, category, published_at DESC, id DESC);

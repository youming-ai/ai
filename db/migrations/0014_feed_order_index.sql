-- The feed sorts by (day bucket, quality score, published_at, id D), where the
-- day bucket was the expression `published_at / 86400000`. No index can satisfy
-- an ORDER BY on an expression, so every page sorted the entire live partition
-- in a temp B-tree — and the keyset predicates had the same problem, so page N
-- cost exactly as much as page 1.
--
-- A generated column makes the bucket a real, addressable value: the sort can
-- walk an index and the keyset comparison becomes a single row-value test
-- (`(day_bucket, quality_score, published_at, id) < (?, ?, ?, ?)`), which the
-- planner turns into an index seek. Both indexes carry the sort order so the
-- ORDER BY needs no sort step at all.
--
-- VIRTUAL, not STORED: SQLite cannot add a STORED generated column via ALTER,
-- and the value is a two-digit integer the index already materialises.
ALTER TABLE articles ADD COLUMN day_bucket INTEGER GENERATED ALWAYS AS (published_at / 86400000) VIRTUAL;

CREATE INDEX IF NOT EXISTS idx_feed_global
  ON articles (status, is_on_topic, day_bucket DESC, quality_score DESC, published_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_feed_category
  ON articles (status, is_on_topic, category, day_bucket DESC, quality_score DESC, published_at DESC, id DESC);

-- 0014 introduced day_bucket as plain integer division, which is floor only for
-- non-negative values: SQLite's `/` truncates toward zero, so a pre-1970 pubDate
-- landed one bucket lower than the contract. That input is reachable —
-- `Date.parse('Jan 1 1960')` returns a negative number, which is truthy, so
-- parseRss stores it as-is — and AGENTS.md documents the bucket as
-- `floor(published_at / 86400000)`. The column now implements floor for every
-- input: for negatives, subtracting one short of a day before dividing makes the
-- truncation land on the floor instead of the ceiling.
--
-- Verified against Math.floor on both sides of every boundary (0, ±1 day,
-- ±1 ms either side, and real production timestamps). No production row has a
-- negative published_at (MIN is 2015-10), so this changes nothing today.
--
-- The two feed indexes reference the column, so they are rebuilt around it.
DROP INDEX IF EXISTS idx_feed_global;
DROP INDEX IF EXISTS idx_feed_category;

ALTER TABLE articles DROP COLUMN day_bucket;

ALTER TABLE articles ADD COLUMN day_bucket INTEGER GENERATED ALWAYS AS (
  CASE
    WHEN published_at >= 0 THEN published_at / 86400000
    ELSE (published_at - 86399999) / 86400000
  END
) VIRTUAL;

-- Seek targets, not covering indexes: the feed reads title/description/summary
-- and friends from the table row it lands on, which is a cheap lookup per
-- returned row. Making these covering would mean copying every projected text
-- column into the index — far more than the sort it saves on a 25-row page.
CREATE INDEX IF NOT EXISTS idx_feed_global
  ON articles (status, is_on_topic, day_bucket DESC, quality_score DESC, published_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_feed_category
  ON articles (status, is_on_topic, category, day_bucket DESC, quality_score DESC, published_at DESC, id DESC);

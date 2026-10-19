-- Uncurated rows score 0 until the curator writes a real one.
--
-- `storeArticle` used to seed `quality_score` with the source's authority
-- (75–90), and the board sorts by score within a day, so every story the model
-- had not judged yet — and every one it skipped as too thin to judge — ranked
-- above the curated ones (55–72 on a measured tick). New rows are stored at 0;
-- this brings the rows already waiting, and the skipped ones, in line.
UPDATE articles SET quality_score = 0
WHERE status = 'published'
  AND (
    enriched_at IS NULL
    OR id IN (SELECT article_fingerprint FROM agent_runs WHERE status = 'skipped')
  );

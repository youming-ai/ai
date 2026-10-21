-- Gemini returns free-form tags, so the first production ingest stored
-- "premier league" (56) and "premier-league" (24) as two separate facets, and
-- the explore rail listed both. normalizeTag() in src/feeds/enrich.ts now
-- collapses whitespace to hyphens; this rewrites the rows written before it.
--
-- OR REPLACE is doing real work: where an article already carries both
-- spellings, rewriting one collides with the other on the
-- (article_id, tag) primary key, and OR REPLACE drops the loser instead of
-- aborting the statement.
UPDATE OR REPLACE article_tags
   SET tag = trim(replace(replace(lower(tag), ' ', '-'), '--', '-'), '-')
 WHERE tag <> trim(replace(replace(lower(tag), ' ', '-'), '--', '-'), '-');

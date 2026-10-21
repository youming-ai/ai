-- article_clusters was created in 0001 for cross-source near-duplicate
-- grouping and never written to — zero code references, zero rows. Dedupe is
-- handled earlier and more cheaply: ingestAllSources drops articles whose
-- fingerprint is already stored, and processArticle re-checks canonical_url
-- and fingerprint before spending a Gemini call.
--
-- Dropping it rather than leaving a table nobody can explain. If semantic
-- clustering is wanted later it needs a schema built around whatever
-- similarity method is chosen, not this placeholder.
DROP INDEX IF EXISTS idx_clusters_cluster;
DROP TABLE IF EXISTS article_clusters;

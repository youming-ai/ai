-- Poche Explore pivot: the only active source is now the curated Poche feed.
-- Keep all rows for dedupe and audit, but take stories from removed source
-- registries out of every published query. Do not touch sources.enabled: it is
-- an operator override and old source rows remain inert in ingestAllSources.
UPDATE articles
   SET status = 'archived'
 WHERE source_id <> 'poche-explore'
   AND status IN ('published', 'filtered');

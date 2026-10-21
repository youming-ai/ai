-- void:allow-destructive
-- Destructive by design; applied in production before Void deployed this Worker.
-- Poche Explore is the only source, and the registry never fetches any other
-- again, so the old corpus no longer guards dedupe for anything: delete it
-- instead of archiving it. Poche rows (including archived ones) stay, because
-- they are what stops the next tick re-ingesting the same Poche links.
-- agent_runs was the retired curator's claim log; nothing reads it.
DELETE FROM article_tags
 WHERE article_id IN (SELECT id FROM articles WHERE source_id <> 'poche-explore');
DELETE FROM articles WHERE source_id <> 'poche-explore';
DROP TABLE IF EXISTS agent_runs;
DELETE FROM sources WHERE id <> 'poche-explore';

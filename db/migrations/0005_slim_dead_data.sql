-- Drop dead data: tables/columns that are written every tick but never read
-- back by any query, UI, or worker endpoint. See the audit in the flow review.

-- agent_runs was a pure write-only audit trail: written on every article insert
-- and failure, deleted by the daily sweep, and never SELECTed by anything.
-- Two indexes existed to accelerate queries that were never run.
DROP INDEX IF EXISTS idx_agent_runs_status;
DROP INDEX IF EXISTS idx_agent_runs_fingerprint;
DROP TABLE IF EXISTS agent_runs;

-- source_health columns that only ever received writes. The sole survivor is
-- articles_fetched_count — the running tally getDeskStats sums for the home
-- page "today's desk" strip. last_fetch_at / last_success_at /
-- consecutive_failures / avg_latency_ms / articles_inserted_count had zero
-- readers (no admin dashboard, no health page, no alerting).
ALTER TABLE source_health DROP COLUMN last_fetch_at;
ALTER TABLE source_health DROP COLUMN last_success_at;
ALTER TABLE source_health DROP COLUMN consecutive_failures;
ALTER TABLE source_health DROP COLUMN avg_latency_ms;
ALTER TABLE source_health DROP COLUMN articles_inserted_count;

-- raw_metadata stored {source, sourceAuthority} on every insert — both are
-- reconstructable via the source_id FK join the explore query already does,
-- and nothing ever SELECTed this column.
ALTER TABLE articles DROP COLUMN raw_metadata;

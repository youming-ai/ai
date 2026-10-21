-- source_health is now fully dead: the last reader (getDeskStats, which summed
-- articles_fetched_count for the home page desk strip) was removed along with
-- the DeskStats banner. The table received writes every ingest tick and had
-- zero SELECTs. The FK on articles.source_id → sources.id is unaffected —
-- source_health was a separate telemetry side-table, not part of the article
-- relation.
DROP TABLE IF EXISTS source_health;

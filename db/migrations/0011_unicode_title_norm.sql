-- 0008 introduced title_norm with an ASCII-only normalizer. The ingest code
-- now keeps Unicode letters and numbers, so old values cannot be safely
-- compared to new keys. Clear them rather than letting values such as `ai`
-- falsely suppress unrelated multilingual stories; canonical_url and
-- fingerprint remain the exact duplicate guards for these legacy rows.
UPDATE articles SET title_norm = NULL WHERE title_norm IS NOT NULL;

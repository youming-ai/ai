-- Cross-source dedup key: normalized title (lowercase, non-alphanumerics
-- stripped) so the same story syndicated across outlets is stored once.
-- Existing rows are left NULL; they are not deduped against (and cannot be
-- cleaned anyway — retention archives, never deletes). New rows carry it.
ALTER TABLE articles ADD COLUMN title_norm TEXT;

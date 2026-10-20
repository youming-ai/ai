-- Back to Poche Explore as the only source: take the independent-source stories
-- of the curator era off the board. Archived, not deleted, so their fingerprint
-- and canonical_url still guard dedupe (same shape as 0010).
UPDATE articles
   SET status = 'archived'
 WHERE source_id <> 'poche-explore'
   AND status IN ('published', 'filtered');

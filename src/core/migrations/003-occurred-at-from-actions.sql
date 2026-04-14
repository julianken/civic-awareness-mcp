-- Phase 2.5 correctness fix: OpenStates bills were previously ingested
-- with `occurred_at = bill.updated_at` (the upstream crawl/update
-- timestamp) instead of the latest legislative action date. This made
-- "recent" feeds surface crawl-time activity instead of real
-- legislative activity. Adapter is fixed at refresh-write time; this
-- migration heals existing rows by reading the action date out of
-- `raw.actions` and canonicalising it to the full ISO-8601 form that
-- Document.occurred_at (Zod iso.datetime) requires.
--
-- Idempotent: already-canonical rows are preserved because strftime
-- on a parseable date returns the same canonical form, and rows
-- without actions are filtered by json_array_length > 0.
UPDATE documents
SET occurred_at = COALESCE(
    strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(raw, '$.actions[#-1].date')),
    occurred_at
)
WHERE kind = 'bill'
  AND source_name = 'openstates'
  AND json_array_length(json_extract(raw, '$.actions')) > 0;

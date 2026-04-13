-- Phase 2.5 correctness fix: OpenStates bills were previously ingested
-- with `occurred_at = bill.updated_at` (the upstream crawl/update
-- timestamp) instead of the latest legislative action date. This made
-- "recent" feeds surface crawl-time activity instead of real
-- legislative activity. Adapter is fixed at refresh-write time; this
-- migration heals existing rows by reading the action date out of
-- `raw.actions`.
--
-- Idempotent: running on already-healed rows is a no-op because
-- json_extract of a non-existent path returns NULL and COALESCE
-- preserves the existing value.
UPDATE documents
SET occurred_at = COALESCE(
    json_extract(raw, '$.actions[#-1].date'),
    occurred_at
)
WHERE kind = 'bill'
  AND source_name = 'openstates'
  AND json_array_length(json_extract(raw, '$.actions')) > 0;

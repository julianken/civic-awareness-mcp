-- Pre-Phase-5 OpenStates ingests stored `occurred_at` as
-- `2026-04-04T06:20:24.862671+00:00` (microsecond precision +
-- numeric offset), bypassing the strict Zod `iso.datetime()` regex
-- and breaking `recent_bills` on read. `upsertDocument` now
-- canonicalizes on write; this migration heals legacy rows.
-- `strftime('%Y-%m-%dT%H:%M:%fZ', ...)` is idempotent on already-
-- canonical input, so running this on a clean DB is a no-op.
UPDATE documents
SET occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at)
WHERE occurred_at NOT GLOB '????-??-??T??:??:??.???Z';

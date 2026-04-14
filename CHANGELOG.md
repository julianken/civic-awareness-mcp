# Changelog

All notable changes to `civic-awareness-mcp` will be documented in
this file. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] — 2026-04-13

Phase 2.5 correctness and polish, surfaced by a 5-reviewer UX + technical
analysis. Full plan at `docs/plans/phase-2.5-correctness-polish.md`.

### Fixed

- **OpenStates `occurred_at` = latest action date, not crawl time.**
  Previously, `documents.occurred_at` on OpenStates bills stored
  `bill.updated_at` (when OpenStates last touched the record), so
  "recent" feeds surfaced 7-month-old legislative activity as if it
  had just happened. Migration 003 heals existing rows idempotently.
  (T2)
- **`upsertEntity` merges metadata and appends to `roles[]`.** The
  UPDATE branch previously only touched `external_ids`/`aliases`/
  `last_seen_at`, so richer metadata from subsequent refreshes was
  silently dropped — a senator first ingested with just `{party}` and
  then re-ingested with full role info never got the full info.
  `roles[]` now appends non-duplicates keyed on
  `(jurisdiction, role, from)`. Hand-rolled merge blocks in the
  congress and openfec adapters removed. (T1)
- **Fuzzy resolver wired into `upsertEntity`.** `fuzzyPick` was
  implemented but never called. Now part of the resolver chain after
  external-ID → exact-name → exact-alias, gated on linking signals
  (shared external-id source family, matching middle-name, overlapping
  role-jurisdiction). (T1)
- **`get_entity.recent_documents` sorts by legislative action date.**
  Now returns `action_date` alongside `occurred_at` on each item and
  sorts by the former, falling back to the latter via COALESCE. (T3)
- **`queryDocuments` honors `"*"` jurisdiction wildcard.** Previously
  the WHERE clause emitted `jurisdiction = '*'` literally, matching
  nothing. Now the filter is skipped when `"*"` is passed. (T5 polish)
- **`data_freshness.last_refreshed_at` reflects fetch time, not event
  time.** Corrected the underlying SQL from `occurred_at` to
  `fetched_at`. (T5 polish)
- **Sponsorship-only legislators get roles populated from the bill's
  jurisdiction.** OpenStates sponsorship payloads include legislator
  scalar metadata but omit `jurisdiction.id`; the adapter now uses
  the bill's own jurisdiction as a fallback when creating/updating a
  person seen only as a sponsor. (Fix caught by smoke test, outside
  the six planned Phase 2.5 tasks.)

### Added

- **`sponsor_summary` on `recent_bills` responses.** Replaces the
  previous full-sponsor inline array. Summary carries
  `{count, by_party, top: [≤5]}` computed via a single batched SELECT
  instead of N+1 per-sponsor lookups. 20-bill Texas response fits
  in <30 KB (was ~171 KB). Full sponsor list remains reachable via
  `get_entity(bill_id)` or `entity_connections`. (T4)
- **`empty_reason` + `data_freshness` + `hint` on empty feed
  responses.** Distinguishes "no_refresh" (jurisdiction not yet
  ingested), "no_events_in_window" (old data exists outside window),
  and "unknown_jurisdiction". Wired into `recent_bills` and
  `recent_votes`. Non-empty responses unchanged. (T5)
- **`session` filter on `recent_bills` and `recent_votes`.** Bypasses
  the date window when present. `recent_bills` already advertised the
  parameter in its zod schema but the handler ignored it; both tools
  now honor it. `recent_votes.session` is plumbing ahead of
  OpenStates vote ingestion (federal votes from Congress.gov write
  `raw.congress`, not `raw.session`). (T6)
- **`days` ceiling raised from 90 to 365** on `recent_bills` and
  `recent_votes` inputs. Biennial state legislatures can now be
  reached via a single window query without resorting to `session`.
  (T6)

### Changed (breaking)

- **`BillSummary.sponsors` removed.** `recent_bills` response items
  now carry `sponsor_summary` instead. Callers that want the full
  sponsor list should call `get_entity(bill_id)` or
  `entity_connections`. (T4)
- **`Document.occurred_at` semantics changed for OpenStates bills.**
  Migration 003 heals existing rows automatically; early-adopter
  databases may alternatively be rebuilt via
  `rm -rf data/*.db && pnpm refresh --all`. (T2)

### Known gaps (deferred)

- `queryDocuments` is the sort chokepoint for `recent_*` feed tools;
  T3 extended `findDocumentsByEntity` to surface `action_date` and
  sort by it, but `queryDocuments` is unchanged. The two projections
  may report different "recent" orderings for the same data. V2+
  target.
- `recent_votes.session` is schema-and-handler ready but depends on
  OpenStates vote ingestion, which isn't yet implemented.
- `sponsor_summary.top` is capped at 5 by design. Bills with hundreds
  of cosponsors (e.g., TX SB 5 with 112) surface only the first 5.
- Session scans are capped at 100 bills / 200 votes. Complete
  enumeration of large sessions (TX 88th ≈ 8,000 bills) requires
  pagination; none is implemented.

## [0.0.6] — 2026-04-12

First public release candidate. Four polish commits (metadata,
README, examples, drift-guard).

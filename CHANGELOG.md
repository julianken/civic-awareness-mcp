# Changelog

All notable changes to `civic-awareness-mcp` will be documented in
this file. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Added
- `recent_bills` accepts an optional `limit: number` (1..20). When set, the handler drops the days-derived upstream time filter and returns top-N by last-updated. Intended for biennial and off-session jurisdictions where the default 7-day window is empty. See D12 / R16. (phase-9a)
- `list_bills` MCP tool for structured bill listing by sponsor,
  subject, classification, session, chamber, and date ranges.
  Ships OpenStates state-bill support; federal returns
  `not_yet_supported` until a future phase.
- `get_vote` detail tool: returns per-legislator positions (entity_id,
  name, party, state, yea/nay/present/not_voting) for one roll-call
  vote. Federal (Congress.gov) only; accepts either `vote_id` or the
  `(congress, chamber, session, roll_number)` composite. See R17, D11.
- `entity_connections`: edges now include `via_roles[]` alongside
  `via_kinds[]`, distinguishing sponsored / cosponsored / voted /
  contributor edges. (phase-9d)
- `search_entities`: optional `had_role` and `had_jurisdiction`
  filters over `metadata.roles[]`. Both AND against a single roles
  entry so a federal senator's state-legislator history in Texas
  matches `(had_role=state_legislator, had_jurisdiction=us-tx)` but
  the senator role alone does not. (phase-9d)
- `recent_contributions`: optional `contributor_entity_id` and
  `side` inputs. Donor-side queries ("what did X give to") no
  longer require `entity_connections` chaining. (phase-9d)

### Changed
- `recent_bills` and `list_bills`: removed the 20/50 caps on
  `limit`. Both tools now honor any caller-provided `limit`. When
  `limit > 500`, the tool returns a `requires_confirmation`
  envelope (no upstream fetch) until the caller passes
  `acknowledge_high_cost: true`. OpenStates and Congress.gov
  adapters paginate underneath. See R18, D12 amendment. (phase-9e)
- `recent_contributions` cache key expanded to include
  `contributor_entity_id` and `side`. When `candidate_or_committee`
  is set and `side` is omitted, `side` defaults to `"recipient"` —
  preserves back-compat so pre-9d calls hit the same cache row as
  before. (phase-9d)
- `list_bills`: chamber filter now matches the bill's originating
  chamber; OpenStates `from_organization` is persisted into
  `documents.raw` so the filter survives subsequent re-projections.
  (4d10c78)
- `list_bills`: short-circuits when a sponsor filter resolves to
  an entity with no upstream sponsor link (instead of returning a
  full unfiltered list); inlines OpenStates `updatedDate` and fills
  legislator coverage gaps so sponsor-side queries don't miss bills
  whose only signal was a sponsorship-only legislator row. (77e2507)
- `openstates`: extracted a shared fetch-and-upsert-bills helper
  used by both `recent_bills` and `list_bills` so the two tools
  share one normalization path. (29c21d2, refactor only)
- `get_vote`: hoisted the bioguide-resolution prepared statement
  out of the per-position loop and added an expression index on
  `external_ids.bioguide` (migration 007). Cuts per-vote projection
  cost on large roll calls. (a6f48b9)
- `get_vote`: narrowed `VotePosition.vote` from `string` to the
  literal union `"yea" | "nay" | "present" | "not_voting"` — the
  four values the handler actually emits. (b6a5fb6)

### Tests
- `list_bills`: new integration test covering the
  `upstream_failure` path — a fetch error after warm cache exists
  serves stale rows with the documented `stale_notice`. (561a34b)

## 0.3.0 (2026-04-14)

### Changed
- Hydration architecture rewritten from R13 (jurisdiction-wide
  pass-through cache) to R15 (shaped-query hydration per endpoint).
  All 9 MCP tools now use `withShapedFetch` with narrow
  shape-specific adapter methods.
- Cache key migrated from `hydrations(source, jurisdiction, scope)`
  to `fetch_log(source, endpoint_path, args_hash)`.
- `stale_notice` narrowed: retired `partial_hydrate`,
  `rate_limited`, and `daily_budget_exhausted` reasons.
  `upstream_failure` is the only reason emitted when cached data
  exists as fallback.

### Removed
- `hydrations` table (migration 006).
- `src/core/hydrate.ts`, `src/core/freshness.ts`.

### Cache state
- Upgraders lose their R13 `hydrations` rows on first launch.
  Fine-grained `fetch_log` rows are populated fresh on next tool
  calls. DailyBudget prevents refetch storm.

## v0.2.0 — 2026-04-13

**Transparent pass-through cache (R13).** The MCP is no longer an
empty database waiting to be filled by the user — it's a live
interface to OpenStates, Congress.gov, and OpenFEC with the SQLite
store acting as a TTL cache. Cache misses fetch upstream
transparently. Upstream failures serve stale local data with a
`stale_notice` field. Entity tools auto-hydrate their jurisdiction.

### Added
- `src/core/freshness.ts` — TTL helpers (1h recent / 24h full)
- `src/core/singleflight.ts` — concurrent-hydrate coalescing
- `src/core/budget.ts` — daily request budget guard
  (`CIVIC_AWARENESS_DAILY_BUDGET` env var)
- `src/core/hydrate.ts` — pass-through orchestrator
- `src/core/limiters.ts` — shared per-source rate limiter registry
- `hydrations` table (migration 004)
- `stale_notice` sibling field on every tool response envelope
- Adapter `deadline?: number` option for wall-clock bounded pulls
- `RateLimiter.peekWaitMs()` + `RATE_LIMIT_WAIT_THRESHOLD_MS=2500`
- Tagged `ConfigurationError` for hard-fail on missing API keys

### Changed
- All 8 read tools now hydrate transparently when data is stale or
  missing. No user-visible refresh step.
- Empty-feed diagnostic hints no longer reference `pnpm refresh`;
  removed the `no_refresh` variant from `EmptyReason`.
- Entity tools bound their first-call hydration to `maxPages=5` AND
  a 20s wall-clock deadline; partial results are marked and
  surfaced via `stale_notice`.

### Removed
- `refresh_source` MCP tool (superseded by pass-through). The
  `pnpm refresh` CLI remains for operator use.

### Docs
- `docs/00-rationale.md`: R13 added
- `docs/06-open-decisions.md`: D5 second amendment
- `CLAUDE.md`: D5 bullet + pass-through mental model
- `docs/05-tool-surface.md`: pass-through cache section
- `docs/02-architecture.md`: pass-through hydration layer
- `docs/plans/phase-5-onboarding-and-refresh-tool.md`: supersede banner

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

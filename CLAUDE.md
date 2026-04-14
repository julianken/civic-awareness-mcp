# Instructions for Claude Code in this repo

This is a **planning-complete, code-not-started** repository for an
MCP server that exposes **US federal and state-legislature civic
data** to LLMs. Scope and key decisions are locked (see R11 in
`docs/00-rationale.md` and all D-items in
`docs/06-open-decisions.md`, finalized 2026-04-12).

## First-session protocol

When a human opens this repo in Claude Code for the first time:

1. **Read the planning docs in order:**
   - `README.md`
   - `docs/00-rationale.md` — especially **R11** (the scope pivot
     from Arizona-civic to US-legislative)
   - `docs/01-vision.md`
   - `docs/02-architecture.md`
   - `docs/05-tool-surface.md`
   - `docs/06-open-decisions.md` — all 10 decisions are locked
     (D1–D10), but read for the rationale and constraints

2. **Verify your understanding with the human.** Briefly summarize:
   - V1 scope: OpenStates (50 states) + Congress.gov (federal) +
     OpenFEC (federal campaign finance)
   - Out of scope: municipal, state-level campaign finance, courts
   - Person entities are cross-jurisdiction (D3b)
   Confirm nothing has changed in the human's head since the docs
   were written.

3. **Invoke `superpowers:subagent-driven-development`** (preferred)
   or `superpowers:executing-plans` and start executing
   `docs/plans/phase-1-foundation.md` task-by-task.

## Ongoing sessions

- Every phase is a separate plan in `docs/plans/`. Don't run multiple
  phases in parallel — each phase produces a working, tested
  artifact that the next phase builds on.
- After completing any plan, run the test suite, commit, and wait
  for human review before starting the next phase.
- If a planning assumption turns out wrong during implementation,
  **stop and update the plan document** rather than silently
  diverging. The plan is the source of truth.
- If a scope-level decision needs revisiting (anything in
  `docs/06-open-decisions.md`), update that decision in place with a
  new dated line AND add a new R entry to `docs/00-rationale.md`.
  Preserve history; don't rewrite it. R11 is the pattern to follow.

> **⚠️ Phase-8 migration in flight (started 2026-04-14):** The
> hydration model is moving from R13 (transparent pass-through
> cache, jurisdiction-keyed) to R15 (shaped-query hydration,
> endpoint-keyed). Existing tools still call `ensureFresh` via
> `src/core/hydrate.ts`; new adapter methods and `withShapedFetch`
> in `src/core/tool_cache.ts` are the target pattern for all tool
> rewrites starting in phase 8b. See
> `docs/superpowers/specs/2026-04-14-shaped-query-hydration-design.md`
> and `docs/plans/phase-8a-shaped-fetch-infra.md` for the full
> design and rollout. During the migration window, do not
> introduce new `ensureFresh` calls — use `withShapedFetch` for
> any new code paths.

## Key conventions (locked by decision records)

- **Language:** TypeScript on Node.js 22+ (D1)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Package manager:** `pnpm`
- **Test runner:** `vitest`; HTTP mocking via `msw` (D10)
- **Schema validation:** `zod`
- **Entity store:** `better-sqlite3` (synchronous, zero-setup)
- **HTTP:** native `fetch` (Node 22+)
- **Scope (D2 / R11):** V1 = OpenStates all 50 states; V2 = +
  Congress.gov + OpenFEC. Municipal sources are out indefinitely.
- **Scraping posture (D4):** All V1 sources are Tier 1 (sanctioned
  API, free with key). `src/util/http.ts` enforces User-Agent,
  per-host token bucket, backoff, `Retry-After`.
- **Refresh (D5 → R13 → R15):** Under the phase-8 migration
  (in flight), tools call `withShapedFetch(db, key, ttl,
  fetchAndWrite, readLocal)` from `src/core/tool_cache.ts`. The
  cache key is `(source, endpoint_path, args_hash)`; freshness
  rows live in the `fetch_log` table. Upstream fetch +
  write-through happen in one transaction and `fetch_log` is
  updated in the same transaction. `stale_notice` fires only
  when an upstream fetch failed and cached data exists as
  fallback. The `hydrations` table and `ensureFresh` still exist
  for tools not yet rewritten; both are removed in phase 8.10.
  `pnpm refresh` CLI remains for operator use.
- **Storage (D6):** `./data/civic-awareness.db` default; env var
  `CIVIC_AWARENESS_DB_PATH` overrides for installed use.
- **License (D7):** MIT
- **Distribution (D8):** Publish to npm as `civic-awareness-mcp`
  after Phase 2 (V1), not after V2 as originally proposed.
- **Code style:** no comments explaining WHAT — only explain WHY
  when non-obvious. No defensive programming for things that can't
  happen. No backwards-compatibility hacks for code that was never
  released.

## How to think about this MCP

The tool surface has three projections over the same entity-tagged
event stream:

- **Feeds (B):** `recent_bills`, `recent_votes`,
  `recent_contributions`, `search_civic_documents` — time-first,
  discovery-oriented.
- **Entities (A):** `search_entities`, `get_entity`,
  `entity_connections`, `resolve_person` — identity-first,
  investigation-oriented.
- **Details (C):** `get_bill` (and future `get_vote`,
  `get_contribution`) — identifier-first, full projection of one
  resource. Uses per-document TTL (R14 / D11) tracked in
  documents.fetched_at, independent of the endpoint-level
  fetch_log cache used by feed and entity tools.
- **Shaped-query hydration (R15, in flight):** Tools gate their
  upstream fetches on a `fetch_log` row keyed by
  `(source, endpoint_path, args_hash)`. On a miss they call
  the adapter's narrow shaped method, write-through inside a
  transaction, and serve from the local store. R13's
  jurisdiction-wide singleflight and `partial_hydrate` stale
  notice no longer apply. See
  `src/core/tool_cache.ts::withShapedFetch`.

Both share the same underlying store. Every adapter writes
`Document`s with `Entity` references; every tool reads those same
tables with different projections. **Do not build two separate
pipelines.**

Under D3b, Person entities are **cross-jurisdiction** — one sitting
Senator's state-legislature history and federal role live on one
entity row, not two. Entity resolution uses external-IDs first, then
exact normalized name, then Levenshtein ≤ 1 fuzzy *only with a
positive linking signal* (shared external-id source family, exact
middle-name match, or role-jurisdiction overlap). See
`docs/04-entity-schema.md` for the full algorithm.

## What NOT to do

- Don't add municipal, state-finance, or non-Tier-1 sources without
  updating `docs/01-vision.md`, `docs/03-data-sources.md`,
  `docs/06-open-decisions.md` D2, and adding a new R entry to
  `docs/00-rationale.md`. R11 is the pattern.
- Don't over-engineer entity resolution. V1 is **external-IDs, exact
  name, and fuzzy Levenshtein with linking-signal merges**. No ML,
  no embeddings, no vector search. See `docs/04-entity-schema.md`.
- The SQLite store IS the cache (`fetch_log` table under R15;
  `hydrations` table retained for not-yet-migrated tools until
  phase 8.10). Don't add a second cache layer in memory or
  elsewhere. Per-tool TTLs live in `src/core/tool_cache.ts`;
  legacy per-jurisdiction TTLs live in `src/core/freshness.ts`
  until their removal in phase 8.10.
- Don't bake jurisdiction into Person entity uniqueness constraints.
  Per D3b, `entities` must not have a UNIQUE on
  `(kind, jurisdiction, name_normalized)` that includes Person rows.
- Don't hardcode `"az"` (or any other state) anywhere. Jurisdictions
  are runtime parameters, iterated by the refresh job.
- Don't synthesize `Document.summary` inside the MCP (D3c / R9). The
  consuming LLM does summarization.

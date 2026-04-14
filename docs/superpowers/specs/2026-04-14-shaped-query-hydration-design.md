# Shaped-Query Hydration — Design Spec

**Date:** 2026-04-14
**Status:** Approved (pending user sign-off)
**Supersedes:** R13 (transparent pass-through cache, 2026-04-13)
**Introduces:** R15 (shaped-query hydration), D5 second amendment

## Problem

R13's transparent pass-through cache gates every tool call on a
`(source, jurisdiction, scope)` freshness row and, on a miss, runs
`refreshSource()` — which paginates whole upstreams. For
Congress.gov that's `/member` + `/bill` + `/vote` across two
Congresses at 250/page × up to 5 pages each. Cold `us-federal`
calls hit the 20 s budget, return `partial_hydrate` stale notices,
and often an empty result. The cost model doesn't match the call
model: `resolve_person("Angus King")` needs one endpoint, not
thousands of records.

The current architecture conflates three orthogonal concerns — cache
freshness, upstream pagination, and jurisdiction scope — into a
single gate. Separating them lets each tool pay only for the
upstream work it actually needs.

## Principle

Shaped upstream fetches, narrow per call:

```
tool call
  → narrow upstream fetch (shaped to source's capability)
  → atomic write-through to documents/entities
  → local SQL read
  → return
```

The local store is a growing cache of "things any tool has ever
touched." Not a mirror of upstream. No jurisdiction hydration.
`stale_notice` fires in exactly one case: an upstream fetch failed
AND we have stale cached data to fall back on.

Two complementary freshness mechanisms coexist:

- **R14 (per-document TTL)** — used when the tool returns exactly
  one resource whose freshness is inherent to the row. `get_bill`
  uses this via `ensureBillFresh`, which reads `documents.fetched_at`
  directly and re-fetches if the row is older than the TTL.
- **R15 (per-endpoint TTL, new)** — used when the tool queries a
  listing/search endpoint that returns many rows. Freshness is
  tracked in a new `fetch_log` table keyed on the upstream
  `(source, endpoint_path, args)` tuple. The store gets populated
  as a side effect; the `fetch_log` row records "we asked this
  question and got an answer at time T."

`pnpm refresh` CLI is retained for operator bulk pre-fill and
should write `fetch_log` rows (per specific endpoint+args it
covers) so tool calls after a bulk-fill hit the cache.

## Architecture

### Components

**`fetch_log` table (new).** Per-endpoint cache-freshness
tracking. Replaces `hydrations` entirely.

```sql
CREATE TABLE fetch_log (
  source         TEXT NOT NULL,
  endpoint_path  TEXT NOT NULL,
  args_hash      TEXT NOT NULL,
  scope          TEXT NOT NULL,   -- "recent" | "full" | "detail"
  fetched_at     TEXT NOT NULL,   -- ISO-8601
  last_rowcount  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, endpoint_path, args_hash)
);
CREATE INDEX idx_fetch_log_fetched_at ON fetch_log (fetched_at);
```

The key is `(source, endpoint_path, args_hash)`. Multiple tools
hitting the same upstream endpoint with the same normalized args
share one row — real deduplication at the upstream request
boundary. `scope` is tracked as a column to support TTL dispatch
but is NOT part of the key: a "full" fetch supersedes a prior
"recent" for the same endpoint+args. `last_rowcount` distinguishes
"upstream returned empty" from "never tried" — important for
`empty_reason` diagnostics.

**`src/core/tool_cache.ts` (new).** Single module exposing:

```ts
export async function withShapedFetch<T>(
  db: Database.Database,
  key: { source: HydrationSource; endpoint_path: string; args: unknown },
  ttl: { scope: "recent" | "full" | "detail"; ms: number },
  fetchAndWrite: () => Promise<{ primary_rows_written: number }>,
  readLocal: () => T,
): Promise<{ value: T; stale_notice?: StaleNotice }>
```

`primary_rows_written` is the count of top-level resources the
shaped fetch produced (e.g., 250 for a paginated bills response
regardless of how many sponsors or votes get upserted as side
effects). Stored in `fetch_log.last_rowcount` for the
"upstream returned empty" vs "never tried" distinction.

Internally: check `fetch_log`; if fresh, skip upstream and
`readLocal()`; else singleflight-coalesce, rate-limit peek, daily
budget check, `fetchAndWrite()` inside a `db.transaction`, update
`fetch_log` in the same transaction, `readLocal()`. On upstream
failure with cached data present, return `readLocal()` + a
`stale_notice`.

**Singleflight** (kept, moved out of `hydrate.ts`) — keyed on
`(source, endpoint_path, args_hash)`. Coalesces concurrent
identical requests regardless of which tool issued them.

**DailyBudget** (kept, moved out of `hydrate.ts`) — per-source
daily cap as a safety rail against budget exhaustion when many
unique args hit in quick succession.

### Data flow — per-tool call

1. Tool handler parses and Zod-validates input.
2. For each upstream endpoint the tool needs: compute
   `args_hash = sha256_32(canonicalize(args))`.
3. `withShapedFetch(...)`:
   a. SELECT from `fetch_log`; if `Date.now() - fetched_at < ttl`, skip
      upstream, do `readLocal()`, return.
   b. Else acquire singleflight lock on
      `(source, endpoint_path, args_hash)`.
   c. Re-check freshness (double-check under lock).
   d. Check daily budget; if exhausted, fall back to
      `readLocal()` + `stale_notice` if any cached data, else
      propagate budget error.
   e. Peek rate-limit wait; if > 2.5 s threshold, fall back to
      cached data or propagate.
   f. Inside `db.transaction`:
      - Call adapter's shaped fetch method (returns parsed
        upstream payload).
      - Upsert resulting `documents` / `entities` /
        `document_references`.
      - Upsert `fetch_log` row with `fetched_at = now`,
        `last_rowcount = N`.
   g. On success: run `readLocal()`, return.
   h. On upstream error inside the transaction: rollback the
      whole batch; if prior cached data exists, return
      `readLocal()` + `stale_notice(upstream_failure)`; else
      propagate the error.

**Why `fetch_log` UPDATE is inside the same transaction as the
write-through:** the scenario "upstream succeeded, write-through
partial-failed, `fetch_log` marked fresh anyway" produces
silently-wrong cache state that never self-heals until TTL
expiry. Wrapping both in one transaction eliminates the
possibility.

### args_hash normalization

Runs **post-parse** (on the Zod-validated object). Algorithm:

1. Recursive canonicalization `canon(v)`:
   - `undefined` → drop key
   - `null` → emit `null`
   - `boolean`, `number` → emit as-is (`Number.isFinite` required)
   - `string` → NFC-normalize, trim, collapse internal whitespace,
     lowercase. Uniformly — every string in the args tree.
   - array → `v.map(canon)`, preserve input order (arrays carry
     semantics — sponsor order matters)
   - object → drop keys whose canon value is `undefined`; emit
     remaining keys in codepoint-sorted order
2. Serialize canonicalized value via `JSON.stringify`.
3. Prefix with tool name: `payload = ${tool}:${json}`. Prevents
   cross-tool collisions (`{id:"x"}` means different things to
   `get_entity` vs `get_bill`).
4. Hash: `crypto.createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32)`.
   32 hex chars (128 bits); birthday collision probability ~10⁻²⁹
   at 10 k dedup keys/day.

**Empty/absent equivalence:** `undefined`, missing key, and `""`
after trim all collapse to "field omitted." `null` stays distinct
(no caller passes explicit null today). Zod `.default()` values are
populated by parse and always appear in canonical form.

**Test vectors** (exercised by `tests/unit/core/tool_cache.test.ts`):

| # | Input | Canonical payload | Hash |
|---|---|---|---|
| 1 | `{name:"Angus King"}` | `resolve_person:{"name":"angus king"}` | H1 |
| 2 | `{name:"angus king"}` | same | H1 |
| 3 | `{name:"Angus King", role_hint:""}` | same | H1 |
| 4 | `{name:"  Angus  King  "}` | same | H1 |
| 5 | `{role_hint:"senator", name:"Angus King"}` | `resolve_person:{"name":"angus king","role_hint":"senator"}` | H2 |
| 6 | `{name:"Angus King", role_hint:"senator"}` | same as #5 | H2 |
| 7 | `{jurisdiction:"US-TX", days:7}` | `recent_bills:{"days":7,"jurisdiction":"us-tx"}` | H3 |
| 8 | `{jurisdiction:"us-tx", days:7.0}` | same as #7 | H3 |
| 9 | `{q:"tax",kinds:["bill","vote"]}` | `search_civic_documents:{"kinds":["bill","vote"],"limit":20,"q":"tax"}` | H4 |
| 10 | `{q:"tax",kinds:["vote","bill"]}` | `search_civic_documents:{"kinds":["vote","bill"],"limit":20,"q":"tax"}` | H5 (≠ H4) |
| 11 | `{name:"Smith"}` | `resolve_person:{"name":"smith"}` | H6 |
| 12 | `{name:"John Smith"}` | `resolve_person:{"name":"john smith"}` | H7 (≠ H6) |

### Per-tool wiring

| Tool | Endpoint(s) | Scope | TTL |
|---|---|---|---|
| `recent_bills` (state) | OpenStates `/bills?jurisdiction=<abbr>&updated_since=<date>&sort=updated_desc` | recent | 1 h |
| `recent_bills` (federal) | Congress.gov `/bill?fromDateTime=<iso>&sort=updateDate+desc` | recent | 1 h |
| `recent_votes` | Congress.gov `/vote?congress=<N>&sort=date+desc` (client date filter — no `fromDateTime` on `/vote`) | recent | 1 h |
| `recent_contributions` | OpenFEC `/schedules/schedule_a?committee_id=<id>&min_date=<mm/dd/yyyy>` | recent | 1 h |
| `search_civic_documents` | Local-only; returns `empty_reason: "store_not_warmed"` + hint when local corpus is empty for the queried jurisdiction | — | — |
| `resolve_person` | OpenStates `/people?jurisdiction=&name=`, OpenFEC `/candidates/search?q=`, Congress.gov `/member?congress=<N>` (first page + client name filter — no name param on `/member`) | full | 24 h |
| `search_entities` | Same three endpoints as `resolve_person` — shares cache rows when args normalize identically | full | 24 h |
| `get_entity` | By external ID: Congress.gov `/member/{bioguide}`, OpenStates `/people/{ocd-id}`, OpenFEC `/candidate/{id}` | detail | 24 h |
| `get_bill` | Unchanged (R14 per-document TTL via `ensureBillFresh`; OpenStates `/bills/{ocd-bill-id}`) | detail | 1 h |
| `entity_connections` | See below | full | 24 h |

**Key API corrections from the original plan:**
- Congress.gov `/bill` DOES support `fromDateTime` — use it, don't
  paginate-and-filter.
- Congress.gov DOES expose `/member/{bioguideId}/sponsored-legislation`
  and `/cosponsored-legislation` — use for `entity_connections`.
- OpenFEC `/schedules/schedule_a` does NOT support `candidate_id`.
  Two-step: fetch `/candidate/{id}`, read
  `principal_committees[].committee_id`, then query schedule_a with
  `committee_id=A&committee_id=B&...`.
- OpenFEC date filters are `min_date`/`max_date` and filter on
  *reporting* date, not contribution date — document the caveat in
  tool response metadata.
- OpenStates `/bills` supports `updated_since`, `created_since`,
  `sponsor=<ocd-id>`, and `q=<fulltext>` — use where applicable.

### `entity_connections` cold-path

On call for entity X:

1. Load X from `entities`.
2. If `X.external_ids` is empty, short-circuit: return
   `{ root: X, edges: [], nodes: [], sources: [], truncated: false, empty_reason: "no_external_ids" }`.
   No upstream calls, no hydration. Self-heals on future merge.
3. Else, fan out narrow fetches per external ID present, each
   `withShapedFetch`-gated:
   - **OpenFEC** (if `fec_candidate` present): two-step fetch
     `/candidate/{id}` → harvest `principal_committees[].committee_id` →
     `/schedules/schedule_a?committee_id=A&committee_id=B&...` with
     a reasonable date window (last 2 cycles). Write-through to
     contribution documents.
   - **OpenStates** (if `openstates_person` present): `/people/{ocd-id}`
     for canonical metadata, plus `/bills?sponsor=<id>` (narrow)
     with `sort=updated_desc`, 1 page. Write-through.
   - **Congress.gov** (if `bioguide` present):
     `/member/{bioguide}/sponsored-legislation` AND
     `/cosponsored-legislation`, one page each. Write-through.
4. Run existing `findConnections()` over the now-warmer local
   store.
5. Each per-source fan-out is itself fetch-log-cached at
   `(source, <endpoint_path>, hash(external_id))` with 24 h TTL, so
   repeat calls for the same entity within TTL skip upstream.

Cost: cold call for a fully-linked federal senator makes ~5 API
calls (~1-3 s). Subsequent senators benefit from already-cached
members; entity_connections for entities the graph has already
touched is local-only.

### Atomicity requirements

- **Every adapter shaped-fetch method MUST wrap its full upsert
  batch in `db.transaction(() => { ... })()`.** The current
  `CongressAdapter.refresh` calls `upsertBill` in a bare for-loop
  inside sections without a wrapping transaction — readers can see
  half-warmed state. Fix as part of the per-tool vertical.
- **`fetch_log` row is written in the same transaction as the
  documents/entities it represents.** If the adapter throws or
  returns partial data, the whole transaction rolls back, including
  the freshness mark.
- **WAL journal mode must be enabled.** Confirm at bootstrap
  (`PRAGMA journal_mode=WAL`) so long writes don't block readers.

## Error model

`stale_notice` is emitted in exactly one case: **we attempted an
upstream fetch, it failed (network error, 5xx, parse error), and
we have prior cached rows to return as fallback.**

| Reason | Triggered when | Response shape |
|---|---|---|
| `upstream_failure` | Adapter threw; cache has data | Full response + stale_notice |
| `not_found` | Single-resource fetch returned 404 (e.g., `get_bill`, `get_entity` by external ID) | `null` result + stale_notice |
| `not_yet_supported` | Tool not implemented for a jurisdiction (e.g., federal `get_bill` today) | `null` + stale_notice |

Removed from the model:
- `partial_hydrate` — no jurisdiction hydration, no deadline to exceed
- `rate_limited` — narrow calls fit the bucket; if wait > 2.5 s,
  caller sees `upstream_failure` + stale fallback
- `daily_budget_exhausted` — still possible, surfaced as
  `upstream_failure` if stale data exists, else propagated as error

**"Upstream returned empty" vs "cache is empty":** tracked via
`fetch_log.last_rowcount`. Zero-with-fresh-TTL is valid;
absent-row is "never tried." This feeds into `emptyFeedDiagnostic`
for tools like `recent_bills` and into `search_civic_documents`'s
`empty_reason: "store_not_warmed"` hint.

## Testing strategy

- **`tests/unit/core/tool_cache.test.ts` (new):** args_hash
  normalization test vectors (the 12 above), TTL expiry, singleflight
  coalesce, rollback on upstream failure.
- **Per-tool unit tests:** mock the adapter's shaped fetch method
  (not `ensureFresh`). Each tool test asserts: warm read bypasses
  upstream; cold read calls adapter; upstream failure with stale
  data returns stale_notice; upstream failure without stale
  propagates.
- **`tests/integration/passthrough-e2e.shaped.test.ts` (new):**
  end-to-end scenarios using msw for upstream mocking. Cold fill →
  warm hit → TTL expiry → upstream failure with fallback.
  Grown scenario-by-scenario through the migration; old
  `passthrough-e2e.test.ts` retained until 8.10.
- **`tests/unit/core/hydrate.test.ts`, `tests/unit/core/freshness.test.ts`:**
  deleted in 8.10.
- **`tests/unit/core/hydrations-migration.test.ts`:** deleted in
  8.10 (tests the table being dropped).
- **Integration-test `vi.mock("hydrate.js")` lines** in
  `openfec-e2e.test.ts`, `congress-e2e.test.ts`,
  `openstates-e2e.test.ts`, `phase5-e2e.test.ts`: removed as part
  of each tool's vertical slice in 8.3-8.9.

## Migration plan (11 sub-phases)

Each sub-phase is a separate plan doc + PR; commits on main;
subagent-driven-development workflow with per-task green tests.

| # | Sub-phase | What ships |
|---|---|---|
| 8.1 | Infra | Migration `005_fetch_log.sql`; `src/core/tool_cache.ts` with `withShapedFetch`, singleflight, budget re-exports; args_hash module + unit tests. No behavior change. |
| 8.2 | Docs + compat shim | CLAUDE.md updated with R15 "migration in-flight" banner; `docs/00-rationale.md` R15 (in-flight); `docs/06-open-decisions.md` D5 second amendment; `hydrate.ts` becomes a passthrough stub re-exporting `ensureFresh` unchanged; empty `passthrough-e2e.shaped.test.ts` skeleton. |
| 8.3 | `recent_bills` vertical | Narrow adapter methods for Congress.gov `/bill?fromDateTime=` and OpenStates `/bills?updated_since=`; handler rewrite using `withShapedFetch`; unit test rewrite; drop `vi.mock("hydrate.js")` in `recent_bills`'s integration e2e; one new scenario in `passthrough-e2e.shaped.test.ts`. |
| 8.4 | `recent_votes` vertical | Same shape. Congress.gov `/vote?congress=<N>` + client date filter (no `fromDateTime` on `/vote`). |
| 8.5 | `recent_contributions` vertical | OpenFEC two-step fetch (candidate → committees → schedule_a). |
| 8.6 | `search_civic_documents` vertical | Local-only implementation; `empty_reason: "store_not_warmed"` diagnostic. |
| 8.7 | `resolve_person` + `search_entities` vertical | Paired rewrite; shared endpoint cache rows via endpoint-keyed `fetch_log`. |
| 8.8 | `get_entity` vertical | Direct lookups by external ID per source. |
| 8.9 | `entity_connections` vertical | Cold-path fanout including `no_external_ids` short-circuit, Congress.gov `sponsored-legislation` + `cosponsored-legislation`, OpenFEC two-step. |
| 8.10 | Deletion + release | Delete `hydrate.ts`, `freshness.ts`, old `passthrough-e2e.test.ts`, `tests/unit/core/{hydrate,freshness}.test.ts`, `hydrations-migration.test.ts`, `scripts/smoke-passthrough.ts`. Migration `006_drop_hydrations.sql` with `INSERT INTO fetch_log SELECT FROM hydrations`. Bump to 0.3.0 in `package.json` + `src/mcp/server.ts:30`. CHANGELOG entry. |
| 8.11 | Final docs | Flip R15 "in-flight" → "complete"; update `docs/02-architecture.md`, `docs/05-tool-surface.md`. |

**Ordering rationale:** single-source feeds (8.3-8.5) are simplest
and exercise the new `withShapedFetch` helper in isolation.
`search_civic_documents` (8.6) introduces multi-source fanout
semantics without upstream calls. Entity pair (8.7) validates the
endpoint-keyed cache-sharing property. `get_entity` (8.8) and
`entity_connections` (8.9) come last because they have the most
cross-adapter coupling.

**Compat shim discipline:** in 8.3-8.9, every commit MUST drop
that tool's `vi.mock("hydrate.js")` line. The shim in 8.2 exists
only to prevent import failures during the migration window; if a
tool rewrite forgets step (d), the test silently passes because the
shim's no-op `ensureFresh` stub satisfies the mock. Enforce with a
pre-commit grep: `grep -r 'vi.mock.*hydrate' tests/integration | wc
-l` should strictly decrease with each 8.3-8.9 commit and be zero
before 8.10.

**Migration 006 is a plain `DROP TABLE hydrations`.** The key
schema changed from `(source, jurisdiction, scope)` to
`(source, endpoint_path, args_hash)` — there is no mechanical
mapping from old rows to new. Users upgrading pay a one-time
refetch on first access of each tool+args tuple, capped at
TTL granularity (1 h recent / 24 h full). DailyBudget prevents any
refetch storm. Noted in the CHANGELOG as a semver-minor cache
reset.

## Risks

| Risk | Mitigation |
|---|---|
| Congress.gov `/member` has no name filter → `resolve_person` federal still paginates first page (250) and client-filters. First page may not contain the target. | Cache the page after first fetch; subsequent resolve calls against the same congress hit local. Document the "resolve works best for current Congress" limit. |
| Fuzzy Person with no external IDs returns empty `entity_connections` — caller must understand why. | `empty_reason: "no_external_ids"` is a machine-readable discriminator; response shape identical to normal case. Self-heals on future merge. |
| Shared cache key between `resolve_person` and `search_entities` — if the latter wants richer results in future, the cache forces the query shape to stay aligned. | Acceptable for V1; if the query shapes genuinely diverge in future, tools can carry different `endpoint_path` values (e.g., `/people?jurisdiction=` vs `/people?name=`) to split cache rows. |
| Compat shim in 8.2 can mask incomplete rewrites. | Pre-commit grep enforcement (see above). |
| Migration 006 blanket-row fallback could suppress fresh fetches immediately post-upgrade if TTL hasn't expired. | The blanket row is insert-only; real rows from new tool calls have higher specificity and win the PK lookup. Verified by test. |

## Decisions reference

- **Cache-key scope (decision 7):** `(source, endpoint_path, normalized_args)`.
- **`args_hash` normalization (decision 8):** specified in §args_hash.
- **`entity_connections` no-external-IDs (decision 9):** Option A,
  empty + `empty_reason`.
- **Phase reshape (decision 10):** Plan Y refined into 11 sub-phases.

## Out of scope

- Eviction for `fetch_log` (accumulates per unique args forever).
  Add a `DELETE WHERE fetched_at < date('now','-30 days')` sweep in
  a future polish pass if row count becomes a concern.
- A `merge_entities` admin tool to reconcile fuzzy-split Persons.
  Tracked in D3b; unrelated to this redesign.
- Replacing `pnpm refresh` CLI. CLI continues to exist; in 8.10 it
  also writes `fetch_log` rows for every `(source, endpoint_path,
  args_hash)` its bulk-fill covers (or a blanket row), so tool
  calls after a bulk-fill hit the cache.

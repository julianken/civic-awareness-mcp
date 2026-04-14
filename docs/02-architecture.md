# 02 — Architecture

## The one-sentence architecture

**Upstream adapters normalize heterogeneous civic data into
`Document`s with `Entity` references; tools query that normalized
store in two projections — time-first (feeds) and identity-first
(entities).**

## The diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     MCP Tool Layer                          │
│                                                             │
│  Feed tools (B)              Entity tools (A)               │
│  ─ recent_bills              ─ search_entities              │
│  ─ recent_votes              ─ get_entity                   │
│  ─ recent_contributions      ─ entity_connections           │
│  ─ search_civic_documents    ─ resolve_person               │
└──────────────────────┬──────────────────────────────────────┘
                       │  reads (via withShapedFetch)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│               Normalized Store (SQLite)                     │
│                                                             │
│  entities ──<has_role>── documents ──<mentions>── entities  │
│                                                             │
│  ─ Person (cross-jurisdiction), Organization, Committee     │
│  ─ Bill, Vote, Contribution, Expenditure                    │
│  ─ source_id, source_name, source_url, fetched_at           │
│  ─ fetch_log(source, endpoint_path, args_hash, fetched_at)  │
└──────────────────────▲──────────────────────────────────────┘
                       │  writes
┌──────────────────────┴──────────────────────────────────────┐
│                    Adapter Layer                            │
│                                                             │
│  OpenStatesAdapter       CongressGovAdapter                 │
│  OpenFECAdapter          (future: FederalRegister, ...)     │
│                                                             │
│  Each implements: fetch() → Document[] with Entity refs     │
└──────────────────────┬──────────────────────────────────────┘
                       │  calls
                       ▼
                 Upstream public APIs
```

## Why this shape

### Feed tools and entity tools share data, not code paths

Both tool families read the same two tables (`entities`,
`documents`) with different WHERE clauses and projections:

- A feed tool: "give me Documents of kind=bill ordered by
  occurred_at DESC where jurisdiction=us-federal"
- An entity tool: "give me Documents that have an EntityReference
  matching entity_id=person/abc-123"

This is a 20-line difference in SQL, not a different architecture.
We gain both user-facing projections with roughly the work of one.

### Adapters are normalizers, not wrappers

The temptation is to build N "Congress.gov client" classes that each
expose the upstream API shape. We don't do that. Adapters **always**
translate into our normalized `Document` / `Entity` shape, and the
rest of the system never sees Congress.gov JSON or OpenFEC line
items. This means:

- Tools don't case-split by source.
- Adding a new source requires zero tool changes.
- Entity resolution happens in one place (the adapter output merge),
  not scattered through tool implementations.

### SQLite is the cache, the index, AND the store

The data volume fits comfortably on one machine:

- **OpenStates:** ~200k bills across all 50 states' recent sessions,
  growing by ~10k/year. Plus ~7k active legislators and ~2k
  committees.
- **Congress.gov:** ~15k bills per two-year Congress, plus ~535
  sitting Members and a few hundred committees.
- **OpenFEC:** tens of millions of individual contribution records
  per election cycle — the volume outlier. Even so, one SQLite file
  handles it indefinitely (the FEC's full bulk dump is a few
  hundred GB; a curated V1 slice is orders of magnitude smaller).

All of this fits in one local SQLite file well under a gigabyte for
V1, and comfortably under tens of gigabytes at full Phase 4 scope.

This means:
- Tool calls read local rows after an optional shaped upstream fetch (R15). Cache hits are local-only; misses fetch and write-through inside one SQLite transaction.
- No separate caching layer. No Redis. No Postgres. One file.
- The `pnpm refresh` CLI exists for bulk seeding and operator cron, but is not on the user-facing read path.

Freshness is tracked per `(source, endpoint_path, args_hash)` in the
`fetch_log` table under R15, with per-document freshness on
`documents.fetched_at` for the single-resource `get_bill` tool (R14).
TTL values live in `src/core/tool_cache.ts` and are set per-tool.

### Entity resolution is simple on purpose

V1 entity resolution (finalized per D3 — see `docs/04-entity-schema.md`):

1. If the upstream source provides a stable ID (OpenStates
   `ocd-person` IDs, Congress.gov `bioguide_id`, OpenFEC
   `candidate_id`, OpenFEC `committee_id`) — use it. Map it into
   `entities.external_ids`. External-ID match always wins.
2. For unmatched entities (mostly individual contributors in
   OpenFEC data), use exact match on normalized name + kind first.
   Under R11's scope pivot, Person entities are
   **cross-jurisdiction** — no jurisdiction filter on the exact
   match — so a senator and their prior state-legislator persona
   collapse into one row.
3. Fuzzy match falls back to Levenshtein ≤ 1 on full normalized
   name, but *only merges* when a positive linking signal is
   present (shared external-id source family, exact middle-name
   match, or role-jurisdiction overlap).
4. On ambiguous match, **don't merge**. Create two separate
   entities. A future admin tool can reconcile known splits.

We deliberately under-match rather than over-match. Two entities for
the same person is a bug we can live with; merging two distinct
people (say, two "Michael Brown"s from different states) into one is
a correctness failure that would poison every downstream tool
response.

## Module layout

```
src/
├── index.ts                   # MCP server entry point
├── mcp/
│   ├── server.ts              # Wires tools + transport
│   ├── shared.ts              # StaleNotice, shared response types
│   ├── tools/
│   │   ├── recent_bills.ts
│   │   ├── recent_votes.ts
│   │   ├── recent_contributions.ts
│   │   ├── search_civic_documents.ts
│   │   ├── search_entities.ts
│   │   ├── get_entity.ts
│   │   ├── get_bill.ts
│   │   ├── entity_connections.ts
│   │   └── resolve_person.ts
│   └── schemas.ts             # zod schemas for tool inputs/outputs
├── core/
│   ├── types.ts               # Entity, Document, Reference types
│   ├── store.ts               # SQLite open + migrations
│   ├── entities.ts            # CRUD + resolution
│   ├── documents.ts           # CRUD + query helpers
│   ├── connections.ts         # entity_connections graph query
│   ├── tool_cache.ts          # withShapedFetch (R15 cache wrapper)
│   ├── fetch_log.ts           # per-endpoint freshness table
│   ├── args_hash.ts           # canonical JSON + hash for cache keys
│   ├── budget.ts              # daily upstream budget guard
│   ├── singleflight.ts        # per-key in-flight request coalescing
│   ├── limiters.ts            # per-host token buckets
│   ├── sources.ts             # HydrationSource enum + helpers
│   ├── hydrate_bill.ts        # R14 per-document hydration (get_bill)
│   ├── refresh.ts             # batch refresh (pnpm refresh CLI)
│   ├── seeds.ts               # bootstrap seed data
│   └── migrations/            # SQLite schema migrations
├── adapters/
│   ├── base.ts                # Adapter interface
│   ├── openstates.ts          # all 50 states
│   ├── congress.ts            # federal legislature
│   └── openfec.ts             # federal campaign finance
├── cli/                       # pnpm refresh entry
├── resolution/
│   └── fuzzy.ts               # Name normalization + Levenshtein ≤ 1
└── util/
    ├── http.ts                # fetch wrapper with rate limiting
    ├── datetime.ts
    ├── env.ts
    ├── env-file.ts
    ├── sql.ts
    └── logger.ts
tests/
├── unit/
│   └── ...                    # Mirror src/ structure
└── integration/
    └── ...                    # msw-mocked tests per push;
                               # live nightly integration per D10
```

## Two design decisions to call out

### 1. Upstream fetches are shaped per-tool, not jurisdiction-wide

Each read tool call performs a narrow upstream fetch shaped to its
exact need (one OpenStates `/people?name=` request, one Congress.gov
`/member/{bioguide}/sponsored-legislation` request, one OpenFEC
`/candidates/search?q=` request) rather than refreshing a whole
jurisdiction. The cost model matches the call model: a single
`resolve_person("Angus King")` costs one upstream request, not
thousands. See R15 in `docs/00-rationale.md`.

Bulk refresh across a full jurisdiction is still available via the
`pnpm refresh` CLI (`src/cli/refresh.ts`) for operator cron and
historical backfill — rate-aware, resumable, and incremental
(`--since=<date>`). It's not on the user-facing read path; tool calls
fetch and write through on their own.

Rate-limit and daily-budget guards in `src/util/http.ts` +
`src/core/budget.ts` govern both paths — see
`docs/03-data-sources.md` for the OpenStates 500/day free-tier
constraint.

### 2. We use synchronous SQLite (`better-sqlite3`)

All MCP tool calls are request/response. Synchronous SQLite queries
are faster than async ones for single-digit-millisecond work, have
simpler error handling, and eliminate a class of race conditions.
Network fetch in adapters is async; local DB access is sync. That's
intentional.

### Shaped-query hydration (R15)

Read tool handlers do not query the store directly. They call `src/core/tool_cache.ts#withShapedFetch(db, key, ttl, fetcher, writer)` first. The key is a `{source, endpoint_path, args_hash}` tuple that names the exact upstream request needed to satisfy the tool call. That function:
1. Checks `fetch_log(source, endpoint_path, args_hash)` TTL.
2. If fresh → skips the upstream call; handler queries local.
3. If stale/missing → issues the shaped upstream fetch (e.g., OpenStates `/people?name=`, Congress.gov `/member/{bioguide}/sponsored-legislation`, OpenFEC `/candidates/search?q=`). On success, writes the normalized `Document`s + `Entity`s + references in a single `db.transaction`, stamps `fetch_log`, returns to the handler.
4. On upstream failure → if stale cached data exists, returns it with `stale_notice{reason:"upstream_failure"}`; otherwise propagates the error (or returns `stale_notice{reason:"not_found"}` when the endpoint correctly signals empty).

The key sits at the real deduplication boundary — the upstream request — so tools that hit the same endpoint with the same args (e.g., `resolve_person` and `search_entities` both calling OpenStates `/people`) share warm cache rows. R14's per-document TTL (`documents.fetched_at`, used by `get_bill`) coexists with R15: R14 for single-resource tools where freshness is inherent to the row; R15 for listing/search endpoints where per-endpoint tracking is needed.

Writes remain batch-normalized (same code path as the CLI `pnpm refresh`) so entity resolution produces the same graph regardless of trigger.

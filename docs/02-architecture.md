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
│                                                             │
│  Refresh tool (C) — writes      ─ refresh_source            │
└──────────────────────┬──────────────────────────────────────┘
                       │  reads (B + A)  writes (C, on consent)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│               Normalized Store (SQLite)                     │
│                                                             │
│  entities ──<has_role>── documents ──<mentions>── entities  │
│                                                             │
│  ─ Person (cross-jurisdiction), Organization, Committee     │
│  ─ Bill, Vote, Contribution, Expenditure                    │
│  ─ source_id, source_name, source_url, fetched_at           │
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
- Tool calls are local queries (fast, deterministic, testable).
- Refresh is a background job (adapters re-fetch and write).
- No separate caching layer. No Redis. No Postgres. One file.

Freshness is per-source, driven by adapter refresh intervals defined
in `docs/03-data-sources.md`.

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
│   ├── tools/
│   │   ├── recent_bills.ts
│   │   ├── recent_votes.ts             # Phase 3
│   │   ├── recent_contributions.ts     # Phase 4
│   │   ├── search_civic_documents.ts
│   │   ├── search_entities.ts
│   │   ├── get_entity.ts
│   │   ├── entity_activity.ts
│   │   ├── entity_connections.ts       # Phase 5
│   │   └── resolve_person.ts           # Phase 5
│   └── schemas.ts             # zod schemas for tool inputs/outputs
├── core/
│   ├── types.ts               # Entity, Document, Reference types
│   ├── store.ts               # SQLite open + migrations
│   ├── entities.ts            # CRUD + resolution
│   └── documents.ts           # CRUD + query helpers
├── adapters/
│   ├── base.ts                # Adapter interface
│   ├── openstates.ts          # Phase 2 — all 50 states
│   ├── congress.ts            # Phase 3 — federal legislature
│   └── openfec.ts             # Phase 4 — federal campaign finance
├── resolution/
│   └── fuzzy.ts               # Name normalization + Levenshtein ≤ 1
└── util/
    ├── http.ts                # fetch wrapper with rate limiting
    └── logger.ts
tests/
├── unit/
│   └── ...                    # Mirror src/ structure
└── integration/
    └── ...                    # msw-mocked tests per push;
                               # live nightly integration per D10
```

## Two design decisions to call out

### 1. We don't do background refresh in-process

The MCP server serves queries only. A separate script,
`src/jobs/refresh.ts`, runs adapters and writes to SQLite. It can be
invoked manually, via cron, or (later) as a long-lived process. The
separation keeps the MCP server simple and stateless from the LLM's
perspective.

Refresh under the 50-state + federal scope has to be rate-aware,
resumable, and incremental (`--since=<date>`) — see
`docs/03-data-sources.md` for the OpenStates 500/day free-tier
constraint that drives this.

### 2. We use synchronous SQLite (`better-sqlite3`)

All MCP tool calls are request/response. Synchronous SQLite queries
are faster than async ones for single-digit-millisecond work, have
simpler error handling, and eliminate a class of race conditions.
Network fetch in adapters is async; local DB access is sync. That's
intentional.

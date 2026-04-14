# 05 — MCP Tool Surface

The MCP exposes **11 tools**, split into three groups by query
projection. Feed tools (B) answer "what's happening?"; entity tools
(A) answer "who is X and what have they done?"; detail tools (C)
answer "give me the full record of this one resource by ID". All
three groups query the same underlying store with different SELECT
projections — see `docs/02-architecture.md`.

Under R11's scope pivot (US-federal + all-50-state legislative), the
original design's `recent_council_matters` and `upcoming_meetings`
tools are removed along with the municipal scope that motivated them.

## Tool design principles

1. **Every tool returns provenance.** All responses include a
   `sources` array with URLs the LLM can cite.
2. **Sensible defaults** where unambiguous (`days` = 7, `limit` = 20).
   No default on `jurisdiction` — the caller must state federal or
   state explicitly.
3. **Inputs validated with zod.** Invalid input → clear error
   message, no silent fallback.
4. **No tool synthesizes text.** Summaries come from upstream or not
   at all. The LLM summarizes (D3c / R9).

## Shared response shape

```ts
type ToolResponse<T> = {
  results: T[];
  total: number;         // total matches, may exceed results.length
  sources: { name: string; url: string }[];
  window?: { from: string; to: string }; // for time-bounded queries
};
```

## Feed tools (B) — 4 tools

### `recent_bills`

```
input:
  jurisdiction: string              // REQUIRED. "us-federal" or "us-<state>" (e.g. "us-tx")
                                    // or "*" to query across all
  days: number (default 7, max 365)
  chamber: "upper" | "lower" | undefined
  session: string | undefined       // e.g. "119" for 119th Congress, or OpenStates session id
  limit: number (1..20) | undefined // optional row cap; when set, drops the
                                    // days-derived upstream time filter and
                                    // returns top-N by last-updated. Use for
                                    // biennial / off-session jurisdictions.
                                    // Both `days` and `limit` apply as upper
                                    // bounds when both are set; pass
                                    // `days=365, limit=N` for "last N ever."

output: ToolResponse<BillSummary>

BillSummary = {
  id: string                        // entity-graph ID of the Bill document
  identifier: string                // "HR1234", "HB2345", "SB89", etc.
  title: string
  latest_action: { date: string; description: string }
  sponsors: { name: string; party?: string; district?: string }[]
  source_url: string
}
```

Results are sorted by **last-updated**, not introduced date — a re-touched older bill with recent committee activity can rank above a freshly introduced one.

### `list_bills`

```
input:
  jurisdiction: string              // REQUIRED. "us-<state>". us-federal returns not_yet_supported in 9b.
  session: string | undefined       // OpenStates session id, e.g. "20252026"
  chamber: "upper" | "lower" | undefined
  sponsor_entity_id: string | undefined     // filters bills with this entity as sponsor or cosponsor
  classification: string | undefined        // "bill", "resolution", "joint resolution", ...
  subject: string | undefined               // OpenStates subject tag, exact match
  introduced_since: string | undefined      // ISO date; inclusive
  introduced_until: string | undefined      // ISO date; inclusive
  updated_since: string | undefined         // ISO date; inclusive
  updated_until: string | undefined         // ISO date; inclusive
  sort: "updated_desc" | "updated_asc" | "introduced_desc" | "introduced_asc"  (default updated_desc)
  limit: number (default 20, max 50)

output: ToolResponse<BillSummary>
```

`list_bills` is a structured-predicate listing projection, distinct
from `recent_bills` (which is a time-windowed feed). The two share
the `BillSummary` shape so consumers can treat results
interchangeably. Cache rows use `endpoint_path="/bills/list"` and
never collide with `recent_bills`'s `endpoint_path="/bills"` rows —
see D13.

Federal (us-federal) is not yet supported; Congress.gov's `/bill`
endpoint does not accept the same predicate surface (no native
sponsor, subject, or classification filters), and the audit
found these queries are better served today by `entity_connections`
on the member entity. A later phase can add federal support without
changing the tool surface.

### `recent_contributions` (Phase 4)

```
input:
  window: { from: string; to: string }        // ISO dates; required
  candidate_or_committee: string | undefined  // free-text, entity-resolved
  side: "contributor" | "recipient" | "either" | undefined
                                              // controls which side candidate_or_committee matches on;
                                              // defaults to "recipient" when candidate_or_committee
                                              // is set, "either" otherwise (back-compat for
                                              // pre-9d callers)
  contributor_entity_id: string | undefined   // entity-resolved donor;
                                              // filters contributor side and threads to OpenFEC
                                              // as contributor_name
  min_amount: number | undefined

output: ToolResponse<ContributionSummary>

ContributionSummary = {
  id: string
  amount: number
  date: string
  contributor: { name: string; entity_id?: string }  // address not exposed
  recipient: { name: string; entity_id: string }
  source_url: string
}
```

### `recent_votes` (Phase 3)

```
input:
  jurisdiction: string              // REQUIRED — "us-federal" or "us-<state>"
  days: number (default 7, max 365)
  chamber: "upper" | "lower" | undefined
  bill_identifier: string | undefined    // e.g. "HR1234" to filter to one bill
  session: string | undefined       // e.g. OpenStates session id; bypasses window. Requires OpenStates vote ingestion (pending).

output: ToolResponse<VoteSummary>

VoteSummary = {
  id: string
  bill_identifier: string
  chamber: string
  date: string
  result: string                    // "passed", "failed", etc.
  tally: { yea: number; nay: number; present: number; absent: number }
  source_url: string
}
```

`recent_votes` replaces the original design's `recent_council_matters`
and `upcoming_meetings`. Votes work uniformly across federal (from
Congress.gov) and state (from OpenStates) data.

### `search_civic_documents`

```
input:
  q: string                        // full-text search
  sources: string[] | undefined    // ["openstates","congress","openfec"]
  kinds: DocumentKind[] | undefined
  window: { from: string; to: string } | undefined
  limit: number (default 20, max 100)

output: ToolResponse<DocumentMatch>
```

Phase 2 searches only OpenStates-sourced Bills. Later phases light up
other sources transparently.

## Entity tools (A) — 5 tools

### `search_entities`

```
input:
  q: string
  kind: EntityKind | undefined
  jurisdiction: string | undefined  // filters on Organization.jurisdiction
                                    // and on Person roles[].jurisdiction (current)
  had_role: string | undefined      // matches any entry in metadata.roles[].role
                                    // (historical — surfaces past as well as current;
                                    //  see D3b cross-jurisdiction Person model)
  had_jurisdiction: string | undefined
                                    // matches any entry in metadata.roles[].jurisdiction
                                    // had_role + had_jurisdiction AND against the SAME entry
  limit: number (default 20, max 50)

output: ToolResponse<EntityMatch>

EntityMatch = {
  id: string
  kind: EntityKind
  name: string
  roles_seen: string[]              // e.g. ["sponsor","voter","contributor"]
  jurisdictions_active_in: string[] // for Persons, derived from metadata.roles[]
  last_seen_at: string
}
```

### `get_entity`

```
input:
  id: string                        // UUID or "kind:external_id" shorthand
                                    // (e.g. "person:bioguide=H001234")

output: Entity & {
  recent_documents: DocumentMatch[] // last 10 docs referencing this entity
}
```

Under the cross-jurisdiction Person model (D3b), `get_entity` on a
sitting Senator returns their full career — state legislature roles,
federal committee assignments, campaign-finance candidacies — as a
single record with a roles[] history.

### `entity_activity`

```
input:
  id: string
  window: { from: string; to: string } | undefined
  kinds: DocumentKind[] | undefined
  jurisdiction: string | undefined  // filter activity to one jurisdiction

output: ToolResponse<DocumentMatch>
```

### `entity_connections` (Phase 5)

```
input:
  id: string
  depth: 1 | 2 (default 1)
  min_co_occurrences: number (default 2)

output: {
  root: EntityMatch,
  edges: Array<{
    from: string; to: string;
    via_kinds: DocumentKind[];
    via_roles: string[];              // neighbor's roles on shared documents
                                      // (e.g. ["sponsor","cosponsor","voter"])
    co_occurrence_count: number;
    sample_documents: DocumentMatch[];
  }>,
  nodes: EntityMatch[],
  sources: { name: string; url: string }[];
}
```

An edge between two entities exists if they co-occur on at least
`min_co_occurrences` documents. `via_kinds` tells the LLM whether
the connection is via bills, votes, contributions, etc.; `via_roles`
narrows that further to the neighbor's role on those documents
(e.g. `sponsor` vs `cosponsor` vs `voter`), so a "who cosponsored
with X" query is answerable without a second hop.

### `resolve_person` (Phase 5)

```
input:
  name: string
  jurisdiction_hint: string | undefined   // "us-federal", "us-tx", etc.
  role_hint: string | undefined           // "senator", "state_legislator", ...
  context: string | undefined             // free-text hint, e.g. "Texas energy committee"

output:
  matches: Array<{
    entity_id: string
    name: string
    confidence: "exact" | "alias" | "fuzzy"
    disambiguators: string[]              // roles, jurisdictions, time spans
  }>
```

## Detail tools (C) — 2 tools

Identifier-first, full projection of a single resource. Uses
per-document freshness (R14 / D11) — `documents.fetched_at` drives
the TTL — rather than the per-endpoint `fetch_log` used by the
listing and search tools (R15). See `docs/00-rationale.md` for the
rationale.

### `get_bill` (Phase 7)

```
input:
  jurisdiction: string   // "us-<state>"; "us-federal" returns not_yet_supported in V1
  session: string        // upstream session id, e.g. "20252026" for CA 2025–2026
  identifier: string     // bill identifier with space, e.g. "SB 1338"

output:
  bill: {
    id: string
    jurisdiction: string
    session: string
    identifier: string
    title: string
    summary: string | null              // Legislative Counsel's digest
    subjects: string[]                  // source-provided subject tags
    primary_sponsor: {                  // null if no primary recorded
      entity_id: string | null
      name: string
      party?: string
      classification: string
    } | null
    cosponsors: Array<{ ...same shape as primary_sponsor }>
    actions: Array<{ date, description, classification? }>
    versions: Array<{                   // bill text lives at text_url — MCP does NOT proxy it
      note: string | null
      date: string | null
      text_url: string | null
      media_type: string | null
    }>
    related_bills: Array<{ identifier?, session?, relation? }>
    latest_action: { date, description } | null
    introduced_date: string | null
    source_url: string
    fetched_at: string
  } | null
  sources: Array<{ name, url }>
  stale_notice?: { ... }                // reason ∈ "upstream_failure" | "not_found" | "not_yet_supported"
```

Freshness: per-document TTL of 1h keyed on `documents.fetched_at`.
Missing or stale rows trigger a direct fetch of OpenStates v3
`/bills/{jurisdiction}/{session}/{identifier}`. Upstream failures
serve the last-known row with a `stale_notice`.

**Full bill text is out of scope by design.** Follow
`versions[*].text_url` to the state leginfo site. See R9 / D3c —
summarization is the consuming LLM's job, not the MCP's.

### `get_vote` (Phase 9c)

```
input:
  // Either:
  vote_id: string                       // the documents.id from recent_votes
  // OR (federal composite — Congress.gov only in V2):
  congress: number                      // e.g. 119
  chamber: "upper" | "lower"
  session: 1 | 2                        // 1st or 2nd session of the Congress
  roll_number: number

output:
  vote: {
    id: string
    bill_identifier: string | null      // e.g. "HR1234"; null for procedural
    jurisdiction: "us-federal"
    session: string                     // Congress number as string
    chamber: "upper" | "lower"
    date: string
    result: string                      // "Passed", "Failed", etc.
    tally: { yea, nay, present, absent }
    positions: Array<{
      entity_id: string | null          // resolved via external_ids.bioguide
      name: string
      party: string | null              // e.g. "Democratic", "Republican"
      state?: string                    // federal only; absent for state votes
      vote: "yea" | "nay" | "present" | "absent" | "not_voting"
    }>
    source_url: string
    fetched_at: string
  } | null
  sources: Array<{ name, url }>
  stale_notice?: { reason, ... }
```

Freshness: per-document TTL of 1h keyed on `documents.fetched_at`
(R14 / D11). On a composite miss the handler calls
`CongressAdapter.fetchVote` (`/senate-vote/{c}/{s}/{r}` or
`/house-vote/...`), upserts, then projects. Upstream failures serve
the last-known row with a `stale_notice`.

Federal (Congress.gov) only in V2. State-jurisdiction votes are
not ingested; a `vote_id` unknown to the local store returns
`stale_notice.reason="not_found"`. See R17 for why `get_vote` is a
new tool rather than an extension of `VoteSummary`.

## Shaped-query cache (R15)

Read tools perform a narrow upstream fetch shaped to the specific
tool call, write-through to SQLite inside one transaction, then read
locally. The SQLite store is a TTL cache, not a user concern.

- Keyed per `(source, endpoint_path, args_hash)` in the `fetch_log` table
- TTL is set per tool (values live in `src/core/tool_cache.ts`); listing/feed endpoints use short windows, lookup-by-id endpoints use longer ones
- The `get_bill` detail tool uses a per-document TTL on `documents.fetched_at` instead of `fetch_log` (R14)

On upstream failure, tools serve stale local data (if any) with a
`stale_notice` sibling field on the response:

```jsonc
{
  "results": [...],
  "stale_notice": {
    "as_of": "2026-04-12T14:30:00Z",
    "reason": "upstream_failure",  // or: not_found | not_yet_supported
    "message": "Human-readable one-line summary."
  }
}
```

Valid `stale_notice.reason` values under R15: `upstream_failure`,
`not_found`, `not_yet_supported`. The earlier R13 reasons
`partial_hydrate`, `rate_limited`, and `daily_budget_exhausted` are
retired — shaped queries either fit the per-call budget, fall back
to stale cache as `upstream_failure`, or surface a real error.

`refresh_source` is not an MCP tool (historical artifact removed
when R13 was superseded by R15). The `pnpm refresh` CLI is retained
for operator use (cron, bulk seeding, historical backfill).

## Phase-to-tool mapping

| Phase | Status | Tools shipped / expanded |
|---|---|---|
| **1 — Foundation** | ✅ done | Scaffolding only — no tools exposed |
| **2 — OpenStates (50 states)** | ✅ done | `recent_bills`, `search_entities`, `get_entity`, `search_civic_documents` (OpenStates-only) |
| **3 — Congress.gov** | ✅ done | + `recent_votes`; `recent_bills`, `search_entities`, `get_entity`, `search_civic_documents` expand to include federal |
| **4 — OpenFEC** | ✅ done | + `recent_contributions`; cross-source entity merge (fec_candidate ↔ bioguide ↔ openstates_person) |
| **5 — Connections** | ✅ done | + `entity_connections`, `resolve_person` |
| **6 — Pass-through cache (R13)** | ✅ done | No new tools; `refresh_source` removed from MCP surface |
| **7 — Detail projection** | ✅ done | + `get_bill` (OpenStates state bills only; federal deferred to 7b) |
| **8 — Shaped-query hydration (R15)** | ✅ done | No new tools; all 9 tools migrated from R13 jurisdiction-wide cache to R15 per-endpoint `fetch_log`; R13 infrastructure deleted |
| **9b — list_bills** | ✅ done | + `list_bills` (OpenStates state bills; federal deferred) |
| **9c — get_vote detail tool** | ✅ done | + `get_vote` (federal-only; state deferred) |
| **9d — Tool polish** | ✅ done | No new tools; `entity_connections` edges gain `via_roles[]`; `search_entities` gains `had_role` / `had_jurisdiction`; `recent_contributions` gains `contributor_entity_id` / `side` |

As of Phase 9d (2026-04-14), the server exposes **11 tools total**:
`recent_bills`, `list_bills`, `recent_votes`, `recent_contributions`,
`search_entities`, `get_entity`, `search_civic_documents`,
`entity_connections`, `resolve_person`, `get_bill`, `get_vote`.

The original spec mentioned `entity_activity` as a separate tool.
That surface is effectively covered by `get_entity.recent_documents`
plus `search_civic_documents` (which accepts a `kinds` filter). If
a dedicated `entity_activity` tool emerges as necessary, it can be
added as a wrapper over the existing `queryDocuments` / `findDocumentsByEntity`
core helpers without new infrastructure.

## Why 11 tools and not 20

LLM tool-selection accuracy drops noticeably beyond ~15 tools with
similar-sounding names. We keep to 11 with clearly distinct verbs
(`recent_X` vs `list_X` vs `search_X` vs `get_X` vs `resolve_X` vs
`entity_connections`). If a future sub-source needs a new surface,
we prefer extending an existing tool's input over adding a new tool.

## What we explicitly DON'T expose

- No `raw_*` tools. Adapters normalize upstream data; consumers never
  see raw Congress.gov JSON or OpenFEC line items.
- No write tools **into civic systems**. The MCP never posts back to
  OpenStates, Congress.gov, or OpenFEC — writing to civic systems is
  a completely different trust/safety problem.
- No streaming / long-poll tools. Each call is a single
  request/response.
- No purge / admin tools. Cache eviction, schema migrations, etc.
  remain operator scripts, not LLM surfaces.
- **No contributor PII in responses.** OpenFEC contributor addresses
  and employers are stored but never returned through tools.

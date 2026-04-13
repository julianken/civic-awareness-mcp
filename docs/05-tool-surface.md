# 05 — MCP Tool Surface

The MCP exposes **9 tools**, split into two groups by query
projection. Feed tools (B) answer "what's happening?"; entity tools
(A) answer "who is X and what have they done?". Both groups query
the same underlying store with different SELECT projections — see
`docs/02-architecture.md`.

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
  days: number (default 7, max 90)
  chamber: "upper" | "lower" | undefined
  session: string | undefined       // e.g. "119" for 119th Congress, or OpenStates session id

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

### `recent_contributions` (Phase 4)

```
input:
  window: { from: string; to: string }        // ISO dates; required
  candidate_or_committee: string | undefined  // free-text, entity-resolved
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
  days: number (default 7, max 90)
  chamber: "upper" | "lower" | undefined
  bill_identifier: string | undefined    // e.g. "HR1234" to filter to one bill

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
                                    // and on Person roles[].jurisdiction
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
    co_occurrence_count: number;
    sample_documents: DocumentMatch[];
  }>,
  nodes: EntityMatch[],
  sources: { name: string; url: string }[];
}
```

An edge between two entities exists if they co-occur on at least
`min_co_occurrences` documents. The `via_kinds` tells the LLM whether
the connection is via bills, votes, contributions, etc.

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

## Phase-to-tool mapping

| Phase | Tools shipped / expanded |
|---|---|
| **1 — Foundation** | Scaffolding only — no tools exposed |
| **2 — OpenStates (50 states)** | `recent_bills`, `search_entities`, `get_entity`, `search_civic_documents` (OpenStates-only) |
| **3 — Congress.gov** | + `recent_votes`; `recent_bills`, `search_entities`, `get_entity`, `search_civic_documents`, `entity_activity` expand to include federal |
| **4 — OpenFEC** | + `recent_contributions`; cross-source entity joining for candidates ↔ Members of Congress |
| **5 — Connections** | + `entity_connections`, `resolve_person` |

## Why 9 tools and not 20

LLM tool-selection accuracy drops noticeably beyond ~15 tools with
similar-sounding names. We keep to 9 with clearly distinct verbs
(`recent_X` vs `search_X` vs `get_X` vs `resolve_X`). If a future
sub-source needs a new surface, we prefer extending an existing
tool's input over adding a new tool.

## What we explicitly DON'T expose

- No `raw_*` tools. Adapters normalize upstream data; consumers never
  see raw Congress.gov JSON or OpenFEC line items.
- No write tools. This MCP is read-only. Writing to civic systems is
  a completely different trust/safety problem.
- No streaming / long-poll tools. Each call is a single
  request/response.
- No admin tools (refresh, purge cache). Those are scripts run by
  the operator, not surfaces for the LLM.
- **No contributor PII in responses.** OpenFEC contributor addresses
  and employers are stored but never returned through tools.

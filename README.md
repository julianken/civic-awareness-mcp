# Civic Awareness MCP

An [MCP](https://modelcontextprotocol.io) server that gives an LLM first-class access to **US federal and state-legislature civic data** — bills, votes, committees, Members of Congress, state legislators, and federal campaign finance — across **51 jurisdictions** (Congress + 50 states), with both time-ordered **feeds** and identity-resolved **entity** tools over one normalized store.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node 22+](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
[![Nightly drift](https://github.com/julianken/civic-awareness-mcp/actions/workflows/nightly-drift.yml/badge.svg)](https://github.com/julianken/civic-awareness-mcp/actions/workflows/nightly-drift.yml)

## Tools

| Tool | Kind | What it answers |
|------|------|-----------------|
| [`recent_bills`](./docs/05-tool-surface.md#recent_bills) | feed | Bills introduced or acted on in the last N days, filterable by jurisdiction / chamber / session |
| [`recent_votes`](./docs/05-tool-surface.md#recent_votes-phase-3) | feed | Roll-call votes in the last N days, with yea/nay/present/absent tallies |
| [`recent_contributions`](./docs/05-tool-surface.md#recent_contributions-phase-4) | feed | Federal campaign contributions in a window, optionally filtered to a candidate or committee |
| [`search_civic_documents`](./docs/05-tool-surface.md#search_civic_documents) | feed | Full-text search across bills / votes / contributions |
| [`search_entities`](./docs/05-tool-surface.md#search_entities) | entity | Find Persons / Organizations / Committees / PACs by name |
| [`get_entity`](./docs/05-tool-surface.md#get_entity) | entity | Full entity record including role history (cross-jurisdiction for Persons) plus recent documents |
| [`entity_connections`](./docs/05-tool-surface.md#entity_connections-phase-5) | entity | Graph of co-occurrence edges (via bills / votes / contributions) out to depth 2 |
| [`resolve_person`](./docs/05-tool-surface.md#resolve_person-phase-5) | entity | Disambiguate a name into one or more Person entity IDs using role / jurisdiction / context hints |
| [`get_bill`](./docs/05-tool-surface.md#get_bill-phase-7) | detail | Full projection of a single bill by `(jurisdiction, identifier)` with per-document TTL |

Every response includes a `sources: { name, url }[]` array so the LLM can cite provenance. No tool synthesizes summaries — that's the LLM's job (per [D3c](./docs/06-open-decisions.md)).

## Architecture

One normalized event store, two projections:

```
┌─────────────────────────────────────────────────────────────┐
│                     MCP Tool Layer                          │
│                                                             │
│  Feed tools                  Entity tools                   │
│  ─ recent_bills              ─ search_entities              │
│  ─ recent_votes              ─ get_entity                   │
│  ─ recent_contributions      ─ entity_connections           │
│  ─ search_civic_documents    ─ resolve_person               │
└──────────────────────┬──────────────────────────────────────┘
                       │  reads
                       ▼
┌─────────────────────────────────────────────────────────────┐
│               Normalized Store (SQLite)                     │
│                                                             │
│  entities ──<has_role>── documents ──<mentions>── entities  │
└──────────────────────▲──────────────────────────────────────┘
                       │  writes
┌──────────────────────┴──────────────────────────────────────┐
│  OpenStatesAdapter   CongressGovAdapter   OpenFECAdapter    │
│  Each: fetch() → Document[] with Entity references          │
└─────────────────────────────────────────────────────────────┘
```

The feed and entity tools read the same two tables (`entities`, `documents`) with different WHERE clauses — a ~20-line SQL difference, not a parallel pipeline. Adapters normalize upstream JSON into `Document`s with `EntityReference`s, so tools never case-split by source and adding a new adapter requires zero tool changes. See [`docs/02-architecture.md`](./docs/02-architecture.md) for the full rationale.

The SQLite store is a transparent TTL cache: when a tool request arrives for data that is absent or stale (1h for feeds, 24h for entities), the server fetches upstream automatically before returning results. Upstream failures serve the last-known data with a `stale_notice` field. No manual refresh step required.

## Entity resolution

The moat. Same human can appear in three APIs under three IDs; V1 resolution is three tiers, **external-ID first, fuzzy last**:

1. **External ID match always wins.** `bioguide`, `openstates_person`, `fec_candidate` IDs collapse records across sources immediately.
2. **Exact normalized-name match** (lowercased, punctuation-stripped, cross-jurisdiction for Persons). Tiebreakers: middle-name match or same external-ID source family.
3. **Levenshtein ≤ 1** only with a **positive linking signal** — shared external-ID source family, alias match, or role-jurisdiction overlap. If uncertain, don't merge.

The algorithm deliberately under-matches. Two rows for the same person is a bug we can live with; merging two distinct "Michael Brown"s from different states would poison every downstream tool response. See [`docs/04-entity-schema.md`](./docs/04-entity-schema.md) for the full spec, including why `entities.jurisdiction` is `NULL` for Persons (the [D3b invariant](./docs/06-open-decisions.md)).

**No ML, no embeddings, no vector search.** External IDs are high-confidence structured data; use them.

## Example invocations

### Feed a recent-bills query

```json
// call:   recent_bills
// input:
{ "jurisdiction": "us-federal", "days": 14, "chamber": "upper" }

// output (trimmed):
{
  "results": [
    {
      "id": "bill-01J...",
      "identifier": "S.1234",
      "title": "A bill to authorize appropriations for fiscal year 2026 ...",
      "latest_action": {
        "date": "2026-04-09",
        "description": "Placed on Senate Legislative Calendar"
      },
      "sponsors": [
        { "name": "Jane Doe", "party": "D", "district": "WA" }
      ],
      "source_url": "https://www.congress.gov/bill/119th-congress/senate-bill/1234"
    }
  ],
  "total": 47,
  "sources": [
    { "name": "congress.gov", "url": "https://api.congress.gov/v3/bill" }
  ],
  "window": { "from": "2026-03-30", "to": "2026-04-13" }
}
```

### Resolve a person across sources

```json
// call:   resolve_person
// input:
{ "name": "Chuck Schumer", "role_hint": "senator", "jurisdiction_hint": "us-federal" }

// output:
{
  "matches": [
    {
      "entity_id": "person-7a4b...",
      "name": "Charles E. Schumer",
      "confidence": "exact",
      "disambiguators": [
        "senator (us-federal) 1999–present",
        "bioguide: S000148",
        "fec_candidate: S8NY00082"
      ]
    }
  ]
}
```

### Walk the connection graph

```json
// call:   entity_connections
// input:
{ "id": "person-7a4b...", "depth": 1, "min_co_occurrences": 3 }

// output (trimmed):
{
  "root": { "id": "person-7a4b...", "kind": "person", "name": "Charles E. Schumer", ... },
  "edges": [
    {
      "from": "person-7a4b...",
      "to": "organization-f91c...",
      "via_kinds": ["contribution"],
      "co_occurrence_count": 142,
      "sample_documents": [ /* recent contributions */ ]
    }
  ],
  "nodes": [ /* neighboring entities */ ],
  "sources": [
    { "name": "openfec", "url": "https://api.open.fec.gov/v1/schedules/schedule_a" }
  ]
}
```

See [`examples/`](./examples) for complete request/response fixtures.

## Example transcript

A real interaction an LLM can carry off using three tools in sequence:

> **User:** *Who are Ted Cruz's top institutional donors this cycle, and has he sponsored any bills related to them?*
>
> **LLM** → `resolve_person({ name: "Ted Cruz", role_hint: "senator" })`
> ← `{ matches: [{ entity_id: "person-8e2c...", confidence: "exact", disambiguators: ["senator (us-federal) 2013–present", "fec_candidate: S2TX00312"] }] }`
>
> **LLM** → `entity_connections({ id: "person-8e2c...", depth: 1, min_co_occurrences: 5 })`
> ← *(graph showing top co-occurring committees and PACs via `contribution` edges)*
>
> **LLM** → `recent_bills({ jurisdiction: "us-federal", days: 90 })` *(then cross-references sponsors)*
>
> **LLM:** *"This cycle Senator Cruz's highest-volume institutional contributors are [committee A], [PAC B], and [committee C]. In the last 90 days he has sponsored S.1789 (energy infrastructure) and cosponsored S.1622 (…). Sources: openfec schedule A; congress.gov bill."*

## Installation

### Prerequisites

- Node.js ≥ 22
- [pnpm](https://pnpm.io) 10+
- API keys for [OpenStates](https://openstates.org/accounts/signup/), [Congress.gov](https://api.congress.gov/sign-up/), and [OpenFEC](https://api.data.gov/signup/) — all free tier

### Build + run

```bash
pnpm install
pnpm bootstrap     # create ./data/civic-awareness.db and seed jurisdictions
pnpm build         # emit dist/
pnpm start         # run the MCP over stdio
# or for development:
pnpm dev           # run via tsx with no build step
```

### Data hydration

The server fetches data automatically. Ask Claude about Texas bills,
federal campaign contributions, or any other supported source — if
the local cache is empty or stale, the server fetches from upstream
before returning the result. API keys must be set (see Environment
variables below); the server hard-fails on startup if they are
missing.

For bulk pre-population or forced re-ingestion, the CLI is still
available:

```bash
# API keys in .env.local: OPENSTATES_API_KEY, API_DATA_GOV_KEY
# (the api.data.gov key works for both Congress.gov and OpenFEC)
pnpm refresh --source=openstates --jurisdictions=tx --max-pages=1
pnpm refresh --source=congress   --max-pages=1
pnpm refresh --source=openfec    --max-pages=1
```

All paths upsert into `./data/civic-awareness.db` (gitignored).
The schema auto-bootstraps on first server start — no `pnpm
bootstrap` needed unless you want to create the DB ahead of time.

### Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on other platforms:

```json
{
  "mcpServers": {
    "civic-awareness": {
      "command": "node",
      "args": ["/absolute/path/to/civic-awareness-mcp/dist/index.js"],
      "env": {
        "CIVIC_AWARENESS_DB_PATH": "/absolute/path/to/civic-awareness.db"
      }
    }
  }
}
```

Then restart Claude Desktop; the 9 tools will appear in the tool picker.

### Environment variables

- `CIVIC_AWARENESS_DB_PATH` — override the default SQLite path (`./data/civic-awareness.db`). Needed when Claude Desktop launches the server from an arbitrary working directory.
- `LOG_LEVEL` — `debug` / `info` / `warn` / `error` (default `info`). Structured JSON is emitted to stderr.

### Skipping per-call consent prompts (Claude Code users)

Claude Code prompts for approval on every MCP tool call by
default. If you trust your own instance of this server, add this
to your user-level `settings.json` (or the project-level
`.claude/settings.json`):

```json
{
  "permissions": {
    "allow": ["mcp__civic_awareness__*"]
  }
}
```

After that, calls to any of the 9 tools run without prompts. To approve
individual tools rather than the whole server:

```json
{
  "permissions": {
    "allow": [
      "mcp__civic_awareness__recent_bills",
      "mcp__civic_awareness__recent_votes",
      "mcp__civic_awareness__recent_contributions",
      "mcp__civic_awareness__search_entities",
      "mcp__civic_awareness__get_entity",
      "mcp__civic_awareness__search_civic_documents",
      "mcp__civic_awareness__entity_connections",
      "mcp__civic_awareness__resolve_person",
      "mcp__civic_awareness__get_bill"
    ]
  }
}
```

Claude Desktop does not persist per-tool allowlists across
sessions (see
[anthropics/claude-code#24433](https://github.com/anthropics/claude-code/issues/24433)).
Desktop users will see the per-call prompt every session.

## CI — nightly upstream drift detection

One workflow, [`.github/workflows/nightly-drift.yml`](./.github/workflows/nightly-drift.yml), runs daily at 09:00 UTC (or via `workflow_dispatch`). It makes ~7 real requests against OpenStates / Congress.gov / OpenFEC and asserts that the response shapes the adapters depend on are still present. If a field name changes upstream, the job goes red and the regression is visible before end users see broken tool output.

There is **no CI on push or pull-request.** The mocked unit + integration suite (157 tests) runs locally via `pnpm test`; upstream drift is the only regression the repo is exposed to.

To run the nightly workflow, set two repo secrets (`OPENSTATES_API_KEY` and `API_DATA_GOV_KEY`) under `Settings → Secrets and variables → Actions`. The api.data.gov key is federated across Congress.gov and OpenFEC — one signup at <https://api.data.gov/signup/> covers both. Each is *your* maintainer key; end users still bring their own keys via `.env.local`.

## Security

- Never writes upstream — no posts or mutations against OpenStates / Congress.gov / OpenFEC. The server transparently writes to the operator's local SQLite store on cache misses, sourced from Tier-1 APIs.
- All upstream APIs are sanctioned Tier-1 (free-tier keys, documented rate limits) — see [`docs/03-data-sources.md`](./docs/03-data-sources.md)
- Rate-limited fetch wrapper with per-host token bucket, `Retry-After` honoured, redirects rejected by default
- Zod-validated tool inputs; `better-sqlite3` parameterized queries; `LIKE ... ESCAPE` on user-supplied patterns
- **No contributor PII** in responses — OpenFEC contributor addresses and employers are stored but never returned through tools
- Third-party GitHub Actions pinned to commit SHAs (not mutable tags)
- GitHub secret scanning + push protection + Dependabot alerts enabled

See [`SECURITY.md`](./SECURITY.md) for the security posture write-up.

## Documentation

Full design rationale lives in [`docs/`](./docs). The starting points:

| | |
|---|---|
| [`docs/README.md`](./docs/README.md) | Doc-tree index |
| [`docs/00-rationale.md`](./docs/00-rationale.md) | Decisions considered and rejected. **R11** is the early scope pivot (Arizona → US-legislative). |
| [`docs/02-architecture.md`](./docs/02-architecture.md) | Dual feeds+entities projection |
| [`docs/04-entity-schema.md`](./docs/04-entity-schema.md) | Entity schema + resolution algorithm |
| [`docs/05-tool-surface.md`](./docs/05-tool-surface.md) | Full tool specs |
| [`docs/06-open-decisions.md`](./docs/06-open-decisions.md) | 10 design decisions (all finalized 2026-04-12) |
| [`docs/plans/`](./docs/plans) | Per-phase TDD implementation plans |

## License

MIT — see [`LICENSE`](./LICENSE).

---

## For contributors / Claude Code sessions

[`CLAUDE.md`](./CLAUDE.md) documents the in-repo conventions and first-session protocol for any Claude Code session operating here. The key invariants: Person entities are cross-jurisdiction ([D3b](./docs/06-open-decisions.md)); `jurisdiction` is a runtime parameter, never hardcoded; don't bake two pipelines for feeds + entities when the plan is one.

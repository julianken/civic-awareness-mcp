# Civic Awareness MCP

An MCP (Model Context Protocol) server that gives LLMs first-class
access to **US federal and state-legislature civic data** — bills,
votes, committees, Members of Congress, state legislators, and
federal campaign finance — with both time-ordered **feed** tools and
entity-resolved **profile/connection** tools.

**Status:** Phase 1 scaffolding complete. MCP server skeleton,
SQLite-backed entity/document store, and TDD harness are in place.
Phase 2 (OpenStates adapter + first 4 tools) is the next phase.

## Running locally

```bash
pnpm install
pnpm bootstrap   # creates ./data/civic-awareness.db with seeded jurisdictions
pnpm test        # runs the full test suite
pnpm typecheck   # tsc --noEmit
pnpm build       # produces dist/
pnpm start       # runs the MCP over stdio (after build)
# or:
pnpm dev         # runs the MCP directly via tsx (no build step)
```

Environment variables:

- `CIVIC_AWARENESS_DB_PATH` — overrides the default SQLite path
  (`./data/civic-awareness.db`). Useful when the MCP is launched
  by Claude Desktop from an arbitrary working directory.
- `LOG_LEVEL` — one of `debug`, `info`, `warn`, `error` (default
  `info`). Logs are structured JSON emitted to stderr.

Claude Desktop config
(`~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS):

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

Phase 1 does not yet expose any tools to the LLM (see
[`docs/05-tool-surface.md`](./docs/05-tool-surface.md)); the server
is fully functional as an MCP endpoint but its tool registry is
empty. Tools land in Phase 2.

## Quickstart for future Claude Code sessions

1. Open this folder in Claude Code.
2. Claude reads `CLAUDE.md` automatically.
3. Claude reads the planning docs, confirms scope, and proceeds to
   `docs/plans/phase-2-openstates.md` (Phase 1 is complete). Use
   `superpowers:subagent-driven-development` or
   `superpowers:executing-plans`.

## Documentation map

| File | Purpose |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | Instructions for any Claude Code session operating in this repo |
| [`docs/00-rationale.md`](./docs/00-rationale.md) | Design alternatives considered and rejected — read before second-guessing a choice. See **R11** for the 2026-04-12 scope pivot. |
| [`docs/01-vision.md`](./docs/01-vision.md) | What this MCP does, who it's for, what success looks like |
| [`docs/02-architecture.md`](./docs/02-architecture.md) | Combined feed + entity-graph architecture |
| [`docs/03-data-sources.md`](./docs/03-data-sources.md) | Inventory of upstream APIs (OpenStates, Congress.gov, OpenFEC) with auth, rate limits, quirks |
| [`docs/04-entity-schema.md`](./docs/04-entity-schema.md) | Canonical Person / Organization / Document schemas; cross-jurisdiction Person resolution |
| [`docs/05-tool-surface.md`](./docs/05-tool-surface.md) | MCP tool specifications (9 tools) |
| [`docs/06-open-decisions.md`](./docs/06-open-decisions.md) | 10 decisions, all finalized 2026-04-12 |
| [`docs/roadmap.md`](./docs/roadmap.md) | Phase 3–5 intent-level roadmap |
| [`docs/plans/`](./docs/plans/) | Per-phase TDD implementation plans |

## Scope (summary)

**In scope for V1 (Phase 1 + 2):**
- OpenStates API v3 — all 50 U.S. state legislatures (bills,
  legislators, committees)
- SQLite-backed entity store with cross-jurisdiction Person
  resolution (external-IDs + exact name + Levenshtein ≤ 1 fuzzy
  with linking-signal guards)
- Four MCP tools: `recent_bills`, `search_entities`, `get_entity`,
  `search_civic_documents`
- Working end-to-end against Claude Desktop; published to npm after
  Phase 2 (D8)

**In scope for V2 (Phase 3–5):**
- Congress.gov API — federal legislature (Phase 3)
- OpenFEC API — federal campaign finance (Phase 4)
- Cross-source entity linking: sitting Members of Congress joined
  with their prior state-legislature histories (from Phase 2) and
  their federal candidacies (from Phase 4)
- `recent_votes`, `recent_contributions`, `entity_connections`,
  `resolve_person` tools

**Deferred / out of scope:**
- Municipal civic data (city councils, local crime, municipal
  budgets). A future sibling `civic-awareness-municipal-mcp` could
  target this.
- State-level campaign finance (50 different systems; fragmented).
  OpenFEC covers federal only.
- Federal executive branch (Federal Register, Regulations.gov,
  USASpending) — plausible V3 additions.
- Court dockets (PACER, state courts) — Tier 3, hostile scraping.
- Real-time election results (event-driven, different product shape).
- Voter rolls (PII-sensitive; not a good fit for LLM-consumed data).

See [`docs/00-rationale.md`](./docs/00-rationale.md) R11 for the
scope-pivot rationale, and [`docs/03-data-sources.md`](./docs/03-data-sources.md)
for the full source matrix including Later candidates.

## License

MIT (per D7 in `docs/06-open-decisions.md`).

# Civic Awareness MCP

Two [MCP](https://modelcontextprotocol.io) servers for US civic data — one for Congress + federal campaign finance, one for 50-state legislatures.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node 22+](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
[![Nightly drift](https://github.com/julianken/civic-awareness-mcp/actions/workflows/nightly-drift.yml/badge.svg)](https://github.com/julianken/civic-awareness-mcp/actions/workflows/nightly-drift.yml)

## Servers

| Server              | Source                 | Jurisdictions  | Package                 |
| ------------------- | ---------------------- | -------------- | ----------------------- |
| `civic-federal-mcp` | Congress.gov + OpenFEC | US federal     | `npx civic-federal-mcp` |
| `civic-state-mcp`   | OpenStates             | 50 states + DC | `npx civic-state-mcp`   |

Each server reads/writes-through to a local SQLite store as a TTL cache. Every response includes a `sources: { name, url }[]` array for provenance. No tool synthesizes summaries — that is the LLM's job.

## Tools

### civic-federal-mcp (9 tools)

| Tool                     | Kind   | What it answers                                                    |
| ------------------------ | ------ | ------------------------------------------------------------------ |
| `recent_bills`           | feed   | Bills introduced or acted on in the last N days (Congress.gov)     |
| `recent_votes`           | feed   | Roll-call votes in the last N days, yea/nay/present tallies        |
| `recent_contributions`   | feed   | Federal campaign contributions in a date window (OpenFEC)          |
| `search_civic_documents` | search | Title search across cached federal bills, votes, contributions     |
| `search_entities`        | entity | Name search across Members of Congress + FEC candidates/committees |
| `get_entity`             | entity | Entity detail + role history + recent documents                    |
| `resolve_person`         | entity | Disambiguate a name into one or more Person entity IDs             |
| `entity_connections`     | entity | Co-occurrence graph via bills, votes, contributions (depth 1–2)    |
| `get_vote`               | detail | Full roll-call vote with per-legislator positions                  |

### civic-state-mcp (8 tools)

| Tool                     | Kind   | What it answers                                                                       |
| ------------------------ | ------ | ------------------------------------------------------------------------------------- |
| `recent_bills`           | feed   | Bills by jurisdiction; filters for sponsor, subject, classification, session, dates   |
| `recent_votes`           | feed   | Roll-call votes in the last N days, chamber + tally (OpenStates, per jurisdiction)    |
| `get_bill`               | detail | Full bill detail: actions, versions, sponsors, subjects                               |
| `search_civic_documents` | search | Title search across cached state bills                                                |
| `search_entities`        | entity | Name search across state legislators (OpenStates)                                     |
| `get_entity`             | entity | Entity detail + role history + recent documents                                       |
| `resolve_person`         | entity | Disambiguate a name into one or more Person entity IDs                                |
| `entity_connections`     | entity | Co-occurrence graph via shared sponsored bills (depth 1–2)                            |

## Installation

### Prerequisites

- Node.js ≥ 22
- API keys: [api.data.gov](https://api.data.gov/signup/) (covers Congress.gov + OpenFEC), [OpenStates](https://openstates.org/accounts/signup/) — all free tier

### Build + run

```bash
npm install
npm run build

# federal server
npm run bootstrap:federal
npm run start:federal

# state server
npm run bootstrap:state
npm run start:state
```

For development (no build step):

```bash
npm run dev:federal
npm run dev:state
```

### Data hydration

The server fetches data automatically on cache miss. For bulk pre-population:

```bash
# federal
npm run refresh:federal -- --source=congress --max-pages=1
npm run refresh:federal -- --source=openfec --max-pages=1

# state (one jurisdiction)
npm run refresh:state -- --source=openstates --jurisdictions=tx --max-pages=1
```

To prune stale fetch-log rows (recommended monthly):

```bash
npm run evict-fetch-log
```

### Development

```bash
npm test              # mocked unit + integration suite (MSW)
npm run test:watch    # rerun on change
npm run test:drift    # live-API drift tests (requires .env.local)
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format        # prettier --write
```

### Claude Desktop config

To run both servers locally, add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "civic-federal-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/civic-awareness-mcp/dist/federal/index.js"],
      "env": {
        "API_DATA_GOV_KEY": "your-key",
        "CIVIC_FEDERAL_DB_PATH": "/absolute/path/to/federal.db"
      }
    },
    "civic-state-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/civic-awareness-mcp/dist/state/index.js"],
      "env": {
        "OPENSTATES_API_KEY": "your-key",
        "CIVIC_STATE_DB_PATH": "/absolute/path/to/state.db"
      }
    }
  }
}
```

## Environment variables

| Variable                       | Server  | Description                                                          |
| ------------------------------ | ------- | -------------------------------------------------------------------- |
| `API_DATA_GOV_KEY`             | federal | api.data.gov key (Congress.gov + OpenFEC)                            |
| `OPENSTATES_API_KEY`           | state   | OpenStates v3 API key                                                |
| `CIVIC_FEDERAL_DB_PATH`        | federal | SQLite path (default `./data/federal.db`)                            |
| `CIVIC_STATE_DB_PATH`          | state   | SQLite path (default `./data/state.db`)                              |
| `CIVIC_AWARENESS_DAILY_BUDGET` | both    | Optional daily API spend cap (unused by default)                     |
| `LOG_LEVEL`                    | both    | `debug` / `info` / `warn` / `error` (default `info`, JSON to stderr) |

## CI

One workflow ([`.github/workflows/nightly-drift.yml`](./.github/workflows/nightly-drift.yml)) runs daily at 09:00 UTC. It makes real requests against OpenStates / Congress.gov / OpenFEC and asserts response shapes. No CI on push or pull-request — the mocked unit + integration suite runs locally via `npm test`.

Requires two repo secrets: `OPENSTATES_API_KEY` and `API_DATA_GOV_KEY`.

## Security

See [`SECURITY.md`](./SECURITY.md). Highlights:

- Never writes to upstream APIs
- All sources are sanctioned free-tier APIs with documented rate limits
- Rate-limited fetch with per-host token bucket; `Retry-After` honoured
- Zod-validated inputs; parameterized SQLite queries
- No contributor PII in responses

## License

MIT — see [`LICENSE`](./LICENSE).

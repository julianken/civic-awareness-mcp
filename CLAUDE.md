# civic-awareness-mcp

A marketplace of two MCP servers for US civic data:

- **federal-mcp** (Congress.gov + OpenFEC) — 9 tools
- **state-mcp** (OpenStates, 50 states + DC) — 8 tools

## Layout

- `src/core/` — shared kernel (store, entities, documents, connections, tool_cache, fetch_log, budget, resolution, util)
- `src/federal/` — Congress.gov + OpenFEC adapters, 9 tools, own schema, own DB at `./data/federal.db`
- `src/state/` — OpenStates adapter, 8 tools, own schema, own DB at `./data/state.db`

Each server has its own `bin` entry, own schemas, own CLI. `src/core/` has no source-specific logic.

## Key rules

- **No migrations machinery.** Schemas live in `src/{core,federal,state}/schema.sql` as idempotent `CREATE TABLE IF NOT EXISTS`. `openStore(path, ...schemaPaths)` runs them on open. Zero users = no data to preserve.
- **No phased plans.** This is a pre-publish project — no production migration framing, no backwards-compat, no "compile green between commits" discipline for user safety.
- **Scraping posture:** all sources are Tier 1 (sanctioned API, free with key). `src/util/http.ts` enforces User-Agent, per-host token bucket, backoff, `Retry-After`.
- **Hydration flow:** tools call `withShapedFetch(db, key, ttl, fetchAndWrite, readLocal, peekWaitMs)` from `src/core/tool_cache.ts`. Cache key is `(source, endpoint_path, args_hash)`; freshness rows live in `fetch_log`. `stale_notice` fires only when an upstream fetch failed and cached data exists as fallback.
- **Person entities** use `EXTERNAL_ID_PATHS` in `src/core/entities.ts` for federal IDs; `src/state/entities.ts` extends with `STATE_EXTERNAL_ID_PATHS` for `openstates_person`.
- **Code style:** no comments explaining WHAT — only WHY when non-obvious. No defensive programming. No backwards-compatibility hacks.
- **Live API sanity check before merge.** Any PR touching `src/*/adapters/` or `src/*/tools/` must run `tsx --env-file=.env.local scripts/sanity-check-tools.ts` against real upstreams and show no new errors. MSW-mocked unit tests miss API-contract bugs (datetime format, required query params, upstream filter rules). New tools must add their own case to the sanity script in the same PR. This rule comes from PR #2, which caught 3 such bugs (3/17 = 18%) that passed `npm test` cleanly.

## Commands

- `npm run dev:federal` / `npm run dev:state` — run a server locally via `tsx`
- `npm run bootstrap:federal` / `npm run bootstrap:state` — initialize the local SQLite DB
- `npm run refresh:federal` / `npm run refresh:state` — bulk pre-fill from upstream
- `npm test` — vitest (mocked with MSW — **does NOT exercise live APIs**)
- `tsx --env-file=.env.local scripts/sanity-check-tools.ts` — **live-API sanity gate** on all 17 tool handlers; required before merging any PR touching adapters or tool handlers
- `npm run build` — tsc + schema copy

# Documentation

This folder holds the design docs for civic-awareness-mcp. Read the top-level [`README.md`](../README.md) first if you arrived here directly.

The docs are numbered in reading order. Decisions are cross-referenced by their `R` (rationale) or `D` (decision) codes.

| File | Purpose |
|---|---|
| [`00-rationale.md`](./00-rationale.md) | Alternatives considered and rejected. **R11** is the scope pivot from Arizona-civic to US-legislative (2026-04-12) — read this before second-guessing scope. |
| [`01-vision.md`](./01-vision.md) | What this MCP does, who it's for, what success looks like |
| [`02-architecture.md`](./02-architecture.md) | The dual feeds+entities projection over one normalized store; adapter contract; why SQLite |
| [`03-data-sources.md`](./03-data-sources.md) | Upstream API inventory — OpenStates / Congress.gov / OpenFEC — with auth, rate limits, quirks, and the refresh-cadence rationale |
| [`04-entity-schema.md`](./04-entity-schema.md) | **The most load-bearing doc.** Canonical Person / Organization / Committee / PAC schemas; the 3-tier resolution algorithm; the [D3b](./06-open-decisions.md) cross-jurisdiction Person invariant |
| [`05-tool-surface.md`](./05-tool-surface.md) | All 8 MCP tools with input / output zod schemas |
| [`06-open-decisions.md`](./06-open-decisions.md) | D1–D10 design decisions, all finalized 2026-04-12 |
| [`roadmap.md`](./roadmap.md) | Phase 3–5 intent-level roadmap (historical — all shipped) |
| [`plans/`](./plans) | Per-phase TDD implementation plans. Phase 1–5 are done; future phases would land here. |

## Conventions

- **R-codes** (e.g. R11) track rationale entries — decisions the project walked up to and chose one way rather than another. History is preserved in-place; don't rewrite a prior R entry, add a new one.
- **D-codes** (e.g. D3b, D7) track locked design decisions. These are load-bearing and changing them requires a new R entry explaining why.
- Every decision doc has a `Finalized: YYYY-MM-DD` stamp.

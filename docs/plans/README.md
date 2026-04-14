# Plans

This directory contains implementation plans, one per phase. Phases
1–8 are complete; plans are retained as specification and audit trail
for what shipped. Each plan includes post-execution amendments where
reality diverged from the original design.

## Phases

| Plan | Ships | Status |
|---|---|---|
| [`phase-1-foundation.md`](./phase-1-foundation.md) | Working MCP skeleton with empty store | Shipped |
| [`phase-2-openstates.md`](./phase-2-openstates.md) | 4 tools live against real OpenStates data for all 50 U.S. states | Shipped |
| [`phase-2.5-correctness-polish.md`](./phase-2.5-correctness-polish.md) | Correctness + polish pass over Phase 2 adapters | Shipped |
| [`phase-3-congress.md`](./phase-3-congress.md) | Congress.gov adapter + federal bills/votes | Shipped |
| [`phase-4-openfec.md`](./phase-4-openfec.md) | OpenFEC adapter + `recent_contributions` | Shipped |
| [`phase-5-connections.md`](./phase-5-connections.md) | `entity_connections` + `resolve_person` | Shipped |
| [`phase-5-onboarding-and-refresh-tool.md`](./phase-5-onboarding-and-refresh-tool.md) | Bootstrap CLI + `refresh_source` MCP tool (later removed in Phase 6 per R13) | Shipped |
| [`phase-6-passthrough-cache.md`](./phase-6-passthrough-cache.md) | Transparent pass-through TTL cache (R13); `refresh_source` removed from MCP tool surface (superseded by R15 / phase-8) | Shipped |
| [`phase-7-get-bill.md`](./phase-7-get-bill.md) | `get_bill` detail tool with per-document TTL (R14 / D11) | Shipped |
| [`phase-8a-shaped-fetch-infra.md`](./phase-8a-shaped-fetch-infra.md) | `withShapedFetch` + `fetch_log` table infra (R15) | Shipped |
| [`phase-8b-recent-bills.md`](./phase-8b-recent-bills.md) | `recent_bills` migrated to R15 shaped fetch | Shipped |
| [`phase-8c-recent-votes.md`](./phase-8c-recent-votes.md) | `recent_votes` migrated to R15 shaped fetch | Shipped |
| [`phase-8d-recent-contributions.md`](./phase-8d-recent-contributions.md) | `recent_contributions` migrated to R15 shaped fetch | Shipped |
| [`phase-8e-search-civic-documents.md`](./phase-8e-search-civic-documents.md) | `search_civic_documents` migrated to R15 shaped fetch | Shipped |
| [`phase-8f-resolve-and-search-entities.md`](./phase-8f-resolve-and-search-entities.md) | `resolve_person` + `search_entities` migrated to R15 shaped fetch | Shipped |
| [`phase-8g-get-entity.md`](./phase-8g-get-entity.md) | `get_entity` migrated to R15 shaped fetch | Shipped |
| [`phase-8h-entity-connections.md`](./phase-8h-entity-connections.md) | `entity_connections` migrated to R15 shaped fetch | Shipped |
| [`phase-8i-deletion-and-release.md`](./phase-8i-deletion-and-release.md) | R13 infrastructure deleted; v0.3.0 release | Shipped |
| [`phase-8j-final-docs.md`](./phase-8j-final-docs.md) | Docs polished into R15 steady state | Shipped |

Post-V2 work (Federal Register, USASpending, CourtListener, SOPR
lobbying, etc.) follows the same pattern: write the plan, execute
task-by-task, let the review loop catch plan bugs before they
compound.

## How to execute a plan

Each plan follows the writing-plans skill convention:

- TDD discipline: write the failing test, see it fail, make it pass,
  refactor, commit.
- Steps are bite-sized (2–5 min each) with checkboxes.
- Complete code in every step — no placeholders.

To execute, use one of:

1. **`superpowers:subagent-driven-development`** (preferred): dispatches
   a fresh subagent per task with two-stage review between tasks.
2. **`superpowers:executing-plans`**: batch execution in the current
   session with checkpoints.

All decisions in `docs/06-open-decisions.md` were finalized 2026-04-12
(D1–D10) with D11 added 2026-04-13 for Phase 7.

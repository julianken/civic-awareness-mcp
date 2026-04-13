# Plans

This directory contains executable implementation plans, one per phase.

## Phases

| Plan | Ships | Status |
|---|---|---|
| [`phase-1-foundation.md`](./phase-1-foundation.md) | Working MCP skeleton with empty store | Ready to execute |
| [`phase-2-openstates.md`](./phase-2-openstates.md) | 4 tools live against real OpenStates data for all 50 U.S. states | Ready to execute |

Higher-numbered phases are documented in [`../roadmap.md`](../roadmap.md)
at intent level. They will be expanded into full plans in this directory
once the prior phase ships — not before, because what we learn in Phase 2
will shape Phase 3.

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

All decisions in `docs/06-open-decisions.md` were finalized 2026-04-12.
The first Claude Code session in this repo should choose between the
two execution skills above and begin with `phase-1-foundation.md`.

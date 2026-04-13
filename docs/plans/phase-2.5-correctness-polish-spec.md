# Phase 2.5 — Correctness & Polish: Design Spec

**Date:** 2026-04-13
**Origin:** 5-reviewer UX + technical analysis of a live MCP session
**Target version:** v0.1.0

## Goal

Fix V1 correctness lies and trim LLM-facing response bloat before the
Phase 3 (Congress.gov) adapter layers onto the same foundation.

## Scope (6 tasks)

1. **T1** — `upsertEntity` merges metadata correctly; `roles[]` appends
   on non-duplicates keyed on `(jurisdiction, role, from)`; `fuzzyPick`
   wired as resolver step 4.
2. **T2** — `Document.occurred_at` = event time (from
   `raw.actions[-1].date`), not crawl time. Migration backfills
   existing rows.
3. **T3** — `get_entity.recent_documents` exposes `action_date` and
   sorts by it.
4. **T4** — `recent_bills` trims `sponsors[]` to `sponsor_summary`
   (count + by-party + top-5).
5. **T5** — Empty feed responses carry `empty_reason` +
   `data_freshness`.
6. **T6** — `recent_*` tools reach beyond 90 days via raised `days`
   ceiling and optional `session` filter.

## Deferred (explicit non-goals for this phase)

- `bill_action` first-class rows
- Unified window parameter across all four feed tools
- Standard `diagnostics` envelope across every tool
- `recent_*` → `updated_*` + `latest_*` tool-family split

These are V2-era hardening; pulling them forward risks breaking the
Phase 3 adapter work that builds on the current surface.

## Root causes → fixes

| Symptom | Root cause | Fixed by |
|---|---|---|
| `roles: []` on every Person | `upsertEntity` UPDATE path only touches `external_ids`, `aliases`, `last_seen_at` (entities.ts:42-46) | T1 |
| Metadata asymmetry (Huffman vs. Creighton) | Same — first insert wins, subsequent richer payloads dropped | T1 |
| Surname-only sponsors never resolve | `fuzzyPick` in `resolution/fuzzy.ts` is implemented but never called from the resolver chain | T1 |
| "Recent" bills are 7 months old | `adapters/openstates.ts:208` writes `b.updated_at` into `occurred_at` | T2 |
| `recent_documents` sorted by batch time | Same root cause + `documents.ts:148` sorts by misnamed column | T2, T3 |
| 171KB / 20-bill response | `recent_bills.ts:59-69` does N+1 `findEntityById` + inlines full sponsor objects | T4 |
| Empty `recent_votes` indistinguishable from "unknown jurisdiction" | No diagnostic field; empty is a valid terminal response shape | T5 |
| 90-day cap locks out biennial legislatures | `schemas.ts:39` caps `days` at 90 with no bypass | T6 |

## Key policy decisions

- **Clean breaks over migration glue.** Zero external users confirmed
  (repo is public but pre-npm, pre-registry). No backward-compat
  shims. Upgrade path for early DBs:
  `rm -rf data/*.db && pnpm refresh --all`. Only T2 ships a migration
  since it backfills cheaply from existing `raw.actions`.
- **No opt-in flag for full sponsors** in T4. Full list remains
  reachable via `get_entity(bill_id)` or `entity_connections`; a flag
  would lock the old shape in forever.
- **Task granularity.** 6 small tasks, 5-way parallel batch + 1
  follow-up. T1 · T2 · T4 · T5 · T6 in batch 1 (parallel); T3 after
  T2 merges. T4 and T5 both touch `recent_bills.ts` / `recent_votes.ts`
  but in different branches (success shape vs empty branch); reviewer
  resolves any trivial merge.
- **Version target:** v0.1.0 — minor bump, additive response fields
  (T5), one deliberate breaking response-shape trim (T4), internal
  correctness (T1-T3, T6).

## Success criteria

- All 6 tasks merged to `main`; `pnpm test` passes.
- Fresh `pnpm refresh --source=openstates --jurisdiction=tx` followed
  by `recent_bills({jurisdiction: "us-tx", days: 30})` returns
  a response <30KB, sorted by real legislative activity (not batch
  ingest time).
- `resolve_person("Joan Huffman", {jurisdiction_hint: "us-tx"})` →
  `get_entity(<id>)` returns a Person with a non-empty, correctly-merged
  `metadata.roles[]`.
- `recent_votes({jurisdiction: "us-tx", session: "892"})` returns the
  SB 5 enactment action from September 2025 regardless of today's date.
- CHANGELOG entry for v0.1.0.

## Non-goals

- Reshaping the 9-tool surface
- Adding new ingest sources (Phase 3 work)
- Schema migrations beyond T2's `occurred_at` backfill
- Rebuilding the entity resolver (fuzzy logic already exists; T1 just
  wires it)

## Out-of-band artifacts

- **UX review transcript** used to motivate this spec:
  `/tmp/civic-mcp-ux-transcript.md` (session-scoped; not committed).
- **Reviewer outputs** from the 5-agent pass live in this
  conversation only; the consensus findings are captured above in the
  Root causes → fixes table.

## Next step

Invoke `superpowers:writing-plans` to produce the executable plan doc
at `docs/plans/phase-2.5-correctness-polish.md` with per-task
implementation steps, verification commands, and done-criteria in the
project's plan format. Plan will be dispatched via
`superpowers:subagent-driven-development` (implementer + two reviewers
per task).

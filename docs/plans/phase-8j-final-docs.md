# Phase 8j — Final Docs Polish

> Final phase. R15 is the shipped architecture; flip any remaining
> "in-flight" language to "complete" and update architecture /
> tool-surface docs to describe R15 as current.

**Goal:** Bring `docs/` into final steady-state. Every "migration in flight" / "phase-8 rollout" / "R13 → R15" transitional phrase is stripped; R15 stands on its own as the shipped model.

---

## Files to audit

- `docs/00-rationale.md` — R15 entry may say "in-flight"; R13 and R14 entries may need a "Superseded by R15" pointer
- `docs/02-architecture.md` — may still describe the R13 jurisdiction-wide cache model
- `docs/05-tool-surface.md` — may reference `refresh_source` or old hydration semantics
- `docs/plans/README.md` — should list all phase-8 plans as shipped

## Task 1: Rationale

- [ ] Grep `docs/00-rationale.md` for `in-flight`, `in flight`, `migration in`. Strip.
- [ ] Add a single-line postscript to R13: `**Superseded by R15 (2026-04-14).**`
- [ ] R15 entry: confirm it reads as shipped; no "in-flight" adjectives.
- [ ] Commit: `docs(rationale): finalize R15 entry; mark R13 superseded`

## Task 2: Architecture

- [ ] Read `docs/02-architecture.md` in full.
- [ ] Replace any passage describing `hydrate.ts` / `ensureFresh` / jurisdiction-wide pass-through cache with the R15 picture: `withShapedFetch`, `fetch_log`, per-endpoint keys.
- [ ] Update any diagrams that show R13 hydration flow.
- [ ] Commit: `docs(architecture): describe R15 shaped-query hydration as current`

## Task 3: Tool surface

- [ ] Read `docs/05-tool-surface.md`.
- [ ] Remove any mention of `refresh_source` as an MCP tool (already removed from code; doc may still reference).
- [ ] Each tool's "freshness" notes should reference `fetch_log` / R15, not `hydrations` / R13.
- [ ] Confirm `stale_notice` reason list matches shipped reality: `upstream_failure`, `not_found`, `not_yet_supported`. Retired: `partial_hydrate`, `rate_limited`, `daily_budget_exhausted`.
- [ ] Commit: `docs(tool-surface): align with R15 stale_notice and fetch_log semantics`

## Task 4: Plans index

- [ ] Read `docs/plans/README.md` (if exists) or plan listing.
- [ ] Add phase 8a through 8j entries as "Shipped".
- [ ] Commit: `docs(plans): index phase-8 as shipped`

## Acceptance

- `grep -i 'in.flight' docs/` — zero matches (other than historical phase-8 plan docs which legitimately record the history)
- `grep -i 'refresh_source' docs/05-tool-surface.md` — zero (or references only as a historical artifact)
- All 4 tasks committed with Co-Authored-By trailer

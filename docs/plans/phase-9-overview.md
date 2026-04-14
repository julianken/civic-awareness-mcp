# Phase 9 — V2 Tool Surface Completion (Overview)

> **For agentic workers:** This is the index doc for Phase 9.
> Each sub-phase (9a–9d) has its own plan file. Execute them in
> order via `superpowers:subagent-driven-development` (recommended)
> or `superpowers:executing-plans`.

**Goal:** Close the structural gaps in the MCP tool surface surfaced
by the post-Phase-8 tool-surface audit. Land the V2 steady-state:
**11 tools** with a listing projection for bills, a detail tool for
votes, and four small parameter additions that make heterogeneous
civic-data queries answerable without client-side chaining.

**Why now:** The post-Phase-8 tool-surface audit mapped ~48 realistic
LLM-driven civic queries against the current 9 tools and found that
entire query families — "bills on date X," "bills currently in
committee," "how did Senator Y vote," "which bills did Z cosponsor
(not primary-sponsor)?," "contributions **from** donor X" — are
either impossible or require awkward multi-tool chains. The audit
concluded that the taxonomy (feeds / entities / details) is correct
in its bones but specific tools are under-parameterized and one
listing projection is missing. Phase 9 closes both.

**Nothing is published yet.** There is no `civic-awareness-mcp` npm
release, so all four sub-phases land sequentially on `main` and ship
together as v0.4.0 at the end of 9d. No breaking-change mitigations
are required.

---

## Sub-phases

| Plan | Scope | Adds | Size |
|---|---|---|---|
| [`phase-9a-recent-bills-limit.md`](./phase-9a-recent-bills-limit.md) | Optional `limit` on `recent_bills`; when set, the handler drops `updated_since` and returns top-N by OpenStates' native `sort=updated_desc`. Unblocks the reported biennial-legislature case (last 20 MT bills with no recent activity). | — | ~1 commit |
| [`phase-9b-list-bills.md`](./phase-9b-list-bills.md) ✅ | New `list_bills` tool. Inputs: `jurisdiction`, `session?`, `chamber?`, `sponsor_entity_id?`, `subject?`, `classification?`, `introduced_since?`/`until?`, `updated_since?`/`until?`, `sort`, `limit`. Proper bill-listing projection distinct from time-windowed feed. | Tool #10 | ~4 commits |
| [`phase-9c-get-vote.md`](./phase-9c-get-vote.md) ✅ | New `get_vote` detail tool. Inputs: `vote_id` (or `(jurisdiction, session, identifier)` composite). Returns per-legislator `positions[]` so "how did X vote" / "party-line breakdown" / "against-their-party" queries become answerable. Mirrors `get_bill`'s C-projection shape. | Tool #11 | ~3 commits |
| [`phase-9d-tool-polish.md`](./phase-9d-tool-polish.md) | Three small parameter additions: `via_roles[]` on `entity_connections` edges; `had_role?`/`had_jurisdiction?` on `search_entities`; `contributor_entity_id?`/`side?` on `recent_contributions` for donor-side queries. | — | ~3 commits |

Total: 2 new tools + 4 param additions → terminal count **11 tools**,
well inside the ~15-tool LLM-selection ceiling per R5.

---

## Scope-level decisions added in Phase 9

Each sub-phase's first task updates these docs. Listed here for
visibility:

- **D12 (new, this phase):** Feed tools accept an optional `limit`
  for row-bounded listings. When set, the window-derived
  `updated_since` is dropped and upstream sort order decides which
  rows return. Rationale: biennial legislatures and off-session
  jurisdictions can't express "last N" via a time window alone.
- **D13 (new, this phase):** `list_bills` is a distinct tool, not an
  extension of `search_civic_documents`. Listing with structured
  predicates is taxonomically different from text-search; conflating
  them degrades LLM tool-selection accuracy more than +1 tool costs.
- **R16 (new, this phase):** Cross-reference for the D12 rationale.
  Points at the specific Montana-biennium case that surfaced the gap.
- **R17 (new, this phase):** Why `get_vote` as a new detail tool
  rather than `VoteSummary.positions[]` on `recent_votes`. Cleaner
  feed-vs-detail split; matches `get_bill`'s existing C-projection.

## What Phase 9 deliberately does NOT address

Per the audit's "defer indefinitely" section — left unchanged:

- **Aggregate queries** (top-N donors, most-sponsored members, totals).
  The LLM can aggregate client-side over returned pages.
- **Federal `get_bill`.** Already explicitly deferred to a future
  Phase 7b; the `not_yet_supported` stale_notice path is correct.
- **Geo / district lookups.** Out of scope (not in any upstream API
  we consume; requires separate Census or OpenStates districts data).
- **Industry rollups on contributions.** OpenFEC has industry codes,
  but exposing them requires a rollup surface we can build later if
  the demand shows up. Not V2.

---

## Acceptance for Phase 9 as a whole

- [ ] All four sub-phases merged.
- [ ] `pnpm test` all green.
- [ ] `pnpm build` clean.
- [ ] Tool count is 11. Confirmed by `grep -c '^### ' docs/05-tool-surface.md` matching the documented count.
- [ ] `docs/05-tool-surface.md` rewritten to reflect 11 tools with the new inputs.
- [ ] `docs/06-open-decisions.md` has D12, D13 locked.
- [ ] `docs/00-rationale.md` has R16, R17 appended.
- [ ] `CLAUDE.md` "key conventions" section lists the new tools.
- [ ] `CHANGELOG.md` has a v0.4.0 entry — but **not yet released.**

Phase 9 complete when all hold. Releases remain a separate post-phase
decision (Phase 9e if needed).

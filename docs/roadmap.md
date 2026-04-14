# Roadmap (Phases 3–5)

Scope is locked by R11 in `docs/00-rationale.md` (US-federal +
all-50-state legislative). Former AZ/Phoenix-municipal phases are
retired.

> **Status update (2026-04-13):** Phases 1–6 are all complete.
> TDD plans live in `docs/plans/phase-{1..6}-*.md` and were executed
> task-by-task via `superpowers:subagent-driven-development`. The
> server ships with **8 tools** exposing a cross-source entity graph
> spanning OpenStates (50 states), Congress.gov (federal legislature
> + votes), and OpenFEC (federal campaign finance), with a transparent
> pass-through TTL cache (R13) replacing the former `refresh_source`
> tool. See `README.md` for the final run instructions.
>
> This document is preserved as the historical intent-level roadmap.
> The implementation plans (and their post-execution amendments) are
> the source of truth for what actually shipped. Post-V2 work
> (Federal Register, USASpending, CourtListener, SOPR lobbying, etc.)
> follows the same pattern: write the plan, execute task-by-task,
> let the review loop catch plan bugs before they compound.

Phases 1 and 2 have full TDD plans in `docs/plans/`. Phases 3 through
5 were originally described here at intent level; each was expanded
into a full plan when the prior phase shipped. **Do not attempt to
execute from this document — expand it into a proper plan first.**

---

## Phase 3 — Congress.gov (federal legislature)

**Ships:** Two new tools (or extensions to existing feed/entity
tools) that surface federal bills, votes, committees, and Members
of Congress, joined into the same entity graph as the 50-state
OpenStates data from Phase 2.

**Scope:**
- New adapter: `src/adapters/congress.ts` (against
  `https://api.congress.gov/v3/...` — see `docs/03-data-sources.md`)
  - `GET /bill` → `Document` of kind `bill`, jurisdiction
    `us-federal`
  - `GET /member` → `Person` with
    `external_ids.bioguide = <bioguide_id>`
  - `GET /committee` → `Organization` (committee) entities
- Cross-source entity resolution: when a Member of Congress has a
  name + prior-state-role match against an existing OpenStates
  `Person` (from Phase 2), merge into one entity via the fuzzy
  resolver's linking-signal rule (D3b step 4c).
- Jurisdiction seeding extends to `us-federal` (added to
  `jurisdictions` table; `us-<state>` rows already seeded in Phase 2).

**Load-bearing sub-decisions to revisit before expanding this plan:**
- How many historical Congresses? Only the current (119th)? Back to
  some horizon (e.g., 113th ~ 2013)? Full history (93rd forward) is
  ~thousands of members and tens of thousands of bills and is a real
  refresh cost. *Lean: current Congress + prior one for V2; full
  history deferred.*
- When a current Senator also appears as a former state legislator
  in OpenStates data, do we require a high-confidence match before
  merging, or do we tolerate occasional under-match? *Lean:
  under-match tolerated per R11 / D3b; a future `merge_entities`
  admin tool handles reconciliation.*
- Does Phase 3 surface federal votes (roll calls) as separate
  Documents, or only bill-level sponsorships? *Lean: votes as
  `kind='vote'` Documents, referencing each Member of Congress as
  an `EntityReference` with role `voter` and qualifier `yea`/`nay`/
  `present`.*

**Tool changes:**
- `recent_bills` (existing; now sees federal bills when
  `jurisdiction=us-federal`)
- `search_entities` (existing; now surfaces Members of Congress)
- `get_entity` and `entity_activity` (existing; profiles now span
  federal + state roles for a merged Person)
- `search_civic_documents` (existing; scope expands)

**Risk:** The cross-source merge heuristic in D3b is the riskiest
bit. An incorrect merge between a sitting Senator and an unrelated
state legislator with a similar name would be a visible correctness
failure. Invest in resolution tests early in this phase — seed the
test fixture with known hard cases (common names, same-state
collisions, cross-cycle name changes from marriage/etc.).

---

## Phase 4 — OpenFEC (federal campaign finance)

**Ships:** `recent_contributions` tool and cross-source entity
resolution between OpenFEC candidates/committees and Congress.gov
Members of Congress.

**Scope:**
- New adapter: `src/adapters/openfec.ts` (against
  `https://api.open.fec.gov/v1/...`)
  - `GET /candidate/{id}` → `Person` with
    `external_ids.fec_candidate`; merged into Congress.gov Person
    when the candidate is a sitting Member
  - `GET /committees` → `Organization` (kind `pac` or
    `committee`) with `external_ids.fec_committee`
  - `GET /schedules/schedule_a` → `Document` of kind
    `contribution`
  - `GET /schedules/schedule_b` → `Document` of kind `expenditure`
- Contributor entity resolution is the hardest case: individual
  donors often lack stable IDs. Lean on fuzzy matching with the D3b
  tightened thresholds; tolerate under-match.

**Load-bearing sub-decisions to revisit before expanding this plan:**
- How much historical campaign-finance data? Current cycle only, or
  full cycles back to 2000? Full history is the larger part of a
  multi-GB download. *Lean: last two cycles for V1 (current +
  prior); full history deferred.*
- When two contributors with the same name in the same ZIP exist, do
  we merge or split? *Lean: split (under-match bias). Same
  city/ZIP is *not* a strong enough positive signal under D3b.*
- OpenFEC contributor addresses are public. Do we store them?
  *Lean: yes, for aggregate-query internal use, but never expose
  through tool responses. (Same as `docs/03-data-sources.md`.)*

**Tool changes:**
- `recent_contributions` (new)
- `entity_activity` (existing; now surfaces contribution Documents
  tied to a Person)
- `search_entities` (existing; now surfaces PACs and individual
  contributors)

**Risk:** OpenFEC is a well-documented, stable API — low technical
risk. The risk is ethics and scope drift: once contributions are
in the store, the temptation to expose contributor addresses,
employers, etc. will be real. Keep the boundary clear — stored for
aggregate queries, never leaked through tools.

---

## Phase 5 — Connections & resolution

**Ships:** `entity_connections` (graph queries) and `resolve_person`
(disambiguation).

**Scope:**
- New query layer in `src/core/connections.ts` computing
  co-occurrence counts between entities over `document_references`.
- Edge discovery: given two entities, find shared documents and
  summarize by kind.
- Disambiguation: given a name string, return all matching entities
  with confidence scores and disambiguators (roles,
  jurisdiction-history, time spans).

**Load-bearing sub-decisions to revisit before expanding this plan:**
- `depth=2` graph queries can explode on well-connected entities
  (prolific legislators co-occur with thousands of others, especially
  at federal level). We cap `min_co_occurrences` and total edge
  count per response. *Lean: `depth=1` default, `depth=2` opt-in
  with stricter caps.*
- How do we present graph results to an LLM? Flat edge lists beat
  nested graph JSON for LLM comprehension. *Lean: flat list of
  edges, grouped by `via_kinds`.*
- Under the US-wide scope, "who did this Senator vote with most
  often" is a legitimate query and requires co-occurrence over
  votes. Does `entity_connections` surface that, or is it a separate
  tool? *Lean: surface through `entity_connections` with
  `via_kinds=['vote']`.*

**Tool changes:**
- `entity_connections` (new)
- `resolve_person` (new)

**Stretch goal (maybe defer to Phase 6):**
- Natural-language composability test: can the LLM answer "which
  sitting senators were previously state legislators, and what bills
  did they sponsor in their prior state?" in a single turn using
  only the exposed tools? That's the product test for whether the
  cross-jurisdiction entity graph earns its cost.

---

## Done criteria for the overall project

The project is "done enough to publish" (per D8 — publish after V1,
i.e., after Phase 2) when:

1. Claude Desktop, using this MCP, can answer the five
   representative questions listed in `docs/01-vision.md` — without
   the LLM needing to be told which tool to use.
2. Each answer cites upstream sources (Congress.gov, OpenStates,
   OpenFEC) that a human can verify.
3. Integration tests pass in CI: `msw`-mocked tests per push, live
   nightly integration tests catch upstream schema drift (D10).
4. A fresh operator can `git clone`, `pnpm install`, `pnpm bootstrap`,
   `pnpm refresh`, and have a working server in under ten minutes —
   or can `npx @<user>/civic-awareness-mcp` once published (D8).

Post-V2, additional adapters (Federal Register, USASpending,
CourtListener, SOPR) would each be their own single-phase plan,
following the same TDD pattern.

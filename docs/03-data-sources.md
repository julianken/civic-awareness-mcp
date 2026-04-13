# 03 — Data Sources

Canonical inventory of upstream data sources. Scope is locked by R11
in `docs/00-rationale.md` (US-federal + 50-state legislative). Every
V1/V2 source is Tier 1 (sanctioned API, free with API key) per D4 in
`docs/06-open-decisions.md`.

## Source matrix

| Source | Type | Auth | Rate limit | Phase |
|---|---|---|---|---|
| [OpenStates API v3](https://docs.openstates.org/api-v3/) | JSON REST | API key | 10/min, 500/day free tier | **V1 — Phase 2** |
| [api.congress.gov](https://api.congress.gov/) | JSON REST | API key (via api.data.gov) | ~5,000/hour with key | **V2 — Phase 3** |
| [OpenFEC](https://api.open.fec.gov/developers/) | JSON REST | API key (via api.data.gov) | 1,000/hour with key | **V2 — Phase 4** |
| Federal Register | JSON REST | None | Soft | Later |
| Regulations.gov | JSON REST | API key | Documented | Later |
| USASpending.gov | JSON REST | None | Generous | Later |
| [CourtListener](https://www.courtlistener.com/help/api/rest/) | JSON REST | API key | Documented | Later |
| VoteSmart | JSON REST | API key | Documented | Later |
| [OpenElections](http://www.openelections.net/) | Bulk CSV + API | None | N/A | Later |
| Senate LDA (SOPR) | XML dumps | None | N/A | Later |
| House Clerk LD-203 | HTML/CSV | None | N/A | Later |
| [LegiScan](https://legiscan.com/) | JSON REST | API key (paid tiers) | Per-tier | Later — paid alt to OpenStates |

## Per-source notes

### OpenStates API v3 — V1 primary source (Phase 2)

**Base URL:** `https://v3.openstates.org`
**Auth:** Header `X-API-KEY: <key>` — obtain at https://open.pluralpolicy.com
**Docs:** https://docs.openstates.org/api-v3/

**Endpoints we use:**
- `GET /bills?jurisdiction=<state>&session=<id>` — paginated bill list, per-state
- `GET /bills/{id}` — single bill with sponsorships, actions
- `GET /people?jurisdiction=<state>` — legislators with `ocd-person` IDs
- `GET /people/{id}` — single legislator
- `GET /committees?jurisdiction=<state>` — committees

**Jurisdiction parameter:** OpenStates accepts any of the 50 U.S.
state jurisdictions plus D.C. and Puerto Rico. V1 iterates across
them rather than hardcoding one. Stable form is
`ocd-jurisdiction/country:us/state:<abbrev>/government`.

**Entities produced:**
- `Person` with `external_ids.openstates_person = ocd-person/<uuid>`
- `Organization` (committees) with `external_ids.openstates_org`
- `Document` of kind `bill` with references to sponsor Persons

**Refresh cadence:** Daily. State legislative sessions vary by state
(some year-round, others only a few weeks). Refresh prioritizes
active sessions and backfills history incrementally.

**Scaling consideration — free-tier constraint:** At 500 requests/day
free, a full cold-start refresh across all 50 states is not
possible in one day (roughly 150–200 paginated calls for bills in
currently-active sessions alone, before people and committees). V1
mitigates by:
1. Prioritizing states with active sessions first (fewer calls).
2. Supporting `--since=<date>` incremental refresh.
3. Being resumable — a refresh that dies mid-run at state 32 picks
   up there on the next invocation.

Paid OpenStates tiers remove this constraint and are a reasonable
V2/V3-era consideration if the free tier becomes a real blocker.

**Gotchas:**
- Pagination uses `page` and `per_page`, max `per_page=20` for bills.
- Session IDs like `"57th Legislature - 2nd Regular Session"` are
  human strings, not stable keys. Use the `ocd-jurisdiction/...` form
  for filtering.
- The `abstract` field is often empty for many states' bills; use
  `title` plus the latest `actions[].description` for summaries.

### Congress.gov API — V2 federal legislature source (Phase 3)

**Base URL:** `https://api.congress.gov/v3`
**Auth:** API key (free from https://api.data.gov/signup/)
**Docs:** https://api.congress.gov/

**Endpoints we use:**
- `GET /bill` — paginated bills with filters (`congress`, `billType`)
- `GET /bill/{congress}/{billType}/{billNumber}` — single bill
- `GET /member` — current and past Members of Congress
- `GET /member/{bioguideId}` — single member with committee assignments
- `GET /committee` — committees

**Entities produced:**
- `Person` with `external_ids.bioguide = <bioguide_id>`, cross-linked
  to OpenStates `Person` entries via name + prior-state-role overlap
  (per D3b, Person entities are cross-jurisdiction in V1)
- `Organization` for congressional committees
- `Document` of kind `bill` with federal sponsor/cosponsor references

**Refresh cadence:** Daily.

**Gotchas:**
- Congress numbers are two-year cycles (the 119th Congress covers
  2025–2026). Multi-congress queries require iteration.
- `bioguide_id` is the canonical federal legislator ID and has been
  consistent for decades — treat as the authoritative federal
  external_id.
- The API exposes voting records, but they lag committee/floor
  actions by hours.

### OpenFEC — V2 federal campaign finance source (Phase 4)

**Base URL:** `https://api.open.fec.gov/v1`
**Auth:** API key (same api.data.gov registration as Congress.gov)
**Docs:** https://api.open.fec.gov/developers/

**Endpoints we use:**
- `GET /candidates/search` — federal candidates
- `GET /candidate/{candidate_id}` — single candidate profile
- `GET /committees` — PACs, party committees, campaign committees
- `GET /schedules/schedule_a` — itemized individual contributions
- `GET /schedules/schedule_b` — disbursements

**Entities produced:**
- `Person` for candidates with
  `external_ids.fec_candidate = <candidate_id>`; cross-linked to
  Congress.gov bioguide where the candidate is a sitting Member
- `Person` or `Organization` for contributors
- `Organization` for committees with
  `external_ids.fec_committee = <committee_id>`
- `Document` of kind `contribution` or `expenditure`

**Refresh cadence:** Daily during active election cycles; weekly
otherwise.

**Gotchas:**
- Contributor records often lack a stable ID (many individual donors
  are listed only by name + address). Entity resolution for
  contributors is the hardest case and relies on
  `src/resolution/fuzzy.ts` with the tightened thresholds from D3b
  (Levenshtein ≤ 1; merges require shared external_id OR exact
  middle-name match OR alias propagation).
- Rate limit is per-hour, not per-day — more generous than
  OpenStates but still requires pacing during full refreshes.
- Contributor home addresses are present in raw records. We store
  them for aggregate-query use cases but never surface them through
  tool responses.

## Deferred sources — former V1/V2 scope

Deferred indefinitely by R11 in `docs/00-rationale.md`:

- **See The Money (AZ SoS)** — Arizona state campaign finance. Would
  be canonical for one state; V1 scopes state finance out entirely
  (federal only via OpenFEC). State-level finance across 50 states
  would require 50 different systems.
- **Phoenix Legistar** — City council agenda and votes. Municipal is
  out of scope.
- **Phoenix Open Data CKAN** — Crime, budget, municipal datasets.
  Same exclusion.
- **Phoenix OpenGov** — Municipal budget transparency. Same.
- **AZ Corporation Commission eCorp** — Business filings. Tier 3 (no
  API, hostile scraping).
- **Maricopa Superior Court docket** — Tier 3, same reason.

A future sibling project (`civic-awareness-municipal-mcp` or
`civic-awareness-az-mcp`) could pick these up without affecting this
codebase.

## Forward-looking — Later candidates

Plausible V3+ additions, not built today:

- **Federal Register** — rulemaking, notices, executive orders.
  Extends "federal activity" to the executive branch.
- **Regulations.gov** — public comments on proposed rules.
- **USASpending.gov** — federal contracts, grants, and loans.
- **CourtListener / Free Law Project** — federal court opinions and
  the RECAP mirror of PACER.
- **Senate LDA (SOPR) / House Clerk LD-203** — federal lobbying
  disclosures (raw XML/CSV). Would materially enrich the entity
  graph by linking lobbyists to the Members of Congress they
  approach.
- **VoteSmart** — positions, ratings, member bios.
- **OpenElections** — historical official election results
  (precinct-level, public domain).
- **LegiScan** — commercial alternative to OpenStates. Would
  replace OpenStates if the 500/day free tier becomes a real
  blocker and the project has budget.

## Entity ID strategy across sources

Every `Entity` row has:
- An internal UUID (`id`)
- An `external_ids` JSON map, e.g.:
  ```json
  {
    "openstates_person": "ocd-person/abc-123",
    "bioguide": "H001234",
    "fec_candidate": "H0AZ01234"
  }
  ```

When an adapter encounters an entity, it:
1. Looks up by each known external_id it can compute. Any hit merges.
2. If not found, does **exact normalized-name match** on the same
   `kind` (cross-jurisdiction per D3b — no jurisdiction filter).
3. For `kind='person'`, falls through to fuzzy match at Levenshtein
   ≤ 1, with merges requiring one of: shared external_id, exact
   middle-name/initial match, or alias propagation from a previously
   merged row. See `docs/04-entity-schema.md`.
4. Creates a new entity only if steps 1–3 all miss.

This is implemented once in
`src/core/entities.ts::upsertByExternalIdOrFuzzy()` and used by every
adapter.

## What we do NOT fetch

- **Voter rolls / registration data.** Sold by states for a fee and
  carries PII — wrong shape for an LLM-consumed MCP.
- **Police body-cam transcripts.** Available by records request;
  unstructured.
- **Individual tax records.** Privacy red line.
- **Contributor home addresses** (from OpenFEC). We may store them
  for aggregate deduplication but never expose them through tool
  output.

## Rate-limit / ethics floor

All adapters route through `src/util/http.ts`, which enforces:
- A per-host token bucket (configurable, defaults conservative)
- Exponential backoff on 429 and 5xx
- `User-Agent: civic-awareness-mcp/<version> (+<repo-url>)`
- Respect for `Retry-After` headers

These APIs are public infrastructure run by the Library of Congress,
the FEC, and Plural Policy. We treat them the way we'd treat a
library — use them, cite them, and don't crash them.

# 06 — Open Decisions

These decisions are **pre-committed with defaults** but the user should
explicitly confirm or override each one before Phase 1 implementation
begins. See `CLAUDE.md` — the Claude Code session opening this repo for
the first time must walk the user through this file.

When a decision is finalized, strike through the proposal and record
the final answer with a date, like this:

```
~~Proposal: TypeScript~~ → **Decided 2026-04-12: TypeScript** (confirmed).
```

---

## D1 — Language and runtime

**Proposal:** TypeScript on Node.js 22+ (has native `fetch`, stable
`--experimental-require-module`, mature ESM).

**Rationale:**
- The MCP TypeScript SDK (`@modelcontextprotocol/sdk`) is the
  reference implementation and has the richest ecosystem.
- `zod` is a de-facto standard for MCP tool schema declaration.
- Civic data is schema-heavy; TS catches adapter/tool contract bugs at
  compile time.

**Override if:** You'd prefer Python (MCP Python SDK is also excellent;
swap `zod` → `pydantic`, `better-sqlite3` → `sqlite3` std lib), or
strong team familiarity with another language.

**Decision:** 2026-04-12 — **TypeScript on Node.js 22+** (confirmed).

---

## D2 — Scope of jurisdictions in V1

**Proposal:** V1 covers **Arizona statewide** (the legislature). V2
expands to **Phoenix** (council, crime, budget). Other AZ cities
(Tucson, Mesa, Scottsdale) are deferred indefinitely unless there's
specific demand.

**Rationale:**
- OpenStates gives us a clean Arizona legislature surface for Phase 1.
- Phoenix is the largest city and has the richest open-data footprint
  among AZ municipalities — highest ROI per adapter.
- Narrower scope now ships a real product sooner.

**Override if:** You care more about a different city, OR you want
multi-city parity from day one.

**Decision:** 2026-04-12 — **Overridden.** Scope pivoted to
**US-federal + all-50-state legislative**. V1 adapters: OpenStates
(50 states), Congress.gov (federal), OpenFEC (federal campaign
finance). All three are free-with-API-key. AZ- and Phoenix-specific
sources (See The Money, Phoenix Legistar, Phoenix CKAN) deferred
indefinitely and removed from V1/V2 scope. Competitive context:
closest existing MCP is `legiscan-mcp` (paid LegiScan backend, no
entity graph, no federal finance); nobody currently joins federal
money ↔ Member of Congress ↔ state legislator as one entity — that's
the moat. Full rationale to be recorded as R11 in
`docs/00-rationale.md` during the upcoming docs-rewrite batch.

---

## D3 — Entity schema finalization

**Proposal:** The schema in `docs/04-entity-schema.md` is committed
as-is, with three remaining sub-questions:

- **D3a:** Do aliases participate in exact-match resolution?
  _Proposal: yes._
- **D3b:** Are Person entities per-jurisdiction in V1?
  _Proposal: yes — flatten in V2 if needed._
- **D3c:** Does the MCP ever synthesize `Document.summary`?
  _Proposal: no — upstream only._

**Decision:** 2026-04-12 — All three sub-decisions:

- **D3a — confirmed YES.** Aliases participate in exact-match
  resolution. Without it, common name variations ("Lake, Kari A." vs
  "Kari Lake") split into duplicate entities, which directly defeats
  the cross-source entity graph. Aliases are the primary
  controlled-merge mechanism.

- **D3b — OVERRIDDEN. Entities are cross-jurisdiction in V1.**
  The US-federal + 50-state scope locked in D2 makes
  cross-jurisdiction identity a core product feature (a typical
  Member of Congress's career spans state legislature → federal
  office; a federal donor may also appear in state bill sponsorships
  or lobbying records). Per-jurisdiction splitting would make
  `entity_connections` and `get_entity` return fragmented answers —
  the moat evaporates.
  To compensate for nationwide name-collision risk ("Michael Brown"
  has hundreds of matches), the resolution algorithm tightens:
  (1) fuzzy-match Levenshtein threshold drops from ≤ 2 to ≤ 1;
  (2) merges require at least one of: a shared `external_id` from any
  source (OpenStates ocd-person, Congress.gov bioguide, FEC
  candidate_id), an exact normalized name match including middle
  name/initial, or external-id propagation via a previously-merged
  alias. `Entity.metadata.roles[]` carries
  `{jurisdiction, role, time_span}` tuples so per-jurisdiction views
  are still a cheap query over one entity, not separate rows.
  This overrides the step-3/step-4 logic in
  `docs/04-entity-schema.md`; that doc will be rewritten to match as
  part of the post-D3 docs-rewrite batch.

- **D3c — confirmed NO.** The MCP never synthesizes
  `Document.summary`. Locked by R9 in `docs/00-rationale.md`.

---

## D4 — Scraping posture

**Proposal:** Three-tier policy.

- **Tier 1 (sanctioned APIs)** — OpenStates, Maricopa Assessor,
  Phoenix CKAN, Legistar. Use freely, cache per rate limits.
- **Tier 2 (undocumented JSON backends)** — See The Money, Phoenix
  OpenGov. Use with identifying User-Agent, conservative rate limits,
  and robustness tests. Acceptable.
- **Tier 3 (HTML-only / hostile)** — eCorp, court dockets, lobbyist
  registry. **Not** built into V1 or V2. A future opt-in adapter may
  support them with explicit user consent.

**Override if:** You have stronger ethical constraints (only Tier 1)
or relationships that unlock Tier 3 access (e.g., a press credential).

**Decision:** 2026-04-12 — **Three-tier framework confirmed**
(option 1). Post-D2 adjustments:
- **Tier 1 V1 sources:** Congress.gov, OpenStates, OpenFEC (all
  sanctioned, free API key).
- **Tier 2** remains acceptable for future adapters with extra care
  (integration tests for schema drift, conservative rate limits,
  identifying User-Agent). Forward-looking candidates:
  FollowTheMoney, state-specific SPA backends.
- **Tier 3** requires explicit per-source user opt-in; none planned
  for V1 or V2.
- **Baseline regardless of tier:** all adapters route through
  `src/util/http.ts`, which enforces identifying User-Agent, per-host
  token-bucket rate limiting, exponential backoff on 429/5xx, and
  `Retry-After` respect.
- The original proposal's concrete examples (Maricopa Assessor,
  Phoenix CKAN, See The Money, eCorp, etc.) are obsolete under D2 and
  will be replaced in the post-D3 docs-rewrite batch.

---

## D5 — Refresh strategy

**Proposal:** Out-of-process refresh via a CLI command:
`pnpm refresh --source=openstates`. Cron-able by the operator. The
MCP server itself never triggers refreshes — it only reads.

**Rationale:** Keeps the server deterministic and fast. Decouples
failure modes (refresh can retry; tool calls can't).

**Override if:** You want a long-lived background worker built in, OR
on-demand refresh inside tool calls (strong no from me — produces
unpredictable latency).

**Decision:** 2026-04-12 — **Confirmed.** Out-of-process refresh via
`pnpm refresh --source=<name>` (and `--all`). Cron-able. MCP server
never triggers refreshes — it only reads. Implementation
requirements deferred to the Phase 2 plan rewrite: resumability,
`--since=<date>` incremental mode, per-source rate-limit handling
(especially OpenStates at 500/day free tier, which requires
prioritizing active sessions and backfilling history over multiple
refresh cycles).

**Amended 2026-04-13:** Refresh is additionally exposed as an MCP
tool (`refresh_source`) alongside the existing CLI, sharing a
single `refreshSource()` core function. The server remains
read-only on the query path; `refresh_source` is the only
write-capable tool and requires explicit per-call user consent
(MCP default behavior). See R12 in `docs/00-rationale.md` and
`docs/plans/phase-5-onboarding-and-refresh-tool.md`.

**Amended 2026-04-13 (second amendment):** Refresh is removed from
the MCP tool surface entirely. Read tools now pass through to
upstream APIs transparently, using the local SQLite store as a TTL
cache (1h for `scope="recent"` feed pulls, 24h for `scope="full"`
entity hydration, keyed per `(source, jurisdiction, scope)`).
Rate-limit waits over 2.5s, 5xx upstream errors, and daily-budget
exhaustion all fall back to stale local data with a `stale_notice`
sibling field on the response envelope. Entity tools auto-hydrate
on cold jurisdictions, bounded by `maxPages=5` AND a 20s wall-clock
deadline (partial-result fallback if deadline fires).
`refresh_source` no longer appears in `tools/list`; the
`pnpm refresh` CLI remains for operator use (cron, bulk seeding,
historical backfill). The original D5 read-only invariant on the
query path is preserved in a different form — callers never see or
initiate writes; the server transparently writes through to SQLite
on cache misses. See R13 in `docs/00-rationale.md` and
`docs/plans/phase-6-passthrough-cache.md`.

**Amended 2026-04-14 (R15):** D5's transparent-cache approach is
re-shaped from jurisdiction-wide pass-through to per-endpoint
shaped fetches. Cache keying moves from
`(source, jurisdiction, scope)` in the `hydrations` table to
`(source, endpoint_path, args_hash)` in a new `fetch_log` table.
Each tool call issues the narrow upstream query its shape
permits, writes-through atomically, and serves from local. The
20s jurisdiction hydration budget and its `partial_hydrate`
stale notice are eliminated — narrow fetches don't accrete
enough work to exceed rate-limit windows. The `pnpm refresh`
CLI continues to exist for operator bulk pre-fill and should
write `fetch_log` rows for the endpoints it covers.

---

## D6 — Storage location and lifecycle

**Proposal:** SQLite file at `./data/civic-awareness.db`. Gitignored.
The schema is code (migrations in `src/core/migrations/`); the
populated file is local state.

A `pnpm bootstrap` script initializes an empty DB with schema applied.

**Override if:** You want the DB to live in an XDG dir, or you want
multi-instance support (would need a different storage choice).

**Decision:** 2026-04-12 — **Default + env override** (option 1).
Default path: `./data/civic-awareness.db` (gitignored). Env var
`CIVIC_AWARENESS_DB_PATH` overrides it for installed use. Bootstrap
stays explicit via `pnpm bootstrap` for V1; auto-bootstrap on first
launch deferred to a V2 polish. Multi-instance support remains out
of scope (one file, one process).

---

## D7 — License

**Proposal:** MIT (permissive, simple, compatible with all upstream
API ToS we've reviewed).

**Rationale:** This is a client of public APIs, not a fork of anything
copyleft. MIT lets anyone run their own instance or fork freely.

**Decision:** 2026-04-12 — **MIT** (confirmed).

---

## D8 — Distribution

**Proposal:** Publish to npm as `@<user>/civic-awareness-mcp` after V2
ships. Before then, installation is "git clone + pnpm install + pnpm
build" with example `claude_desktop_config.json` in the README.

**Decision:** 2026-04-12 — **Publish after V1** (option 2, overrides
the original proposal). OpenStates (50 states) is a complete
shippable feature on its own; publishing early surfaces real operator
feedback and exercises D6's installed-path env-var in anger rather
than in theory. Package name is `civic-awareness-mcp` (scope-agnostic
— the old `civic-awareness-az` reference in `00-rationale.md` R2 is
obsolete under the D2 pivot and will be rewritten in the docs batch).
The `<user>` npm scope remains a placeholder to be filled at publish
time with the author's npm/GitHub handle.

---

## D9 — Attribution / credit line

**Proposal:** Every `ToolResponse` embeds source URLs (already in the
spec). In addition, the MCP's `tools/list` response advertises: "Data
sourced from OpenStates, See The Money (AZ SoS), City of Phoenix Open
Data. This server is not affiliated with any of those organizations."

**Decision:** 2026-04-12 — **Confirmed with updated source list.**
Every `ToolResponse` continues to embed per-source URLs. The
`tools/list` response will advertise:

> Data sourced from OpenStates (Plural Policy), the U.S. Congress via
> api.congress.gov (Library of Congress), and the U.S. Federal
> Election Commission via OpenFEC. This server is not affiliated with
> any of those organizations.

The old attribution referencing See The Money and Phoenix Open Data
is obsolete under the D2 pivot and will be replaced in the
docs-rewrite batch.

---

## D10 — Testing strategy depth

**Proposal:**
- **Unit tests:** full coverage of `core/entities.ts`, `core/documents.ts`,
  `resolution/fuzzy.ts`, every adapter's normalization logic.
- **Integration tests:** real HTTP against OpenStates with recorded
  fixtures (via `nock` or `msw`). Run in CI.
- **End-to-end tests:** a scripted MCP session that spins up the server,
  calls each tool, and asserts response shape. Runs in CI.
- No manual QA. If Claude can't test it, we don't have it.

**Decision:** 2026-04-12 — **Confirmed with refinements.**

- **Unit tests:** full coverage of `core/entities.ts`,
  `core/documents.ts`, `resolution/fuzzy.ts`, and every adapter's
  normalization logic (Congress.gov, OpenStates, OpenFEC under the
  D2 scope).
- **Integration tests:** use **`msw`** for HTTP mocking with committed
  JSON fixtures (better maintained than `nock` and more ergonomic;
  `nock` remains acceptable if a specific case needs it). Run on
  every CI push.
- **Nightly live-integration job:** a small, stable set of queries
  hits real Congress.gov / OpenStates / OpenFEC endpoints and asserts
  that the adapter's normalization still produces the expected
  `Document` / `Entity` shape. Failing this job signals upstream
  schema drift — fail loud, never silently fall back.
- **End-to-end tests:** scripted MCP session spawns the server via
  stdio, uses the `@modelcontextprotocol/sdk` client library to send
  real MCP requests, and asserts tool response shape. Run on every
  CI push.
- **No manual QA.** If Claude can't test it, we don't have it.

---

## When all decisions are final

Once every row above has a **Decided** line, the first Claude Code
session should:

1. Commit this file with the decisions locked in.
2. Begin executing `docs/plans/phase-1-foundation.md` via the
   `superpowers:subagent-driven-development` skill.

## D11 — Detail-tool hydration scope (2026-04-13, LOCKED)

**Decision:** Detail tools (`get_bill`, and future `get_vote`,
`get_contribution`) use per-document freshness via
`documents.fetched_at`, not the `hydrations` table. TTL is the
same 1h recent window used by feed tools. Upstream fetches hit
the per-resource endpoint (e.g. OpenStates
`/bills/{jurisdiction}/{session}/{identifier}`).

**Why:** See R14. Per-jurisdiction freshness cannot represent
"I have this specific bill" — it only tracks "I have this
jurisdiction's recent feed."

**Alternatives rejected:**
- Extend `hydrations` with a per-identifier scope → unbounded
  table growth, complicates eviction.
- Always refetch on every `get_bill` call → hammers upstream,
  breaks rate-limit budget under concurrent MCP clients.

## D12 — Feed tools accept optional `limit` for row-bounded listings (2026-04-14, LOCKED)

**Decision:** Feed tools (starting with `recent_bills` in phase-9a) accept an optional `limit: z.number().int().min(1).max(20).optional()`. When `limit` is set the handler drops the `days`-derived upstream time filter (`updated_since` on OpenStates; widened `fromDateTime` on Congress.gov) so the upstream's native `sort=updated_desc` / `sort=updateDate+desc` surfaces the top-N most recently updated rows regardless of recency. When both `days` and `limit` are set, both apply: `days` constrains the local projection window and `limit` caps the result count. `limit` joins the `withShapedFetch` args bag so distinct values get distinct `fetch_log` rows.

**Why:** See R16. Biennial state legislatures (Montana, Nevada, Texas in off-years) and any jurisdiction between sessions have empty 7-day windows. "Give me the last 20 updated bills" is the right query shape for that case; "give me bills updated since last Tuesday" is not.

**Alternatives rejected:**
- Make `limit` a general-purpose cap but keep `updated_since` → defeats the purpose; the upstream still filters to an empty window.
- Auto-widen `days` when results are empty → silent semantic drift; the cache key would no longer reflect what the caller asked for.
- Add a separate tool for listing → see D13; a distinct tool is only warranted when predicate richness grows past a single optional parameter.

**Amended 2026-04-14 (R18):** The `max(20)` / `max(50)` caps on
bill-listing tool `limit` parameters are removed. Tools now honor
any `limit` value, returning a `requires_confirmation` envelope
(no upstream fetch) for `limit > 500` until the caller passes
`acknowledge_high_cost: true`. Pagination is added to the
OpenStates and Congress.gov bill-listing adapter methods. See R18
in `docs/00-rationale.md` and
`docs/plans/phase-9e-bill-pagination.md`.

## D13 — `list_bills` is a distinct tool from `search_civic_documents` (2026-04-14, LOCKED)

**Decision:** `list_bills` ships as MCP tool #10 rather than
extending `search_civic_documents` with more predicates. Structured
bill-listing queries (by sponsor, subject, classification, session,
date ranges) go through `list_bills`; free-text cross-kind search
stays on `search_civic_documents`.

**Why:** LLM tool-selection accuracy benefits more from verb
clarity ("list bills by predicates" vs "search documents by text")
than it loses from the +1 tool slot. Conflating the two would
require the LLM to know which subset of `search_civic_documents`
inputs produce which kind of projection — a worse affordance than
two tools with distinct names and distinct return shapes.

The audit of 48 realistic civic queries found that bill-listing
queries fall naturally under a single tool name; collapsing them
into `search_civic_documents` degraded model tool-selection in
manual spot-checks more than keeping a clean separation.

**Alternatives rejected:**
- Extend `search_civic_documents` with `sponsor_entity_id`,
  `subject`, `classification`, `session` → overloaded tool surface;
  return shape would have to become a union; text `q` becomes
  optional, which changes the tool's existing contract.
- Add a `bills_listing` flag to `recent_bills` → polymorphic tool;
  same LLM-selection cost, with the added problem of masking the
  time-windowed vs predicate-listing distinction.

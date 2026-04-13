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

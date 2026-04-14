# 00 — Rationale: Roads Not Taken

This doc captures the design choices that were **considered and
rejected** before Phase 1 planning began. It exists to prevent future
re-litigation: when someone proposes "let's add X," check here first to
see whether X was deliberately scoped out.

If you disagree with any of these and want to reopen the decision,
update this file with a new decision entry rather than silently
diverging from the plan.

---

## R1 — Why civic data (and not other Arizona data)?

**Rejected alternatives:**
- "Living in Phoenix" — daily-life assistant combining transit + AQI +
  weather + crime near me + events. Broad but shallow; heavy on
  ephemeral data; competes with existing weather/transit apps.
- "Property intel" — assessor + parcel GIS + zoning + MLS. High value
  for a narrow audience (investors). MLS data requires paid membership
  access; gates the product.
- "Desert outdoors" — trails + parks + wildfire + AQI + water levels.
  Fun but no strong data infrastructure exists; most "APIs" would be
  scraping park websites.

**Chosen:** Civic transparency/awareness. Reasons:
1. The data infrastructure exists and has stable APIs (OpenStates,
   Legistar, Phoenix CKAN).
2. Cross-source entity resolution is the highest-leverage feature —
   every source talks about the same people/orgs. This theme justifies
   the entity graph; other themes don't.
3. Journalist and civic-curious-citizen personas are both well-served
   by the same tools — no theme split.

## R2 — Why "civic awareness" and not "civic transparency"?

"Transparency" names an *obligation* on government (publish data);
"awareness" names an *outcome* for citizens (understand what
government does). Since this MCP is consumed by LLMs helping users
understand civic affairs, the user-outcome framing fits better.

The repo is `civic-awareness-mcp` (aspirational, no geo scope), but
the published npm package per `docs/06-open-decisions.md` D8 will be
`civic-awareness-az` — so a future sibling `civic-awareness-ca` can
exist without renaming this repo.

## R3 — Architecture archetypes considered

Three archetypes were considered during brainstorming:

**A. Follow-the-money spine** — Entity-resolution graph first; tools
like `resolve_person(name)` return a profile linking contributions,
lobbying, filings, mentions.

**B. Document-feed aggregator** — Time-ordered feeds; tools like
`recent_bills`, `upcoming_council_meetings` answer "what's happening?"

**C. Records-request amplifier** — Tools help draft and track public
records requests. Leans into gaps in upstream APIs by making the MCP
useful *because* the data isn't automated.

**Rejected:** Pure A (no discovery surface for LLMs that don't already
know who to ask about). Pure B (no drill-down; just lists). Pure C
(feels more like a lawyering assistant than an information tool;
high-friction; no upstream APIs at all).

**Chosen:** A + B combined, sharing the same entity-tagged event
stream. B tools are the discovery surface; A tools are the
investigation surface. They compose naturally (LLM flows B → A). Both
read from the same store with different projections. See
`docs/02-architecture.md`.

C is not in scope for V1 or V2 but is not foreclosed — a future
adapter could add a "drafting PRRs" surface if there's demand.

## R4 — Two source-integration meta-architectures considered

**Rejected:** "Unified ArcGIS adapter" — a single generic client
speaking ArcGIS FeatureServer, with Phoenix/Maricopa/state layers
pre-registered. This would give us wide coverage fast. Trade-off: every
tool returns similar-shaped GeoJSON, which is poor for LLM reasoning
and doesn't satisfy the entity-graph design.

**Chosen:** "Curated civic domain" — fewer sources, richer per-tool
semantics (e.g., `get_entity(id)` returns a rich Person/Org profile,
not raw GeoJSON). Higher implementation effort per source but much
better LLM ergonomics.

## R5 — Why 10 tools and not 20?

LLM tool-selection accuracy drops noticeably beyond ~15 tools with
similar-sounding names. The five feed tools and five entity tools use
clearly distinct verbs (`recent_X`, `upcoming_X`, `search_X`, `get_X`,
`resolve_X`). If a future source needs a new surface, we extend an
existing tool's input rather than adding a new tool. See
`docs/05-tool-surface.md`.

## R6 — Why SQLite and not Postgres / DuckDB / no-DB?

**Rejected:** No database (adapters query upstream on every tool call).
Too slow, hammers public APIs, unreliable when upstream is down.

**Rejected:** Postgres. Operational overhead (service, migrations,
auth) that buys us nothing at the expected data volume (~10M rows
worst case).

**Rejected:** DuckDB. Strong analytics story but weaker on
write-path (our adapter refresh does lots of small upserts). And
better-sqlite3 is the most mature, synchronous, zero-setup option in
Node.

**Chosen:** SQLite via `better-sqlite3`. One file, zero setup,
synchronous reads (match MCP's request/response model), handles our
data volume indefinitely.

## R7 — Why TypeScript and not Python?

Both official MCP SDKs are first-class. TypeScript was chosen because:
- The schema-heavy adapter and tool code benefits materially from
  compile-time type checks.
- `zod` is the de-facto input-schema tool for TS MCP servers; the
  `.shape` export integrates directly with the SDK.
- Node's `better-sqlite3` is synchronous and mature (Python's sqlite3
  stdlib is sync too, but less ergonomic).

Override is open (`docs/06-open-decisions.md` D1) — Python would not
be a mistake, just a different set of choices downstream.

## R8 — Why out-of-process refresh?

**Rejected:** Background refresh in the same process as the MCP
server. Would make tool latencies non-deterministic and couple failure
modes (an adapter crash kills the LLM's session).

**Chosen:** Refresh via `pnpm refresh` CLI. Operator cron-ables it.
MCP server is read-only from the LLM's perspective. See
`docs/02-architecture.md` "Two design decisions to call out."

## R9 — Why no LLM summarization inside the MCP?

The MCP could synthesize `Document.summary` strings using a smaller
LLM internally. We explicitly chose not to:
1. The LLM consuming the MCP is already a language model; let it
   summarize from the raw data.
2. Adding an internal LLM call makes the MCP non-deterministic,
   harder to test, and introduces an API-key/cost dependency.
3. Hallucination risk compounds: once a summary is persisted to our
   store, every downstream tool call spreads it.

Summaries in our store come from upstream (e.g., OpenStates
`abstracts[0]`) or not at all.

## R10 — Sources we deliberately excluded

Beyond the Tier 1–2 inventory in `docs/03-data-sources.md`:

- **Maricopa Superior Court docket** — public records but aggressive
  rate-limiting, UI-only, licensing ambiguity. High legal risk for
  low marginal value.
- **AZ Corporation Commission eCorp** — no API, hostile scraping
  environment. Deferred until there's specific demand.
- **Lobbyist bulk database** — AZ SoS sells it as a $25 CSV, not an
  API. Not a good fit for a live MCP.
- **Voter rolls** — PII-sensitive. Not a good fit for LLM-consumed
  data.
- **Real-time election results** — event-driven architecture would
  differ from the batch-refresh model of everything else. A different
  product.

## R11 — Scope pivot from Arizona-civic to US-legislative

**Originally decided:** R1 chose civic transparency/awareness as the
domain, and within that V1 was "Arizona statewide legislature" per
`docs/06-open-decisions.md` D2, expanding to Phoenix in V2 (council,
crime, budget). R2 reinforced this with a `civic-awareness-az`
future-package-name plan.

**Revisited on:** 2026-04-12

**New decision:** V1 pivoted to **US-federal + all-50-state
legislative**. V1 adapter set is OpenStates (50 states, was already
planned), Congress.gov (federal legislature, Library of Congress),
and OpenFEC (federal campaign finance). All Arizona- and
Phoenix-specific sources — See The Money, Phoenix Legistar, Phoenix
CKAN, Phoenix OpenGov — are deferred indefinitely and removed from
V1 and V2. The `-az` package-name pattern from R2 is obsolete; the
package is now simply `civic-awareness-mcp` (scope-agnostic).

**Why:**

1. **No dedicated OpenStates MCP exists** (2026-04-12 survey of
   github + MCP registries). The closest-scope competitor,
   `legiscan-mcp` (sh-patterson), uses the commercial LegiScan
   backend instead of free OpenStates, has no federal
   campaign-finance integration, and ships endpoint-wrapper tools
   rather than the feed+entity dual projection. The genuinely novel
   architectural idea in this repo — one entity graph joining
   federal money ↔ Member of Congress ↔ former state legislator ↔
   contributor — has no implementation anywhere, at any scope. That
   moat survives the pivot and in fact gets wider.

2. **Adapter math worked out better than the initial fear.** The
   initial "10× scope" assumption for US-wide was wrong.
   US-federal + 50-state-legislative V1 needs three core adapters
   (OpenStates, Congress.gov, OpenFEC — all free-with-API-key). The
   original AZ-civic V1+V2 combined needed four (OpenStates, See The
   Money, Phoenix Legistar, Phoenix CKAN). Similar total effort;
   different product shape (horizontal vs. vertical).

3. **The federal-API landscape is healthier than at original
   planning.** ProPublica Congress API died. Google Civic
   Representatives API shut down April 2025. But `api.congress.gov`
   (Library of Congress) is now the stable canonical federal source,
   and OpenFEC has been consistent for years. Federal legislative
   and campaign-finance coverage is no longer blocked by
   API-availability concerns.

4. **The architecture was accidentally pre-tuned for US-wide.**
   `Jurisdiction` was already a first-class type in
   `docs/04-entity-schema.md`; the entity graph already parameterizes
   on it; OpenStates already speaks 50 states. The only
   load-bearing doc change triggered by this pivot is flipping D3b
   (per-jurisdiction Person entities → cross-jurisdiction) because
   cross-jurisdiction identity *is* the moat under the new scope.
   Everything else in the doc cascade is cosmetic.

**What this does NOT change:**

- Combined feed (B) + entity (A) architecture (R3)
- SQLite via `better-sqlite3` (R6)
- TypeScript (R7)
- Out-of-process refresh via CLI (R8)
- No MCP-side LLM summarization (R9)
- 10-tool surface
- Three-tier scraping policy framework (all V1 sources happen to be
  Tier 1, but the framework is preserved for future additions)

Downstream doc cascades are recorded in each affected doc's own
revision, not enumerated here.

## R12 — Refresh as an MCP tool alongside the CLI

**Originally decided:** R8 + D5 locked refresh as out-of-process
via `pnpm refresh --source=<name>`. Rationale was server
determinism, predictable latency, and entity-resolution
reproducibility (batch normalization produces a stable graph).

**Revisited on:** 2026-04-13

**New decision:** Refresh remains a batch operation and remains
available via the CLI, but is **additionally** exposed as an MCP
tool, `refresh_source`. The server still does not auto-refresh on
read-tool invocations — every refresh is an explicit, consented,
batch operation. The CLI and the tool are thin wrappers over a
single `refreshSource()` core function.

**Why:**

1. **Onboarding friction.** Under the CLI-only model, a user who
   wires the MCP server into Claude Desktop or Claude Code hits an
   empty-DB wall on their first query. The solution — "open a
   terminal, run `pnpm refresh --source=<name>`, wait, retry" —
   breaks the in-conversation flow that is the whole point of MCP.

2. **The reasons for D5's constraint are preserved.** The server
   is still read-only on the query path (the 8 feed/entity tools).
   Only `refresh_source` writes, and only when the user approves
   the tool call. Entity-resolution reproducibility is not harmed:
   refresh is still a batch normalization pass, the same code as
   the CLI, producing the same entity graph.

3. **MCP consent boundaries align with the design.** In MCP, the
   *tool call* is the consent boundary, not the upstream HTTP
   request. A single `refresh_source` call may fan out to hundreds
   of upstream requests, but the user approves it once with full
   context ("refresh Texas bills" → one prompt → batch runs → done).

4. **Client-allowlist support absorbs the remaining friction for
   trusted users.** Claude Code supports persistent per-tool
   allowlisting via `permissions.allow: ["mcp__civic_awareness__*"]`.
   A user who trusts their own server instance sees zero prompts
   after one config line. Claude Desktop lacks this (issue #24433
   closed NOT PLANNED, 2026-03), so Desktop users will still see a
   per-session prompt for `refresh_source` — but that's one prompt
   per refresh intent, not per upstream request.

**What this does NOT change:**

- `pnpm refresh` CLI continues to work, unchanged from the user's
  perspective. It now calls the same `refreshSource()` function
  the MCP tool does.
- The 8 existing read tools (`recent_bills`, `recent_votes`,
  `recent_contributions`, `search_civic_documents`,
  `search_entities`, `get_entity`, `entity_connections`,
  `resolve_person`) remain pure reads from SQLite. No upstream
  HTTP on the query path.
- Rate-limiting infrastructure in `src/util/http.ts` (per-host
  token bucket, backoff, `Retry-After`) still governs the refresh
  path. A `refresh_source` tool call that hits 429 will back off
  identically to the CLI path.
- Batch resolution (D3b cross-jurisdiction Person) still runs
  post-ingest as part of `refreshSource()`. The entity graph
  produced is identical regardless of trigger (CLI or tool).

**Related work shipped in this phase:**

- Auto-bootstrap on `pnpm start` (Task 3 of
  `docs/plans/phase-5-onboarding-and-refresh-tool.md`). Previously
  deferred to "V2 polish" per D6; promoted because the new
  `refresh_source` flow assumes the DB exists.

## R13 — Transparent pass-through cache: refresh as a cache miss, not a user concern

**Originally decided:** R8 + D5 (as amended by R12) exposed
`refresh_source` as an MCP tool alongside the CLI, making refresh an
explicit, user-visible step. The 8 read tools remained pure reads from
SQLite; an empty store on a fresh install returned empty results with
a hint telling the LLM to call `refresh_source` (or the human to run
the CLI).

**Revisited on:** 2026-04-13

**New decision:** The SQLite store becomes an invisible implementation
detail. Read tools pass through to the upstream APIs transparently,
using the local store as a TTL cache. From the caller's POV there is
no "refresh" concept — they ask, they receive. Cache misses hit
upstream, write through to SQLite, return. Cache hits return local.
TTL-expired entries trigger a fresh upstream fetch on the next read.
Upstream failures (including rate limits exceeded beyond a threshold)
fall back to stale local data with a `stale_notice` sibling field on
the response envelope. `refresh_source` is removed from the MCP tool
surface. The `pnpm refresh` CLI remains for operator use (cron, bulk
seeding, historical backfill) but is no longer part of the
user-facing product.

**Why:**

1. **The DB layer is plumbing, not product.** The value of this MCP
   is connecting LLMs to OpenStates + Congress.gov + OpenFEC with
   entity resolution across all three. The SQLite cache is how we
   make that fast and polite to upstream APIs — not a thing the
   caller needs to reason about. Under R12, every fresh install hit
   an empty-DB wall and required the LLM to make an explicit write
   call before reads worked. That leaked implementation detail into
   the UX.

2. **MCP consent is per tool call, not per HTTP request.** A
   `recent_bills({jurisdiction:"us-tx"})` call that transparently
   triggers an upstream fetch is still one consent boundary. The
   LLM approves "get me Texas bills"; the caller doesn't need to
   know that the server fetched upstream to satisfy that request.
   This matches how every production API cache on earth works
   (read-through with TTL).

3. **Failure modes degrade gracefully.** Under R12, an upstream
   failure during `refresh_source` meant the LLM had to retry the
   refresh tool explicitly. Under R13, upstream failures fall
   through to local data with a `stale_notice` — the caller always
   gets something back, and the staleness is honestly reported.
   Matches the "ask and receive" product posture.

4. **Entity tools can auto-hydrate.** Previously,
   `entity_connections` on a cold jurisdiction returned an empty
   graph. Now, a cold jurisdiction triggers an auto-hydrate bounded
   by `maxPages=5` and a 20s wall-clock deadline, marking `partial`
   if the deadline fires. The graph answers what it can; staleness
   is surfaced via `stale_notice{reason: "partial_hydrate"}`.

**Key parameters (confirmed in pre-plan analysis):**

- **TTL:** `scope="recent"` (feed pulls) = 1h; `scope="full"`
  (entity hydration) = 24h. Keyed per `(source, jurisdiction, scope)`
  to respect OpenStates' 500/day free-tier budget — a global TTL
  would either starve small states or hammer large ones.
- **Rate-limit threshold:** 2.5s. If the per-host token bucket
  would require waiting more than 2.5s to proceed, abort the
  hydrate and serve stale + `stale_notice{reason:"rate_limited"}`.
  Keeps p99 tool latency under the ~5s LLM-caller expectation.
- **Entity hydration bound:** `maxPages=5` AND 20s wall-clock
  deadline. If deadline fires, write what we have, mark
  `partial`, return results + `stale_notice{reason:"partial_hydrate",
  completeness:"active_session_only"}`.
- **Daily budget guard:** `CIVIC_AWARENESS_DAILY_BUDGET` env var
  caps in-session requests per source below upstream hard limits,
  preserving headroom for the CLI and neighbors sharing a key.
- **Singleflight:** concurrent hydrates on the same
  `(source, jurisdiction, scope)` coalesce to one in-flight pull;
  secondary callers await the first. Without this, two parallel
  entity tool calls on `us-tx` would double the rate-limit cost.

**What this does NOT change:**

- The feed (B) + entity (A) dual projection (R3).
- SQLite via `better-sqlite3` (R6) — still the store, with a TTL
  layer on top.
- TypeScript (R7).
- `pnpm refresh` CLI (R8, as amended by R12) — retained for ops
  use, demoted from primary user path.
- No MCP-side LLM summarization (R9).
- Three-tier scraping policy and per-host token bucket (D4) —
  in fact, now load-bearing for pass-through behavior.
- Entity resolution algorithm (D3 / D3b) — unchanged; still runs
  post-ingest as part of the hydrator.
- The 8 read tools' response shapes (backward compatible; the
  optional `stale_notice` field is additive).

**Supersedes:** R12's refresh-as-a-tool conclusion, and the
refresh-as-a-tool portion of
`docs/plans/phase-5-onboarding-and-refresh-tool.md`. The
auto-bootstrap portion of that plan already shipped and is retained.

---

## How to add to this doc

When a decision is revisited and changed, do **not** delete the
original rationale. Add a new section below:

```markdown
## R11 — [Decision being revisited]

**Originally decided:** [summary of the R# above]
**Revisited on:** YYYY-MM-DD
**New decision:** [what changed]
**Why:** [new evidence, new constraint, new insight]
```

This preserves the project's institutional memory.

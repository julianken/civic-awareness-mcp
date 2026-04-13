# 01 — Vision

## What this is

An MCP server that lets an LLM answer questions like:

- "Who's sponsoring HR1234 in the current Congress, and which
  committees has it passed through?"
- "Which current U.S. Senators previously served in their state
  legislatures, and what bills did they sponsor there?"
- "Who are the top donors to members of the House Ways and Means
  Committee, and how does that compare to Energy and Commerce?"
- "What state legislatures passed bills this month mentioning
  'artificial intelligence'?"
- "Track a specific federal candidate's funding — who are the biggest
  contributors, and do any of them also show up as donors to sitting
  legislators in the candidate's home state?"

The MCP abstracts away the fact that these answers require hitting
OpenStates (50 state legislatures), Congress.gov (federal
legislature), and OpenFEC (federal campaign finance) — each with
different auth, rate limits, and data shapes — and presents the LLM
with a small, coherent set of tools bound together by cross-source
entity resolution.

## Who it's for

Three concentric user rings, in priority order:

1. **The author and collaborators** (immediate use). Dogfooding U.S.
   federal and state civic questions in Claude Desktop / claude.ai.
   If it's not useful here, it isn't useful anywhere.
2. **Civic-curious Americans** using an LLM to understand what's
   happening in Congress and in any state legislature — people who
   would never hit `api.congress.gov` by hand but will happily ask an
   LLM a question.
3. **Journalists and researchers** who need fast cross-source lookups
   (federal money ↔ sitting legislators ↔ state-legislature
   histories). These users have the deepest queries and the highest
   bar for correctness and attribution.

The design should never sacrifice ring 1 for ring 3. If a tool is
hard for the author to use, it's hard for everyone.

## What success looks like

**Phase 1 ship criterion** (foundation): scaffolding exists.
`pnpm bootstrap` produces an empty, schema-applied SQLite store; a
one-command test harness passes. No tools are exposed to the LLM yet.

**Phase 2 ship criterion (V1)**: a human can open Claude Desktop
with the MCP installed, type "what bills did the Texas House pass
last week?" (or any other state's chamber), and get an accurate,
properly-sourced answer in a single turn. The same query works for
Arizona, New Hampshire, California, and every other state without
code changes — `jurisdiction` is a runtime parameter.

**Phase 3 ship criterion**: "What federal bills were introduced this
week on immigration?" works. Congress.gov data is in the store and
joined into the same entity graph as the 50-state data — a Senator
who previously served as a state legislator is *one* Person entity
with both roles, not two.

**Phase 4 ship criterion (V1-complete)**: "Who are the top donors to
Senator X, and what committees does she sit on?" works by joining
OpenFEC campaign-finance data into the same entity graph as
Congress.gov and OpenStates.

**Phase 5 ship criterion (V2)**: "Which sitting senators were
previously state legislators, and what bills did they sponsor in
their prior state?" works — cross-jurisdiction entity resolution
answers questions that no existing MCP can.

## Non-goals

- **Not a general civic-data API.** This is an MCP server, consumed
  by LLMs. If you want a REST API, use the upstream APIs directly.
- **Not a replacement for OpenStates, Congress.gov, or OpenFEC.** It
  composes them with local caching and cross-source entity
  resolution. It does not mirror or rehost their data in bulk.
- **Not a real-time firehose.** Freshness target is "within a day"
  for most sources. Election-night realtime is a different product.
- **Not a municipal MCP.** City council matters, local crime data,
  and municipal budget line items are out of scope for V1 and V2. A
  future sibling (e.g., `civic-awareness-municipal-mcp`) could target
  those; this project deliberately does not.
- **Not a state-level campaign-finance MCP.** State finance systems
  are fragmented across 50 different sources; V1 restricts itself to
  OpenFEC (federal money only). State finance is a plausible V3
  direction but explicitly out of V1 and V2.
- **Not an AI-over-AI layer.** No embeddings, no vector search, no
  LLM summarization inside the MCP. Just clean tools. The LLM that
  consumes the MCP does that work.

## Values

- **Correctness > completeness.** Return fewer results that are
  correctly sourced than more results that are sometimes wrong.
- **Provenance everywhere.** Every tool response includes source
  URL(s) so the LLM can cite them.
- **Fail loud.** If Congress.gov or OpenStates is down, the MCP
  returns a clear error, not stale cached data masquerading as fresh.
- **Respect upstreams.** Cache aggressively. Back off on rate limits.
  Do not hammer public civic infrastructure — these are public goods
  maintained by government agencies and nonprofits, and in several
  cases (OpenStates' 500/day free tier) we will share capacity with
  many other civic tools.

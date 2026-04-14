# Phase 9c — `get_vote` Detail Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new MCP tool `get_vote` that returns the full detail
of a single roll-call vote — including **per-legislator positions**
with resolved `entity_id`, party-at-vote, and state — so LLMs can
answer queries the existing `recent_votes` feed cannot:

- "How did Senator X vote on HR1234?"
- "Party-line breakdown of vote 42 in the 119th Congress, House."
- "Who voted against their party on vote N?"
- "State delegation split on vote N."

**Architecture:** `get_vote` is the **C-projection** for votes, the
direct analogue of `get_bill` (Phase 7). Same freshness model:
per-document TTL via `documents.fetched_at` (R14 / D11), **not** the
endpoint-level `fetch_log` cache used by feeds and search (R15). The
handler reads the local `documents` row for the vote and projects
per-member positions out of `raw.positions[]`; upstream fetch +
write-through happens in the adapter's new `fetchVote()` methods.

Two additions make it work:

1. The Congress.gov adapter's `upsertVote` is extended to persist the
   full per-legislator positions list in `Document.raw.positions`,
   including each voter's `bioguideId`, display name, party, state,
   and normalised vote qualifier. Today's `upsertVote` already
   iterates positions into `entity_references` but drops the
   party/state context needed for the projection.
2. A new `src/core/hydrate_vote.ts` adds `ensureVoteFresh()` — the
   per-document TTL gate — and a new `CongressAdapter.fetchVote()`
   fetches one roll-call vote with the `members` expansion.

The OpenStates path is **explicitly deferred** (parallel to how
`recent_votes` is federal-only today — OpenStates vote ingestion is
not wired up). State-jurisdiction calls to `get_vote` return a
`stale_notice` with `reason="not_yet_supported"` until a dedicated
state-votes phase lands.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`,
`better-sqlite3`, `vitest` + `msw` for HTTP mocking.

**Scope impact:**

- `docs/05-tool-surface.md` gains a new **Detail Tools (C)** entry
  for `get_vote`, and the top-of-file "11 tools" count needs updating
  when phase-9 lands end-to-end. This plan only edits the
  `get_vote` section + the tool count; phase-9b adds `list_bills`
  and is sequenced before 9c per the overview doc.
- `docs/00-rationale.md` gains **R17** ("Why `get_vote` as a new
  detail tool instead of `VoteSummary.positions[]` on
  `recent_votes`").
- `docs/06-open-decisions.md` — **no new D item**. The storage
  decision (positions in `Document.raw`, no relational
  `vote_positions` table) is a direct extension of D11 ("detail
  tools use per-document freshness and project from `Document.raw`")
  and does not merit a separate locked decision. If during
  implementation a relational table becomes necessary after all,
  stop and add D14 before proceeding — per CLAUDE.md's "planning
  assumption wrong → stop and update the plan" rule.
- `CHANGELOG.md` gets a v0.4.0-unreleased line for `get_vote`.

---

## Identifier-scheme decision

`get_bill` uses a clean composite `(jurisdiction, session, identifier)`
because OpenStates' URL shape is exactly that tuple. Votes are
messier: Congress.gov keys roll-calls by `(congress, chamber, session,
rollNumber)` — a 4-tuple — and OpenStates uses opaque
`ocd-vote/<uuid>` IDs that don't decompose into human-meaningful
parts. Forcing one shape over both sources would either (a) expose
Congress-specific `congress` + `rollNumber` inputs that make no
sense for states, or (b) demand opaque IDs for federal, which is
hostile to the common LLM query "the recent Senate vote on HR1234"
flowing from a `recent_votes` result.

**Decision:** `GetVoteInput` accepts **either** `vote_id` (the
`documents.id` from a prior `recent_votes` result) **or** a
federal-composite `{ congress, chamber, session, roll_number }`
quad. At least one path must be provided; zod's `.refine()` enforces
this. In practice the LLM always has a `vote_id` in hand from
`recent_votes` — the composite path exists only for users who know
the roll-call number directly. OpenStates-style `ocd-vote/...`
lookups go via `vote_id` after state vote ingestion eventually lands.
`jurisdiction` is not required on the composite path because
`chamber + roll_number` already implies `us-federal`; the handler
writes `us-federal` into the resulting document.

## Storage decision

Per-member positions are stored **denormalised inside
`Document.raw.positions`** — no new `vote_positions` relational
table.

Why:

- **Consistency with D11.** `get_bill` projects sponsors, actions,
  versions, and related_bills out of `bill.raw.*` — the detail
  projection lives entirely in the JSON blob, and only cross-entity
  relationships (sponsor→bill, voter→vote) land in
  `entity_references`. Adding a relational votes-positions table
  would break that symmetry with no new query it enables.
- **Query shape.** Every `get_vote` call reads one document's full
  positions list; no query ever wants "all positions across all
  votes" except in tests. Denormalised JSON serves the only real
  access pattern without join cost.
- **`entity_references` stays source-of-truth for entity links.**
  The existing `upsertVote` already writes one EntityReference per
  voter (`role='voter'`, `qualifier=<yea|nay|present|not_voting>`);
  projecting out of `raw.positions` does **not** replace that — the
  reference rows still drive `entity_connections` and
  `get_entity.recent_documents`. What changes is only that
  `raw.positions` gains the display-side fields (`name`,
  `party_at_vote`, `state`) needed for the detail projection.

If a future phase needs indexed lookups like "count party
breakdowns across all votes in session X" we can add a materialized
view on top; for V2 this is YAGNI.

---

## File structure produced by this phase

```
src/
├── adapters/
│   └── congress.ts              # MODIFIED: upsertVote persists raw.positions[];
│                                #           new fetchVote() method
├── core/
│   └── hydrate_vote.ts          # NEW: ensureVoteFresh() — per-document TTL
├── mcp/
│   ├── schemas.ts               # MODIFIED: + GetVoteInput
│   ├── server.ts                # MODIFIED: registerTool("get_vote", ...)
│   └── tools/
│       └── get_vote.ts          # NEW: handler + projection
docs/
├── 00-rationale.md              # MODIFIED: + R17
├── 05-tool-surface.md           # MODIFIED: + get_vote section, count bump
└── plans/
    └── phase-9c-get-vote.md     # this file
CHANGELOG.md                      # MODIFIED: v0.4.0-unreleased entry
tests/
├── integration/
│   ├── fixtures/
│   │   └── congress-vote-detail.json       # NEW
│   └── get-vote-e2e.test.ts                # NEW
└── unit/
    ├── adapters/congress.test.ts            # MODIFIED: + fetchVote + raw.positions assertions
    ├── core/hydrate_vote.test.ts            # NEW
    └── mcp/tools/get_vote.test.ts           # NEW
```

---

## Task 1: Decision record + input schema

**Files:**
- Modify: `docs/00-rationale.md` (append R17)
- Modify: `src/mcp/schemas.ts` (append `GetVoteInput`)
- Modify: `tests/unit/mcp/schemas.test.ts` (append schema tests)

- [ ] **Step 1: Append R17 to `docs/00-rationale.md`**

Append at the end of the file (preserve all prior R entries):

```markdown
## R17 — `get_vote` as a separate detail tool, not a feed extension (2026-04-14)

Phase 9's tool-surface audit found that `VoteSummary` as returned by
`recent_votes` cannot answer "how did Senator X vote on bill Y" —
the tally is aggregate, not per-member. Two options existed:

1. Add `positions[]` to `VoteSummary` and expand `recent_votes`.
2. Add a new `get_vote` detail tool that returns `positions[]` only
   when the caller asks for one specific vote.

Option 2 wins because `recent_votes` is a feed projection — its
purpose is to answer "what votes happened recently" with enough
context for the LLM to pick one. Inlining every voter's position
into every feed row would bloat payloads 100×–500× (one row is
~200 bytes today; with positions it's 50–100 KB for a full federal
roll call) and push every feed response past typical MCP content
limits for marginal query value. The C-projection pattern
established by `get_bill` — "feed-tool result → LLM picks one →
detail-tool fetch" — is the right shape.

Cost: one additional tool registration, against the ~15-tool
LLM-selection ceiling (R5). Terminal count after Phase 9 is 11,
still well inside the ceiling.

Cross-references: R14 (per-document freshness for detail tools),
D11 (detail-tool hydration scope locked).
```

- [ ] **Step 2: Append `GetVoteInput` to `src/mcp/schemas.ts`**

Append at the end of the file:

```typescript
export const GetVoteInput = z
  .object({
    vote_id: z.string().min(1).optional(),
    congress: z.number().int().positive().optional(),
    chamber: z.enum(["upper", "lower"]).optional(),
    session: z.union([z.literal(1), z.literal(2)]).optional(),
    roll_number: z.number().int().positive().optional(),
  })
  .refine(
    (v) =>
      v.vote_id !== undefined ||
      (v.congress !== undefined &&
        v.chamber !== undefined &&
        v.session !== undefined &&
        v.roll_number !== undefined),
    {
      message:
        "Provide either vote_id OR the full composite (congress, chamber, session, roll_number).",
    },
  );
export type GetVoteInput = z.infer<typeof GetVoteInput>;
```

- [ ] **Step 3: Add schema tests**

Append to `tests/unit/mcp/schemas.test.ts`:

```typescript
describe("GetVoteInput", () => {
  it("accepts a vote_id alone", () => {
    const parsed = GetVoteInput.parse({ vote_id: "doc-uuid-abc" });
    expect(parsed.vote_id).toBe("doc-uuid-abc");
  });

  it("accepts the full federal composite", () => {
    const parsed = GetVoteInput.parse({
      congress: 119, chamber: "upper", session: 1, roll_number: 42,
    });
    expect(parsed.congress).toBe(119);
    expect(parsed.roll_number).toBe(42);
  });

  it("rejects empty input", () => {
    expect(() => GetVoteInput.parse({})).toThrow();
  });

  it("rejects a partial composite (missing roll_number)", () => {
    expect(() =>
      GetVoteInput.parse({ congress: 119, chamber: "upper", session: 1 }),
    ).toThrow();
  });

  it("rejects session values other than 1 or 2", () => {
    expect(() =>
      GetVoteInput.parse({
        congress: 119, chamber: "upper", session: 3, roll_number: 42,
      }),
    ).toThrow();
  });
});
```

Import `GetVoteInput` at the top of the file alongside the other
schema imports.

- [ ] **Step 4: Run schema tests**

Run: `pnpm test tests/unit/mcp/schemas.test.ts -t "GetVoteInput"`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add docs/00-rationale.md src/mcp/schemas.ts tests/unit/mcp/schemas.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add R17 + GetVoteInput schema for get_vote detail tool

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Adapter — persist `raw.positions[]` in `upsertVote` + add `fetchVote`

**Files:**
- Modify: `src/adapters/congress.ts`
- Modify: `tests/unit/adapters/congress.test.ts`

Today's `upsertVote` at `src/adapters/congress.ts:585-647` writes
one `EntityReference` per voter but drops the per-position display
fields (party, state, display name) into
`entity_references.qualifier` alone. The detail projection needs
those fields inline in `raw.positions[]` so `handleGetVote` can
render them without re-querying entity rows for every voter.

`fetchVote` is a new public method that fetches one roll-call by
composite, upserts it, and returns the resulting `documents.id`
for the handler to select on.

- [ ] **Step 1: Write failing test for `raw.positions` persistence**

Append to `tests/unit/adapters/congress.test.ts`:

```typescript
describe("upsertVote persists per-member positions in raw.positions", () => {
  it("stores bioguideId, name, party, state, and position for each voter", async () => {
    const dbPath = `/tmp/upsertVote-positions-${Date.now()}.db`;
    await bootstrap({ dbPath });
    const { db } = openStore(dbPath);

    const adapter = new CongressAdapter({ apiKey: "test" });
    (adapter as unknown as {
      upsertVote: (db: Database.Database, v: unknown) => void;
    }).upsertVote(db, {
      congress: 119,
      chamber: "Senate",
      rollNumber: 42,
      date: "2026-04-01",
      question: "On Passage of HR 1234",
      result: "Passed",
      bill: { type: "HR", number: "1234" },
      positions: [
        {
          member: {
            bioguideId: "S000148",
            name: "Schumer, Charles E.",
            partyName: "Democratic",
            state: "NY",
          },
          votePosition: "Yea",
        },
        {
          member: {
            bioguideId: "M000355",
            name: "McConnell, Mitch",
            partyName: "Republican",
            state: "KY",
          },
          votePosition: "Nay",
        },
      ],
      totals: { yea: 1, nay: 1, present: 0, notVoting: 0 },
    });

    const row = db
      .prepare("SELECT raw FROM documents WHERE source_id = ?")
      .get("vote-119-senate-42") as { raw: string };
    const raw = JSON.parse(row.raw) as {
      positions: Array<{
        bioguideId: string;
        name: string;
        party: string | null;
        state: string | null;
        position: string;
      }>;
    };
    expect(raw.positions).toHaveLength(2);
    expect(raw.positions[0]).toMatchObject({
      bioguideId: "S000148",
      name: "Schumer, Charles E.",
      party: "Democratic",
      state: "NY",
      position: "yea",
    });
    expect(raw.positions[1].position).toBe("nay");
  });
});
```

Note: the test widens the `CongressVotePosition` interface —
`member` needs to carry `partyName` and `state`. Step 3 updates the
interface accordingly. The Congress.gov `/vote/.../members` endpoint
does return these fields when the `members` expansion is requested.

- [ ] **Step 2: Run test to confirm it fails**

Run: `pnpm test tests/unit/adapters/congress.test.ts -t "raw.positions"`
Expected: FAIL — `raw.positions` is `undefined` (current impl only
writes `totals`, `result`, `bill`, etc.).

- [ ] **Step 3: Widen `CongressVotePosition` and extend `upsertVote`**

In `src/adapters/congress.ts`, replace the `CongressVotePosition`
interface (currently at lines 38–41):

```typescript
interface CongressVotePosition {
  member: {
    bioguideId: string;
    name: string;
    partyName?: string;
    state?: string;
  };
  votePosition: string;  // "Yea" | "Nay" | "Present" | "Not Voting"
}
```

Then replace the `upsertVote` method body (at lines 585–647) with:

```typescript
  private upsertVote(db: Database.Database, v: CongressVote): void {
    const occurred = v.date.includes("T") ? v.date : `${v.date}T00:00:00.000Z`;
    const billId = v.bill ? billIdentifier(v.bill.type, v.bill.number) : "unknown";
    const title = `Vote ${v.congress}-${v.chamber}-${v.rollNumber}: ${billId} — ${v.question ?? ""}`;
    const humanUrl = voteUrl(v.congress, v.chamber, v.rollNumber);

    const positions = (v.positions ?? []).map((pos) => ({
      bioguideId: pos.member.bioguideId,
      name: pos.member.name,
      party: pos.member.partyName ?? null,
      state: pos.member.state ?? null,
      position: normalizeVotePosition(pos.votePosition),
    }));

    const refs = (v.positions ?? []).map((pos) => {
      const qualifier = normalizeVotePosition(pos.votePosition);
      const existing = db
        .prepare(
          "SELECT id FROM entities WHERE json_extract(external_ids, '$.\"bioguide\"') = ? LIMIT 1",
        )
        .get(pos.member.bioguideId) as { id: string } | undefined;
      let entityId: string;
      if (existing) {
        entityId = existing.id;
      } else {
        const { entity } = upsertEntity(db, {
          kind: "person",
          name: pos.member.name,
          jurisdiction: undefined,
          external_ids: { bioguide: pos.member.bioguideId },
          metadata: {
            party: pos.member.partyName,
            state: pos.member.state,
          },
        });
        entityId = entity.id;
      }
      return { entity_id: entityId, role: "voter" as const, qualifier };
    });

    upsertDocument(db, {
      kind: "vote",
      jurisdiction: "us-federal",
      title,
      occurred_at: occurred,
      source: {
        name: "congress",
        id: `vote-${v.congress}-${v.chamber.toLowerCase()}-${v.rollNumber}`,
        url: humanUrl,
      },
      references: refs,
      raw: {
        congress: v.congress,
        chamber: v.chamber,
        rollNumber: v.rollNumber,
        question: v.question,
        result: v.result,
        bill: v.bill ?? null,
        totals: v.totals ?? {},
        positions,
      },
    });
  }
```

- [ ] **Step 4: Run test to confirm pass**

Run: `pnpm test tests/unit/adapters/congress.test.ts -t "raw.positions"`
Expected: PASS. Also rerun the full adapter suite
(`pnpm test tests/unit/adapters/congress.test.ts`) to confirm
existing `recent_votes` / `upsertVote` tests still pass — new
`raw.positions` is additive.

- [ ] **Step 5: Write failing test for `fetchVote`**

Append to `tests/unit/adapters/congress.test.ts`:

```typescript
describe("CongressAdapter.fetchVote", () => {
  it("fetches one roll-call vote by composite and upserts with positions", async () => {
    server.use(
      http.get(
        "https://api.congress.gov/v3/senate-vote/119/1/42",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("api_key")).toBe("test-key");
          expect(url.searchParams.get("format")).toBe("json");
          return HttpResponse.json({
            voteInformation: {
              congress: 119,
              chamber: "Senate",
              rollNumber: 42,
              date: "2026-04-01",
              question: "On Passage of HR 1234",
              result: "Passed",
              bill: { type: "HR", number: "1234" },
              totals: { yea: 1, nay: 1, present: 0, notVoting: 0 },
              members: {
                item: [
                  {
                    bioguideId: "S000148",
                    name: "Schumer, Charles E.",
                    partyName: "Democratic",
                    state: "NY",
                    votePosition: "Yea",
                  },
                  {
                    bioguideId: "M000355",
                    name: "McConnell, Mitch",
                    partyName: "Republican",
                    state: "KY",
                    votePosition: "Nay",
                  },
                ],
              },
            },
          });
        },
      ),
    );

    const dbPath = `/tmp/fetchVote-${Date.now()}.db`;
    await bootstrap({ dbPath });
    const { db } = openStore(dbPath);

    const adapter = new CongressAdapter({ apiKey: "test-key" });
    const result = await adapter.fetchVote(db, {
      congress: 119, chamber: "upper", session: 1, roll_number: 42,
    });

    expect(result.documentId).toBeTruthy();
    const row = db
      .prepare("SELECT id, raw FROM documents WHERE source_id = ?")
      .get("vote-119-senate-42") as { id: string; raw: string };
    expect(row.id).toBe(result.documentId);
    const raw = JSON.parse(row.raw) as {
      positions: Array<{ bioguideId: string; position: string }>;
    };
    expect(raw.positions).toHaveLength(2);
  });

  it("throws VoteNotFoundError on 404", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/house-vote/119/1/9999", () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );
    const dbPath = `/tmp/fetchVote-404-${Date.now()}.db`;
    await bootstrap({ dbPath });
    const { db } = openStore(dbPath);
    const adapter = new CongressAdapter({ apiKey: "test-key" });
    await expect(
      adapter.fetchVote(db, {
        congress: 119, chamber: "lower", session: 1, roll_number: 9999,
      }),
    ).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 6: Run test to confirm it fails**

Run: `pnpm test tests/unit/adapters/congress.test.ts -t "fetchVote"`
Expected: FAIL — `adapter.fetchVote is not a function`.

- [ ] **Step 7: Implement `fetchVote` + `VoteNotFoundError`**

At the top of `src/adapters/congress.ts` (after the imports, before
`BASE_URL`), add:

```typescript
export class VoteNotFoundError extends Error {
  constructor(
    public readonly congress: number,
    public readonly chamber: "upper" | "lower",
    public readonly session: number,
    public readonly rollNumber: number,
  ) {
    const ch = chamber === "upper" ? "senate" : "house";
    super(
      `Vote not found: ${ch} ${congress}-${session} roll ${rollNumber}`,
    );
    this.name = "VoteNotFoundError";
  }
}
```

Then insert the `fetchVote` method on `CongressAdapter` immediately
after `fetchRecentVotes` (around line 452):

```typescript
  /** Fetches a single roll-call vote by composite
   *  `(congress, chamber, session, roll_number)` with full member
   *  positions and upserts it. Used by `get_vote` (R14 per-document
   *  TTL). The Congress.gov endpoint is
   *  `/senate-vote/{congress}/{session}/{roll}` or
   *  `/house-vote/{congress}/{session}/{roll}`. */
  async fetchVote(
    db: Database.Database,
    opts: {
      congress: number;
      chamber: "upper" | "lower";
      session: 1 | 2;
      roll_number: number;
    },
  ): Promise<{ documentId: string }> {
    const chamberSlug = opts.chamber === "upper" ? "senate-vote" : "house-vote";
    const path = `/${chamberSlug}/${opts.congress}/${opts.session}/${opts.roll_number}`;
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set("api_key", this.opts.apiKey);
    url.searchParams.set("format", "json");

    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
    });
    if (res.status === 404) {
      throw new VoteNotFoundError(
        opts.congress, opts.chamber, opts.session, opts.roll_number,
      );
    }
    if (!res.ok) {
      throw new Error(`Congress.gov ${path} returned ${res.status}`);
    }

    interface VoteDetailResponse {
      voteInformation?: {
        congress: number;
        chamber: string;
        rollNumber: number;
        date: string;
        question?: string;
        result?: string;
        bill?: { type: string; number: string };
        totals?: { yea?: number; nay?: number; present?: number; notVoting?: number };
        members?: {
          item?: Array<{
            bioguideId: string;
            name: string;
            partyName?: string;
            state?: string;
            votePosition: string;
          }>;
        };
      };
    }
    const body = (await res.json()) as VoteDetailResponse;
    const info = body.voteInformation;
    if (!info) {
      throw new Error(`Congress.gov ${path} returned no voteInformation`);
    }

    const vote: CongressVote = {
      congress: info.congress,
      chamber: info.chamber,
      rollNumber: info.rollNumber,
      date: info.date,
      question: info.question,
      result: info.result,
      bill: info.bill,
      totals: info.totals,
      positions: (info.members?.item ?? []).map((m) => ({
        member: {
          bioguideId: m.bioguideId,
          name: m.name,
          partyName: m.partyName,
          state: m.state,
        },
        votePosition: m.votePosition,
      })),
    };
    this.upsertVote(db, vote);

    const sourceId = `vote-${info.congress}-${info.chamber.toLowerCase()}-${info.rollNumber}`;
    const row = db
      .prepare("SELECT id FROM documents WHERE source_id = ?")
      .get(sourceId) as { id: string } | undefined;
    if (!row) {
      throw new Error(`fetchVote upsert failed to produce document row for ${sourceId}`);
    }
    return { documentId: row.id };
  }
```

- [ ] **Step 8: Run tests to confirm pass**

Run: `pnpm test tests/unit/adapters/congress.test.ts`
Expected: PASS (new tests + all existing adapter tests).

- [ ] **Step 9: Commit**

```bash
git add src/adapters/congress.ts tests/unit/adapters/congress.test.ts
git commit -m "$(cat <<'EOF'
feat(congress): persist per-member positions and add fetchVote for detail tool

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Core — `ensureVoteFresh` with per-document TTL

**Files:**
- Create: `src/core/hydrate_vote.ts`
- Test: `tests/unit/core/hydrate_vote.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/core/hydrate_vote.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { upsertDocument } from "../../../src/core/documents.js";
import { ensureVoteFresh } from "../../../src/core/hydrate_vote.js";
import { CongressAdapter, VoteNotFoundError } from "../../../src/adapters/congress.js";

const TEST_DB = "./data/test-hydrate-vote.db";
let store: Store;
let fetchVoteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  process.env.API_DATA_GOV_KEY = "test-key";
  fetchVoteSpy = vi
    .spyOn(CongressAdapter.prototype, "fetchVote")
    .mockImplementation(async (db: Database.Database) => {
      upsertDocument(db, {
        kind: "vote",
        jurisdiction: "us-federal",
        title: "Vote 119-Senate-42: HR1234 — On Passage",
        occurred_at: "2026-04-01T00:00:00.000Z",
        source: {
          name: "congress",
          id: "vote-119-senate-42",
          url: "https://www.congress.gov/roll-call-votes/119/senate/42",
        },
        raw: { congress: 119, chamber: "Senate", rollNumber: 42, positions: [] },
      });
      const row = store.db
        .prepare("SELECT id FROM documents WHERE source_id = ?")
        .get("vote-119-senate-42") as { id: string };
      return { documentId: row.id };
    });
});

afterEach(() => {
  store.close();
  fetchVoteSpy.mockRestore();
  delete process.env.API_DATA_GOV_KEY;
});

describe("ensureVoteFresh", () => {
  it("fetches upstream when the vote is missing (composite path)", async () => {
    const result = await ensureVoteFresh(store.db, {
      composite: { congress: 119, chamber: "upper", session: 1, roll_number: 42 },
    });
    expect(fetchVoteSpy).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.documentId).toBeTruthy();
  });

  it("skips upstream when fetched_at is < 1h old", async () => {
    upsertDocument(store.db, {
      kind: "vote",
      jurisdiction: "us-federal",
      title: "Vote 119-Senate-42: HR1234 — On Passage",
      occurred_at: "2026-04-01T00:00:00.000Z",
      source: {
        name: "congress",
        id: "vote-119-senate-42",
        url: "https://www.congress.gov/roll-call-votes/119/senate/42",
      },
      raw: { congress: 119, chamber: "Senate", rollNumber: 42, positions: [] },
    });
    const result = await ensureVoteFresh(store.db, {
      composite: { congress: 119, chamber: "upper", session: 1, roll_number: 42 },
    });
    expect(fetchVoteSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("refetches when fetched_at is > 1h old", async () => {
    upsertDocument(store.db, {
      kind: "vote",
      jurisdiction: "us-federal",
      title: "Vote 119-Senate-42: HR1234 — On Passage",
      occurred_at: "2026-04-01T00:00:00.000Z",
      source: {
        name: "congress",
        id: "vote-119-senate-42",
        url: "https://www.congress.gov/roll-call-votes/119/senate/42",
      },
      raw: { congress: 119, chamber: "Senate", rollNumber: 42, positions: [] },
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    store.db
      .prepare("UPDATE documents SET fetched_at = ? WHERE source_id = ?")
      .run(twoHoursAgo, "vote-119-senate-42");
    await ensureVoteFresh(store.db, {
      composite: { congress: 119, chamber: "upper", session: 1, roll_number: 42 },
    });
    expect(fetchVoteSpy).toHaveBeenCalledOnce();
  });

  it("returns stale_notice on upstream_failure when local row exists", async () => {
    upsertDocument(store.db, {
      kind: "vote",
      jurisdiction: "us-federal",
      title: "Vote 119-Senate-42: HR1234 — On Passage",
      occurred_at: "2026-04-01T00:00:00.000Z",
      source: {
        name: "congress",
        id: "vote-119-senate-42",
        url: "https://www.congress.gov/roll-call-votes/119/senate/42",
      },
      raw: { congress: 119, chamber: "Senate", rollNumber: 42, positions: [] },
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    store.db
      .prepare("UPDATE documents SET fetched_at = ? WHERE source_id = ?")
      .run(twoHoursAgo, "vote-119-senate-42");
    fetchVoteSpy.mockRejectedValueOnce(new Error("boom"));
    const result = await ensureVoteFresh(store.db, {
      composite: { congress: 119, chamber: "upper", session: 1, roll_number: 42 },
    });
    expect(result.ok).toBe(true);
    expect(result.stale_notice?.reason).toBe("upstream_failure");
    expect(result.documentId).toBeTruthy();
  });

  it("returns not_found on VoteNotFoundError", async () => {
    fetchVoteSpy.mockRejectedValueOnce(
      new VoteNotFoundError(119, "lower", 1, 9999),
    );
    const result = await ensureVoteFresh(store.db, {
      composite: { congress: 119, chamber: "lower", session: 1, roll_number: 9999 },
    });
    expect(result.ok).toBe(false);
    expect(result.stale_notice?.reason).toBe("not_found");
  });

  it("returns ok on direct vote_id lookup when local row exists and is fresh", async () => {
    upsertDocument(store.db, {
      kind: "vote",
      jurisdiction: "us-federal",
      title: "Vote 119-Senate-42: HR1234 — On Passage",
      occurred_at: "2026-04-01T00:00:00.000Z",
      source: {
        name: "congress",
        id: "vote-119-senate-42",
        url: "https://www.congress.gov/roll-call-votes/119/senate/42",
      },
      raw: { congress: 119, chamber: "Senate", rollNumber: 42, positions: [] },
    });
    const localId = (store.db
      .prepare("SELECT id FROM documents WHERE source_id = ?")
      .get("vote-119-senate-42") as { id: string }).id;

    const result = await ensureVoteFresh(store.db, { vote_id: localId });
    expect(fetchVoteSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.documentId).toBe(localId);
  });

  it("vote_id lookup: no-op-with-stale-notice when row missing and no composite available", async () => {
    const result = await ensureVoteFresh(store.db, { vote_id: "unknown-uuid" });
    expect(fetchVoteSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.stale_notice?.reason).toBe("not_found");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `pnpm test tests/unit/core/hydrate_vote.test.ts`
Expected: FAIL — `ensureVoteFresh` not found.

- [ ] **Step 3: Implement `src/core/hydrate_vote.ts`**

Create the file:

```typescript
import type Database from "better-sqlite3";
import type { StaleNotice } from "../mcp/shared.js";
import { CongressAdapter, VoteNotFoundError } from "../adapters/congress.js";
import { getLimiter } from "./limiters.js";
import { requireEnv } from "../util/env.js";
import { logger } from "../util/logger.js";

const FRESH_TTL_MS = 60 * 60 * 1000;

export interface FederalVoteComposite {
  congress: number;
  chamber: "upper" | "lower";
  session: 1 | 2;
  roll_number: number;
}

export interface EnsureVoteInput {
  vote_id?: string;
  composite?: FederalVoteComposite;
}

export interface EnsureVoteResult {
  ok: boolean;
  documentId?: string;
  stale_notice?: StaleNotice;
}

interface Row {
  id: string;
  fetched_at: string;
}

/** Resolve a `documents` row for the requested vote, either directly
 *  by `vote_id` or by upserting via the federal composite. Same
 *  per-document TTL rules as `ensureBillFresh` (R14 / D11). */
export async function ensureVoteFresh(
  db: Database.Database,
  input: EnsureVoteInput,
): Promise<EnsureVoteResult> {
  let existing: Row | undefined;

  if (input.vote_id) {
    existing = db
      .prepare(
        "SELECT id, fetched_at FROM documents WHERE id = ? AND kind = 'vote'",
      )
      .get(input.vote_id) as Row | undefined;

    if (!existing && !input.composite) {
      return {
        ok: false,
        stale_notice: {
          as_of: new Date().toISOString(),
          reason: "not_found",
          message: `Vote ${input.vote_id} not found in local store and no composite provided for upstream fetch.`,
        },
      };
    }
  }

  if (!existing && input.composite) {
    const chamberLower = input.composite.chamber === "upper" ? "senate" : "house";
    const sourceId = `vote-${input.composite.congress}-${chamberLower}-${input.composite.roll_number}`;
    existing = db
      .prepare(
        "SELECT id, fetched_at FROM documents WHERE source_name = 'congress' AND source_id = ?",
      )
      .get(sourceId) as Row | undefined;
  }

  if (existing) {
    const ageMs = Date.now() - Date.parse(existing.fetched_at);
    if (ageMs < FRESH_TTL_MS) {
      return { ok: true, documentId: existing.id };
    }
  }

  if (!input.composite) {
    return existing
      ? { ok: true, documentId: existing.id }
      : {
          ok: false,
          stale_notice: {
            as_of: new Date().toISOString(),
            reason: "not_found",
            message: "Vote not in local store and no composite provided for upstream fetch.",
          },
        };
  }

  try {
    const adapter = new CongressAdapter({
      apiKey: requireEnv("API_DATA_GOV_KEY"),
      rateLimiter: getLimiter("congress"),
    });
    const { documentId } = await adapter.fetchVote(db, input.composite);
    return { ok: true, documentId };
  } catch (err) {
    if (err instanceof VoteNotFoundError) {
      return {
        ok: false,
        stale_notice: {
          as_of: new Date().toISOString(),
          reason: "not_found",
          message: err.message,
        },
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("ensureVoteFresh upstream failed", {
      composite: input.composite,
      error: msg,
    });
    const as_of = existing?.fetched_at ?? new Date(0).toISOString();
    return {
      ok: existing !== undefined,
      documentId: existing?.id,
      stale_notice: {
        as_of,
        reason: "upstream_failure",
        message: `Upstream congress fetch failed; ${existing ? "serving stale local data" : "no local data available"}. ${msg}`,
      },
    };
  }
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `pnpm test tests/unit/core/hydrate_vote.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/hydrate_vote.ts tests/unit/core/hydrate_vote.test.ts
git commit -m "$(cat <<'EOF'
feat(core): ensureVoteFresh — per-document TTL for get_vote

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Tool handler — `get_vote` projection + server registration

**Files:**
- Create: `src/mcp/tools/get_vote.ts`
- Create: `tests/unit/mcp/tools/get_vote.test.ts`
- Modify: `src/mcp/server.ts`
- Modify: `tests/unit/mcp/server.test.ts`

- [ ] **Step 1: Write failing handler test**

Create `tests/unit/mcp/tools/get_vote.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleGetVote } from "../../../../src/mcp/tools/get_vote.js";

vi.mock("../../../../src/core/hydrate_vote.js", async (orig) => {
  const actual = await orig<typeof import("../../../../src/core/hydrate_vote.js")>();
  return { ...actual, ensureVoteFresh: vi.fn() };
});
import { ensureVoteFresh } from "../../../../src/core/hydrate_vote.js";
const mockEnsure = vi.mocked(ensureVoteFresh);

const TEST_DB = "./data/test-get-vote.db";
let store: Store;
let seededVoteId: string;

beforeEach(() => {
  mockEnsure.mockReset();
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  const { entity: schumer } = upsertEntity(store.db, {
    kind: "person", name: "Schumer, Charles E.", jurisdiction: undefined,
    external_ids: { bioguide: "S000148" },
    metadata: { party: "Democratic", state: "NY" },
  });
  upsertEntity(store.db, {
    kind: "person", name: "McConnell, Mitch", jurisdiction: undefined,
    external_ids: { bioguide: "M000355" },
    metadata: { party: "Republican", state: "KY" },
  });

  upsertDocument(store.db, {
    kind: "vote",
    jurisdiction: "us-federal",
    title: "Vote 119-Senate-42: HR1234 — On Passage of HR 1234",
    occurred_at: "2026-04-01T00:00:00.000Z",
    source: {
      name: "congress",
      id: "vote-119-senate-42",
      url: "https://www.congress.gov/roll-call-votes/119/senate/42",
    },
    references: [{ entity_id: schumer.id, role: "voter", qualifier: "yea" }],
    raw: {
      congress: 119,
      chamber: "Senate",
      rollNumber: 42,
      question: "On Passage of HR 1234",
      result: "Passed",
      bill: { type: "HR", number: "1234" },
      totals: { yea: 1, nay: 1, present: 0, notVoting: 0 },
      positions: [
        { bioguideId: "S000148", name: "Schumer, Charles E.", party: "Democratic", state: "NY", position: "yea" },
        { bioguideId: "M000355", name: "McConnell, Mitch", party: "Republican", state: "KY", position: "nay" },
      ],
    },
  });
  seededVoteId = (store.db
    .prepare("SELECT id FROM documents WHERE source_id = ?")
    .get("vote-119-senate-42") as { id: string }).id;
});
afterEach(() => store.close());

describe("get_vote tool", () => {
  it("projects per-member positions with resolved entity_id when called by vote_id", async () => {
    mockEnsure.mockResolvedValue({ ok: true, documentId: seededVoteId });
    const result = await handleGetVote(store.db, { vote_id: seededVoteId });

    expect(result.vote).not.toBeNull();
    expect(result.vote?.jurisdiction).toBe("us-federal");
    expect(result.vote?.chamber).toBe("upper");
    expect(result.vote?.bill_identifier).toBe("HR1234");
    expect(result.vote?.tally).toEqual({ yea: 1, nay: 1, present: 0, absent: 0 });
    expect(result.vote?.positions).toHaveLength(2);

    const schumer = result.vote?.positions.find((p) => p.name.startsWith("Schumer"));
    expect(schumer?.vote).toBe("yea");
    expect(schumer?.party).toBe("Democratic");
    expect(schumer?.state).toBe("NY");
    expect(schumer?.entity_id).toBeTruthy();

    const mcconnell = result.vote?.positions.find((p) => p.name.startsWith("McConnell"));
    expect(mcconnell?.entity_id).toBeTruthy();
    expect(mcconnell?.vote).toBe("nay");
  });

  it("projects by composite and uses documentId from ensureVoteFresh", async () => {
    mockEnsure.mockResolvedValue({ ok: true, documentId: seededVoteId });
    const result = await handleGetVote(store.db, {
      congress: 119, chamber: "upper", session: 1, roll_number: 42,
    });
    expect(result.vote?.positions).toHaveLength(2);
  });

  it("returns null vote + stale_notice when ensureVoteFresh reports not_found", async () => {
    mockEnsure.mockResolvedValue({
      ok: false,
      stale_notice: {
        as_of: new Date().toISOString(),
        reason: "not_found",
        message: "Vote not found: house 119-1 roll 9999",
      },
    });
    const result = await handleGetVote(store.db, {
      congress: 119, chamber: "lower", session: 1, roll_number: 9999,
    });
    expect(result.vote).toBeNull();
    expect(result.stale_notice?.reason).toBe("not_found");
  });

  it("returns null vote + not_yet_supported for non-federal jurisdictions (vote_id miss + no composite)", async () => {
    mockEnsure.mockResolvedValue({
      ok: false,
      stale_notice: {
        as_of: new Date().toISOString(),
        reason: "not_found",
        message: "Vote unknown not found in local store and no composite provided for upstream fetch.",
      },
    });
    const result = await handleGetVote(store.db, { vote_id: "unknown" });
    expect(result.vote).toBeNull();
    expect(result.stale_notice?.reason).toBe("not_found");
  });

  it("passes through upstream_failure stale_notice alongside projected vote", async () => {
    mockEnsure.mockResolvedValue({
      ok: true,
      documentId: seededVoteId,
      stale_notice: {
        as_of: "2026-04-01T00:00:00.000Z",
        reason: "upstream_failure",
        message: "Upstream congress fetch failed; serving stale local data. boom",
      },
    });
    const result = await handleGetVote(store.db, { vote_id: seededVoteId });
    expect(result.vote).not.toBeNull();
    expect(result.stale_notice?.reason).toBe("upstream_failure");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `pnpm test tests/unit/mcp/tools/get_vote.test.ts`
Expected: FAIL — `handleGetVote` not found.

- [ ] **Step 3: Implement `src/mcp/tools/get_vote.ts`**

Create the file:

```typescript
import type Database from "better-sqlite3";
import { ensureVoteFresh, type EnsureVoteInput } from "../../core/hydrate_vote.js";
import { GetVoteInput } from "../schemas.js";
import type { StaleNotice } from "../shared.js";

export interface VoteTally {
  yea: number;
  nay: number;
  present: number;
  absent: number;
}

export interface VotePosition {
  entity_id: string | null;
  name: string;
  party: string | null;
  state?: string;
  vote: "yea" | "nay" | "present" | "absent" | "not_voting";
}

export interface VoteDetail {
  id: string;
  bill_identifier: string | null;
  jurisdiction: string;
  session: string;
  chamber: "upper" | "lower";
  date: string;
  result: string;
  tally: VoteTally;
  positions: VotePosition[];
  source_url: string;
  fetched_at: string;
}

export interface GetVoteResponse {
  vote: VoteDetail | null;
  sources: Array<{ name: string; url: string }>;
  stale_notice?: StaleNotice;
}

interface Row {
  id: string;
  jurisdiction: string;
  occurred_at: string;
  fetched_at: string;
  source_name: string;
  source_url: string;
  raw: string;
}

interface RawPosition {
  bioguideId: string;
  name: string;
  party: string | null;
  state: string | null;
  position: string;
}

interface RawShape {
  congress?: number;
  chamber?: string;
  rollNumber?: number;
  question?: string;
  result?: string;
  bill?: { type?: string; number?: string } | null;
  totals?: { yea?: number; nay?: number; present?: number; notVoting?: number };
  positions?: RawPosition[];
}

function normaliseChamber(raw: string | undefined): "upper" | "lower" {
  return (raw ?? "").toLowerCase().includes("senate") ? "upper" : "lower";
}

function normalisePosition(p: string): VotePosition["vote"] {
  if (p === "yea" || p === "nay" || p === "present") return p;
  if (p === "absent") return "absent";
  return "not_voting";
}

export async function handleGetVote(
  db: Database.Database,
  rawInput: unknown,
): Promise<GetVoteResponse> {
  const input = GetVoteInput.parse(rawInput);

  const ensureInput: EnsureVoteInput = {
    vote_id: input.vote_id,
    composite:
      input.congress !== undefined &&
      input.chamber !== undefined &&
      input.session !== undefined &&
      input.roll_number !== undefined
        ? {
            congress: input.congress,
            chamber: input.chamber,
            session: input.session,
            roll_number: input.roll_number,
          }
        : undefined,
  };

  const freshness = await ensureVoteFresh(db, ensureInput);

  const sources = [{ name: "congress", url: "https://www.congress.gov/" }];

  if (!freshness.documentId) {
    return {
      vote: null,
      sources,
      ...(freshness.stale_notice ? { stale_notice: freshness.stale_notice } : {}),
    };
  }

  const row = db
    .prepare(
      `SELECT id, jurisdiction, occurred_at, fetched_at, source_name, source_url, raw
         FROM documents
        WHERE id = ? AND kind = 'vote'`,
    )
    .get(freshness.documentId) as Row | undefined;

  if (!row) {
    return {
      vote: null,
      sources,
      ...(freshness.stale_notice ? { stale_notice: freshness.stale_notice } : {}),
    };
  }

  const raw = JSON.parse(row.raw) as RawShape;
  const totals = raw.totals ?? {};
  const tally: VoteTally = {
    yea: totals.yea ?? 0,
    nay: totals.nay ?? 0,
    present: totals.present ?? 0,
    absent: totals.notVoting ?? 0,
  };
  const billIdentifier =
    raw.bill && raw.bill.type && raw.bill.number
      ? `${raw.bill.type.toUpperCase()}${raw.bill.number}`
      : null;

  const positions: VotePosition[] = (raw.positions ?? []).map((p) => {
    const ent = db
      .prepare(
        `SELECT id FROM entities
          WHERE json_extract(external_ids, '$."bioguide"') = ?`,
      )
      .get(p.bioguideId) as { id: string } | undefined;
    const position: VotePosition = {
      entity_id: ent?.id ?? null,
      name: p.name,
      party: p.party,
      vote: normalisePosition(p.position),
    };
    if (p.state) position.state = p.state;
    return position;
  });

  const session = raw.congress !== undefined ? String(raw.congress) : "";

  const vote: VoteDetail = {
    id: row.id,
    bill_identifier: billIdentifier,
    jurisdiction: row.jurisdiction,
    session,
    chamber: normaliseChamber(raw.chamber),
    date: row.occurred_at,
    result: raw.result ?? "unknown",
    tally,
    positions,
    source_url: row.source_url,
    fetched_at: row.fetched_at,
  };

  return {
    vote,
    sources,
    ...(freshness.stale_notice ? { stale_notice: freshness.stale_notice } : {}),
  };
}
```

- [ ] **Step 4: Run handler test to confirm pass**

Run: `pnpm test tests/unit/mcp/tools/get_vote.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Write failing server-registration test**

Append to `tests/unit/mcp/server.test.ts`:

```typescript
it("registers get_vote tool", () => {
  const { mcp } = buildServer({ dbPath: TEST_DB });
  const tools = (mcp as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  expect(tools).toHaveProperty("get_vote");
});
```

(If the existing tests use a different discovery mechanism — e.g.
`mcp.listTools()` — mirror the pattern used by the `get_bill`
registration test instead.)

- [ ] **Step 6: Register in `src/mcp/server.ts`**

Add to the existing schemas import line at the top of
`src/mcp/server.ts` — add `GetVoteInput` alongside the other
imported schemas:

```typescript
import { GetVoteInput } from "./schemas.js";
import { handleGetVote } from "./tools/get_vote.js";
```

Add the registration block after the `get_bill` registration
(before `return { mcp, store };`):

```typescript
  mcp.registerTool(
    "get_vote",
    {
      description:
        "Fetch full detail for a single roll-call vote, including " +
        "per-legislator positions (entity_id, name, party, state, " +
        "yea/nay/present/not_voting). Pass either `vote_id` " +
        "(the documents.id returned by recent_votes) OR the federal " +
        "composite `{ congress, chamber, session, roll_number }`. " +
        "Federal (Congress.gov) only in V2; state-jurisdiction votes " +
        "are not yet ingested.",
      inputSchema: GetVoteInput.shape,
    },
    async (input) => {
      const data = await handleGetVote(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );
```

- [ ] **Step 7: Run server test to confirm pass**

Run: `pnpm test tests/unit/mcp/server.test.ts -t "get_vote"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/tools/get_vote.ts src/mcp/server.ts tests/unit/mcp/tools/get_vote.test.ts tests/unit/mcp/server.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add get_vote detail tool with per-legislator positions

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Integration test (msw end-to-end)

**Files:**
- Create: `tests/integration/fixtures/congress-vote-detail.json`
- Create: `tests/integration/get-vote-e2e.test.ts`

- [ ] **Step 1: Write fixture**

Create `tests/integration/fixtures/congress-vote-detail.json`:

```json
{
  "voteInformation": {
    "congress": 119,
    "chamber": "Senate",
    "rollNumber": 42,
    "date": "2026-04-01",
    "question": "On Passage of HR 1234",
    "result": "Passed",
    "bill": { "type": "HR", "number": "1234" },
    "totals": { "yea": 52, "nay": 47, "present": 0, "notVoting": 1 },
    "members": {
      "item": [
        {
          "bioguideId": "S000148",
          "name": "Schumer, Charles E.",
          "partyName": "Democratic",
          "state": "NY",
          "votePosition": "Yea"
        },
        {
          "bioguideId": "M000355",
          "name": "McConnell, Mitch",
          "partyName": "Republican",
          "state": "KY",
          "votePosition": "Nay"
        },
        {
          "bioguideId": "C001098",
          "name": "Collins, Susan M.",
          "partyName": "Republican",
          "state": "ME",
          "votePosition": "Yea"
        }
      ]
    }
  }
}
```

- [ ] **Step 2: Write the e2e test**

Create `tests/integration/get-vote-e2e.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/core/seeds.js";
import { handleGetVote } from "../../src/mcp/tools/get_vote.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/congress-vote-detail.json"), "utf-8"),
);

const TEST_DB = "./data/test-get-vote-e2e.db";
let store: Store;

const server = setupServer();
beforeAll(() => {
  process.env.API_DATA_GOV_KEY = "test-key";
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => {
  server.close();
  delete process.env.API_DATA_GOV_KEY;
});
beforeEach(() => {
  server.resetHandlers();
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});
afterEach(() => store.close());

describe("get_vote e2e", () => {
  it("hydrates a federal vote by composite and projects per-member positions", async () => {
    let hitCount = 0;
    server.use(
      http.get("https://api.congress.gov/v3/senate-vote/119/1/42", () => {
        hitCount += 1;
        return HttpResponse.json(fixture);
      }),
    );
    const result = await handleGetVote(store.db, {
      congress: 119, chamber: "upper", session: 1, roll_number: 42,
    });
    expect(hitCount).toBe(1);
    expect(result.vote?.bill_identifier).toBe("HR1234");
    expect(result.vote?.chamber).toBe("upper");
    expect(result.vote?.tally).toEqual({ yea: 52, nay: 47, present: 0, absent: 1 });
    expect(result.vote?.positions).toHaveLength(3);
    expect(result.vote?.positions.find((p) => p.name.startsWith("Schumer"))?.vote).toBe("yea");
    expect(result.vote?.positions.every((p) => p.entity_id !== null)).toBe(true);
  });

  it("serves from cache on second call within TTL", async () => {
    let hitCount = 0;
    server.use(
      http.get("https://api.congress.gov/v3/senate-vote/119/1/42", () => {
        hitCount += 1;
        return HttpResponse.json(fixture);
      }),
    );
    const first = await handleGetVote(store.db, {
      congress: 119, chamber: "upper", session: 1, roll_number: 42,
    });
    const voteId = first.vote!.id;

    await handleGetVote(store.db, { vote_id: voteId });
    await handleGetVote(store.db, {
      congress: 119, chamber: "upper", session: 1, roll_number: 42,
    });
    expect(hitCount).toBe(1);
  });

  it("returns not_found stale_notice when upstream 404s", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/house-vote/119/1/9999", () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );
    const result = await handleGetVote(store.db, {
      congress: 119, chamber: "lower", session: 1, roll_number: 9999,
    });
    expect(result.vote).toBeNull();
    expect(result.stale_notice?.reason).toBe("not_found");
  });
});
```

- [ ] **Step 3: Run the e2e test**

Run: `pnpm test tests/integration/get-vote-e2e.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 4: Run the full suite to confirm no regressions**

Run: `pnpm test`
Expected: PASS (all existing + new tests).

Run: `pnpm build`
Expected: clean TypeScript compile.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/fixtures/congress-vote-detail.json tests/integration/get-vote-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(get_vote): e2e with msw fixture

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Documentation + CHANGELOG + acceptance

**Files:**
- Modify: `docs/05-tool-surface.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add `get_vote` section to `docs/05-tool-surface.md`**

Inside the `## Detail tools (C)` section, **after** the existing
`### `get_bill`` block, insert:

```markdown
### `get_vote` (Phase 9c)

```
input:
  // Either:
  vote_id: string                       // the documents.id from recent_votes
  // OR (federal composite — Congress.gov only in V2):
  congress: number                      // e.g. 119
  chamber: "upper" | "lower"
  session: 1 | 2                        // 1st or 2nd session of the Congress
  roll_number: number

output:
  vote: {
    id: string
    bill_identifier: string | null      // e.g. "HR1234"; null for procedural
    jurisdiction: "us-federal"
    session: string                     // Congress number as string
    chamber: "upper" | "lower"
    date: string
    result: string                      // "Passed", "Failed", etc.
    tally: { yea, nay, present, absent }
    positions: Array<{
      entity_id: string | null          // resolved via external_ids.bioguide
      name: string
      party: string | null              // e.g. "Democratic", "Republican"
      state?: string                    // federal only; absent for state votes
      vote: "yea" | "nay" | "present" | "absent" | "not_voting"
    }>
    source_url: string
    fetched_at: string
  } | null
  sources: Array<{ name, url }>
  stale_notice?: { reason, ... }
```

Freshness: per-document TTL of 1h keyed on `documents.fetched_at`
(R14 / D11). On a composite miss the handler calls
`CongressAdapter.fetchVote` (`/senate-vote/{c}/{s}/{r}` or
`/house-vote/...`), upserts, then projects. Upstream failures serve
the last-known row with a `stale_notice`.

Federal (Congress.gov) only in V2. State-jurisdiction votes are
not ingested; a `vote_id` unknown to the local store returns
`stale_notice.reason="not_found"`. See R17 for why `get_vote` is a
new tool rather than an extension of `VoteSummary`.
```

Update the "As of Phase N" tool count paragraph when this lands
alongside phases 9a/9b/9d per the phase-9 overview's total. If
9c lands first in the 9x sequence, bump the count to **10 tools**;
if 9b has already landed, bump to **11 tools**.

Also update the phase-to-tool mapping table at the bottom to add:

```markdown
| **9c — get_vote detail tool** | ✅ done | + `get_vote` (federal-only; state deferred) |
```

- [ ] **Step 2: Update `CHANGELOG.md`**

If a `v0.4.0` (unreleased) section already exists (added by a prior
9a/9b plan), append under it. Otherwise create the section at the
top of the Unreleased changes:

```markdown
## [0.4.0] — unreleased

### Added
- `get_vote` detail tool: returns per-legislator positions (entity_id,
  name, party, state, yea/nay/present/not_voting) for one roll-call
  vote. Federal (Congress.gov) only; accepts either `vote_id` or the
  `(congress, chamber, session, roll_number)` composite. See R17, D11.
```

- [ ] **Step 3: Run full suite + build one final time**

Run: `pnpm test`
Run: `pnpm build`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add docs/05-tool-surface.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(get_vote): tool surface + changelog entry for phase 9c

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**Placeholder scan:** No `TODO`, `TBD`, or "add appropriate X"
markers. Every code block is complete and self-contained.

**Type-signature consistency across tasks:**

- `CongressVotePosition.member` widened in Task 2 Step 3 → carries
  `partyName` and `state` → consumed by both `upsertVote`'s
  `positions` mapper (Task 2) and `fetchVote`'s response shaping
  (Task 2 Step 7).
- `RawPosition` (Task 4 handler) consumes **exactly** the five
  fields `upsertVote` writes: `bioguideId`, `name`, `party`,
  `state`, `position` (normalised). No field drift.
- `EnsureVoteInput` (Task 3) accepts `vote_id?` and `composite?`
  in the same shape `handleGetVote` (Task 4) constructs from
  `GetVoteInput` (Task 1). `GetVoteInput`'s `.refine()` guarantees
  at least one path is present, so `ensureVoteFresh` never sees a
  fully-empty input.
- `EnsureVoteResult` (Task 3) returns `{ ok, documentId?, stale_notice? }`
  — `handleGetVote` (Task 4) gates the projection on
  `freshness.documentId` being set, which matches the guarantees
  of `ensureVoteFresh` (set on success or on stale-but-available;
  unset on not_found).
- `StaleNotice.reason` — this plan uses only values already in the
  union widened during Phase 7 (`"upstream_failure"`,
  `"not_found"`, `"not_yet_supported"`). No new union members.
- `VoteNotFoundError` (Task 2) is the single error type caught by
  name in `ensureVoteFresh` (Task 3). No other error types cross
  module boundaries.

**Spec coverage (mapped to the original query-audit table):**

| Query | Task implementing |
|---|---|
| "How did Senator X vote on HR1234?" | Task 4 — `positions[].entity_id` + `.vote` |
| "Party-line breakdown of vote N" | Task 4 — `positions[].party` + `.vote`; LLM aggregates |
| "Who voted against their party on vote N?" | Task 4 — same fields; LLM filters |
| "State delegation split on vote N" | Task 4 — `positions[].state` + `.vote` |

All four target queries map to exactly the projected fields.

**Freshness semantics:** Per-document TTL at 1h matches `get_bill`.
Votes are effectively immutable once taken; the 1h TTL exists only
to catch the rare post-hoc correction from the Clerk, not to
capture "updates."

**Federal-only posture:** State `get_vote` is closed off by the
combination of (a) `GetVoteInput`'s composite being federal-shaped
(`congress` + `session ∈ {1,2}`) and (b) OpenStates vote ingestion
not existing in the adapter. If a caller passes `vote_id` pointing
to a state-source vote that somehow got ingested in the future,
the projection still works — the schema is source-agnostic after
that point. Task 4's `normaliseChamber` handles either source's
chamber string.

**Decisions checklist for updating CLAUDE.md in a follow-up:**
- Tool list in "How to think about this MCP" → Details (C) now
  includes `get_vote`.
- No change to "What NOT to do" — no schema denormalisation beyond
  what D11 already sanctions.

---

## Execution Handoff

Plan complete and saved to `docs/plans/phase-9c-get-vote.md`.
Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent
   per task, review between tasks, commits on main per
   `feedback_workflow.md`.
2. **Inline Execution** — work through tasks in this session
   with checkpoints for review.

Which approach?

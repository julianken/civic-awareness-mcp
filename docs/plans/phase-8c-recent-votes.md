# Phase 8c — `recent_votes` Vertical Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Migrate `recent_votes` off `ensureFresh` onto
`withShapedFetch`. Add `CongressAdapter.fetchRecentVotes` with
graceful 404 handling (the `/vote` endpoint 404s on the free API
tier, mirroring `refresh()`'s existing pattern). State jurisdictions
go local-only — OpenStates doesn't expose a `/votes` feed endpoint
and vote ingestion for states remains deferred.

**Architecture:** Same shape as phase-8b-recent-bills: thin
handler orchestrator, narrow adapter method, unit tests mock the
adapter, integration tests use `passthrough-e2e.shaped.test.ts`.
Extracts a shared `seedStaleCache` test helper (flagged by
phase-8b rollup) for reuse in subsequent verticals.

**Tech Stack:** TypeScript, `vitest` + `vi.spyOn(global, "fetch")`
(matches codebase convention; msw is not a project dep).

**Scope:** `recent_votes` only. Other 6 tool handlers remain on
R13. Preserves `recent_votes` current federal-only semantics.

---

## File structure

```
src/
├── adapters/congress.ts             # MODIFIED: + fetchRecentVotes
└── mcp/tools/recent_votes.ts        # MODIFIED: withShapedFetch orchestrator
tests/
├── helpers/
│   └── seed_stale_cache.ts          # NEW: shared integration-test helper
├── integration/
│   ├── congress-e2e.test.ts         # MODIFIED: drop ensureFresh mock for recent_votes
│   ├── passthrough-e2e.test.ts      # MODIFIED: drop recent_votes R13 scenarios
│   └── passthrough-e2e.shaped.test.ts # MODIFIED: + recent_votes scenarios
└── unit/
    ├── adapters/congress.test.ts    # MODIFIED: + fetchRecentVotes tests
    └── mcp/tools/recent_votes.test.ts  # MODIFIED: mock adapter, not ensureFresh
```

---

## Task 1: Extract `seedStaleCache` test helper

**Files:**
- Create: `tests/helpers/seed_stale_cache.ts`
- Modify: `tests/integration/passthrough-e2e.shaped.test.ts` (use the helper)

Repeatable pattern for staging a stale-cache fallback scenario in
integration tests: seed a `documents` row + a past-dated `fetch_log`
row.

- [ ] **Step 1: Write the helper**

Create `tests/helpers/seed_stale_cache.ts`:

```ts
import type Database from "better-sqlite3";
import { upsertDocument } from "../../src/core/documents.js";
import { upsertFetchLog } from "../../src/core/fetch_log.js";
import { hashArgs } from "../../src/core/args_hash.js";
import type { FetchLogScope } from "../../src/core/fetch_log.js";
import type { HydrationSource } from "../../src/core/freshness.js";

export interface SeedStaleCacheInput {
  db: Database.Database;
  source: HydrationSource;
  endpoint_path: string;
  scope: FetchLogScope;
  tool: string;
  args: unknown;
  stale_age_ms?: number; // default 48h
  documents?: Parameters<typeof upsertDocument>[1][];
}

export function seedStaleCache(input: SeedStaleCacheInput): void {
  const ageMs = input.stale_age_ms ?? 48 * 60 * 60 * 1000;
  upsertFetchLog(input.db, {
    source: input.source,
    endpoint_path: input.endpoint_path,
    args_hash: hashArgs(input.tool, input.args),
    scope: input.scope,
    fetched_at: new Date(Date.now() - ageMs).toISOString(),
    last_rowcount: input.documents?.length ?? 0,
  });
  for (const d of input.documents ?? []) upsertDocument(input.db, d);
}
```

- [ ] **Step 2: Refactor the existing stale-cache scenario in `passthrough-e2e.shaped.test.ts`**

Replace any inline `upsertFetchLog` + `upsertDocument` seed code
with a call to `seedStaleCache(...)`. Confirm the scenario still
passes.

- [ ] **Step 3: Run tests**

`pnpm test tests/integration/passthrough-e2e.shaped.test.ts`

All scenarios green.

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/seed_stale_cache.ts tests/integration/passthrough-e2e.shaped.test.ts
git commit -m "$(cat <<'EOF'
test(helpers): extract seedStaleCache helper for R15 integration tests

Common pattern across per-vertical shaped e2e tests: stage a stale
documents row + an expired fetch_log row so the stale-fallback
branch of withShapedFetch fires on the next call. Helper takes a
single input object including the expected tool + args hash key.

Flagged by phase-8b-recent-bills rollup review as shared boilerplate.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Congress.gov `fetchRecentVotes` narrow method

**Files:**
- Modify: `src/adapters/congress.ts`
- Modify: `tests/unit/adapters/congress.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/adapters/congress.test.ts`:

```ts
describe("CongressAdapter.fetchRecentVotes", () => {
  it("fetches votes for current congress and writes them", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        votes: [{
          congress: 119, chamber: "Senate", rollNumber: 42,
          date: "2026-04-10T12:00:00Z",
          question: "Motion to proceed",
          result: "Passed",
          bill: { type: "S", number: "1234" },
          positions: [],
          totals: { yea: 60, nay: 40 },
        }],
        pagination: { count: 1 },
      }), { status: 200 }),
    );

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchRecentVotes(store.db);

    expect(result.documentsUpserted).toBe(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/\/vote\?/);
    expect(url).toMatch(/congress=119/);
    expect(url).toMatch(/api_key=test-key/);
    const written = store.db.prepare(
      "SELECT kind FROM documents WHERE source_name='congress' AND kind='vote'",
    ).all();
    expect(written).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("gracefully degrades on 404 (free-tier API limitation)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 404 }),
    );

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchRecentVotes(store.db);

    expect(result.documentsUpserted).toBe(0);
    expect(result.degraded).toBe(true);
    fetchSpy.mockRestore();
  });

  it("chamber filter selects senate/house votes client-side", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        votes: [
          { congress: 119, chamber: "Senate", rollNumber: 1, date: "2026-04-10", positions: [], totals: {} },
          { congress: 119, chamber: "House", rollNumber: 2, date: "2026-04-10", positions: [], totals: {} },
        ],
        pagination: { count: 2 },
      }), { status: 200 }),
    );

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchRecentVotes(store.db, { chamber: "upper" });

    expect(result.documentsUpserted).toBe(1);
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests — expect fail**

`pnpm test tests/unit/adapters/congress.test.ts -t "fetchRecentVotes"`

Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement the method**

Add to `CongressAdapter` alongside `fetchRecentBills`:

```ts
async fetchRecentVotes(
  db: Database.Database,
  opts: { chamber?: "upper" | "lower"; limit?: number } = {},
): Promise<{ documentsUpserted: number; degraded?: boolean }> {
  const congress = this.congresses[0];
  const url = new URL(`${BASE_URL}/vote`);
  url.searchParams.set("congress", String(congress));
  url.searchParams.set("sort", "updateDate+desc");
  url.searchParams.set("limit", String(opts.limit ?? 250));
  url.searchParams.set("api_key", this.opts.apiKey);

  const res = await rateLimitedFetch(url.toString(), {
    userAgent: "civic-awareness-mcp/0.1.0 (+github)",
    rateLimiter: this.rateLimiter,
  });
  if (res.status === 404) {
    logger.warn("congress /vote 404 — free tier limitation; skipping", {
      url: url.toString(),
    });
    return { documentsUpserted: 0, degraded: true };
  }
  if (!res.ok) throw new Error(`Congress.gov /vote returned ${res.status}`);
  const body = (await res.json()) as { votes?: CongressVote[] };

  const chamberMatch = (chamber: string): boolean => {
    if (!opts.chamber) return true;
    const senate = chamber.toLowerCase().includes("senate");
    return opts.chamber === "upper" ? senate : !senate;
  };

  let documentsUpserted = 0;
  for (const v of body.votes ?? []) {
    if (!chamberMatch(v.chamber)) continue;
    this.upsertVote(db, v);
    documentsUpserted += 1;
  }
  return { documentsUpserted };
}
```

Note: `upsertVote` already exists in the adapter (private method).
Reuse it.

- [ ] **Step 4: Run tests — all pass**

`pnpm test tests/unit/adapters/congress.test.ts`

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/congress.ts tests/unit/adapters/congress.test.ts
git commit -m "$(cat <<'EOF'
feat(congress): fetchRecentVotes narrow method with graceful 404

Narrow R15 fetch for recent_votes — one page of /vote with
sort=updateDate+desc and optional chamber filter. On 404 (free API
tier limitation), returns { documentsUpserted: 0, degraded: true }
with a warning log rather than throwing, matching the existing
refresh() graceful-degradation behavior.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `recent_votes` handler rewrite + unit tests

**Files:**
- Modify: `src/mcp/tools/recent_votes.ts`
- Modify: `tests/unit/mcp/tools/recent_votes.test.ts`

- [ ] **Step 1: Rewrite the handler**

Replace `handleRecentVotes` with a thin orchestrator. Structure:

```ts
import type Database from "better-sqlite3";
import { queryDocuments } from "../../core/documents.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import { CongressAdapter } from "../../adapters/congress.js";
import { getLimiter } from "../../core/limiters.js";
import { requireEnv } from "../../util/env.js";
import { RecentVotesInput } from "../schemas.js";
import {
  emptyFeedDiagnostic, type EmptyFeedDiagnostic, type StaleNotice,
} from "../shared.js";

// ... keep VoteTally, VoteSummary, RecentVotesResponse types, CHAMBER_MAP ...

export async function handleRecentVotes(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentVotesResponse> {
  const input = RecentVotesInput.parse(rawInput);
  const to = new Date();
  const from = new Date(to.getTime() - input.days * 86400 * 1000);

  const projectLocal = (): RecentVotesResponse => {
    // ... lift current projection (queryDocuments + chamber/bill_identifier filter + map to VoteSummary + empty diagnostic fallback) unchanged ...
  };

  // Votes only have a federal source today; state jurisdictions go local-only.
  if (input.jurisdiction !== "us-federal") {
    return projectLocal();
  }

  const fetchAndWrite = async (): Promise<{ primary_rows_written: number }> => {
    const adapter = new CongressAdapter({
      apiKey: requireEnv("API_DATA_GOV_KEY"),
      rateLimiter: getLimiter("congress"),
    });
    const result = await adapter.fetchRecentVotes(db, { chamber: input.chamber });
    return { primary_rows_written: result.documentsUpserted };
  };

  const result = await withShapedFetch(
    db,
    {
      source: "congress",
      endpoint_path: "/vote",
      args: { jurisdiction: input.jurisdiction, days: input.days, chamber: input.chamber, session: input.session, bill_identifier: input.bill_identifier },
      tool: "recent_votes",
    },
    { scope: "recent", ms: 60 * 60 * 1000 },
    fetchAndWrite,
    projectLocal,
    () => getLimiter("congress").peekWaitMs(),
  );

  return result.stale_notice
    ? { ...result.value, stale_notice: result.stale_notice }
    : result.value;
}
```

Preserve all projection logic (queryDocuments → chamber filter →
bill_identifier filter → map to VoteSummary → source URL map →
emptyFeedDiagnostic fallback). Only the `ensureFresh` loop changes.

- [ ] **Step 2: Rewrite the unit test**

Replace test file's mocks. Key changes from today's test:
- Remove `vi.mock(".../hydrate.js", ...)` / `ensureFresh` mock
- Import `_resetToolCacheForTesting` from `src/core/tool_cache.js`; call in beforeEach
- For tests that need fresh-upstream behavior: `vi.spyOn(CongressAdapter.prototype, "fetchRecentVotes").mockImplementation(...)` that writes a vote doc to the DB
- For tests that need cache-hit behavior: seed `fetch_log` with `upsertFetchLog` pre-call so `isFetchLogFresh` returns true, spy NOT called
- Preserve existing scenarios: federal fetch, chamber filter, bill_identifier filter, empty result diagnostic
- Add: state jurisdiction short-circuit (local-only, no spy call)
- Add: 404 degraded-mode returns normally (no stale_notice, empty results)
- Add: upstream failure with no cache propagates

- [ ] **Step 3: Run tests — all pass**

`pnpm test tests/unit/mcp/tools/recent_votes.test.ts`

- [ ] **Step 4: Full suite**

`pnpm test`

Expected: integration tests in `congress-e2e.test.ts` and
`passthrough-e2e.test.ts` that reference recent_votes on R13 path
will fail. Enumerate them in the Task 4 cleanup. Failures should
be confined to those files only.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/recent_votes.ts tests/unit/mcp/tools/recent_votes.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): recent_votes on withShapedFetch (R15)

Federal votes fetched via CongressAdapter.fetchRecentVotes with
graceful 404 handling. State jurisdictions short-circuit to
local-only (OpenStates vote ingestion remains deferred). Unit
tests mock the adapter method; integration test updates follow
in Task 4.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Integration test cleanup

**Files:**
- Modify: `tests/integration/congress-e2e.test.ts`
- Modify: `tests/integration/passthrough-e2e.test.ts`
- Modify: `tests/integration/passthrough-e2e.shaped.test.ts`

- [ ] **Step 1: Drop R13 recent_votes scenarios**

Identify and remove scenarios in `congress-e2e.test.ts` and
`passthrough-e2e.test.ts` that test recent_votes through the
`ensureFresh` path. Preserve scenarios for other tools.

- [ ] **Step 2: Add recent_votes scenarios to shaped e2e**

Append to `passthrough-e2e.shaped.test.ts`:

```ts
describe("passthrough shaped e2e — recent_votes (federal)", () => {
  it("cold fetch → warm hit: second call is cache hit", async () => {
    let upstreamHits = 0;
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
      upstreamHits += 1;
      return new Response(JSON.stringify({
        votes: [{ congress: 119, chamber: "Senate", rollNumber: 1,
          date: "2026-04-10T12:00:00Z", positions: [], totals: {} }],
        pagination: { count: 1 },
      }), { status: 200 });
    });

    await handleRecentVotes(db, { jurisdiction: "us-federal", days: 7 });
    await handleRecentVotes(db, { jurisdiction: "us-federal", days: 7 });

    expect(upstreamHits).toBe(1);
    fetchSpy.mockRestore();
  });

  it("404 degraded mode returns empty without stale_notice", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 404 }),
    );

    const result = await handleRecentVotes(db, { jurisdiction: "us-federal", days: 7 });
    expect(result.results).toEqual([]);
    expect(result.stale_notice).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it("upstream failure with stale cache returns stale + notice", async () => {
    seedStaleCache({
      db,
      source: "congress",
      endpoint_path: "/vote",
      scope: "recent",
      tool: "recent_votes",
      args: { jurisdiction: "us-federal", days: 7 },
      documents: [{
        kind: "vote", jurisdiction: "us-federal",
        title: "Vote 119-Senate-1: S.1234 — Motion",
        occurred_at: "2026-04-10T00:00:00Z",
        source: { name: "congress", id: "vote-119-senate-1",
          url: "https://www.congress.gov/roll-call-votes/119/senate/1" },
        references: [],
        raw: { congress: 119, chamber: "Senate", rollNumber: 1,
          totals: { yea: 60, nay: 40 } },
      }],
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

    const result = await handleRecentVotes(db, { jurisdiction: "us-federal", days: 7 });
    expect(result.stale_notice?.reason).toBe("upstream_failure");
    expect(result.results.length).toBeGreaterThan(0);
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Run full suite**

`pnpm test`

Expected: 100% green.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/congress-e2e.test.ts tests/integration/passthrough-e2e.test.ts tests/integration/passthrough-e2e.shaped.test.ts
git commit -m "$(cat <<'EOF'
test: recent_votes integration tests on R15 path

- Drop R13 recent_votes scenarios from congress-e2e and
  passthrough-e2e.
- Add three scenarios to passthrough-e2e.shaped.test.ts using the
  new seedStaleCache helper: cold→warm hit, 404 degraded mode,
  upstream failure with stale cache returns upstream_failure notice.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Acceptance check

- [ ] `pnpm test` — all green.
- [ ] `pnpm build` — TypeScript clean.
- [ ] `grep ensureFresh src/mcp/tools/recent_votes.ts` — 0 matches.
- [ ] `grep withShapedFetch src/mcp/tools/recent_votes.ts` — 1 match.
- [ ] `tests/helpers/seed_stale_cache.ts` exists and is used in shaped e2e.

Phase 8c complete when all five hold. Next: phase-8d-recent-contributions.

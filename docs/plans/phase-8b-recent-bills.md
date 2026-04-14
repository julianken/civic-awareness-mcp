# Phase 8b — `recent_bills` Vertical Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Rewrite the `recent_bills` MCP tool handler to use the
new `withShapedFetch` path (R15) in place of the jurisdiction-wide
`ensureFresh` pipeline (R13). Add narrow `fetchRecentBills`
methods to both the OpenStates and Congress.gov adapters. All
other 8 tool handlers remain on `ensureFresh` until their own
verticals land.

**Architecture:** `handleRecentBills` becomes a thin orchestrator:
branch on jurisdiction (`us-federal` → Congress.gov, else →
OpenStates), call `withShapedFetch(db, key, ttl, fetchAndWrite,
readLocal, peekWaitMs)` where `fetchAndWrite` invokes the narrow
adapter method and `readLocal` runs the existing SQL projection.
Per Task 4 of phase-8a design-spec decisions, the
`withShapedFetch` call uses `endpoint_path="/bills"` for OpenStates
and `"/bill"` for Congress.gov — tool-agnostic keys so
`search_civic_documents` and `entity_connections` can share cache
rows in future verticals.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`,
`better-sqlite3`, `vitest` + `msw`.

**Scope:** Only `recent_bills` rewires. `hydrate.ts`, `freshness.ts`,
and the 8 other tool handlers are untouched. `passthrough-e2e.test.ts`
(R13 integration test) continues to exercise the legacy path for
other tools; this plan adds a new `passthrough-e2e.shaped.test.ts`
for the R15 path, seeded with recent_bills scenarios.

---

## File structure

```
src/
├── adapters/
│   ├── openstates.ts       # MODIFIED: + fetchRecentBills method
│   └── congress.ts         # MODIFIED: + fetchRecentBills method
└── mcp/tools/
    └── recent_bills.ts     # MODIFIED: handler rewritten around withShapedFetch
docs/plans/
└── phase-8b-recent-bills.md   # this file
tests/
├── integration/
│   ├── congress-e2e.test.ts   # MODIFIED: drop vi.mock("hydrate.js") for recent_bills scenarios
│   ├── openstates-e2e.test.ts # MODIFIED: same
│   └── passthrough-e2e.shaped.test.ts  # NEW: R15 e2e skeleton + first recent_bills scenarios
└── unit/
    ├── adapters/
    │   ├── openstates.test.ts  # MODIFIED: + fetchRecentBills tests
    │   └── congress.test.ts    # MODIFIED: + fetchRecentBills tests
    └── mcp/tools/
        └── recent_bills.test.ts  # MODIFIED: mock adapter methods, not ensureFresh
```

---

## Task 1: OpenStates `fetchRecentBills` narrow method

**Files:**
- Modify: `src/adapters/openstates.ts`
- Modify: `tests/unit/adapters/openstates.test.ts`

The method fetches one page of recently-updated bills for a
jurisdiction and write-through-upserts them, returning a telemetry
count. Signature matches the pattern established by `fetchBill`
(takes `db`, takes narrow input, returns promise with telemetry).

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/adapters/openstates.test.ts` (adjust imports
if needed — read the file first to understand the msw setup):

```ts
describe("OpenStatesAdapter.fetchRecentBills", () => {
  it("fetches one page of recently-updated bills for a jurisdiction and writes them", async () => {
    server.use(
      http.get("https://v3.openstates.org/bills", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("jurisdiction")).toBe("tx");
        expect(url.searchParams.get("sort")).toBe("updated_desc");
        expect(url.searchParams.get("per_page")).toBe("20");
        // updated_since is optional — absent means "recent" (API default)
        return HttpResponse.json({
          results: [
            {
              id: "ocd-bill/abc",
              identifier: "HB1",
              title: "Test",
              session: "89R",
              updated_at: "2026-04-10T00:00:00Z",
              openstates_url: "https://openstates.org/tx/bills/89R/HB1",
              jurisdiction: { id: "ocd-jurisdiction/country:us/state:tx/government" },
              sponsorships: [],
              actions: [{ date: "2026-04-10", description: "Introduced" }],
            },
          ],
          pagination: { max_page: 5 },
        });
      }),
    );

    const dbPath = `/tmp/fetchRecentBills-test-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const { db } = openStore(dbPath);

    const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
    const result = await adapter.fetchRecentBills(db, { jurisdiction: "us-tx" });

    expect(result.documentsUpserted).toBe(1);
    const bills = db.prepare(
      "SELECT id, title FROM documents WHERE source_name='openstates' AND kind='bill'",
    ).all() as Array<{ id: string; title: string }>;
    expect(bills).toHaveLength(1);
    expect(bills[0].title).toMatch(/^HB1 — /);
  });

  it("passes updated_since when provided", async () => {
    let capturedUpdatedSince: string | null = null;
    server.use(
      http.get("https://v3.openstates.org/bills", ({ request }) => {
        capturedUpdatedSince = new URL(request.url).searchParams.get("updated_since");
        return HttpResponse.json({ results: [], pagination: { max_page: 1 } });
      }),
    );

    const dbPath = `/tmp/fetchRecentBills-since-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const { db } = openStore(dbPath);

    const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
    await adapter.fetchRecentBills(db, {
      jurisdiction: "us-tx",
      updated_since: "2026-04-01",
    });

    expect(capturedUpdatedSince).toBe("2026-04-01");
  });
});
```

- [ ] **Step 2: Run test — expect fail on missing method**

Run: `pnpm test tests/unit/adapters/openstates.test.ts -t "fetchRecentBills"`

Expected: FAIL — `adapter.fetchRecentBills is not a function`.

- [ ] **Step 3: Implement the method**

Add to `OpenStatesAdapter` (alongside `fetchBill`), roughly:

```ts
/** Narrow per-tool fetch for R15 `recent_bills` — one page of
 *  recently-updated bills for a jurisdiction, with optional
 *  `updated_since` filter. Writes through to `documents` via
 *  `upsertBill`. Returns telemetry count. */
async fetchRecentBills(
  db: Database.Database,
  opts: { jurisdiction: string; updated_since?: string; chamber?: "upper" | "lower" },
): Promise<{ documentsUpserted: number }> {
  const abbr = opts.jurisdiction.replace(/^us-/, "").toLowerCase();
  const url = new URL(`${BASE_URL}/bills`);
  url.searchParams.set("jurisdiction", abbr);
  url.searchParams.set("sort", "updated_desc");
  url.searchParams.set("per_page", "20");
  if (opts.updated_since) url.searchParams.set("updated_since", opts.updated_since);
  for (const inc of ["sponsorships", "abstracts", "actions"]) {
    url.searchParams.append("include", inc);
  }

  const res = await rateLimitedFetch(url.toString(), {
    userAgent: "civic-awareness-mcp/0.1.0 (+github)",
    rateLimiter: this.rateLimiter,
    headers: { "X-API-KEY": this.opts.apiKey },
  });
  if (!res.ok) throw new Error(`OpenStates /bills returned ${res.status}`);
  const body = (await res.json()) as { results: OpenStatesBill[] };

  let documentsUpserted = 0;
  for (const b of body.results) {
    if (opts.chamber) {
      const classification = b.from_organization?.classification;
      if (classification && classification !== opts.chamber) continue;
    }
    this.upsertBill(db, b);
    documentsUpserted += 1;
  }
  return { documentsUpserted };
}
```

(Exact type on `OpenStatesBill` — use the existing interface in
the file. If `from_organization` isn't in the current type, check
the adapter's existing bill fixtures to confirm the field path.)

- [ ] **Step 4: Run tests — both pass**

Run: `pnpm test tests/unit/adapters/openstates.test.ts -t "fetchRecentBills"`

Expected: PASS (2/2).

Full file: `pnpm test tests/unit/adapters/openstates.test.ts`

Expected: all existing adapter tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/openstates.ts tests/unit/adapters/openstates.test.ts
git commit -m "$(cat <<'EOF'
feat(openstates): fetchRecentBills narrow method for R15 recent_bills

One-page fetch of recently-updated bills for a jurisdiction with
optional updated_since and chamber filters. Write-through to
documents via existing upsertBill. Returns telemetry count for
withShapedFetch's primary_rows_written contract.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Congress.gov `fetchRecentBills` narrow method

**Files:**
- Modify: `src/adapters/congress.ts`
- Modify: `tests/unit/adapters/congress.test.ts`

Uses Congress.gov's native `fromDateTime` + `sort=updateDate+desc`
parameters (confirmed by the phase-8a API audit — the original
plan assumed these didn't exist).

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/adapters/congress.test.ts`:

```ts
describe("CongressAdapter.fetchRecentBills", () => {
  it("fetches one page of recent bills with fromDateTime filter", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/bill", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("fromDateTime")).toBeTruthy();
        expect(url.searchParams.get("sort")).toBe("updateDate+desc");
        expect(url.searchParams.get("limit")).toBe("250");
        return HttpResponse.json({
          bills: [
            {
              congress: 119, type: "HR", number: "123",
              title: "Test Bill", updateDate: "2026-04-10",
              url: "https://api.congress.gov/v3/bill/119/HR/123",
              sponsors: [{ bioguideId: "T000001", fullName: "Rep. T" }],
              latestAction: { actionDate: "2026-04-10", text: "Introduced" },
            },
          ],
          pagination: { count: 1 },
        });
      }),
    );

    const dbPath = `/tmp/congress-fetchRecentBills-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const { db } = openStore(dbPath);

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchRecentBills(db, {
      fromDateTime: "2026-04-01T00:00:00Z",
    });

    expect(result.documentsUpserted).toBe(1);
    const bills = db.prepare(
      "SELECT id, title FROM documents WHERE source_name='congress' AND kind='bill'",
    ).all() as Array<{ id: string; title: string }>;
    expect(bills).toHaveLength(1);
  });

  it("filters by chamber when provided", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/bill", () => {
        return HttpResponse.json({
          bills: [
            { congress: 119, type: "HR", number: "1", title: "House Bill",
              updateDate: "2026-04-10",
              url: "https://api.congress.gov/v3/bill/119/HR/1",
              sponsors: [], latestAction: null },
            { congress: 119, type: "S", number: "2", title: "Senate Bill",
              updateDate: "2026-04-10",
              url: "https://api.congress.gov/v3/bill/119/S/2",
              sponsors: [], latestAction: null },
          ],
          pagination: { count: 2 },
        });
      }),
    );

    const dbPath = `/tmp/congress-chamber-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const { db } = openStore(dbPath);

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchRecentBills(db, {
      fromDateTime: "2026-04-01T00:00:00Z",
      chamber: "upper",
    });

    expect(result.documentsUpserted).toBe(1);
    const titles = db.prepare(
      "SELECT title FROM documents WHERE source_name='congress' AND kind='bill'",
    ).all() as Array<{ title: string }>;
    expect(titles[0].title).toMatch(/Senate Bill/);
  });
});
```

- [ ] **Step 2: Run test — fails**

Run: `pnpm test tests/unit/adapters/congress.test.ts -t "fetchRecentBills"`

Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement the method**

Add to `CongressAdapter`, alongside `refresh`:

```ts
/** Narrow per-tool fetch for R15 `recent_bills` — one page of
 *  recently-updated bills with fromDateTime filter. Write-through
 *  via existing upsertBill. Returns telemetry count. */
async fetchRecentBills(
  db: Database.Database,
  opts: { fromDateTime: string; chamber?: "upper" | "lower"; limit?: number },
): Promise<{ documentsUpserted: number }> {
  const congress = this.congresses[0];  // current Congress only for R15
  const url = new URL(`${BASE_URL}/bill`);
  url.searchParams.set("congress", String(congress));
  url.searchParams.set("fromDateTime", opts.fromDateTime);
  url.searchParams.set("sort", "updateDate+desc");
  url.searchParams.set("limit", String(opts.limit ?? 250));
  url.searchParams.set("api_key", this.opts.apiKey);

  const res = await rateLimitedFetch(url.toString(), {
    userAgent: "civic-awareness-mcp/0.1.0 (+github)",
    rateLimiter: this.rateLimiter,
  });
  if (!res.ok) throw new Error(`Congress.gov /bill returned ${res.status}`);
  const body = (await res.json()) as { bills?: CongressBill[] };

  const chamberMatch = (billType: string): boolean => {
    if (!opts.chamber) return true;
    const senate = billType.toUpperCase().startsWith("S");
    return opts.chamber === "upper" ? senate : !senate;
  };

  let documentsUpserted = 0;
  for (const b of body.bills ?? []) {
    if (!chamberMatch(b.type)) continue;
    this.upsertBill(db, b);
    documentsUpserted += 1;
  }
  return { documentsUpserted };
}
```

- [ ] **Step 4: Run tests — both pass**

Full file: `pnpm test tests/unit/adapters/congress.test.ts`

Expected: all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/congress.ts tests/unit/adapters/congress.test.ts
git commit -m "$(cat <<'EOF'
feat(congress): fetchRecentBills narrow method for R15 recent_bills

Uses Congress.gov's native fromDateTime + sort=updateDate+desc
filters (one-page fetch, default limit 250). Optional chamber
filter applied client-side via billType prefix ("S" = upper).
Current congress only — prior congresses are bulk-loaded via
pnpm refresh. Returns telemetry count.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `recent_bills` handler rewrite + unit test rewrite

**Files:**
- Modify: `src/mcp/tools/recent_bills.ts`
- Modify: `tests/unit/mcp/tools/recent_bills.test.ts`

Replace the current `sourcesFor("bill", jurisdiction) → ensureFresh`
pattern with a single `withShapedFetch` call. Branch on
`jurisdiction` to pick the adapter. `readLocal` runs the existing
SQL projection (largely unchanged from today's `handleRecentBills`
tail).

- [ ] **Step 1: Read the current `recent_bills.ts` to understand the projection logic**

Read `src/mcp/tools/recent_bills.ts` fully. Identify:
- The existing projection (query + sponsor summary + map to BillSummary)
- The existing `ensureFresh` / `sourcesFor` calls (to be removed)
- The stale_notice surfacing (now handled by withShapedFetch's return)

- [ ] **Step 2: Write the failing unit-test rewrite first**

Replace the contents of `tests/unit/mcp/tools/recent_bills.test.ts`
with a new version that mocks the adapter methods, not `ensureFresh`.
Read the existing test to preserve its coverage (empty result,
data-present result, chamber filter, stale_notice propagation).

Key change: instead of `vi.mock("../../../../src/core/hydrate.js", ...)`,
mock `OpenStatesAdapter.prototype.fetchRecentBills` and
`CongressAdapter.prototype.fetchRecentBills`. For cache-hit tests
the mock should NOT be called; for cache-miss tests it should be
called once per call.

Example structure:

```ts
import { vi, describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { bootstrap } from "../../../../src/cli/bootstrap.js";
import { openStore } from "../../../../src/core/store.js";
import { handleRecentBills } from "../../../../src/mcp/tools/recent_bills.js";
import { _resetToolCacheForTesting } from "../../../../src/core/tool_cache.js";
import { OpenStatesAdapter } from "../../../../src/adapters/openstates.js";
import { CongressAdapter } from "../../../../src/adapters/congress.js";

let db: Database.Database;

beforeEach(async () => {
  _resetToolCacheForTesting();
  const dbPath = `/tmp/recent-bills-test-${Date.now()}-${Math.random()}.db`;
  await bootstrap({ dbPath });
  db = openStore(dbPath).db;
});

describe("handleRecentBills (R15)", () => {
  it("state jurisdiction: calls OpenStates fetchRecentBills and returns projected bills", async () => {
    const fetchSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async (db) => {
        // Simulate the adapter writing a bill.
        db.prepare(
          `INSERT INTO documents (id, source_name, source_id, kind, jurisdiction,
             title, summary, occurred_at, fetched_at, source_url, raw)
           VALUES ('doc-1', 'openstates', 'ocd-bill/tx/1', 'bill', 'us-tx',
             'HB1 — Test', NULL, '2026-04-10T00:00:00Z', datetime('now'),
             'https://openstates.org/tx/bills/HB1', '{}')`,
        ).run();
        return { documentsUpserted: 1 };
      });

    const result = await handleRecentBills(db, { jurisdiction: "us-tx", days: 7 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].identifier).toBe("HB1");
    expect(result.stale_notice).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("us-federal: calls Congress fetchRecentBills", async () => {
    const fetchSpy = vi.spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(db, { jurisdiction: "us-federal", days: 7 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it("cache hit: does NOT call adapter on second call within TTL", async () => {
    const fetchSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(db, { jurisdiction: "us-tx", days: 7 });
    await handleRecentBills(db, { jurisdiction: "us-tx", days: 7 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it("upstream failure with no cached data propagates", async () => {
    const fetchSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockRejectedValue(new Error("network down"));

    await expect(
      handleRecentBills(db, { jurisdiction: "us-tx", days: 7 }),
    ).rejects.toThrow(/network down/);

    fetchSpy.mockRestore();
  });
});
```

Adjust imports/paths as needed.

- [ ] **Step 3: Run the test — expect fail**

Run: `pnpm test tests/unit/mcp/tools/recent_bills.test.ts`

Expected: FAIL — handler still uses `ensureFresh`, not `withShapedFetch`.

- [ ] **Step 4: Rewrite the handler**

Replace `handleRecentBills` in `src/mcp/tools/recent_bills.ts`.
Structure:

```ts
import { withShapedFetch } from "../../core/tool_cache.js";
import { getLimiter } from "../../core/limiters.js";
import { OpenStatesAdapter } from "../../adapters/openstates.js";
import { CongressAdapter } from "../../adapters/congress.js";
import { requireEnv } from "../../util/env.js";
// ... other existing imports: queryDocuments, findEntityById, types, etc.

export async function handleRecentBills(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentBillsResponse> {
  const input = RecentBillsInput.parse(rawInput);

  const to = new Date();
  const from = new Date(to.getTime() - input.days * 86400 * 1000);

  const projectLocal = (): RecentBillsResponse => {
    // ... existing projection logic, unchanged:
    //   queryDocuments(db, { kind: "bill", jurisdiction, from, to, limit: 50 })
    //   .map(buildBillSummary)
    //   .filter(chamber)
    //   + emptyFeedDiagnostic fallback
  };

  if (input.jurisdiction === "*") {
    // Wildcard — no hydration, local-only (same as "search" style).
    const base = projectLocal();
    return base;
  }

  const isFederal = input.jurisdiction === "us-federal";
  const source = isFederal ? "congress" : "openstates";
  const endpoint_path = isFederal ? "/bill" : "/bills";

  const fetchAndWrite = async (): Promise<{ primary_rows_written: number }> => {
    if (isFederal) {
      const adapter = new CongressAdapter({ apiKey: requireEnv("API_DATA_GOV_KEY") });
      const { documentsUpserted } = await adapter.fetchRecentBills(db, {
        fromDateTime: from.toISOString(),
        chamber: input.chamber,
      });
      return { primary_rows_written: documentsUpserted };
    }
    const adapter = new OpenStatesAdapter({ apiKey: requireEnv("OPENSTATES_API_KEY") });
    const { documentsUpserted } = await adapter.fetchRecentBills(db, {
      jurisdiction: input.jurisdiction,
      updated_since: from.toISOString().slice(0, 10),
      chamber: input.chamber,
    });
    return { primary_rows_written: documentsUpserted };
  };

  const result = await withShapedFetch(
    db,
    {
      source,
      endpoint_path,
      args: { jurisdiction: input.jurisdiction, days: input.days, chamber: input.chamber, session: input.session },
      tool: "recent_bills",
    },
    { scope: "recent", ms: 60 * 60 * 1000 },
    fetchAndWrite,
    projectLocal,
    () => getLimiter(source).peekWaitMs(),
  );

  return result.stale_notice
    ? { ...result.value, stale_notice: result.stale_notice }
    : result.value;
}
```

Delete the old `ensureFresh`/`sourcesFor` imports. Keep all existing
helper functions (`buildSponsorSummary`, etc.) unchanged.

- [ ] **Step 5: Run tests — all pass**

Run: `pnpm test tests/unit/mcp/tools/recent_bills.test.ts`

Expected: 4/4 (or however many) pass.

Run full suite: `pnpm test`

Expected: most pass. There will likely be regressions in
`openstates-e2e.test.ts` / `congress-e2e.test.ts` because they
mock `ensureFresh` — those are handled in Task 4. For Task 3's
green-tests requirement: all tests NOT in those integration files
should pass. Check the failure messages — they should be limited
to the integration e2e files that still reference the removed
`ensureFresh` path for `recent_bills`.

If regressions extend beyond integration tests, STOP and report.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/recent_bills.ts tests/unit/mcp/tools/recent_bills.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): recent_bills on withShapedFetch (R15)

Replaces the jurisdiction-wide ensureFresh path with a narrow
withShapedFetch call. Branches on jurisdiction: us-federal uses
Congress.gov adapter's fetchRecentBills, state jurisdictions use
OpenStates adapter's fetchRecentBills. Wildcard "*" short-circuits
to local-only. Unit tests now mock the adapter methods instead
of ensureFresh.

Integration test updates land in Task 4 of phase-8b-recent-bills.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Integration tests + shaped e2e skeleton

**Files:**
- Modify: `tests/integration/openstates-e2e.test.ts`
- Modify: `tests/integration/congress-e2e.test.ts`
- Create: `tests/integration/passthrough-e2e.shaped.test.ts`

- [ ] **Step 1: Remove recent_bills-specific `vi.mock("hydrate.js")` bits**

In `openstates-e2e.test.ts` and `congress-e2e.test.ts`, find any
section that mocks `ensureFresh` or `src/core/hydrate.js`
specifically for `recent_bills` test scenarios. Either:

- Remove the mock and replace with adapter-method spies (spy on
  `OpenStatesAdapter.prototype.fetchRecentBills` / Congress equivalent)
- OR delete the scenario entirely if it's purely R13-flow-specific
  and has a parallel in `passthrough-e2e.shaped.test.ts`

The `hydrate.js` mock may be shared across scenarios for OTHER
tools (votes, contributions, entities) — preserve those. Only the
`recent_bills` path is migrating in this vertical.

Run tests after each change: `pnpm test tests/integration/openstates-e2e.test.ts`
and same for congress. Both should be green.

- [ ] **Step 2: Create the shaped e2e test file**

Create `tests/integration/passthrough-e2e.shaped.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import Database from "better-sqlite3";
import { bootstrap } from "../../src/cli/bootstrap.js";
import { openStore } from "../../src/core/store.js";
import { handleRecentBills } from "../../src/mcp/tools/recent_bills.js";
import { _resetToolCacheForTesting } from "../../src/core/tool_cache.js";

const server = setupServer();
let db: Database.Database;

beforeEach(async () => {
  server.listen({ onUnhandledRequest: "error" });
  _resetToolCacheForTesting();
  process.env.OPENSTATES_API_KEY = "test-key";
  const dbPath = `/tmp/passthrough-shaped-${Date.now()}-${Math.random()}.db`;
  await bootstrap({ dbPath });
  db = openStore(dbPath).db;
});

afterEach(() => {
  server.resetHandlers();
  server.close();
  delete process.env.OPENSTATES_API_KEY;
});

describe("passthrough shaped e2e — recent_bills", () => {
  it("cold fetch → warm hit: second call does not hit upstream", async () => {
    let upstreamHits = 0;
    server.use(
      http.get("https://v3.openstates.org/bills", () => {
        upstreamHits += 1;
        return HttpResponse.json({
          results: [{
            id: "ocd-bill/tx/1", identifier: "HB1", title: "Test",
            session: "89R", updated_at: "2026-04-10T00:00:00Z",
            openstates_url: "https://openstates.org/tx/bills/89R/HB1",
            jurisdiction: { id: "ocd-jurisdiction/country:us/state:tx/government" },
            sponsorships: [],
            actions: [{ date: "2026-04-10", description: "Intro" }],
          }],
          pagination: { max_page: 1 },
        });
      }),
    );

    await handleRecentBills(db, { jurisdiction: "us-tx", days: 7 });
    await handleRecentBills(db, { jurisdiction: "us-tx", days: 7 });

    expect(upstreamHits).toBe(1);
  });

  it("upstream failure with no cache propagates", async () => {
    server.use(
      http.get("https://v3.openstates.org/bills", () => HttpResponse.error()),
    );

    await expect(
      handleRecentBills(db, { jurisdiction: "us-tx", days: 7 }),
    ).rejects.toThrow();
  });

  it("upstream failure with stale cache returns stale + notice", async () => {
    // First call: cold fetch, populates cache.
    server.use(
      http.get("https://v3.openstates.org/bills", () => HttpResponse.json({
        results: [{
          id: "ocd-bill/tx/2", identifier: "HB2", title: "Cached",
          session: "89R", updated_at: "2026-04-10T00:00:00Z",
          openstates_url: "https://openstates.org/tx/bills/89R/HB2",
          jurisdiction: { id: "ocd-jurisdiction/country:us/state:tx/government" },
          sponsorships: [],
          actions: [{ date: "2026-04-10", description: "Intro" }],
        }],
        pagination: { max_page: 1 },
      })),
    );

    await handleRecentBills(db, { jurisdiction: "us-tx", days: 7 });

    // Expire the fetch_log row.
    db.prepare(
      "UPDATE fetch_log SET fetched_at = '2026-01-01T00:00:00.000Z' WHERE tool='recent_bills' OR 1=1",
    ).run();

    // Second call: upstream fails; should return stale + notice.
    server.resetHandlers();
    server.use(
      http.get("https://v3.openstates.org/bills", () => HttpResponse.error()),
    );

    const result = await handleRecentBills(db, { jurisdiction: "us-tx", days: 7 });
    expect(result.stale_notice?.reason).toBe("upstream_failure");
    expect(result.results.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run shaped e2e — all pass**

Run: `pnpm test tests/integration/passthrough-e2e.shaped.test.ts`

Expected: 3/3 pass.

- [ ] **Step 4: Full test suite green**

Run: `pnpm test`

Expected: all tests across all files pass (both old
`passthrough-e2e.test.ts` for non-migrated tools and new
`passthrough-e2e.shaped.test.ts` for recent_bills).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/openstates-e2e.test.ts tests/integration/congress-e2e.test.ts tests/integration/passthrough-e2e.shaped.test.ts
git commit -m "$(cat <<'EOF'
test: integration tests for recent_bills on R15 path

- openstates-e2e.test.ts / congress-e2e.test.ts: drop
  ensureFresh mocks for recent_bills scenarios; preserved for
  other tools still on R13.
- passthrough-e2e.shaped.test.ts (new): R15 integration scenarios
  for recent_bills — cold → warm hit, upstream failure with no
  cache propagates, upstream failure with stale cache returns
  stale + upstream_failure notice.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Acceptance check

- [ ] `pnpm test` — all tests green (counts go up by ~5-10).
- [ ] `pnpm build` — TypeScript clean.
- [ ] Grep `ensureFresh` in `src/mcp/tools/recent_bills.ts` — ZERO matches (migrated off).
- [ ] Grep `ensureFresh` in other 7 tool handlers — unchanged (still on R13).
- [ ] Grep `withShapedFetch` in `src/mcp/tools/recent_bills.ts` — ONE match.

Phase 8b-recent-bills complete when all five hold. Phase 8c
(`recent_votes`) follows in its own plan doc.

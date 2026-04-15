# Phase 9e — Bill-listing pagination + high-cost confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `max(20)` / `max(50)` zod caps on
`recent_bills.limit` and `list_bills.limit`. Pagination is added to
the OpenStates and Congress.gov bill-listing adapter methods so any
acknowledged `limit` value is honored. A confirmation gate at
`limit > 500` returns a cost-estimate envelope (no upstream fetch)
until the caller passes `acknowledge_high_cost: true`.

**Architecture:** A new shared module `src/mcp/cost_estimate.ts`
holds the threshold constant, the per-source cost calculation, and
the `RequiresConfirmationResponse` shape. Both bill-listing handlers
short-circuit through this module before calling `withShapedFetch`.
The OpenStates adapter's shared helper `fetchAndUpsertBillsFromUrl`
grows a `target` parameter and loops `page=1..N` with
`per_page=20`. `CongressAdapter.fetchRecentBills` similarly loops
on `offset=0,250,...` with `limit=250`. `acknowledge_high_cost` is
a control flag and does NOT join the `withShapedFetch` args bag, so
the warning call and the executing call resolve to the same cache
row (only the executing call ever populates it).

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`,
`better-sqlite3`, `vitest`. HTTP mocking via `vi.spyOn(global, "fetch")`
following the existing adapter test pattern.

---

## Scope impact

This sub-phase updates the following docs in Task 7:

- `docs/06-open-decisions.md` — appends **D12 amendment (2026-04-14)**.
- `docs/00-rationale.md` — appends **R18 (2026-04-14)**.
- `docs/05-tool-surface.md` — updates `recent_bills` and `list_bills`
  input blocks to document `acknowledge_high_cost` and the
  confirmation envelope return shape.
- `CHANGELOG.md` — adds an unreleased entry.

---

## File structure

```
src/
├── mcp/
│   ├── cost_estimate.ts             # NEW: shared cost helper
│   ├── schemas.ts                   # MODIFIED: drop .max(), + acknowledge_high_cost
│   └── tools/
│       ├── recent_bills.ts          # MODIFIED: confirmation gate, thread target
│       └── list_bills.ts            # MODIFIED: confirmation gate, thread target
└── adapters/
    ├── openstates.ts                # MODIFIED: pagination in fetchAndUpsertBillsFromUrl
    └── congress.ts                  # MODIFIED: pagination in fetchRecentBills
tests/
└── unit/
    ├── mcp/
    │   ├── cost_estimate.test.ts    # NEW
    │   └── tools/
    │       ├── recent_bills.test.ts # MODIFIED
    │       └── list_bills.test.ts   # MODIFIED
    └── adapters/
        ├── openstates.test.ts       # MODIFIED
        └── congress.test.ts         # MODIFIED
docs/
├── 00-rationale.md                  # MODIFIED: + R18
├── 05-tool-surface.md               # MODIFIED
├── 06-open-decisions.md             # MODIFIED: + D12 amendment
└── plans/
    └── phase-9e-bill-pagination.md  # this file
CHANGELOG.md                         # MODIFIED
```

---

## Task 1: Shared `cost_estimate` module

**Files:**
- Create: `src/mcp/cost_estimate.ts`
- Create: `tests/unit/mcp/cost_estimate.test.ts`

The threshold (500), the per-source page sizes (OpenStates 20,
Congress.gov 250), the per-source budgets (OpenStates 500/day,
Congress.gov 5000/hour), and the response-token estimate (150 per
bill) all live as module-private constants. `isHighCostLimit` is
the sole gate predicate; `buildConfirmationResponse` is the sole
producer of `RequiresConfirmationResponse`. Both handlers depend
only on this module's exports — no inline math elsewhere.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/mcp/cost_estimate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  isHighCostLimit,
  buildConfirmationResponse,
  HIGH_COST_THRESHOLD,
} from "../../../src/mcp/cost_estimate.js";

describe("cost_estimate", () => {
  it("HIGH_COST_THRESHOLD is 500", () => {
    expect(HIGH_COST_THRESHOLD).toBe(500);
  });

  it("isHighCostLimit returns false for limit <= 500", () => {
    expect(isHighCostLimit(1)).toBe(false);
    expect(isHighCostLimit(500)).toBe(false);
  });

  it("isHighCostLimit returns true for limit > 500", () => {
    expect(isHighCostLimit(501)).toBe(true);
    expect(isHighCostLimit(1000)).toBe(true);
  });

  it("buildConfirmationResponse for openstates computes 20-row pages and daily budget", () => {
    const r = buildConfirmationResponse("openstates", 1000);
    expect(r.requires_confirmation).toBe(true);
    expect(r.requested_limit).toBe(1000);
    expect(r.estimated_cost.upstream_calls).toBe(50);
    expect(r.estimated_cost.openstates_daily_budget_pct).toBe(10);
    expect(r.estimated_cost.congress_hourly_budget_pct).toBeUndefined();
    expect(r.estimated_cost.response_tokens_estimate).toBe(150_000);
    expect(r.message).toContain("50 OpenStates requests");
    expect(r.message).toContain("acknowledge_high_cost: true");
  });

  it("buildConfirmationResponse for congress computes 250-row pages and hourly budget", () => {
    const r = buildConfirmationResponse("congress", 1000);
    expect(r.estimated_cost.upstream_calls).toBe(4);
    expect(r.estimated_cost.congress_hourly_budget_pct).toBeCloseTo(0.08, 2);
    expect(r.estimated_cost.openstates_daily_budget_pct).toBeUndefined();
    expect(r.message).toContain("4 Congress.gov requests");
  });

  it("upstream_calls rounds up for non-multiple sizes", () => {
    expect(buildConfirmationResponse("openstates", 501).estimated_cost.upstream_calls).toBe(26);
    expect(buildConfirmationResponse("congress", 501).estimated_cost.upstream_calls).toBe(3);
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `pnpm vitest tests/unit/mcp/cost_estimate.test.ts -r`
Expected: FAIL with module-not-found error.

- [ ] **Step 3: Create the module**

Create `src/mcp/cost_estimate.ts`:

```ts
export const HIGH_COST_THRESHOLD = 500;

const OPENSTATES_PAGE_SIZE = 20;
const CONGRESS_PAGE_SIZE = 250;
const OPENSTATES_DAILY_BUDGET = 500;
const CONGRESS_HOURLY_BUDGET = 5000;
const TOKENS_PER_BILL = 150;

export interface CostEstimate {
  upstream_calls: number;
  openstates_daily_budget_pct?: number;
  congress_hourly_budget_pct?: number;
  response_tokens_estimate: number;
}

export interface RequiresConfirmationResponse {
  requires_confirmation: true;
  requested_limit: number;
  estimated_cost: CostEstimate;
  message: string;
}

export function isHighCostLimit(limit: number): boolean {
  return limit > HIGH_COST_THRESHOLD;
}

export function buildConfirmationResponse(
  source: "openstates" | "congress",
  limit: number,
): RequiresConfirmationResponse {
  const isOpenStates = source === "openstates";
  const pageSize = isOpenStates ? OPENSTATES_PAGE_SIZE : CONGRESS_PAGE_SIZE;
  const upstream_calls = Math.ceil(limit / pageSize);
  const estimated_cost: CostEstimate = {
    upstream_calls,
    response_tokens_estimate: limit * TOKENS_PER_BILL,
  };
  if (isOpenStates) {
    estimated_cost.openstates_daily_budget_pct =
      (upstream_calls / OPENSTATES_DAILY_BUDGET) * 100;
  } else {
    estimated_cost.congress_hourly_budget_pct =
      (upstream_calls / CONGRESS_HOURLY_BUDGET) * 100;
  }
  const sourceName = isOpenStates ? "OpenStates" : "Congress.gov";
  const pct = isOpenStates
    ? estimated_cost.openstates_daily_budget_pct
    : estimated_cost.congress_hourly_budget_pct;
  const period = isOpenStates ? "today's" : "this hour's";
  return {
    requires_confirmation: true,
    requested_limit: limit,
    estimated_cost,
    message:
      `This call will issue ${upstream_calls} ${sourceName} requests ` +
      `(~${pct!.toFixed(2)}% of ${period} budget). ` +
      `Re-call with acknowledge_high_cost: true to proceed.`,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest tests/unit/mcp/cost_estimate.test.ts -r`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/cost_estimate.ts tests/unit/mcp/cost_estimate.test.ts
git commit -m "feat(cost_estimate): shared high-cost confirmation helper for bill-listing tools"
```

---

## Task 2: OpenStates adapter pagination

**Files:**
- Modify: `src/adapters/openstates.ts:356` (`fetchAndUpsertBillsFromUrl`)
- Modify: `src/adapters/openstates.ts:279` (`fetchRecentBills`)
- Modify: `src/adapters/openstates.ts:309` (`listBills`)
- Modify: `tests/unit/adapters/openstates.test.ts`

The shared helper `fetchAndUpsertBillsFromUrl` accepts a new
optional `target` parameter. When set and `> 20`, the helper sets
`per_page=20` and loops `page=1..N` until accumulated upserts ≥
`target` or `body.pagination.max_page` terminates. Both
`fetchRecentBills` and `listBills` thread their `opts.limit`
through as `target` (no need to compute pages — the helper does
it). Existing single-page callers (callers without `target`)
continue to behave as today.

The adapter does NOT truncate; the handler's existing
`projectLocal()` enforces the final row cap at `limit`.

- [ ] **Step 1: Write the failing pagination test**

Append to `tests/unit/adapters/openstates.test.ts`, inside the
existing `describe("OpenStatesAdapter.fetchRecentBills", ...)`
block:

```ts
    it("paginates when limit > 20", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: any) => {
        const u = new URL(String(url));
        const page = parseInt(u.searchParams.get("page") ?? "1", 10);
        const bills = Array.from({ length: 20 }, (_, i) => ({
          ...SAMPLE_BILL,
          id: `ocd-bill/p${page}-${i}`,
          identifier: `HB${page}${String(i).padStart(2, "0")}`,
        }));
        return new Response(
          JSON.stringify({
            results: bills,
            pagination: { max_page: 3, page },
          }),
          { status: 200 },
        );
      });
      vi.spyOn(global, "fetch").mockImplementation(fetchMock);

      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      const result = await adapter.fetchRecentBills(store.db, {
        jurisdiction: "us-tx",
        limit: 50,
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.documentsUpserted).toBe(60);
    });

    it("stops at pagination.max_page even when limit not yet met", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: any) => {
        const u = new URL(String(url));
        const page = parseInt(u.searchParams.get("page") ?? "1", 10);
        const bills = Array.from({ length: 20 }, (_, i) => ({
          ...SAMPLE_BILL,
          id: `ocd-bill/p${page}-${i}`,
          identifier: `HB${page}${String(i).padStart(2, "0")}`,
        }));
        return new Response(
          JSON.stringify({
            results: bills,
            pagination: { max_page: 2, page },
          }),
          { status: 200 },
        );
      });
      vi.spyOn(global, "fetch").mockImplementation(fetchMock);

      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      const result = await adapter.fetchRecentBills(store.db, {
        jurisdiction: "us-tx",
        limit: 100,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.documentsUpserted).toBe(40);
    });

    it("makes a single fetch when limit <= 20", async () => {
      const fetchMock = vi.fn().mockImplementation(async () =>
        new Response(
          JSON.stringify({
            results: [SAMPLE_BILL],
            pagination: { max_page: 1, page: 1 },
          }),
          { status: 200 },
        ),
      );
      vi.spyOn(global, "fetch").mockImplementation(fetchMock);

      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      await adapter.fetchRecentBills(store.db, { jurisdiction: "us-tx", limit: 5 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `pnpm vitest tests/unit/adapters/openstates.test.ts -r -t "paginates when limit > 20"`
Expected: FAIL — single fetch made, not 3.

- [ ] **Step 3: Modify `fetchAndUpsertBillsFromUrl` to paginate**

In `src/adapters/openstates.ts`, replace the existing
`fetchAndUpsertBillsFromUrl` (lines 348-397) with:

```ts
  /** Shared fetch + write-through loop for the three /bills-shaped
   *  adapter methods. When `target` is set and > 20, loops pages of
   *  per_page=20 until accumulated upserts >= target or the
   *  upstream's pagination.max_page terminates. Does NOT truncate to
   *  exactly `target` — extras land in the local DB cache for future
   *  hits; the handler's local projection enforces the final cap. */
  private async fetchAndUpsertBillsFromUrl(
    db: Database.Database,
    url: URL,
    opts?: { chamber?: "upper" | "lower"; target?: number },
  ): Promise<{ documentsUpserted: number }> {
    const target = opts?.target;
    if (target !== undefined && target > 20) {
      url.searchParams.set("per_page", "20");
    }
    let documentsUpserted = 0;
    let page = 1;
    while (true) {
      url.searchParams.set("page", String(page));
      const res = await rateLimitedFetch(url.toString(), {
        userAgent: "civic-awareness-mcp/0.1.0 (+github)",
        rateLimiter: this.rateLimiter,
        headers: { "X-API-KEY": this.opts.apiKey },
      });
      if (!res.ok) throw new Error(`OpenStates ${url.pathname} returned ${res.status}`);
      const body = (await res.json()) as {
        results?: OpenStatesBill[];
        pagination?: { max_page?: number; page?: number };
      };
      for (const b of body.results ?? []) {
        if (opts?.chamber) {
          const classification = b.from_organization?.classification;
          if (classification && classification !== opts.chamber) {
            logger.debug("openstates chamber filter: skipping bill", {
              billId: b.id,
              identifier: b.identifier,
              from_organization: classification,
              requested: opts.chamber,
            });
            continue;
          }
        }
        try {
          this.upsertBill(db, b);
        } catch (err) {
          logger.warn("openstates upsertBill threw — skipping record", {
            endpoint: "fetchAndUpsertBillsFromUrl",
            billId: b.id,
            identifier: b.identifier,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        documentsUpserted += 1;
      }
      if (target === undefined || target <= 20) break;
      if (documentsUpserted >= target) break;
      const maxPage = body.pagination?.max_page ?? page;
      if (page >= maxPage) break;
      page += 1;
    }
    return { documentsUpserted };
  }
```

- [ ] **Step 4: Thread `target` through `fetchRecentBills`**

In `src/adapters/openstates.ts`, replace the final return of
`fetchRecentBills` (currently line 297):

```ts
    return this.fetchAndUpsertBillsFromUrl(db, url, {
      chamber: opts.chamber,
      target: opts.limit,
    });
```

The `per_page` set on line 292 (`opts.limit ?? 20`) stays — it
seeds the first page when target ≤ 20, and the helper overwrites
it to 20 when target > 20.

- [ ] **Step 5: Thread `target` through `listBills`**

In `src/adapters/openstates.ts`, replace the final return of
`listBills` (currently line 345):

```ts
    return this.fetchAndUpsertBillsFromUrl(db, url, {
      chamber: opts.chamber,
      target: opts.limit,
    });
```

- [ ] **Step 6: Run all openstates adapter tests**

Run: `pnpm vitest tests/unit/adapters/openstates.test.ts -r`
Expected: all tests PASS, including the three new pagination tests.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/openstates.ts tests/unit/adapters/openstates.test.ts
git commit -m "feat(openstates): paginate /bills fetches when target limit > 20"
```

---

## Task 3: Congress.gov adapter pagination

**Files:**
- Modify: `src/adapters/congress.ts:261` (`fetchRecentBills`)
- Modify: `tests/unit/adapters/congress.test.ts`

`CongressAdapter.fetchRecentBills` grows pagination via `offset`.
The Congress.gov `/bill` endpoint accepts `limit` (max 250) and
`offset` query params. The loop runs with `limit=250` and
`offset=0,250,500,...` until accumulated upserts ≥ `target` or
upstream returns an empty `bills` array.

- [ ] **Step 1: Write the failing test**

Find the existing `describe("CongressAdapter.fetchRecentBills", ...)`
block in `tests/unit/adapters/congress.test.ts` (use grep). Append:

```ts
    it("paginates via offset when limit > 250", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: any) => {
        const u = new URL(String(url));
        const offset = parseInt(u.searchParams.get("offset") ?? "0", 10);
        const bills = Array.from({ length: 250 }, (_, i) => ({
          ...SAMPLE_FEDERAL_BILL,
          number: `${offset + i + 1}`,
          updateDate: "2026-04-01",
        }));
        return new Response(JSON.stringify({ bills }), { status: 200 });
      });
      vi.spyOn(global, "fetch").mockImplementation(fetchMock);

      const adapter = new CongressAdapter({
        apiKey: "test-key",
        congresses: [119],
      });
      const result = await adapter.fetchRecentBills(db.db, {
        fromDateTime: "2026-04-01T00:00:00Z",
        limit: 600,
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.documentsUpserted).toBe(750);
    });

    it("stops on empty page even when target not met", async () => {
      let calls = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        calls += 1;
        const bills = calls === 1
          ? Array.from({ length: 250 }, (_, i) => ({
              ...SAMPLE_FEDERAL_BILL,
              number: String(i + 1),
              updateDate: "2026-04-01",
            }))
          : [];
        return new Response(JSON.stringify({ bills }), { status: 200 });
      });
      vi.spyOn(global, "fetch").mockImplementation(fetchMock);

      const adapter = new CongressAdapter({
        apiKey: "test-key",
        congresses: [119],
      });
      const result = await adapter.fetchRecentBills(db.db, {
        fromDateTime: "2026-04-01T00:00:00Z",
        limit: 600,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.documentsUpserted).toBe(250);
    });
```

If `SAMPLE_FEDERAL_BILL` is not already defined in the test file,
inspect existing tests in the same `describe` block for the fixture
they use and copy the same shape.

- [ ] **Step 2: Run the failing tests**

Run: `pnpm vitest tests/unit/adapters/congress.test.ts -r -t "paginates via offset"`
Expected: FAIL — single fetch only.

- [ ] **Step 3: Modify `fetchRecentBills` to paginate**

In `src/adapters/congress.ts`, replace the body of
`fetchRecentBills` (lines 261-294) with:

```ts
  async fetchRecentBills(
    db: Database.Database,
    opts: { fromDateTime: string; chamber?: "upper" | "lower"; limit?: number },
  ): Promise<{ documentsUpserted: number }> {
    const congress = this.congresses[0];
    const target = opts.limit;
    const pageSize = 250;

    const chamberMatch = (billType: string): boolean => {
      if (!opts.chamber) return true;
      const senate = billType.toUpperCase().startsWith("S");
      return opts.chamber === "upper" ? senate : !senate;
    };

    let documentsUpserted = 0;
    let offset = 0;
    while (true) {
      const url = new URL(`${BASE_URL}/bill`);
      url.searchParams.set("congress", String(congress));
      url.searchParams.set("fromDateTime", opts.fromDateTime.replace(/\.\d{3}Z$/, "Z"));
      url.searchParams.set("sort", "updateDate+desc");
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("api_key", this.opts.apiKey);
      url.searchParams.set("format", "json");

      const res = await rateLimitedFetch(url.toString(), {
        userAgent: "civic-awareness-mcp/0.1.0 (+github)",
        rateLimiter: this.rateLimiter,
      });
      if (!res.ok) throw new Error(`Congress.gov /bill returned ${res.status}`);
      const body = (await res.json()) as { bills?: CongressBill[] };
      const bills = body.bills ?? [];
      if (bills.length === 0) break;

      for (const b of bills) {
        if (!chamberMatch(b.type)) continue;
        this.upsertBill(db, b);
        documentsUpserted += 1;
      }

      if (target === undefined) break;
      if (documentsUpserted >= target) break;
      offset += pageSize;
    }
    return { documentsUpserted };
  }
```

- [ ] **Step 4: Run all congress adapter tests**

Run: `pnpm vitest tests/unit/adapters/congress.test.ts -r`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/congress.ts tests/unit/adapters/congress.test.ts
git commit -m "feat(congress): paginate /bill fetches via offset when target limit > 250"
```

---

## Task 4: Schema changes

**Files:**
- Modify: `src/mcp/schemas.ts:3-17` (`RecentBillsInput`)
- Modify: `src/mcp/schemas.ts:89-105` (`ListBillsInput`)

Drop `.max(20)` from `RecentBillsInput.limit` and `.max(50)` from
`ListBillsInput.limit`. Add `acknowledge_high_cost: z.boolean().optional()`
to both. The schemas import nothing new.

- [ ] **Step 1: Apply schema edits**

In `src/mcp/schemas.ts`, replace the `RecentBillsInput.limit`
declaration:

```ts
  // Optional row cap. When set, the handler drops the days-derived
  // `updated_since` upstream filter and returns top-N by
  // OpenStates' native `sort=updated_desc` / Congress.gov's
  // `sort=updateDate+desc`. Use to query biennial or off-session
  // jurisdictions where the time window is empty. See D12 / R16.
  // No upper bound — the handler's confirmation gate (R18) returns
  // a `requires_confirmation` envelope for limit > 500 until the
  // caller passes `acknowledge_high_cost: true`.
  limit: z.number().int().min(1).optional(),
  acknowledge_high_cost: z.boolean().optional(),
```

In `src/mcp/schemas.ts`, replace the `ListBillsInput.limit`
declaration:

```ts
  limit: z.number().int().min(1).default(20),
  acknowledge_high_cost: z.boolean().optional(),
```

- [ ] **Step 2: Run typechecker**

Run: `pnpm tsc --noEmit`
Expected: PASS (no type errors). The handler files don't yet
reference `acknowledge_high_cost`, but the new field is optional
so existing destructures still type-check.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/schemas.ts
git commit -m "feat(schemas): drop bill-listing limit caps; add acknowledge_high_cost"
```

---

## Task 5: `recent_bills` confirmation gate

**Files:**
- Modify: `src/mcp/tools/recent_bills.ts:117` (`handleRecentBills`)
- Modify: `src/mcp/tools/recent_bills.ts:35` (`RecentBillsResponse` type)
- Modify: `tests/unit/mcp/tools/recent_bills.test.ts`

The handler now branches on `isHighCostLimit(input.limit) &&
!input.acknowledge_high_cost`. When that branch fires, the handler
returns a `RequiresConfirmationResponse` and skips `withShapedFetch`
entirely (no upstream call, no cache write). The wildcard
jurisdiction `"*"` short-circuits before the gate check (local-only
path does no upstream work regardless of `limit`).

The handler's response type becomes a discriminated union.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/mcp/tools/recent_bills.test.ts`. Add a new
`describe` block at the bottom of the file:

```ts
describe("recent_bills tool — high-cost confirmation gate", () => {
  it("returns confirmation envelope when limit > 500 without acknowledgement", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(global, "fetch").mockImplementation(fetchMock);

    const result = await handleRecentBills(store.db, {
      jurisdiction: "us-ca",
      days: 7,
      limit: 1000,
    });

    expect("requires_confirmation" in result && result.requires_confirmation).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    if ("requires_confirmation" in result) {
      expect(result.requested_limit).toBe(1000);
      expect(result.estimated_cost.upstream_calls).toBe(50);
      expect(result.estimated_cost.openstates_daily_budget_pct).toBe(10);
    }
  });

  it("executes when limit > 500 with acknowledge_high_cost: true", async () => {
    seedFetchLogFresh("openstates", "/bills", {
      jurisdiction: "us-ca",
      days: 7,
      chamber: undefined,
      session: undefined,
      limit: 1000,
    });
    const result = await handleRecentBills(store.db, {
      jurisdiction: "us-ca",
      days: 7,
      limit: 1000,
      acknowledge_high_cost: true,
    });

    expect("results" in result).toBe(true);
    expect("requires_confirmation" in result).toBe(false);
  });

  it("does not gate at limit = 500 (boundary)", async () => {
    seedFetchLogFresh("openstates", "/bills", {
      jurisdiction: "us-ca",
      days: 7,
      chamber: undefined,
      session: undefined,
      limit: 500,
    });
    const result = await handleRecentBills(store.db, {
      jurisdiction: "us-ca",
      days: 7,
      limit: 500,
    });

    expect("requires_confirmation" in result).toBe(false);
  });

  it("uses congress source costing for us-federal", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(global, "fetch").mockImplementation(fetchMock);

    const result = await handleRecentBills(store.db, {
      jurisdiction: "us-federal",
      days: 7,
      limit: 1000,
    });

    expect("requires_confirmation" in result && result.requires_confirmation).toBe(true);
    if ("requires_confirmation" in result) {
      expect(result.estimated_cost.upstream_calls).toBe(4);
      expect(result.estimated_cost.congress_hourly_budget_pct).toBeCloseTo(0.08, 2);
      expect(result.estimated_cost.openstates_daily_budget_pct).toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not gate wildcard jurisdiction even with limit > 500", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(global, "fetch").mockImplementation(fetchMock);

    const result = await handleRecentBills(store.db, {
      jurisdiction: "*",
      days: 7,
      limit: 1000,
    });

    expect("requires_confirmation" in result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `pnpm vitest tests/unit/mcp/tools/recent_bills.test.ts -r -t "high-cost confirmation gate"`
Expected: FAIL — handler returns `RecentBillsResponse`, not the
envelope shape.

- [ ] **Step 3: Modify the response type**

In `src/mcp/tools/recent_bills.ts`, add the import at the top:

```ts
import {
  isHighCostLimit,
  buildConfirmationResponse,
  type RequiresConfirmationResponse,
} from "../cost_estimate.js";
```

Then change the function signature of `handleRecentBills`
(currently line 117) to return the union:

```ts
export async function handleRecentBills(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentBillsResponse | RequiresConfirmationResponse> {
```

- [ ] **Step 4: Add the gate**

In `src/mcp/tools/recent_bills.ts`, immediately after the
`const input = RecentBillsInput.parse(rawInput);` line (currently
line 121), insert the wildcard short-circuit + gate:

```ts
  // Wildcard short-circuit happens further down (local-only); the
  // gate only applies to upstream-bound jurisdictions.
  if (
    input.jurisdiction !== "*" &&
    input.limit !== undefined &&
    isHighCostLimit(input.limit) &&
    input.acknowledge_high_cost !== true
  ) {
    const source = input.jurisdiction === "us-federal" ? "congress" : "openstates";
    return buildConfirmationResponse(source, input.limit);
  }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest tests/unit/mcp/tools/recent_bills.test.ts -r`
Expected: all tests PASS, including the five new gate tests.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/recent_bills.ts tests/unit/mcp/tools/recent_bills.test.ts
git commit -m "feat(recent_bills): high-cost confirmation gate at limit > 500"
```

---

## Task 6: `list_bills` confirmation gate

**Files:**
- Modify: `src/mcp/tools/list_bills.ts:11-14` (imports)
- Modify: `src/mcp/tools/list_bills.ts:61-65` (handler signature + parse)
- Modify: `src/mcp/tools/list_bills.ts:68-80` (insert gate after federal short-circuit)
- Modify: `tests/unit/mcp/tools/list_bills.test.ts`

`list_bills` already short-circuits with `not_yet_supported` for
`us-federal` at line 68. The gate goes immediately AFTER that
federal check so federal callers get `not_yet_supported` (no
upstream cost) before the gate considers them. For state
jurisdictions, the gate's source is always `"openstates"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/mcp/tools/list_bills.test.ts`. Use the same
helpers and `beforeEach` setup as the file's existing tests
(check the top of the file — the pattern matches `recent_bills.test.ts`):

```ts
describe("list_bills tool — high-cost confirmation gate", () => {
  it("returns confirmation envelope when limit > 500 without acknowledgement", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(global, "fetch").mockImplementation(fetchMock);

    const result = await handleListBills(store.db, {
      jurisdiction: "us-ca",
      limit: 1000,
    });

    expect("requires_confirmation" in result && result.requires_confirmation).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    if ("requires_confirmation" in result) {
      expect(result.requested_limit).toBe(1000);
      expect(result.estimated_cost.openstates_daily_budget_pct).toBe(10);
    }
  });

  it("does not gate at limit = 500 (boundary)", async () => {
    const result = await handleListBills(store.db, {
      jurisdiction: "us-ca",
      limit: 500,
    });
    expect("requires_confirmation" in result).toBe(false);
  });

  it("federal short-circuit fires before the gate (returns not_yet_supported, not envelope)", async () => {
    const result = await handleListBills(store.db, {
      jurisdiction: "us-federal",
      limit: 1000,
    });
    expect("requires_confirmation" in result).toBe(false);
    expect("stale_notice" in result && result.stale_notice?.reason).toBe("not_yet_supported");
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `pnpm vitest tests/unit/mcp/tools/list_bills.test.ts -r -t "high-cost confirmation gate"`
Expected: FAIL — handler returns the normal `ListBillsResponse`
shape, no `requires_confirmation` discriminator.

- [ ] **Step 3: Add the import**

In `src/mcp/tools/list_bills.ts`, add after the existing import
block (insert as a new import statement around line 11):

```ts
import {
  isHighCostLimit,
  buildConfirmationResponse,
  type RequiresConfirmationResponse,
} from "../cost_estimate.js";
```

- [ ] **Step 4: Update the handler signature**

In `src/mcp/tools/list_bills.ts`, change the function signature
of `handleListBills` (currently lines 61-64):

```ts
export async function handleListBills(
  db: Database.Database,
  rawInput: unknown,
): Promise<ListBillsResponse | RequiresConfirmationResponse> {
```

- [ ] **Step 5: Insert the gate after the federal short-circuit**

In `src/mcp/tools/list_bills.ts`, find the end of the federal
short-circuit block (the closing `}` of the `if (input.jurisdiction
=== "us-federal")` block — see line 80 area for the start). Add
the gate immediately after that closing `}`:

```ts
  // High-cost confirmation gate (R18). Federal short-circuited
  // above; only state jurisdictions reach this point.
  if (isHighCostLimit(input.limit) && input.acknowledge_high_cost !== true) {
    return buildConfirmationResponse("openstates", input.limit);
  }
```

`list_bills` has `default(20)` on `limit`, so `input.limit` is
always defined — no `!== undefined` check needed.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest tests/unit/mcp/tools/list_bills.test.ts -r`
Expected: all tests PASS, including the three new gate tests.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/list_bills.ts tests/unit/mcp/tools/list_bills.test.ts
git commit -m "feat(list_bills): high-cost confirmation gate at limit > 500"
```

---

## Task 7: Docs + CHANGELOG

**Files:**
- Modify: `docs/06-open-decisions.md`
- Modify: `docs/00-rationale.md`
- Modify: `docs/05-tool-surface.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Append D12 amendment**

Find the `## D12` section in `docs/06-open-decisions.md` (use grep
for `## D12`). Append after the existing decision text:

```markdown

**Amended 2026-04-14 (R18):** The `max(20)` / `max(50)` caps on
bill-listing tool `limit` parameters are removed. Tools now honor
any `limit` value, returning a `requires_confirmation` envelope
(no upstream fetch) for `limit > 500` until the caller passes
`acknowledge_high_cost: true`. Pagination is added to the
OpenStates and Congress.gov bill-listing adapter methods. See R18
in `docs/00-rationale.md` and
`docs/plans/phase-9e-bill-pagination.md`.
```

- [ ] **Step 2: Append R18 to rationale**

Append to the bottom of `docs/00-rationale.md`:

```markdown

## R18 — Honor caller-requested `limit`, gate at >500 for confirmation (2026-04-14)

D12 (2026-04-14) introduced `limit` on feed tools with a
`max(20)` cap matching OpenStates `/bills` `per_page`. A real
test session showed the cap is the wrong shape: a caller asking
for 30 bills hit the friction immediately, and biennial-state
queries routinely want 50–200 in one shot.

The user's stance: tools should not impose caps as a design
choice — they should honor the caller's request and only push
back when honoring it would impose a real, quantifiable cost.

The real cost is the OpenStates 500/day rate budget, not the
upstream API's per-call ceiling. OpenStates won't reject
`per_page=20, page=5000` — it will return empty pages forever
and charge a request for each. One confused `limit=100000`
call drains the daily budget for every other tool sharing the
process.

R18 keeps the principle (honor the caller) but adds a
confirmation gate above an intuitive threshold (500). The gate
is a soft barrier — the caller passes `acknowledge_high_cost`
to proceed — not a hard cap. Pagination is added to the
adapters so any acknowledged request executes correctly.

Threshold is literal `limit > 500`, not per-source budget
percentage. Federal queries below 500 are trivial cost-wise;
the symmetric threshold is simpler to explain and document.

Locked in phase-9e (`docs/plans/phase-9e-bill-pagination.md`).
```

- [ ] **Step 3: Update tool surface doc**

In `docs/05-tool-surface.md`, find the `recent_bills` and
`list_bills` input blocks (use grep for `### recent_bills` and
`### list_bills` or similar headers). For each, document the new
`acknowledge_high_cost` field and the alternate response shape.

For `recent_bills`, add to its input table (or wherever inputs are
documented):

```markdown
| `limit` | number? | min 1, no upper cap. When > 500, requires `acknowledge_high_cost: true` or returns confirmation envelope. |
| `acknowledge_high_cost` | boolean? | Acknowledges the cost estimate from a prior `requires_confirmation` response. Required for `limit > 500`. |
```

And add a short section explaining the alternate response shape:

```markdown
**Confirmation envelope.** When `limit > 500` and
`acknowledge_high_cost !== true`, the response is:

\`\`\`json
{
  "requires_confirmation": true,
  "requested_limit": 1000,
  "estimated_cost": {
    "upstream_calls": 50,
    "openstates_daily_budget_pct": 10,
    "response_tokens_estimate": 150000
  },
  "message": "This call will issue 50 OpenStates requests..."
}
\`\`\`

No upstream fetch is made. Re-call with `acknowledge_high_cost:
true` to execute.
```

Mirror the same additions under the `list_bills` section.

- [ ] **Step 4: Add CHANGELOG entry**

In `CHANGELOG.md`, find the `## Unreleased` block and append under
its `### Changed` subsection (create the subsection if it doesn't
exist):

```markdown
- `recent_bills` and `list_bills`: removed the 20/50 caps on
  `limit`. Both tools now honor any caller-provided `limit`. When
  `limit > 500`, the tool returns a `requires_confirmation`
  envelope (no upstream fetch) until the caller passes
  `acknowledge_high_cost: true`. OpenStates and Congress.gov
  adapters paginate underneath. See R18, D12 amendment. (phase-9e)
```

- [ ] **Step 5: Verify all docs render**

Run: `pnpm tsc --noEmit && pnpm vitest run`
Expected: PASS (full test suite). The doc changes are markdown
only and don't affect type-checking, but running the full suite
confirms nothing regressed across the phase.

- [ ] **Step 6: Commit**

```bash
git add docs/06-open-decisions.md docs/00-rationale.md docs/05-tool-surface.md CHANGELOG.md
git commit -m "docs: phase-9e bill-listing pagination + high-cost gate (R18)"
```

---

## Post-execution verification

After all tasks land, run:

```bash
pnpm tsc --noEmit
pnpm vitest run
```

Both must pass before the phase is complete.

Manual smoke (optional, requires real OpenStates API key):

```bash
node --import tsx scripts/smoke-r15.ts
```

Or invoke the MCP tool directly via Claude Desktop / Claude Code
with `recent_bills(jurisdiction="us-ca", limit=30)` and confirm 30
bills are returned. Then try `limit=1000` and confirm the
confirmation envelope arrives without upstream fetch.

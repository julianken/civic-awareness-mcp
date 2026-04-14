# Phase 8d — `recent_contributions` Vertical Rewrite Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`.

**Goal:** Migrate `recent_contributions` off `ensureFresh` onto `withShapedFetch`. OpenFEC is federal-only; narrow fetcher uses `min_date`/`max_date` on `/schedules/schedule_a`. Candidate/committee resolution remains client-side (normalized-name LIKE search over local `entities`).

**Architecture:** Same shape as phase-8b/c. Single OpenFEC adapter method; handler rewrite; unit test rewrite; integration cleanup.

---

## File structure

```
src/
├── adapters/openfec.ts                 # MODIFIED: + fetchRecentContributions
└── mcp/tools/recent_contributions.ts    # MODIFIED: withShapedFetch orchestrator
tests/
├── integration/
│   ├── openfec-e2e.test.ts              # MODIFIED (if it has R13 scenarios)
│   ├── passthrough-e2e.test.ts          # MODIFIED (drop recent_contributions R13 scenarios if present)
│   └── passthrough-e2e.shaped.test.ts   # MODIFIED: + recent_contributions scenarios
└── unit/
    ├── adapters/openfec.test.ts         # MODIFIED: + fetchRecentContributions tests
    └── mcp/tools/recent_contributions.test.ts  # MODIFIED: mock adapter
```

---

## Task 1: OpenFEC `fetchRecentContributions` narrow method

**Files:** `src/adapters/openfec.ts`, `tests/unit/adapters/openfec.test.ts`

Narrow one-page fetch using OpenFEC's native date filters. OpenFEC's `min_date`/`max_date` filter by REPORTING date (form filing), not contribution-receipt date — that's a known caveat but V1 accepts it (sort client-side by receipt date if needed in a later polish).

- [ ] **Step 1: Failing tests**

Append to `tests/unit/adapters/openfec.test.ts`:

```ts
describe("OpenFECAdapter.fetchRecentContributions", () => {
  it("fetches schedule_a page with date range", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        results: [{
          transaction_id: "T1", committee_id: "C001",
          contributor_name: "SMITH, JANE",
          contribution_receipt_amount: 2500,
          contribution_receipt_date: "2026-04-10",
        }],
        pagination: { per_page: 100 },
      }), { status: 200 }),
    );

    const adapter = new OpenFECAdapter({ apiKey: "test-key" });
    const result = await adapter.fetchRecentContributions(store.db, {
      min_date: "04/01/2026",
      max_date: "04/30/2026",
    });

    expect(result.documentsUpserted).toBe(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/\/schedules\/schedule_a/);
    expect(url).toMatch(/min_date=04%2F01%2F2026/);
    expect(url).toMatch(/max_date=04%2F30%2F2026/);
    expect(url).toMatch(/api_key=test-key/);
    const written = store.db.prepare(
      "SELECT kind FROM documents WHERE source_name='openfec' AND kind='contribution'",
    ).all();
    expect(written).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("passes committee_id when provided", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [], pagination: { per_page: 100 } }), { status: 200 }),
    );

    const adapter = new OpenFECAdapter({ apiKey: "test-key" });
    await adapter.fetchRecentContributions(store.db, {
      min_date: "04/01/2026",
      committee_ids: ["C001", "C002"],
    });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/committee_id=C001/);
    expect(url).toMatch(/committee_id=C002/);
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run — fails on missing method.**

- [ ] **Step 3: Implement.** Use the existing `upsertContribution` private method (or equivalent) inside the adapter:

```ts
async fetchRecentContributions(
  db: Database.Database,
  opts: { min_date: string; max_date?: string; committee_ids?: string[]; limit?: number },
): Promise<{ documentsUpserted: number }> {
  const url = new URL(`${BASE_URL}/schedules/schedule_a/`);
  url.searchParams.set("min_date", opts.min_date);
  if (opts.max_date) url.searchParams.set("max_date", opts.max_date);
  for (const id of opts.committee_ids ?? []) {
    url.searchParams.append("committee_id", id);
  }
  url.searchParams.set("per_page", String(opts.limit ?? 100));
  url.searchParams.set("sort", "-contribution_receipt_date");
  url.searchParams.set("api_key", this.opts.apiKey);

  const res = await rateLimitedFetch(url.toString(), {
    userAgent: "civic-awareness-mcp/0.1.0 (+github)",
    rateLimiter: this.rateLimiter,
  });
  if (!res.ok) throw new Error(`OpenFEC /schedules/schedule_a returned ${res.status}`);
  const body = (await res.json()) as { results?: FecScheduleA[] };

  let documentsUpserted = 0;
  for (const c of body.results ?? []) {
    this.upsertContribution(db, c);
    documentsUpserted += 1;
  }
  return { documentsUpserted };
}
```

(If `upsertContribution` is named differently, find the existing schedule_a upsert logic in the adapter and use it or extract it.)

- [ ] **Step 4: Run — green.**

- [ ] **Step 5: Commit.**

```bash
git add src/adapters/openfec.ts tests/unit/adapters/openfec.test.ts
git commit -m "$(cat <<'EOF'
feat(openfec): fetchRecentContributions narrow method for R15

One-page schedule_a fetch with min_date/max_date filters and
optional committee_id list. Reuses existing upsert logic; returns
telemetry count. Caveat: min_date/max_date filter on REPORTING
date, not contribution-receipt date — documented in D3d / 03-data-sources.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `recent_contributions` handler rewrite

**Files:** `src/mcp/tools/recent_contributions.ts`, `tests/unit/mcp/tools/recent_contributions.test.ts`

Rewrite handler around `withShapedFetch`. OpenFEC is federal-only; hydration is unconditional.

- [ ] **Step 1: Rewrite handler.** Lift the current candidate-resolution + projection logic into `projectLocal`. `fetchAndWrite` instantiates `OpenFECAdapter` and calls `fetchRecentContributions` with `min_date` from the input window (format `"MM/DD/YYYY"` per OpenFEC convention).

Key shape:

```ts
import { withShapedFetch } from "../../core/tool_cache.js";
import { OpenFECAdapter } from "../../adapters/openfec.js";
import { getLimiter } from "../../core/limiters.js";
import { requireEnv } from "../../util/env.js";

export async function handleRecentContributions(db, rawInput) {
  const input = RecentContributionsInput.parse(rawInput);

  const toMMDDYYYY = (iso: string): string => {
    const d = new Date(iso);
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
  };

  const projectLocal = (): RecentContributionsResponse => {
    // ... candidate-resolution + projection logic, lifted from current code unchanged ...
  };

  const fetchAndWrite = async () => {
    const adapter = new OpenFECAdapter({
      apiKey: requireEnv("API_DATA_GOV_KEY"),
      rateLimiter: getLimiter("openfec"),
    });
    const result = await adapter.fetchRecentContributions(db, {
      min_date: toMMDDYYYY(input.window.from),
      max_date: toMMDDYYYY(input.window.to),
    });
    return { primary_rows_written: result.documentsUpserted };
  };

  const result = await withShapedFetch(
    db,
    {
      source: "openfec",
      endpoint_path: "/schedules/schedule_a",
      args: { window: input.window, candidate_or_committee: input.candidate_or_committee, min_amount: input.min_amount },
      tool: "recent_contributions",
    },
    { scope: "recent", ms: 60 * 60 * 1000 },
    fetchAndWrite,
    projectLocal,
    () => getLimiter("openfec").peekWaitMs(),
  );

  return result.stale_notice
    ? { ...result.value, stale_notice: result.stale_notice }
    : result.value;
}
```

- [ ] **Step 2: Rewrite unit tests.** Mock `OpenFECAdapter.prototype.fetchRecentContributions` via `vi.spyOn`. Cover: happy path fetch, cache hit, upstream failure no-cache propagates, upstream failure with stale cache returns stale + notice, min_amount filter, candidate_or_committee filter.

Remove `vi.mock(".../hydrate.js", ...)`. Call `_resetToolCacheForTesting()` in beforeEach.

- [ ] **Step 3: Run unit tests — green.** Integration failures expected (handled in Task 3).

- [ ] **Step 4: Commit.**

```bash
git add src/mcp/tools/recent_contributions.ts tests/unit/mcp/tools/recent_contributions.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): recent_contributions on withShapedFetch (R15)

OpenFEC is federal-only; narrow fetch uses min_date/max_date on
schedule_a. Candidate/committee filter stays client-side via
normalized-name LIKE over local entities. Unit tests mock the
adapter method.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Integration test cleanup

**Files:** `tests/integration/openfec-e2e.test.ts` (if R13 recent_contributions scenario exists), `tests/integration/passthrough-e2e.test.ts` (same), `tests/integration/passthrough-e2e.shaped.test.ts`

- [ ] **Step 1: Find and remove R13 recent_contributions scenarios.** Grep the three integration files for `handleRecentContributions` or `recent_contributions`. Delete scenarios that use the R13 path (mock `ensureFresh`). Preserve scenarios for other tools.

- [ ] **Step 2: Add R15 scenarios to `passthrough-e2e.shaped.test.ts`.**

```ts
describe("passthrough shaped e2e — recent_contributions", () => {
  it("cold fetch → warm hit", async () => {
    let upstreamHits = 0;
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
      upstreamHits += 1;
      return new Response(JSON.stringify({ results: [], pagination: {} }), { status: 200 });
    });

    const window = {
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-04-14T00:00:00.000Z",
    };
    await handleRecentContributions(store.db, { window });
    await handleRecentContributions(store.db, { window });

    expect(upstreamHits).toBe(1);
    fetchSpy.mockRestore();
  });

  it("upstream failure with stale cache returns stale + notice", async () => {
    const window = { from: "2026-04-01T00:00:00.000Z", to: "2026-04-14T00:00:00.000Z" };
    seedStaleCache({
      db: store.db,
      source: "openfec",
      endpoint_path: "/schedules/schedule_a",
      scope: "recent",
      tool: "recent_contributions",
      args: { window, candidate_or_committee: undefined, min_amount: undefined },
      documents: [{
        kind: "contribution", jurisdiction: "us-federal",
        title: "Contribution from Jane Smith",
        occurred_at: "2026-04-05T00:00:00Z",
        source: { name: "openfec", id: "sa-T1",
          url: "https://docquery.fec.gov/..." },
        references: [],
        raw: { amount: 2500, date: "2026-04-05", contributor_name: "SMITH, JANE" },
      }],
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

    const result = await handleRecentContributions(store.db, { window });
    expect(result.stale_notice?.reason).toBe("upstream_failure");
    expect(result.results.length).toBeGreaterThan(0);
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Full suite green.**

- [ ] **Step 4: Commit.**

```bash
git add tests/integration/
git commit -m "$(cat <<'EOF'
test: recent_contributions integration on R15 path

Drop R13 scenarios; add cold→warm + stale-fallback to shaped e2e.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Acceptance

- [ ] `pnpm test` green.
- [ ] `pnpm build` clean.
- [ ] `grep ensureFresh src/mcp/tools/recent_contributions.ts` = 0.
- [ ] `grep withShapedFetch src/mcp/tools/recent_contributions.ts` = 1.

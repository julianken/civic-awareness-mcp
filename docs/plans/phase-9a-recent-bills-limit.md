# Phase 9a — `recent_bills` optional `limit` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add an optional `limit` input to `recent_bills`. When set,
the handler drops the time-window `updated_since` filter (so
biennial / off-session jurisdictions can return "last N updated
bills" regardless of recency), threads `limit` through both
adapters' `fetchRecentBills` methods, and caps the local
projection at `limit` items.

**Architecture:** `RecentBillsInput` gains
`limit: z.number().int().min(1).max(20).optional()`. The handler
keeps the `days` window for `updated_since` **only when `limit` is
unset**; when `limit` is set the adapter call uses OpenStates'
native `sort=updated_desc` with no upstream time filter, and
Congress.gov's `fromDateTime` is dropped from the query. `limit`
goes into the `args` bag passed to `withShapedFetch`, so distinct
`limit` values get distinct `fetch_log` rows. `projectLocal()` caps
output at `limit` after chamber/session filtering, and raises the
`queryDocuments` intermediate ceiling to `Math.max(50, limit * 3)`
to give chamber/session filtering headroom before the cap.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`,
`better-sqlite3`, `vitest`.

---

## Scope impact

This sub-phase updates the following docs in Task 5:

- `docs/06-open-decisions.md` — appends **D12 (LOCKED, 2026-04-14)**
  (see text below in Task 5).
- `docs/00-rationale.md` — appends **R16 (2026-04-14)** pointing at
  the biennial-legislature case that motivated D12.
- `docs/05-tool-surface.md` — updates the `recent_bills` input
  block to document `limit` and the mutual interaction with `days`.
- `CHANGELOG.md` — adds an entry under unreleased / `0.4.0` for the
  new input.
- `docs/plans/phase-9-overview.md` — no edits (already references
  this plan file).

---

## File structure

```
src/
├── mcp/
│   ├── schemas.ts              # MODIFIED: + limit on RecentBillsInput
│   └── tools/
│       └── recent_bills.ts     # MODIFIED: thread limit, drop updated_since, cap projection, description
└── adapters/
    └── openstates.ts           # MODIFIED: fetchRecentBills accepts opts.limit
                                #           (Congress already supports opts.limit — verify only)
tests/
└── unit/
    ├── mcp/tools/
    │   └── recent_bills.test.ts    # MODIFIED: + limit tests
    └── adapters/
        ├── openstates.test.ts      # MODIFIED: + limit test
        └── congress.test.ts        # MODIFIED: + limit plumbing test
docs/
├── 00-rationale.md                 # MODIFIED: + R16
├── 05-tool-surface.md              # MODIFIED: recent_bills input + limit semantics
├── 06-open-decisions.md            # MODIFIED: + D12
└── plans/
    └── phase-9a-recent-bills-limit.md   # this file
CHANGELOG.md                        # MODIFIED
```

---

## Task 1: Add `limit` to `RecentBillsInput` schema

**Files:**
- Modify: `src/mcp/schemas.ts`
- Modify: `tests/unit/mcp/tools/recent_bills.test.ts`

`RecentBillsInput` gets an optional `limit` with the same shape
used elsewhere for listing caps (min 1, max 20, no default). There
is no dedicated `tests/unit/mcp/schemas.test.ts` — input validation
is covered indirectly through each tool's unit test file.

- [ ] **Step 1: Write the failing schema test**

Append to the first `describe` block of
`tests/unit/mcp/tools/recent_bills.test.ts`, alongside the existing
"rejects days above 365" block:

```ts
  it("accepts limit between 1 and 20", async () => {
    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-tx", days: 7, chamber: undefined, session: undefined, limit: 5 });
    const res = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7, limit: 5 });
    expect(res.window.from).toBeDefined();
  });

  it("rejects limit=0", async () => {
    await expect(
      handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7, limit: 0 }),
    ).rejects.toThrow();
  });

  it("rejects limit above 20", async () => {
    await expect(
      handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7, limit: 21 }),
    ).rejects.toThrow();
  });
```

- [ ] **Step 2: Run — expect FAIL (zod does not yet know about `limit`)**

Run: `pnpm test tests/unit/mcp/tools/recent_bills.test.ts -t "limit"`

Expected: FAIL. Zod strips the unknown key (silent pass of the
"accepts limit" test is possible depending on Zod mode, but the
"rejects limit=0 / limit=21" tests will fail because there is no
constraint).

- [ ] **Step 3: Add the field to the schema**

Edit `src/mcp/schemas.ts`. Replace the `RecentBillsInput` block:

```ts
export const RecentBillsInput = z.object({
  days: z.number().int().min(1).max(365).default(7),
  // REQUIRED. "us-federal", "us-<state>" (e.g. "us-tx"), or "*" to
  // query across all. No default — the caller must state which
  // jurisdiction they want. See docs/05-tool-surface.md.
  jurisdiction: z.string().min(1),
  chamber: z.enum(["upper", "lower"]).optional(),
  session: z.string().optional(),
  // Optional row cap. When set, the handler drops the days-derived
  // `updated_since` upstream filter and returns top-N by
  // OpenStates' native `sort=updated_desc` / Congress.gov's
  // `sort=updateDate+desc`. Use to query biennial or off-session
  // jurisdictions where the time window is empty. See D12 / R16.
  limit: z.number().int().min(1).max(20).optional(),
});
export type RecentBillsInput = z.infer<typeof RecentBillsInput>;
```

- [ ] **Step 4: Run the schema tests — all pass**

Run: `pnpm test tests/unit/mcp/tools/recent_bills.test.ts -t "limit"`

Expected: PASS (3/3 new tests). Other tests in the file still pass
(the `seedFetchLogFresh` args bag now includes `limit` on the new
test; older tests omit it, which matches the handler's existing
args signature).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/schemas.ts tests/unit/mcp/tools/recent_bills.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add optional limit to RecentBillsInput

Optional limit: number (1..20). Schema-only change in this commit —
the handler ignores limit until Task 4. Validation tests assert
the bounds; handler-side plumbing lands in subsequent commits of
phase-9a.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: OpenStates `fetchRecentBills` accepts `opts.limit`

**Files:**
- Modify: `src/adapters/openstates.ts`
- Modify: `tests/unit/adapters/openstates.test.ts`

The adapter already hardcodes `per_page=20`. We extend the opts bag
with `limit?: number` and render it as
`String(opts.limit ?? 20)`. OpenStates caps `per_page` at 20, so
`limit` in the range 1..20 maps one-to-one onto a single upstream
page; no pagination or in-memory slicing is required.

- [ ] **Step 1: Write the failing test**

Append inside the existing
`describe("OpenStatesAdapter.fetchRecentBills", …)` block in
`tests/unit/adapters/openstates.test.ts` (after the
"passes updated_since when provided" test):

```ts
  it("passes per_page=limit when opts.limit is set", async () => {
    let capturedUrl: string | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }),
        { status: 200 },
      );
    });

    const LIMIT_DB = "./data/test-openstates-frb-limit.db";
    if (existsSync(LIMIT_DB)) rmSync(LIMIT_DB, { force: true });
    const db = openStore(LIMIT_DB);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      await adapter.fetchRecentBills(db.db, { jurisdiction: "us-mt", limit: 5 });

      expect(capturedUrl).toBeDefined();
      const u = new URL(capturedUrl!);
      expect(u.searchParams.get("per_page")).toBe("5");
      expect(u.searchParams.get("sort")).toBe("updated_desc");
    } finally {
      db.close();
      if (existsSync(LIMIT_DB)) rmSync(LIMIT_DB, { force: true });
    }
  });
```

- [ ] **Step 2: Run — expect FAIL (per_page is hardcoded 20)**

Run: `pnpm test tests/unit/adapters/openstates.test.ts -t "per_page=limit"`

Expected: FAIL. `per_page` still equals `"20"`.

- [ ] **Step 3: Extend `fetchRecentBills` signature and implementation**

Edit `src/adapters/openstates.ts`. Replace the current
`fetchRecentBills` method (it starts near line 282) with:

```ts
  /** Narrow per-tool fetch for R15 `recent_bills` — one page of
   *  recently-updated bills for a jurisdiction, with optional
   *  `updated_since` filter, optional chamber filter, and optional
   *  row `limit` (1..20, mapped to OpenStates `per_page`). Writes
   *  through to `documents` via `upsertBill`. Returns telemetry
   *  count for `withShapedFetch`'s primary_rows_written contract. */
  async fetchRecentBills(
    db: Database.Database,
    opts: {
      jurisdiction: string;
      updated_since?: string;
      chamber?: "upper" | "lower";
      limit?: number;
    },
  ): Promise<{ documentsUpserted: number }> {
    const abbr = opts.jurisdiction.replace(/^us-/, "").toLowerCase();
    const url = new URL(`${BASE_URL}/bills`);
    url.searchParams.set("jurisdiction", abbr);
    url.searchParams.set("sort", "updated_desc");
    url.searchParams.set("per_page", String(opts.limit ?? 20));
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

- [ ] **Step 4: Run the test — PASS**

Run: `pnpm test tests/unit/adapters/openstates.test.ts -t "fetchRecentBills"`

Expected: all three tests in that `describe` block pass (default
`per_page=20`, `updated_since` plumbing, new `limit=5 → per_page=5`).

Full file: `pnpm test tests/unit/adapters/openstates.test.ts`

Expected: all existing adapter tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/openstates.ts tests/unit/adapters/openstates.test.ts
git commit -m "$(cat <<'EOF'
feat(openstates): fetchRecentBills accepts opts.limit (1..20)

Extends the narrow per-tool fetch with an optional row cap that
maps onto OpenStates' `per_page` (capped at 20 upstream). Keeps
the hardcoded 20 as the default so existing callers are
unaffected. Wires the plumbing for phase-9a's handler-side limit.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Congress.gov `fetchRecentBills` — verify `opts.limit` + test coverage

**Files:**
- Modify: `tests/unit/adapters/congress.test.ts`
- (No change to `src/adapters/congress.ts` — it already accepts
  `opts.limit` and renders it as `String(opts.limit ?? 250)`; see
  `src/adapters/congress.ts:243` and `:250`.)

We still add a unit test that pins the plumbing so a future
refactor can't silently break it.

- [ ] **Step 1: Verify the adapter already supports limit**

Open `src/adapters/congress.ts` and confirm
the `fetchRecentBills` signature reads:

```ts
  async fetchRecentBills(
    db: Database.Database,
    opts: { fromDateTime: string; chamber?: "upper" | "lower"; limit?: number },
  ): Promise<{ documentsUpserted: number }> {
```

and that the URL builder sets `limit` as
`url.searchParams.set("limit", String(opts.limit ?? 250));`.

If the signature has drifted, STOP and report — do not silently
fix it in this phase.

- [ ] **Step 2: Write the failing plumbing test**

Append inside the existing
`describe("CongressAdapter.fetchRecentBills", …)` block in
`tests/unit/adapters/congress.test.ts` (after the "filters by
chamber" test):

```ts
  it("passes opts.limit through as the upstream `limit` query param", async () => {
    let capturedUrl: string | null = null;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({ bills: [], pagination: { count: 0 } }),
        { status: 200 },
      );
    });

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    await adapter.fetchRecentBills(store.db, {
      fromDateTime: "2026-04-01T00:00:00Z",
      limit: 5,
    });

    expect(capturedUrl).toBeTruthy();
    const u = new URL(capturedUrl!);
    expect(u.searchParams.get("limit")).toBe("5");
  });
```

- [ ] **Step 3: Run — expect PASS on first run**

Run: `pnpm test tests/unit/adapters/congress.test.ts -t "opts.limit"`

Expected: PASS (adapter already supports this; the test exists to
pin behaviour).

If it FAILS, STOP and report — the adapter has drifted from
phase-8b-recent-bills; fix scope expands beyond phase-9a.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/adapters/congress.test.ts
git commit -m "$(cat <<'EOF'
test(congress): pin fetchRecentBills opts.limit plumbing

Adapter already accepts opts.limit from phase-8b — this commit
adds a regression test so phase-9a's handler wiring has a
load-bearing assertion on the upstream `limit` query param.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `recent_bills` handler threads `limit`, drops `updated_since`, caps projection

**Files:**
- Modify: `src/mcp/tools/recent_bills.ts`
- Modify: `tests/unit/mcp/tools/recent_bills.test.ts`

Handler-side changes:

1. Thread `input.limit` into `fetchAndWrite` for both branches.
2. On state jurisdictions (OpenStates), pass `updated_since` only
   when `input.limit` is **unset** (the narrow-window case); drop it
   when `limit` is set (the "last N ever" case).
3. On federal (Congress.gov), keep `fromDateTime` always — but
   when `limit` is set, widen the window to 365 days so the
   upstream's native `sort=updateDate+desc` actually surfaces older
   updates. (Congress.gov's `fromDateTime` is required for
   efficient sort, so we set it to `now - 365d` rather than drop
   it; `limit` still caps the result.)
4. Add `limit` to the `args` bag passed to `withShapedFetch` so
   distinct `limit` values get distinct `fetch_log` rows.
5. In `projectLocal`, raise the intermediate `queryDocuments` cap
   to `Math.max(50, (input.limit ?? 0) * 3)` and slice the final
   `results` array at `input.limit` when set.
6. Update the tool's docstring/description to explain the ordering
   semantics (sorted by last-updated, not introduced; both `days`
   and `limit` apply as upper bounds when both are set).

- [ ] **Step 1: Write the failing handler tests**

Append to the existing `describe("recent_bills tool — R15 hydration path", …)`
in `tests/unit/mcp/tools/recent_bills.test.ts`:

```ts
  it("cold fetch with limit=5: calls OpenStates fetchRecentBills WITHOUT updated_since", async () => {
    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { jurisdiction: "us-mt", days: 7, limit: 5 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const callOpts = fetchSpy.mock.calls[0][1];
    expect(callOpts).toMatchObject({ jurisdiction: "us-mt", limit: 5 });
    expect(callOpts.updated_since).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("cold fetch with limit=5: caps the local projection at 5 results", async () => {
    // Seed 10 bills for us-tx so the projection has plenty to cap.
    for (let i = 0; i < 10; i++) {
      upsertDocument(store.db, {
        kind: "bill", jurisdiction: "us-tx",
        title: `SB ${100 + i} — Bulk ${i}`,
        occurred_at: new Date(Date.now() - i * 86400 * 1000).toISOString(),
        source: { name: "openstates", id: `bulk-${i}`, url: `https://ex/${i}` },
        references: [], raw: { actions: [] },
      });
    }
    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 10 }));

    const res = await handleRecentBills(store.db, {
      jurisdiction: "us-tx", days: 7, limit: 5,
    });

    expect(res.results).toHaveLength(5);
    fetchSpy.mockRestore();
  });

  it("distinct limit values produce distinct fetch_log rows", async () => {
    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7, limit: 5 });
    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7, limit: 10 });
    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 });

    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const rows = store.db
      .prepare(
        `SELECT DISTINCT args_hash FROM fetch_log
         WHERE source='openstates' AND endpoint_path='/bills'`,
      )
      .all() as Array<{ args_hash: string }>;
    expect(rows.length).toBe(3);

    fetchSpy.mockRestore();
  });

  it("limit unset: still passes updated_since (existing behaviour)", async () => {
    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 });

    const callOpts = fetchSpy.mock.calls[0][1];
    expect(callOpts.updated_since).toBeDefined();
    expect(callOpts.limit).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("us-federal with limit: threads limit into Congress adapter", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { jurisdiction: "us-federal", days: 7, limit: 5 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const callOpts = fetchSpy.mock.calls[0][1];
    expect(callOpts.limit).toBe(5);
    expect(callOpts.fromDateTime).toBeDefined();

    fetchSpy.mockRestore();
  });
```

At the top of the file, ensure `upsertDocument` is imported (it
already is — see line 6 of the existing file).

- [ ] **Step 2: Run — expect FAIL on the new tests**

Run: `pnpm test tests/unit/mcp/tools/recent_bills.test.ts -t "limit"`

Expected: FAIL. The handler currently always sets `updated_since`,
never threads `limit`, and doesn't cap the projection.

- [ ] **Step 3: Update the handler**

Edit `src/mcp/tools/recent_bills.ts`.

**3a.** Replace the docstring on `handleRecentBills` (the block
above `export async function handleRecentBills`, currently lines
90–101) with:

```ts
/**
 * Returns recently-updated bills for the given jurisdiction.
 *
 * Sort order is **last-updated desc**, not introduced-date — upstream
 * APIs (OpenStates `sort=updated_desc`, Congress.gov
 * `sort=updateDate+desc`) place re-touched older bills above freshly
 * introduced ones when the older bill has the more recent activity.
 *
 * Semantics when both `days` and `limit` are set: BOTH apply as
 * upper bounds. The window filters; `limit` caps. When only `limit`
 * is set (callers omit `days`), the default `days=7` still applies
 * in the local projection, but the upstream `updated_since` filter
 * is dropped so biennial / off-session jurisdictions can surface
 * older entries. To ask for "last N ever," pass `days=365, limit=N`.
 *
 * R15 vertical: the handler is a thin orchestrator around
 * `withShapedFetch`. It branches on jurisdiction — `us-federal` uses
 * the Congress.gov adapter's `fetchRecentBills`, state jurisdictions
 * use the OpenStates adapter's `fetchRecentBills`. Wildcard `"*"`
 * short-circuits to local-only (no upstream fetch).
 *
 * Title format is always "IDENTIFIER — TITLE" — the handler splits on
 * " — " to separate `identifier` from `title` in the response.
 */
```

**3b.** Update the `projectLocal` body. Find the section that
currently reads:

```ts
  const projectLocal = (): RecentBillsResponse => {
    const docs = input.session
      ? queryDocuments(db, {
          kind: "bill",
          jurisdiction: input.jurisdiction,
          limit: 100,
        })
      : queryDocuments(db, {
          kind: "bill",
          jurisdiction: input.jurisdiction,
          from: from.toISOString(),
          to: to.toISOString(),
          limit: 50,
        });
```

Replace with:

```ts
  const projectLocal = (): RecentBillsResponse => {
    // Headroom for chamber/session filters before the final cap.
    const ceiling = Math.max(50, (input.limit ?? 0) * 3);
    const docs = input.session
      ? queryDocuments(db, {
          kind: "bill",
          jurisdiction: input.jurisdiction,
          limit: Math.max(100, ceiling),
        })
      : input.limit !== undefined
        ? queryDocuments(db, {
            kind: "bill",
            jurisdiction: input.jurisdiction,
            limit: ceiling,
          })
        : queryDocuments(db, {
            kind: "bill",
            jurisdiction: input.jurisdiction,
            from: from.toISOString(),
            to: to.toISOString(),
            limit: 50,
          });
```

**3c.** At the end of `projectLocal`, just before
`const base: RecentBillsResponse = {`, insert a cap on `results`:

Find:

```ts
    const results: BillSummary[] = filtered.map((d) => {
```

…through the end of that `.map(...)` block (ending with `});`),
then immediately after the closing `});` of the `.map` insert:

```ts

    const capped = input.limit !== undefined
      ? results.slice(0, input.limit)
      : results;
```

Then change the `base` assignment to use `capped`:

```ts
    const base: RecentBillsResponse = {
      results: capped,
      total: capped.length,
      sources: Array.from(sourceByName, ([name, url]) => ({ name, url })),
      window: { from: from.toISOString(), to: to.toISOString() },
    };
    if (capped.length === 0) {
      const diag = emptyFeedDiagnostic(db, { jurisdiction: input.jurisdiction, kind: "bill" });
      return { ...base, ...diag };
    }
```

**3d.** Update `fetchAndWrite`. Find the federal branch:

```ts
    if (isFederal) {
      const adapter = new CongressAdapter({
        apiKey: requireEnv("API_DATA_GOV_KEY"),
        rateLimiter: getLimiter("congress"),
      });
      const { documentsUpserted } = await adapter.fetchRecentBills(db, {
        fromDateTime: from.toISOString(),
        chamber: input.chamber,
      });
      return { primary_rows_written: documentsUpserted };
    }
```

Replace with:

```ts
    if (isFederal) {
      const adapter = new CongressAdapter({
        apiKey: requireEnv("API_DATA_GOV_KEY"),
        rateLimiter: getLimiter("congress"),
      });
      // Congress.gov requires fromDateTime for sort=updateDate+desc
      // to be meaningful; when `limit` is set we widen the window
      // to 365d so older re-touched bills can surface and the
      // native sort + limit do the real work.
      const fromDateTime = input.limit !== undefined
        ? new Date(to.getTime() - 365 * 86400 * 1000).toISOString()
        : from.toISOString();
      const { documentsUpserted } = await adapter.fetchRecentBills(db, {
        fromDateTime,
        chamber: input.chamber,
        limit: input.limit,
      });
      return { primary_rows_written: documentsUpserted };
    }
```

Then the state branch, currently:

```ts
    const adapter = new OpenStatesAdapter({
      apiKey: requireEnv("OPENSTATES_API_KEY"),
      rateLimiter: getLimiter("openstates"),
    });
    const { documentsUpserted } = await adapter.fetchRecentBills(db, {
      jurisdiction: input.jurisdiction,
      updated_since: from.toISOString().slice(0, 10),
      chamber: input.chamber,
    });
    return { primary_rows_written: documentsUpserted };
  };
```

Replace with:

```ts
    const adapter = new OpenStatesAdapter({
      apiKey: requireEnv("OPENSTATES_API_KEY"),
      rateLimiter: getLimiter("openstates"),
    });
    // When `limit` is set we drop updated_since so biennial / off-
    // session jurisdictions can return their last-N-updated bills
    // regardless of recency. See D12 / R16.
    const { documentsUpserted } = await adapter.fetchRecentBills(db, {
      jurisdiction: input.jurisdiction,
      updated_since: input.limit !== undefined
        ? undefined
        : from.toISOString().slice(0, 10),
      chamber: input.chamber,
      limit: input.limit,
    });
    return { primary_rows_written: documentsUpserted };
  };
```

**3e.** Add `limit` to the `withShapedFetch` args bag. Find:

```ts
      args: {
        jurisdiction: input.jurisdiction,
        days: input.days,
        chamber: input.chamber,
        session: input.session,
      },
```

Replace with:

```ts
      args: {
        jurisdiction: input.jurisdiction,
        days: input.days,
        chamber: input.chamber,
        session: input.session,
        limit: input.limit,
      },
```

- [ ] **Step 4: Run the new handler tests — PASS**

Run: `pnpm test tests/unit/mcp/tools/recent_bills.test.ts -t "limit"`

Expected: all new tests pass (5/5 added in this task plus the 3
schema tests from Task 1).

- [ ] **Step 5: Run the whole file — existing tests still green**

Run: `pnpm test tests/unit/mcp/tools/recent_bills.test.ts`

Expected: every test in the file passes. The existing
`seedFetchLogFresh(...)` calls omit `limit`, and the handler's
args bag now includes `limit: undefined` in those cases — the
`hashArgs` helper must hash `{limit: undefined}` and `{/* no limit */}`
to the same value for the cache-hit tests to still work. Confirm
by reading `src/core/args_hash.ts` — if it JSON-stringifies after
normalizing out `undefined` keys, these tests stay green. If not,
STOP and escalate (scope change: normalize `undefined` out of the
args bag before hashing). A simple fix is to drop the
`limit: input.limit` pair from the args object when `input.limit`
is undefined — do that if needed, using:

```ts
      args: {
        jurisdiction: input.jurisdiction,
        days: input.days,
        chamber: input.chamber,
        session: input.session,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
```

…and update the pre-seeded `seedFetchLogFresh` call in the
"accepts limit between 1 and 20" test from Task 1 accordingly —
but only if `hashArgs` is sensitive to `undefined` keys. Read
`src/core/args_hash.ts` first; prefer the path of minimal change.

- [ ] **Step 6: Full suite green**

Run: `pnpm test`

Expected: all tests across all files pass. Integration e2e tests
that exercise `recent_bills` without `limit` must continue to work
because the handler's behaviour when `limit` is unset is
unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/recent_bills.ts tests/unit/mcp/tools/recent_bills.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): recent_bills threads optional limit end-to-end

When `limit` is set the handler drops the days-derived
`updated_since` (OpenStates) / widens fromDateTime to 365d
(Congress.gov) so upstream `sort=updated_desc` can surface older
re-touched bills. `limit` joins the args bag for
withShapedFetch, producing distinct fetch_log rows per limit
value. projectLocal raises the intermediate queryDocuments
ceiling to max(50, limit*3) for chamber/session filter headroom
and caps the final results slice at `limit`.

Motivates biennial / off-session jurisdictions (MT, TX interim,
etc.) where a 7-day window is usually empty but callers still
want the N most recently updated bills. Default behaviour when
`limit` is unset is unchanged.

See D12 / R16.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Docs, rationale, decision record, changelog

**Files:**
- Modify: `docs/06-open-decisions.md`
- Modify: `docs/00-rationale.md`
- Modify: `docs/05-tool-surface.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Append D12 to `docs/06-open-decisions.md`**

At the end of the file (after the D11 block), append:

```md

## D12 — Feed tools accept optional `limit` for row-bounded listings (2026-04-14, LOCKED)

**Decision:** Feed tools (starting with `recent_bills` in phase-9a)
accept an optional `limit: z.number().int().min(1).max(20).optional()`.
When `limit` is set the handler drops the `days`-derived upstream
time filter (`updated_since` on OpenStates; widened `fromDateTime`
on Congress.gov) so the upstream's native `sort=updated_desc` /
`sort=updateDate+desc` surfaces the top-N most recently updated
rows regardless of recency. When both `days` and `limit` are set,
both apply: `days` constrains the local projection window and
`limit` caps the result count. `limit` joins the `withShapedFetch`
args bag so distinct values get distinct `fetch_log` rows.

**Why:** See R16. Biennial state legislatures (Montana, Nevada,
Texas in off-years) and any jurisdiction between sessions have
empty 7-day windows. "Give me the last 20 updated bills" is the
right query shape for that case; "give me bills updated since
last Tuesday" is not.

**Alternatives rejected:**
- Make `limit` a general-purpose cap but keep `updated_since` →
  defeats the purpose; the upstream still filters to an empty
  window.
- Auto-widen `days` when results are empty → silent semantic
  drift; the cache key would no longer reflect what the caller
  asked for.
- Add a separate tool for listing → see D13; a distinct tool is
  only warranted when predicate richness grows past a single
  optional parameter.
```

- [ ] **Step 2: Append R16 to `docs/00-rationale.md`**

At the end of the file, append:

```md

## R16 — Optional `limit` on feed tools for off-session jurisdictions (2026-04-14)

Post-Phase-8 audit note. The tool-surface audit surfaced a
biennial-legislature case: `recent_bills(jurisdiction="us-mt",
days=7)` returns empty year-round except for the two months
Montana's legislature is in session every other year. Callers
asking "what are Montana's most recently updated bills" need a
listing shape that doesn't depend on the 7-day window.

`limit` is the minimum surface-area change that gets this right.
The handler drops the upstream `updated_since` on OpenStates (and
widens `fromDateTime` to 365d on Congress.gov so
`sort=updateDate+desc` still works) when `limit` is set. The
upstream's native updated-desc sort does the real work.

The decision to keep `days` with its 7-day default — even when
`limit` is set — preserves the local projection window unless
the caller explicitly passes `days=365`. That preserves the
invariant that `days` always constrains the local projection.
Callers who want "last N ever" pass `days=365, limit=N`. This is
documented in the tool description.

Distinct `limit` values produce distinct `fetch_log` rows by
virtue of joining the args bag — no new cache-invalidation
machinery needed.

Locked in phase-9a (`docs/plans/phase-9a-recent-bills-limit.md`).
```

- [ ] **Step 3: Update `docs/05-tool-surface.md` recent_bills block**

Find the existing `### recent_bills` block (lines 39–59 of
`docs/05-tool-surface.md`). Replace the input fenced block with:

```
input:
  jurisdiction: string              // REQUIRED. "us-federal" or "us-<state>" (e.g. "us-tx")
                                    // or "*" to query across all
  days: number (default 7, max 365)
  chamber: "upper" | "lower" | undefined
  session: string | undefined       // e.g. "119" for 119th Congress, or OpenStates session id
  limit: number (1..20) | undefined // optional row cap; when set, drops the
                                    // days-derived upstream time filter and
                                    // returns top-N by last-updated. Use for
                                    // biennial / off-session jurisdictions.
                                    // Both `days` and `limit` apply as upper
                                    // bounds when both are set; pass
                                    // `days=365, limit=N` for "last N ever."

output: ToolResponse<BillSummary>

BillSummary = {
  id: string                        // entity-graph ID of the Bill document
  identifier: string                // "HR1234", "HB2345", "SB89", etc.
  title: string
  latest_action: { date: string; description: string }
  sponsors: { name: string; party?: string; district?: string }[]
  source_url: string
}
```

Below the output block, append a short sentence (before the next
`###`):

```md

Results are sorted by **last-updated**, not introduced date — a
re-touched older bill with recent committee activity can rank
above a freshly introduced one.
```

- [ ] **Step 4: Update `CHANGELOG.md`**

Above the `## 0.3.0 (2026-04-14)` entry, insert a new unreleased
section. If an `## Unreleased` or `## 0.4.0` section is already
drafted by a sibling phase, merge into it; otherwise create it:

```md
## Unreleased

### Added
- `recent_bills` accepts an optional `limit: number` (1..20). When
  set, the handler drops the days-derived upstream time filter
  and returns top-N by last-updated. Intended for biennial and
  off-session jurisdictions where the default 7-day window is
  empty. See D12 / R16. (phase-9a)

```

- [ ] **Step 5: Acceptance commands**

Run the build to confirm no type drift:

```bash
pnpm build
```

Expected: TypeScript clean.

Run the full test suite:

```bash
pnpm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add docs/00-rationale.md docs/05-tool-surface.md docs/06-open-decisions.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(phase-9a): lock D12, add R16, document recent_bills limit

- D12 (LOCKED): feed tools accept optional `limit`; drops
  days-derived upstream time filter; both `days` and `limit`
  apply as upper bounds when set together.
- R16: biennial-legislature case motivating D12. Cross-refs the
  phase-9a plan for implementation details.
- docs/05-tool-surface.md: recent_bills input block documents
  `limit` and sort semantics ("sorted by last-updated, not
  introduced date").
- CHANGELOG.md: Unreleased entry for the new input.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Acceptance check

- [ ] `pnpm test` — all tests green. New count includes: 3 schema
  tests, 1 OpenStates adapter test, 1 Congress adapter test, 5
  handler tests = +10 vs pre-phase-9a.
- [ ] `pnpm build` — TypeScript clean.
- [ ] Grep `limit` in `src/mcp/schemas.ts` — at least one match in
  the `RecentBillsInput` block.
- [ ] Grep `opts.limit` in `src/adapters/openstates.ts` — at least
  one match (the `per_page` binding).
- [ ] Grep `input.limit` in `src/mcp/tools/recent_bills.ts` — at
  least four matches (projection headroom, projection cap, args
  bag, and each of the two fetchAndWrite branches).
- [ ] `docs/06-open-decisions.md` has a `## D12` heading.
- [ ] `docs/00-rationale.md` has a `## R16` heading.
- [ ] `docs/05-tool-surface.md` `recent_bills` block mentions
  `limit: number (1..20)`.
- [ ] `CHANGELOG.md` has an `Unreleased` or `0.4.0` entry
  mentioning `recent_bills` `limit`.

Phase 9a complete when all hold. Phase 9b (`list_bills`) follows
in `docs/plans/phase-9b-list-bills.md`.

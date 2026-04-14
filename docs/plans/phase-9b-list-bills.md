# Phase 9b — `list_bills` Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new MCP tool `list_bills(jurisdiction, ...predicates)`
that exposes a structured-predicate bill listing projection, distinct
from the time-windowed `recent_bills` feed. Inputs cover session,
chamber, sponsor, classification, subject, introduction/update date
windows, and sort direction. Output reuses the existing `BillSummary`
shape so LLM consumers can treat listing results and feed results
interchangeably.

**Architecture:** `handleListBills` is a thin orchestrator around
`withShapedFetch`, shaped the same way as `recent_bills` but with a
**distinct** `endpoint_path="/bills/list"` (OpenStates) so cache rows
for `list_bills` never collide with rows for `recent_bills`. Branches
on jurisdiction: state jurisdictions call a new
`OpenStatesAdapter.listBills`; `us-federal` is explicitly deferred in
9b and returns a `not_yet_supported` stale_notice (same path
`get_bill` uses for federal). Local projection runs `queryDocuments`
with a widened filter, applies sponsor / classification / subject /
date predicates in application code, sorts, and limits.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`,
`better-sqlite3`, `vitest` + `msw` for HTTP mocking.

---

## Scope impact

Docs that must be updated as part of this phase (landed in Task 6):

- `docs/05-tool-surface.md` — add `### list_bills` section under
  **Feed tools (B)**; bump the "9 tools" phrasing to "10 tools";
  append a Phase-to-tool-mapping row for Phase 9b.
- `docs/06-open-decisions.md` — lock **D13** (already drafted in
  `phase-9-overview.md`; this plan moves it from "drafted" to
  "LOCKED" with the 2026-04-14 decision line).
- `docs/plans/phase-9-overview.md` — mark 9b row as shipped.
- `CHANGELOG.md` — v0.4.0 section (unreleased), add a line under
  `## [Unreleased]` → `### Added`: "`list_bills` tool for
  structured bill listing by sponsor, subject, classification,
  session, and date ranges."
- `CLAUDE.md` — no change here; CLAUDE.md's "key conventions" list
  is updated at the end of Phase 9d when all four sub-phases land.

## Federal scope decision

**9b ships OpenStates-only. Federal (`us-federal`) returns a
`not_yet_supported` stale_notice.** Rationale:

1. Congress.gov's `/bill` endpoint does not accept the same predicate
   surface (no native `sponsor=`, no native `subject=`, no
   `classification=` filter). Implementing `list_bills` for federal
   would require client-side filtering after a broad fetch, which
   contradicts the "narrow shaped fetch" contract `withShapedFetch`
   is built around.
2. `get_bill` already defers federal to Phase 7b under D11. Adding a
   second federal deferral is consistent, not a new pattern.
3. The four specific federal listing queries the tool-surface audit
   identified (cosponsor listings, subject browses, classification
   filters) are all better served by `entity_connections` on a
   member OCD ID plus `search_civic_documents`. This is documented
   in Task 5's `not_yet_supported.message`.

When federal support lands (future Phase 9b-federal or similar), the
same handler gains a second branch, the stale_notice path is
deleted, and no `endpoint_path`/tool-name changes are required.

---

## File structure produced by this phase

```
src/
├── adapters/
│   └── openstates.ts              # MODIFIED: + listBills method
├── mcp/
│   ├── schemas.ts                 # MODIFIED: + ListBillsInput
│   ├── server.ts                  # MODIFIED: registerTool("list_bills", ...)
│   └── tools/
│       ├── recent_bills.ts        # MODIFIED: export BillSummary,
│       │                          #           buildSponsorSummary for reuse
│       └── list_bills.ts          # NEW: handler + local projection
docs/
├── 05-tool-surface.md             # MODIFIED: + list_bills section
├── 06-open-decisions.md           # MODIFIED: D13 locked
└── plans/
    ├── phase-9-overview.md        # MODIFIED: 9b row marked shipped
    └── phase-9b-list-bills.md     # this file
tests/
├── integration/
│   └── list-bills-e2e.test.ts     # NEW: R15 shaped e2e scenarios
└── unit/
    ├── adapters/
    │   └── openstates.test.ts     # MODIFIED: + listBills tests
    └── mcp/
        ├── schemas.test.ts        # MODIFIED (or NEW if missing): + ListBillsInput tests
        └── tools/
            └── list_bills.test.ts # NEW: handler unit tests
CHANGELOG.md                       # MODIFIED: [Unreleased] entry
```

---

## Shared shape reuse

`BillSummary`, `SponsorSummary`, and `buildSponsorSummary` currently
live in `src/mcp/tools/recent_bills.ts`. Task 3 adds `export` to
those three symbols (they are already top-level; just ensure
`export` keywords present) and imports them into `list_bills.ts`. No
file move — keeps diffs small and preserves existing test imports.

---

## Task 1: `ListBillsInput` schema + schema tests

**Files:**
- Modify: `src/mcp/schemas.ts`
- Modify (or create if missing): `tests/unit/mcp/schemas.test.ts`

- [ ] **Step 1: Check whether `tests/unit/mcp/schemas.test.ts` exists**

Run:

```bash
ls tests/unit/mcp/schemas.test.ts
```

If the file exists, append new `describe("ListBillsInput", ...)`
block. If it does not exist, create it with the imports block below.

- [ ] **Step 2: Write the failing schema test**

Either append to the existing file or create the new file
`tests/unit/mcp/schemas.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { ListBillsInput } from "../../../src/mcp/schemas.js";

describe("ListBillsInput", () => {
  it("requires jurisdiction", () => {
    expect(() => ListBillsInput.parse({})).toThrow();
  });

  it("accepts jurisdiction alone and applies defaults", () => {
    const parsed = ListBillsInput.parse({ jurisdiction: "us-tx" });
    expect(parsed.jurisdiction).toBe("us-tx");
    expect(parsed.limit).toBe(20);
    expect(parsed.sort).toBe("updated_desc");
    expect(parsed.session).toBeUndefined();
    expect(parsed.chamber).toBeUndefined();
  });

  it("accepts every optional predicate", () => {
    const parsed = ListBillsInput.parse({
      jurisdiction: "us-ca",
      session: "20252026",
      chamber: "upper",
      sponsor_entity_id: "abc-123",
      classification: "bill",
      subject: "Vehicles",
      introduced_since: "2026-01-01",
      introduced_until: "2026-04-01",
      updated_since: "2026-03-01",
      updated_until: "2026-04-10",
      sort: "introduced_desc",
      limit: 50,
    });
    expect(parsed.sponsor_entity_id).toBe("abc-123");
    expect(parsed.sort).toBe("introduced_desc");
    expect(parsed.limit).toBe(50);
  });

  it("rejects chamber values that are not upper/lower", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", chamber: "house" }),
    ).toThrow();
  });

  it("rejects limit > 50", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", limit: 51 }),
    ).toThrow();
  });

  it("rejects limit < 1", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", limit: 0 }),
    ).toThrow();
  });

  it("rejects unknown sort value", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", sort: "by_title" }),
    ).toThrow();
  });
});
```

- [ ] **Step 3: Run — expect fail**

```bash
pnpm test tests/unit/mcp/schemas.test.ts
```

Expected: FAIL — `ListBillsInput` is not exported from `schemas.ts`.

- [ ] **Step 4: Add the schema**

Append to `src/mcp/schemas.ts` (after `GetBillInput`):

```ts
export const ListBillsInput = z.object({
  jurisdiction: z.string().min(1),
  session: z.string().optional(),
  chamber: z.enum(["upper", "lower"]).optional(),
  sponsor_entity_id: z.string().optional(),
  classification: z.string().optional(),
  subject: z.string().optional(),
  introduced_since: z.string().optional(),
  introduced_until: z.string().optional(),
  updated_since: z.string().optional(),
  updated_until: z.string().optional(),
  sort: z
    .enum(["updated_desc", "updated_asc", "introduced_desc", "introduced_asc"])
    .default("updated_desc"),
  limit: z.number().int().min(1).max(50).default(20),
});
export type ListBillsInput = z.infer<typeof ListBillsInput>;
```

Note: date fields are typed as `z.string()` rather than
`z.iso.datetime()` so callers can pass either a plain date
(`"2026-01-01"`) or a full ISO datetime. The handler compares them
lexicographically against `documents.occurred_at` (also ISO 8601),
which is correct as long as both sides use the same 10-char date
prefix; the handler normalizes with `toISOString()` before
comparison.

- [ ] **Step 5: Run — expect pass**

```bash
pnpm test tests/unit/mcp/schemas.test.ts
```

Expected: all new tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/schemas.ts tests/unit/mcp/schemas.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): ListBillsInput schema for structured bill listing

Ten-field input shape — jurisdiction (required) plus session,
chamber, sponsor_entity_id, classification, subject, introduced
and updated date windows, sort, and limit. Default sort
updated_desc; limit defaults to 20, capped at 50. Supports
D13: list_bills is a distinct tool from recent_bills.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `OpenStatesAdapter.listBills` + adapter unit tests

**Files:**
- Modify: `src/adapters/openstates.ts`
- Modify: `tests/unit/adapters/openstates.test.ts`

The adapter method maps `ListBillsInput` to OpenStates v3 `/bills`
query parameters. OpenStates accepts: `jurisdiction`, `session`,
`chamber`, `sponsor` (OCD person id), `classification`, `subject`,
`updated_since`, `created_since` (for introduced-since filters —
OpenStates uses `created_since` for the bill's creation/introduction
date), `sort`, `page`, `per_page`. The adapter maps
`introduced_since` → `created_since` and translates our four sort
values to OpenStates' two canonical values:

| ListBillsInput.sort | OpenStates sort |
|---|---|
| `updated_desc` (default) | `updated_desc` |
| `updated_asc` | `updated_asc` |
| `introduced_desc` | `first_action_desc` |
| `introduced_asc` | `first_action_asc` |

`introduced_until` and `updated_until` are NOT passed upstream
(OpenStates has no `created_before`/`updated_before`); the handler
applies them client-side in the local projection.

- [ ] **Step 1: Write failing adapter tests**

Append to `tests/unit/adapters/openstates.test.ts`:

```ts
describe("OpenStatesAdapter.listBills", () => {
  it("maps jurisdiction, session, chamber, classification, subject to query params", async () => {
    let capturedUrl: URL | null = null;
    server.use(
      http.get("https://v3.openstates.org/bills", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ results: [], pagination: { max_page: 1 } });
      }),
    );

    const dbPath = `/tmp/listBills-params-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const { db } = openStore(dbPath);
    const adapter = new OpenStatesAdapter({ apiKey: "test-key" });

    await adapter.listBills(db, {
      jurisdiction: "us-tx",
      session: "89R",
      chamber: "upper",
      classification: "bill",
      subject: "Vehicles",
      sort: "updated_desc",
      limit: 20,
    });

    expect(capturedUrl).not.toBeNull();
    const params = capturedUrl!.searchParams;
    expect(params.get("jurisdiction")).toBe("tx");
    expect(params.get("session")).toBe("89R");
    expect(params.get("chamber")).toBe("upper");
    expect(params.get("classification")).toBe("bill");
    expect(params.get("subject")).toBe("Vehicles");
    expect(params.get("sort")).toBe("updated_desc");
    expect(params.get("per_page")).toBe("20");
  });

  it("maps introduced_since to created_since and updated_since directly", async () => {
    let capturedUrl: URL | null = null;
    server.use(
      http.get("https://v3.openstates.org/bills", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ results: [], pagination: { max_page: 1 } });
      }),
    );

    const dbPath = `/tmp/listBills-dates-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const { db } = openStore(dbPath);
    const adapter = new OpenStatesAdapter({ apiKey: "test-key" });

    await adapter.listBills(db, {
      jurisdiction: "us-tx",
      introduced_since: "2026-01-01",
      updated_since: "2026-03-01",
      sort: "updated_desc",
      limit: 20,
    });

    expect(capturedUrl!.searchParams.get("created_since")).toBe("2026-01-01");
    expect(capturedUrl!.searchParams.get("updated_since")).toBe("2026-03-01");
    expect(capturedUrl!.searchParams.has("created_before")).toBe(false);
    expect(capturedUrl!.searchParams.has("updated_before")).toBe(false);
  });

  it("maps introduced_desc sort to first_action_desc", async () => {
    let capturedSort: string | null = null;
    server.use(
      http.get("https://v3.openstates.org/bills", ({ request }) => {
        capturedSort = new URL(request.url).searchParams.get("sort");
        return HttpResponse.json({ results: [], pagination: { max_page: 1 } });
      }),
    );

    const dbPath = `/tmp/listBills-sort-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const { db } = openStore(dbPath);
    const adapter = new OpenStatesAdapter({ apiKey: "test-key" });

    await adapter.listBills(db, {
      jurisdiction: "us-tx",
      sort: "introduced_desc",
      limit: 20,
    });

    expect(capturedSort).toBe("first_action_desc");
  });

  it("writes through with upsertBill on successful fetch", async () => {
    server.use(
      http.get("https://v3.openstates.org/bills", () =>
        HttpResponse.json({
          results: [{
            id: "ocd-bill/tx/listbills-1",
            identifier: "HB42",
            title: "Listed Test",
            session: "89R",
            updated_at: "2026-04-10T00:00:00Z",
            openstates_url: "https://openstates.org/tx/bills/89R/HB42",
            jurisdiction: { id: "ocd-jurisdiction/country:us/state:tx/government" },
            sponsorships: [],
            actions: [{ date: "2026-04-10", description: "Introduced" }],
          }],
          pagination: { max_page: 1 },
        }),
      ),
    );

    const dbPath = `/tmp/listBills-writethrough-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const { db } = openStore(dbPath);
    const adapter = new OpenStatesAdapter({ apiKey: "test-key" });

    const result = await adapter.listBills(db, {
      jurisdiction: "us-tx", sort: "updated_desc", limit: 20,
    });

    expect(result.documentsUpserted).toBe(1);
    const rows = db.prepare(
      "SELECT title FROM documents WHERE source_name='openstates' AND kind='bill'",
    ).all() as Array<{ title: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toMatch(/^HB42 — /);
  });

  it("passes sponsor as the sponsor query parameter when provided", async () => {
    let capturedSponsor: string | null = null;
    server.use(
      http.get("https://v3.openstates.org/bills", ({ request }) => {
        capturedSponsor = new URL(request.url).searchParams.get("sponsor");
        return HttpResponse.json({ results: [], pagination: { max_page: 1 } });
      }),
    );

    const dbPath = `/tmp/listBills-sponsor-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const { db } = openStore(dbPath);
    const adapter = new OpenStatesAdapter({ apiKey: "test-key" });

    await adapter.listBills(db, {
      jurisdiction: "us-tx",
      sponsor: "ocd-person/abc",
      sort: "updated_desc",
      limit: 20,
    });

    expect(capturedSponsor).toBe("ocd-person/abc");
  });

  it("throws on non-200 response", async () => {
    server.use(
      http.get("https://v3.openstates.org/bills", () =>
        new HttpResponse("boom", { status: 500 }),
      ),
    );

    const dbPath = `/tmp/listBills-fail-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const { db } = openStore(dbPath);
    const adapter = new OpenStatesAdapter({ apiKey: "test-key" });

    await expect(
      adapter.listBills(db, { jurisdiction: "us-tx", sort: "updated_desc", limit: 20 }),
    ).rejects.toThrow(/OpenStates \/bills returned 500/);
  });
});
```

Note on `sponsor` param: the adapter accepts the upstream OCD id
directly. The handler is responsible for mapping
`sponsor_entity_id` → OCD id via `findEntityById`
→ `metadata.external_ids.openstates_person` before calling the
adapter. See Task 3 Step 4.

- [ ] **Step 2: Run — expect fail**

```bash
pnpm test tests/unit/adapters/openstates.test.ts -t "listBills"
```

Expected: FAIL — `adapter.listBills is not a function`.

- [ ] **Step 3: Implement `listBills`**

Add to `OpenStatesAdapter` (place alongside `fetchRecentBills`):

```ts
/** Narrow per-tool fetch for R15 `list_bills` — one page of bills
 *  matching a set of structured predicates (session, chamber,
 *  sponsor, classification, subject, date windows). Writes through
 *  to `documents` via `upsertBill`. Uses distinct endpoint_path
 *  `/bills/list` in the shaped-fetch key so cache rows never
 *  collide with `recent_bills` (endpoint_path `/bills`). Note that
 *  OpenStates itself exposes only one `/bills` endpoint — the
 *  `/list` suffix is a cache-key discriminator, not a path the
 *  upstream sees. */
async listBills(
  db: Database.Database,
  opts: {
    jurisdiction: string;
    session?: string;
    chamber?: "upper" | "lower";
    sponsor?: string;
    classification?: string;
    subject?: string;
    introduced_since?: string;
    updated_since?: string;
    sort: "updated_desc" | "updated_asc" | "introduced_desc" | "introduced_asc";
    limit: number;
  },
): Promise<{ documentsUpserted: number }> {
  const abbr = opts.jurisdiction.replace(/^us-/, "").toLowerCase();
  const url = new URL(`${BASE_URL}/bills`);
  url.searchParams.set("jurisdiction", abbr);
  url.searchParams.set("sort", mapSort(opts.sort));
  url.searchParams.set("per_page", String(opts.limit));
  if (opts.session) url.searchParams.set("session", opts.session);
  if (opts.chamber) url.searchParams.set("chamber", opts.chamber);
  if (opts.sponsor) url.searchParams.set("sponsor", opts.sponsor);
  if (opts.classification) url.searchParams.set("classification", opts.classification);
  if (opts.subject) url.searchParams.set("subject", opts.subject);
  if (opts.introduced_since) url.searchParams.set("created_since", opts.introduced_since);
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
  const body = (await res.json()) as { results?: OpenStatesBill[] };

  let documentsUpserted = 0;
  for (const b of body.results ?? []) {
    this.upsertBill(db, b);
    documentsUpserted += 1;
  }
  return { documentsUpserted };
}
```

Add the `mapSort` helper at module scope (above the class
definition, alongside `extractStateAbbr`):

```ts
function mapSort(sort: string): string {
  switch (sort) {
    case "updated_desc": return "updated_desc";
    case "updated_asc": return "updated_asc";
    case "introduced_desc": return "first_action_desc";
    case "introduced_asc": return "first_action_asc";
    default: return "updated_desc";
  }
}
```

- [ ] **Step 4: Run — expect pass**

```bash
pnpm test tests/unit/adapters/openstates.test.ts -t "listBills"
```

Expected: all 6 `listBills` tests pass.

Full file sanity check:

```bash
pnpm test tests/unit/adapters/openstates.test.ts
```

Expected: all existing adapter tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/openstates.ts tests/unit/adapters/openstates.test.ts
git commit -m "$(cat <<'EOF'
feat(openstates): listBills adapter method for structured bill listing

Maps ListBillsInput predicates to OpenStates v3 /bills query
parameters. introduced_since maps to created_since; sort values
introduced_{asc,desc} map to first_action_{asc,desc}. Writes
through with upsertBill. Returns telemetry count for
withShapedFetch's primary_rows_written contract.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `list_bills` handler + handler unit tests

**Files:**
- Modify: `src/mcp/tools/recent_bills.ts` (ensure `export` on
  `BillSummary`, `SponsorSummary`, and `buildSponsorSummary`)
- Create: `src/mcp/tools/list_bills.ts`
- Modify: `src/mcp/server.ts` (register new tool)
- Create: `tests/unit/mcp/tools/list_bills.test.ts`

- [ ] **Step 1: Expose shared helpers from recent_bills.ts**

In `src/mcp/tools/recent_bills.ts`: `BillSummary`, `SponsorSummary`,
and `buildSponsorSummary` are already top-level. The types are
exported; `buildSponsorSummary` currently is not. Add the `export`
keyword to the function declaration:

```ts
export function buildSponsorSummary(
  db: Database.Database,
  refs: EntityReference[],
): SponsorSummary {
  // ... existing body unchanged
}
```

No test changes needed — existing tests import `handleRecentBills`,
not the helper.

- [ ] **Step 2: Write the failing handler test file**

Create `tests/unit/mcp/tools/list_bills.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { upsertFetchLog } from "../../../../src/core/fetch_log.js";
import { hashArgs } from "../../../../src/core/args_hash.js";
import { _resetToolCacheForTesting } from "../../../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../../../src/core/limiters.js";
import { OpenStatesAdapter } from "../../../../src/adapters/openstates.js";
import { handleListBills } from "../../../../src/mcp/tools/list_bills.js";

const TEST_DB = "./data/test-tool-list-bills.db";
let store: Store;

function seedFetchLogFresh(args: Record<string, unknown>): void {
  upsertFetchLog(store.db, {
    source: "openstates",
    endpoint_path: "/bills/list",
    args_hash: hashArgs("list_bills", args),
    scope: "recent",
    fetched_at: new Date().toISOString(),
    last_rowcount: 1,
  });
}

beforeEach(() => {
  _resetToolCacheForTesting();
  _resetLimitersForTesting();
  process.env.OPENSTATES_API_KEY = "test-key";
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});
afterEach(() => {
  store.close();
  delete process.env.OPENSTATES_API_KEY;
});

function defaultArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jurisdiction: "us-tx",
    session: undefined,
    chamber: undefined,
    sponsor_entity_id: undefined,
    classification: undefined,
    subject: undefined,
    introduced_since: undefined,
    introduced_until: undefined,
    updated_since: undefined,
    updated_until: undefined,
    sort: "updated_desc",
    limit: 20,
    ...over,
  };
}

describe("list_bills tool — R15 hydration", () => {
  it("calls OpenStatesAdapter.listBills on a cache miss", async () => {
    const spy = vi
      .spyOn(OpenStatesAdapter.prototype, "listBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(res.stale_notice).toBeUndefined();
    spy.mockRestore();
  });

  it("does NOT call adapter on a second call within TTL (cache hit)", async () => {
    const spy = vi
      .spyOn(OpenStatesAdapter.prototype, "listBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleListBills(store.db, { jurisdiction: "us-tx" });
    await handleListBills(store.db, { jurisdiction: "us-tx" });

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("us-federal returns stale_notice with reason=not_yet_supported", async () => {
    const res = await handleListBills(store.db, {
      jurisdiction: "us-federal",
    });
    expect(res.results).toHaveLength(0);
    expect(res.stale_notice?.reason).toBe("not_yet_supported");
  });
});

describe("list_bills tool — local projection (TTL-hit)", () => {
  it("filters by sponsor_entity_id", async () => {
    const { entity: sponsor } = upsertEntity(store.db, {
      kind: "person", name: "Sponsor A",
      external_ids: { openstates_person: "ocd-person/aaa" },
      metadata: {},
    });
    const { entity: other } = upsertEntity(store.db, {
      kind: "person", name: "Sponsor B",
      external_ids: { openstates_person: "ocd-person/bbb" },
      metadata: {},
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB1 — by A",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "1", url: "https://ex/1" },
      references: [{ entity_id: sponsor.id, role: "sponsor" }],
      raw: { actions: [] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB2 — by B",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "2", url: "https://ex/2" },
      references: [{ entity_id: other.id, role: "sponsor" }],
      raw: { actions: [] },
    });

    seedFetchLogFresh(defaultArgs({ sponsor_entity_id: sponsor.id }));
    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
      sponsor_entity_id: sponsor.id,
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].identifier).toBe("HB1");
  });

  it("filters by classification via raw.classification", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB1 — bill",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "c1", url: "https://ex/c1" },
      raw: { classification: ["bill"], actions: [] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HR1 — resolution",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "c2", url: "https://ex/c2" },
      raw: { classification: ["resolution"], actions: [] },
    });

    seedFetchLogFresh(defaultArgs({ classification: "resolution" }));
    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
      classification: "resolution",
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].identifier).toBe("HR1");
  });

  it("filters by subject via raw.subjects[]", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB1 — vehicles",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "s1", url: "https://ex/s1" },
      raw: { subjects: ["Vehicles", "Repossession"], actions: [] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB2 — other",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "s2", url: "https://ex/s2" },
      raw: { subjects: ["Education"], actions: [] },
    });

    seedFetchLogFresh(defaultArgs({ subject: "Vehicles" }));
    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
      subject: "Vehicles",
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].identifier).toBe("HB1");
  });

  it("filters by introduced_since/until using raw.actions[0].date", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB1 — jan",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "i1", url: "https://ex/i1" },
      raw: { actions: [{ date: "2026-01-10", description: "Introduced" }] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB2 — mar",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "i2", url: "https://ex/i2" },
      raw: { actions: [{ date: "2026-03-10", description: "Introduced" }] },
    });

    seedFetchLogFresh(
      defaultArgs({ introduced_since: "2026-02-01", introduced_until: "2026-04-01" }),
    );
    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
      introduced_since: "2026-02-01",
      introduced_until: "2026-04-01",
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].identifier).toBe("HB2");
  });

  it("sorts by introduced_asc", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB1 — late",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "o1", url: "https://ex/o1" },
      raw: { actions: [{ date: "2026-03-10", description: "Introduced" }] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB2 — early",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "o2", url: "https://ex/o2" },
      raw: { actions: [{ date: "2026-01-10", description: "Introduced" }] },
    });

    seedFetchLogFresh(defaultArgs({ sort: "introduced_asc" }));
    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
      sort: "introduced_asc",
    });
    expect(res.results.map((r) => r.identifier)).toEqual(["HB2", "HB1"]);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      upsertDocument(store.db, {
        kind: "bill", jurisdiction: "us-tx", title: `HB${i} — t`,
        occurred_at: `2026-04-${10 + i}T00:00:00Z`,
        source: { name: "openstates", id: `L${i}`, url: `https://ex/${i}` },
        raw: { actions: [] },
      });
    }

    seedFetchLogFresh(defaultArgs({ limit: 3 }));
    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
      limit: 3,
    });
    expect(res.results).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Run — expect fail**

```bash
pnpm test tests/unit/mcp/tools/list_bills.test.ts
```

Expected: FAIL — `handleListBills` does not exist.

- [ ] **Step 4: Implement `handleListBills`**

Create `src/mcp/tools/list_bills.ts`:

```ts
import type Database from "better-sqlite3";
import { OpenStatesAdapter } from "../../adapters/openstates.js";
import { queryDocuments } from "../../core/documents.js";
import { findEntityById } from "../../core/entities.js";
import { getLimiter } from "../../core/limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import { requireEnv } from "../../util/env.js";
import { ListBillsInput } from "../schemas.js";
import type { StaleNotice } from "../shared.js";
import {
  buildSponsorSummary,
  type BillSummary,
} from "./recent_bills.js";

export interface ListBillsResponse {
  results: BillSummary[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  stale_notice?: StaleNotice;
}

function introducedDate(raw: Record<string, unknown>): string | undefined {
  const actions = raw.actions as Array<{ date: string }> | undefined;
  return actions?.[0]?.date;
}

function updatedDate(raw: Record<string, unknown>, occurred_at: string): string {
  // OpenStates bills are written with occurred_at = last action date
  // (see upsertBill). For update-date comparisons we use occurred_at
  // directly — it is kept in sync with the most recent action.
  return occurred_at;
}

function matchesClassification(
  raw: Record<string, unknown>,
  filter: string,
): boolean {
  const c = raw.classification;
  if (Array.isArray(c)) return c.includes(filter);
  if (typeof c === "string") return c === filter;
  return false;
}

function matchesSubject(
  raw: Record<string, unknown>,
  filter: string,
): boolean {
  const subjects = raw.subjects as string[] | undefined;
  return Array.isArray(subjects) && subjects.includes(filter);
}

function compareSort(
  a: { intro?: string; upd: string },
  b: { intro?: string; upd: string },
  sort: "updated_desc" | "updated_asc" | "introduced_desc" | "introduced_asc",
): number {
  if (sort === "updated_desc") return b.upd.localeCompare(a.upd);
  if (sort === "updated_asc") return a.upd.localeCompare(b.upd);
  const ai = a.intro ?? "";
  const bi = b.intro ?? "";
  if (sort === "introduced_desc") return bi.localeCompare(ai);
  return ai.localeCompare(bi);
}

export async function handleListBills(
  db: Database.Database,
  rawInput: unknown,
): Promise<ListBillsResponse> {
  const input = ListBillsInput.parse(rawInput);

  // Federal: defer to future phase; return not_yet_supported.
  if (input.jurisdiction === "us-federal") {
    return {
      results: [],
      total: 0,
      sources: [{ name: "congress", url: "https://www.congress.gov/" }],
      stale_notice: {
        as_of: new Date().toISOString(),
        reason: "not_yet_supported",
        message:
          "list_bills does not yet support us-federal. Congress.gov's bill " +
          "endpoint does not accept the same predicates (sponsor, subject, " +
          "classification). For federal cosponsor queries, use " +
          "entity_connections on the member's entity id.",
      },
    };
  }

  // Map sponsor_entity_id (our UUID) → OCD person id for upstream.
  let sponsorOcd: string | undefined;
  if (input.sponsor_entity_id) {
    const ent = findEntityById(db, input.sponsor_entity_id);
    const xids = (ent?.external_ids ?? {}) as Record<string, string>;
    sponsorOcd = xids.openstates_person;
  }

  const projectLocal = (): ListBillsResponse => {
    const docs = queryDocuments(db, {
      kind: "bill",
      jurisdiction: input.jurisdiction,
      limit: 500,
    });

    const filtered = docs.filter((d) => {
      if (input.session) {
        const s = (d.raw as { session?: string }).session;
        if (s !== input.session) return false;
      }
      if (input.chamber) {
        const sponsor = d.references.find((r) => r.role === "sponsor");
        if (!sponsor) return false;
        const ent = findEntityById(db, sponsor.entity_id);
        if (ent?.metadata.chamber !== input.chamber) return false;
      }
      if (input.sponsor_entity_id) {
        const refs = d.references;
        const hit = refs.some(
          (r) =>
            r.entity_id === input.sponsor_entity_id &&
            (r.role === "sponsor" || r.role === "cosponsor"),
        );
        if (!hit) return false;
      }
      if (input.classification && !matchesClassification(d.raw, input.classification)) {
        return false;
      }
      if (input.subject && !matchesSubject(d.raw, input.subject)) {
        return false;
      }
      if (input.introduced_since || input.introduced_until) {
        const intro = introducedDate(d.raw);
        if (!intro) return false;
        if (input.introduced_since && intro < input.introduced_since) return false;
        if (input.introduced_until && intro > input.introduced_until) return false;
      }
      if (input.updated_since || input.updated_until) {
        const upd = updatedDate(d.raw, d.occurred_at);
        if (input.updated_since && upd < input.updated_since) return false;
        if (input.updated_until && upd > input.updated_until) return false;
      }
      return true;
    });

    const sortable = filtered.map((d) => ({
      doc: d,
      intro: introducedDate(d.raw),
      upd: updatedDate(d.raw, d.occurred_at),
    }));
    sortable.sort((a, b) => compareSort(a, b, input.sort));
    const limited = sortable.slice(0, input.limit);

    const results: BillSummary[] = limited.map(({ doc: d }) => {
      const [identifier, ...titleParts] = d.title.split(" — ");
      const actions =
        (d.raw.actions as Array<{ date: string; description: string }> | undefined) ?? [];
      const latest = actions.length ? actions[actions.length - 1] : null;
      return {
        id: d.id,
        identifier: identifier?.trim() ?? d.title,
        title: titleParts.join(" — ").trim() || d.title,
        latest_action: latest,
        sponsor_summary: buildSponsorSummary(db, d.references),
        source_url: d.source.url,
      };
    });

    const stateAbbr = input.jurisdiction.replace(/^us-/, "");
    return {
      results,
      total: results.length,
      sources: [
        {
          name: "openstates",
          url: `https://openstates.org/${stateAbbr}/`,
        },
      ],
    };
  };

  const fetchAndWrite = async (): Promise<{ primary_rows_written: number }> => {
    const adapter = new OpenStatesAdapter({
      apiKey: requireEnv("OPENSTATES_API_KEY"),
      rateLimiter: getLimiter("openstates"),
    });
    const { documentsUpserted } = await adapter.listBills(db, {
      jurisdiction: input.jurisdiction,
      session: input.session,
      chamber: input.chamber,
      sponsor: sponsorOcd,
      classification: input.classification,
      subject: input.subject,
      introduced_since: input.introduced_since,
      updated_since: input.updated_since,
      sort: input.sort,
      limit: input.limit,
    });
    return { primary_rows_written: documentsUpserted };
  };

  const result = await withShapedFetch(
    db,
    {
      source: "openstates",
      endpoint_path: "/bills/list",
      args: {
        jurisdiction: input.jurisdiction,
        session: input.session,
        chamber: input.chamber,
        sponsor_entity_id: input.sponsor_entity_id,
        classification: input.classification,
        subject: input.subject,
        introduced_since: input.introduced_since,
        introduced_until: input.introduced_until,
        updated_since: input.updated_since,
        updated_until: input.updated_until,
        sort: input.sort,
        limit: input.limit,
      },
      tool: "list_bills",
    },
    { scope: "recent", ms: 60 * 60 * 1000 },
    fetchAndWrite,
    projectLocal,
    () => getLimiter("openstates").peekWaitMs(),
  );

  if (result.stale_notice) {
    return { ...result.value, stale_notice: result.stale_notice };
  }
  return result.value;
}
```

- [ ] **Step 5: Register the tool in server.ts**

In `src/mcp/server.ts` add to the imports:

```ts
import { handleListBills } from "./tools/list_bills.js";
```

Extend the `schemas.js` import to add `ListBillsInput`:

```ts
import {
  RecentBillsInput,
  RecentVotesInput,
  RecentContributionsInput,
  SearchEntitiesInput,
  GetEntityInput,
  SearchDocumentsInput,
  EntityConnectionsInput,
  ResolvePersonInput,
  GetBillInput,
  ListBillsInput,
} from "./schemas.js";
```

Register the tool alongside the others (place after the
`recent_bills` registration so the related tools are adjacent):

```ts
mcp.registerTool(
  "list_bills",
  {
    description:
      "List legislative bills by structured predicates — sponsor, subject, " +
      "classification, session, chamber, introduction/update date ranges. " +
      "Distinct from recent_bills (which is a time-windowed feed). " +
      'Jurisdiction is required; pass "us-<state>" (e.g. "us-ca"). ' +
      "us-federal is not yet supported and returns a stale_notice.",
    inputSchema: ListBillsInput.shape,
  },
  async (input) => {
    const data = await handleListBills(store.db, input);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);
```

- [ ] **Step 6: Run — expect pass**

```bash
pnpm test tests/unit/mcp/tools/list_bills.test.ts
```

Expected: all 9 handler tests pass.

Broader sanity check:

```bash
pnpm test
```

Expected: all tests still green; `recent_bills` is unchanged, only
the helper export was added.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/recent_bills.ts src/mcp/tools/list_bills.ts src/mcp/server.ts tests/unit/mcp/tools/list_bills.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): list_bills tool for structured bill listing

Handler orchestrates withShapedFetch on endpoint_path /bills/list
(distinct from /bills used by recent_bills, so cache rows stay
separate). Branches on jurisdiction: us-federal returns
not_yet_supported stale_notice; state jurisdictions call
OpenStatesAdapter.listBills. Local projection filters by
session/chamber/sponsor_entity_id/classification/subject and
applies introduced_*/updated_* date windows plus the requested
sort, then limits. Reuses BillSummary and buildSponsorSummary
from recent_bills.ts.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Integration test — R15 shaped e2e

**Files:**
- Create: `tests/integration/list-bills-e2e.test.ts`

- [ ] **Step 1: Write the failing integration test**

> Implementation note (2026-04-14): the original draft of this task
> assumed `msw` was a project dev dep. It is not — `passthrough-e2e.shaped.test.ts`
> stubs HTTP with `vi.spyOn(global, "fetch")`. Task 4 was shipped
> using that same pattern, preserving all four scenarios verbatim.
> The `setupServer` / `http.get` example below is kept as reference;
> the live file is the vi.spyOn translation.

Create `tests/integration/list-bills-e2e.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { rmSync, existsSync } from "node:fs";
import { bootstrap } from "../../src/cli/bootstrap.js";
import { openStore, type Store } from "../../src/core/store.js";
import { handleListBills } from "../../src/mcp/tools/list_bills.js";
import { _resetToolCacheForTesting } from "../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../src/core/limiters.js";

const server = setupServer();
const TEST_DB = "./data/test-list-bills-e2e.db";
let store: Store;

beforeEach(async () => {
  server.listen({ onUnhandledRequest: "error" });
  _resetToolCacheForTesting();
  _resetLimitersForTesting();
  process.env.OPENSTATES_API_KEY = "test-key";
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  await bootstrap({ dbPath: TEST_DB });
  store = openStore(TEST_DB);
});

afterEach(() => {
  server.resetHandlers();
  server.close();
  store.close();
  delete process.env.OPENSTATES_API_KEY;
});

describe("list_bills — R15 shaped e2e", () => {
  it("cold fetch writes through, warm hit serves from cache (upstream hit once)", async () => {
    let upstreamHits = 0;
    server.use(
      http.get("https://v3.openstates.org/bills", ({ request }) => {
        upstreamHits += 1;
        const url = new URL(request.url);
        expect(url.searchParams.get("jurisdiction")).toBe("ca");
        expect(url.searchParams.get("subject")).toBe("Vehicles");
        return HttpResponse.json({
          results: [{
            id: "ocd-bill/ca/1",
            identifier: "SB1338",
            title: "Vehicles: repossession.",
            session: "20252026",
            updated_at: "2026-04-10T00:00:00Z",
            openstates_url: "https://openstates.org/ca/bills/20252026/SB1338",
            jurisdiction: { id: "ocd-jurisdiction/country:us/state:ca/government" },
            sponsorships: [],
            actions: [{ date: "2026-02-20", description: "Introduced" }],
            subject: ["Vehicles"],
          }],
          pagination: { max_page: 1 },
        });
      }),
    );

    const first = await handleListBills(store.db, {
      jurisdiction: "us-ca",
      subject: "Vehicles",
    });
    const second = await handleListBills(store.db, {
      jurisdiction: "us-ca",
      subject: "Vehicles",
    });

    expect(upstreamHits).toBe(1);
    expect(first.results).toHaveLength(1);
    expect(first.results[0].identifier).toBe("SB1338");
    expect(second.results).toHaveLength(1);
  });

  it("distinct args produce distinct cache rows (two upstream hits)", async () => {
    let upstreamHits = 0;
    server.use(
      http.get("https://v3.openstates.org/bills", () => {
        upstreamHits += 1;
        return HttpResponse.json({
          results: [],
          pagination: { max_page: 1 },
        });
      }),
    );

    await handleListBills(store.db, { jurisdiction: "us-ca", subject: "Vehicles" });
    await handleListBills(store.db, { jurisdiction: "us-ca", subject: "Education" });

    expect(upstreamHits).toBe(2);
  });

  it("us-federal returns not_yet_supported without upstream hits", async () => {
    let hit = 0;
    server.use(
      http.all("https://api.congress.gov/v3/*", () => {
        hit += 1;
        return HttpResponse.json({});
      }),
    );

    const res = await handleListBills(store.db, { jurisdiction: "us-federal" });
    expect(res.stale_notice?.reason).toBe("not_yet_supported");
    expect(hit).toBe(0);
  });

  it("upstream failure with no cached data propagates", async () => {
    server.use(
      http.get("https://v3.openstates.org/bills", () =>
        HttpResponse.error(),
      ),
    );

    await expect(
      handleListBills(store.db, { jurisdiction: "us-ca" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect pass**

```bash
pnpm test tests/integration/list-bills-e2e.test.ts
```

Expected: 4/4 pass.

Full suite sanity check:

```bash
pnpm test
```

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/list-bills-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(integration): R15 shaped e2e for list_bills

Four scenarios: cold→warm hit with /bills/list cache row, distinct
args produce distinct cache rows, us-federal returns
not_yet_supported without hitting upstream, upstream failure with
no cache propagates the error.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Docs + CHANGELOG + acceptance verification

**Files:**
- Modify: `docs/05-tool-surface.md`
- Modify: `docs/06-open-decisions.md`
- Modify: `docs/plans/phase-9-overview.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the `list_bills` section to `docs/05-tool-surface.md`**

Under `## Feed tools (B)`, after the `### recent_bills` section and
before `### recent_contributions`, insert:

```markdown
### `list_bills`

```
input:
  jurisdiction: string              // REQUIRED. "us-<state>". us-federal returns not_yet_supported in 9b.
  session: string | undefined       // OpenStates session id, e.g. "20252026"
  chamber: "upper" | "lower" | undefined
  sponsor_entity_id: string | undefined     // filters bills with this entity as sponsor or cosponsor
  classification: string | undefined        // "bill", "resolution", "joint resolution", ...
  subject: string | undefined               // OpenStates subject tag, exact match
  introduced_since: string | undefined      // ISO date; inclusive
  introduced_until: string | undefined      // ISO date; inclusive
  updated_since: string | undefined         // ISO date; inclusive
  updated_until: string | undefined         // ISO date; inclusive
  sort: "updated_desc" | "updated_asc" | "introduced_desc" | "introduced_asc"  (default updated_desc)
  limit: number (default 20, max 50)

output: ToolResponse<BillSummary>
```

`list_bills` is a structured-predicate listing projection, distinct
from `recent_bills` (which is a time-windowed feed). The two share
the `BillSummary` shape so consumers can treat results
interchangeably. Cache rows use `endpoint_path="/bills/list"` and
never collide with `recent_bills`'s `endpoint_path="/bills"` rows —
see D13.

Federal (us-federal) is not yet supported; Congress.gov's `/bill`
endpoint does not accept the same predicate surface (no native
sponsor, subject, or classification filters), and the audit
found these queries are better served today by `entity_connections`
on the member entity. A later phase can add federal support without
changing the tool surface.
```

Change the 9-tools phrasing:

- Line 1 of `docs/05-tool-surface.md`: `**9 tools**` → `**10 tools**`.
- The "As of Phase 8 (2026-04-14), the server exposes **9 tools
  total**" paragraph: change to "As of Phase 9b (2026-04-14), the
  server exposes **10 tools total**" and add `list_bills` to the
  comma-separated list.
- Under `## Phase-to-tool mapping` append a new row:

```markdown
| **9b — list_bills** | ✅ done | + `list_bills` (OpenStates state bills; federal deferred) |
```

- [ ] **Step 2: Lock D13 in `docs/06-open-decisions.md`**

The `phase-9-overview.md` draft describes D13. Append to
`docs/06-open-decisions.md` (after D12 or at end if D12 has not yet
landed from 9a):

```markdown
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
```

- [ ] **Step 3: Mark 9b shipped in `docs/plans/phase-9-overview.md`**

In the Sub-phases table, change the 9b row's "Size" column or add
a trailing status checkmark. If the table style elsewhere in the
repo uses an explicit "Status" column, insert one. Minimal
in-place change: prepend "✅ " to the 9b plan link:

```markdown
| [`phase-9b-list-bills.md`](./phase-9b-list-bills.md) ✅ | ... |
```

- [ ] **Step 4: Add a CHANGELOG entry**

Check whether `CHANGELOG.md` exists:

```bash
ls CHANGELOG.md
```

If it exists, add under the first `## [Unreleased]` section an
`### Added` block (creating the `### Added` subsection if absent):

```markdown
### Added
- `list_bills` MCP tool for structured bill listing by sponsor,
  subject, classification, session, chamber, and date ranges.
  Ships OpenStates state-bill support; federal returns
  `not_yet_supported` until a future phase.
```

If `CHANGELOG.md` does not exist, skip this step — this plan
does not create it; it is the job of Phase 9d to establish the
v0.4.0 changelog section.

- [ ] **Step 5: Acceptance verification**

Run the full test suite:

```bash
pnpm test
```

Expected: all tests green, total count has gone up by the tests
added in Tasks 1–4 (roughly 18–22 new tests).

Run the build:

```bash
pnpm build
```

Expected: TypeScript compiles clean, no warnings.

Spot-check the tool count:

```bash
grep -c '^### ' docs/05-tool-surface.md
```

Expected: 10 (the nine prior tools plus `list_bills`; the
`### Added` from the changelog snippet is in a different file).

Grep for the new symbol to confirm wiring:

```bash
grep -rn "handleListBills" src/ | wc -l
```

Expected: 2 (definition in `list_bills.ts`; registration in
`server.ts`).

- [ ] **Step 6: Commit**

```bash
git add docs/05-tool-surface.md docs/06-open-decisions.md docs/plans/phase-9-overview.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: list_bills tool surface + D13 + phase-9b shipped

- docs/05-tool-surface.md: add list_bills section; bump count 9→10
- docs/06-open-decisions.md: lock D13 (list_bills distinct from
  search_civic_documents)
- docs/plans/phase-9-overview.md: mark 9b shipped
- CHANGELOG.md: unreleased Added entry for list_bills

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Acceptance check

- [ ] `pnpm test` green end-to-end. New test count roughly +18–22.
- [ ] `pnpm build` clean.
- [ ] `grep -c '^### ' docs/05-tool-surface.md` → 10.
- [ ] `grep -rn "endpoint_path.*\"/bills/list\"" src/` → exactly
  one hit in `src/mcp/tools/list_bills.ts`.
- [ ] `grep -rn "endpoint_path.*\"/bills\"" src/` → exactly one
  hit in `src/mcp/tools/recent_bills.ts` (unchanged from Phase 8b).
- [ ] `handleListBills` with `us-federal` returns
  `stale_notice.reason === "not_yet_supported"` (covered by Task 3
  test and Task 4 integration test).
- [ ] D13 appears in `docs/06-open-decisions.md` with 2026-04-14
  LOCKED line.
- [ ] `list_bills` appears in `src/mcp/server.ts` `registerTool`
  calls, in `docs/05-tool-surface.md` under Feed tools, and in
  `CHANGELOG.md` (if the file exists).

Phase 9b is complete when all items above hold. Phase 9c
(`get_vote`) follows in its own plan doc.

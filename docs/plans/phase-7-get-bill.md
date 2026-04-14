# Phase 7 — `get_bill` Detail Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new MCP tool `get_bill(jurisdiction, session, identifier)`
that returns the full bill detail Plural-style UIs expect —
abstracts, subjects, versions (with `text_url` links), full
actions history, sponsor classifications, and related bills —
without the MCP itself scraping state-leginfo sites.

**Architecture:** The existing `recent_bills` feed is a thin
projection; `get_bill` is the **detail** projection over the same
`documents` table. Two additions make it work:

1. The OpenStates adapter's `upsertBill` persists four new fields
   in `Document.raw`: `subjects[]`, `versions[]`, `documents[]`,
   `related_bills[]`, plus the full `sponsorships[]` (with
   classification preserved, not collapsed to sponsor/cosponsor).
2. A new `src/core/hydrate_bill.ts` adds per-document freshness:
   if the target bill is missing or its `fetched_at` is stale
   (>1h), fetch it via OpenStates v3 `/bills/{jurisdiction}/{session}/{identifier}`
   with all `include[]` params, upsert, then project.

The handler always reads from the local store after hydration —
the projection logic never touches the network. The LLM consumer
follows `versions[*].text_url` itself to fetch full text
(respecting R9 / D3c — the MCP exposes facts, not summarization).

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`,
`better-sqlite3`, `vitest` + `msw` for HTTP mocking.

**Scope impact:** Adds R14 to `docs/00-rationale.md` and D11 to
`docs/06-open-decisions.md` (both executed in Task 1, before
any code). Federal (Congress.gov) parity for `get_bill` is
explicitly deferred to Phase 7b — this plan is OpenStates-only
to keep the blast radius small. Federal bills will return a
`not_yet_supported` shape until 7b.

---

## File structure produced by this phase

```
src/
├── adapters/
│   └── openstates.ts              # MODIFIED: upsertBill persists new fields,
│                                  #           new fetchBill() method
├── core/
│   └── hydrate_bill.ts            # NEW: ensureBillFresh() — per-document TTL
├── mcp/
│   ├── schemas.ts                 # MODIFIED: + GetBillInput
│   ├── server.ts                  # MODIFIED: registerTool("get_bill", ...)
│   └── tools/
│       └── get_bill.ts            # NEW: handler + projection
docs/
├── 00-rationale.md                # MODIFIED: + R14
├── 05-tool-surface.md             # MODIFIED: + get_bill section
├── 06-open-decisions.md           # MODIFIED: + D11
└── plans/
    └── phase-7-get-bill.md        # this file
tests/
├── integration/
│   ├── fixtures/
│   │   └── openstates-bill-detail.json   # NEW
│   └── get-bill-e2e.test.ts              # NEW
└── unit/
    ├── adapters/openstates.test.ts        # MODIFIED: assert new raw fields
    └── mcp/tools/get_bill.test.ts         # NEW
```

---

## Task 1: Decision records

**Files:**
- Modify: `docs/00-rationale.md` (append R14)
- Modify: `docs/06-open-decisions.md` (append D11)

- [ ] **Step 1: Append R14 to `docs/00-rationale.md`**

Append at the end of the file (preserve all prior R entries):

```markdown
## R14 — Per-document hydration for detail tools (2026-04-13)

R13 establishes pass-through hydration keyed by
`(source, jurisdiction, scope)`. That model fits feed tools
(`recent_bills`, `recent_votes`) which paginate a jurisdiction's
recent activity, but it does not fit detail tools that target a
single resource by identifier. A bill from a prior session or
one that fell off the "recently updated" window will never be
present after a jurisdiction-level refresh.

Phase 7 introduces `get_bill`, whose freshness is tracked
per-document via `documents.fetched_at`. If the target row is
missing or older than the 1h `recent` TTL, the handler fetches
`GET /bills/{jurisdiction}/{session}/{identifier}` directly,
upserts, then projects. The `hydrations` table is not extended;
per-document freshness lives on the document row itself.

This keeps `hydrations` bounded (one row per jurisdiction×scope
pair) while still serving arbitrary bills on demand. Stale-on-
failure semantics match R13: upstream errors serve the existing
local row with a `stale_notice`.
```

- [ ] **Step 2: Append D11 to `docs/06-open-decisions.md`**

Append at the end (after D10):

```markdown
## D11 — Detail-tool hydration scope (2026-04-13, LOCKED)

**Decision:** Detail tools (`get_bill`, and future `get_vote`,
`get_contribution`) use per-document freshness via
`documents.fetched_at`, not the `hydrations` table. TTL is the
same 1h recent window used by feed tools. Upstream fetches hit
the per-resource endpoint (e.g. OpenStates
`/bills/{jurisdiction}/{session}/{identifier}`).

**Why:** See R14. Per-jurisdiction freshness cannot represent
"I have this specific bill" — it only tracks "I have this
jurisdiction's recent feed."

**Alternatives rejected:**
- Extend `hydrations` with a per-identifier scope → unbounded
  table growth, complicates eviction.
- Always refetch on every `get_bill` call → hammers upstream,
  breaks rate-limit budget under concurrent MCP clients.
```

- [ ] **Step 3: Commit**

```bash
git add docs/00-rationale.md docs/06-open-decisions.md
git commit -m "docs: add R14 and D11 for per-document hydration (phase-7)"
```

---

## Task 2: Adapter — persist new fields in `upsertBill`

**Files:**
- Modify: `src/adapters/openstates.ts:37-48,186-217`
- Test: `tests/unit/adapters/openstates.test.ts`

The current `OpenStatesBill` interface and `upsertBill` method
drop everything except `sponsorships`, `actions`, and
`abstracts[0]`. We need `subjects[]`, `versions[]`, `documents[]`,
`related_bills[]`, and the full `sponsorships[]` (preserving
`classification` so "primary" vs "cosponsor" vs "coauthor" round-
trips to the projection).

- [ ] **Step 1: Write failing unit test asserting new raw fields**

Append to `tests/unit/adapters/openstates.test.ts`:

```typescript
describe("upsertBill persists detail fields in raw", () => {
  it("stores subjects, versions, documents, related_bills, sponsorships", () => {
    const store = openStore(TEST_DB);
    seedJurisdictions(store.db);
    const adapter = new OpenStatesAdapter({ apiKey: "test" });
    // Reach through to the private method via a thin test-only wrapper
    // exposed at the bottom of openstates.ts (Step 2 below).
    (adapter as unknown as {
      upsertBill: (db: Database.Database, b: OpenStatesBillDetail) => void
    }).upsertBill(store.db, {
      id: "ocd-bill/abc",
      identifier: "SB 1338",
      title: "Vehicles: repossession.",
      session: "20252026",
      updated_at: "2026-04-09T00:00:00Z",
      openstates_url: "https://openstates.org/ca/bills/20252026/SB1338/",
      jurisdiction: { id: "ocd-jurisdiction/country:us/state:ca/government" },
      subject: ["Vehicles", "Repossession"],
      abstracts: [{ abstract: "Existing law prohibits..." }],
      sponsorships: [{
        name: "Brian Jones",
        classification: "primary",
        person: {
          id: "ocd-person/xyz", name: "Brian Jones", party: "Republican",
          jurisdiction: { id: "ocd-jurisdiction/country:us/state:ca/government" },
        },
      }],
      actions: [{ date: "2026-02-20", description: "Introduced." }],
      versions: [{
        note: "Introduced", date: "2026-02-20",
        links: [{ url: "https://leginfo.legislature.ca.gov/faces/billPdfClient.xhtml?bill_id=202520260SB1338&version=20250SB133899INT", media_type: "application/pdf" }],
      }],
      documents: [],
      related_bills: [],
    });
    const row = store.db
      .prepare("SELECT raw FROM documents WHERE source_id = ?")
      .get("ocd-bill/abc") as { raw: string };
    const raw = JSON.parse(row.raw);
    expect(raw.session).toBe("20252026");
    expect(raw.subjects).toEqual(["Vehicles", "Repossession"]);
    expect(raw.versions).toHaveLength(1);
    expect(raw.versions[0].links[0].url).toMatch(/leginfo\.legislature\.ca\.gov/);
    expect(raw.sponsorships).toHaveLength(1);
    expect(raw.sponsorships[0].classification).toBe("primary");
    expect(raw.abstracts[0].abstract).toMatch(/Existing law/);
    store.close();
  });
});
```

Also add the `OpenStatesBillDetail` type import at the top of
the test file (exported from adapter per Step 2).

- [ ] **Step 2: Run test to confirm it fails**

Run: `pnpm test tests/unit/adapters/openstates.test.ts -t "upsertBill persists detail"`
Expected: FAIL — `raw.subjects` is `undefined` (current impl
only writes `session` and `actions`).

- [ ] **Step 3: Extend `OpenStatesBill` interface in `src/adapters/openstates.ts`**

Replace the interface at `src/adapters/openstates.ts:37-48` with:

```typescript
export interface OpenStatesBillVersion {
  note?: string;
  date?: string;
  links?: Array<{ url: string; media_type?: string }>;
}

export interface OpenStatesBillDocument {
  note?: string;
  date?: string;
  links?: Array<{ url: string; media_type?: string }>;
}

export interface OpenStatesRelatedBill {
  identifier?: string;
  legislative_session?: string;
  relation_type?: string;
}

export interface OpenStatesBillDetail {
  id: string;
  identifier: string;
  title: string;
  session: string;
  updated_at: string;
  openstates_url: string;
  jurisdiction?: { id?: string };
  sponsorships?: OpenStatesSponsorship[];
  actions?: Array<{ date: string; description: string; classification?: string[] }>;
  abstracts?: Array<{ abstract: string; note?: string }>;
  subject?: string[];
  versions?: OpenStatesBillVersion[];
  documents?: OpenStatesBillDocument[];
  related_bills?: OpenStatesRelatedBill[];
}

// Alias kept for backwards compat with the existing fetchAllPages
// code path; the feed endpoint returns a subset of OpenStatesBillDetail.
type OpenStatesBill = OpenStatesBillDetail;
```

- [ ] **Step 4: Rewrite `upsertBill` to persist new fields**

Replace `src/adapters/openstates.ts:186-217`:

```typescript
  private upsertBill(db: Database.Database, b: OpenStatesBillDetail): void {
    const billStateAbbr =
      extractStateAbbr(b.jurisdiction?.id)
      ?? extractStateAbbr(b.sponsorships?.[0]?.person?.jurisdiction?.id);
    if (!billStateAbbr) {
      throw new Error(`Cannot determine state for bill ${b.id}`);
    }
    const billJurisdiction = `us-${billStateAbbr}`;

    const refs = (b.sponsorships ?? []).map((s) => {
      const personId = s.person
        ? this.upsertPerson(db, s.person, billStateAbbr)
        : upsertEntity(db, { kind: "person", name: s.name, jurisdiction: undefined }).entity.id;
      return {
        entity_id: personId,
        role: (s.classification === "primary" ? "sponsor" : "cosponsor") as
          | "sponsor" | "cosponsor",
      };
    });

    const summary = b.abstracts?.[0]?.abstract;
    upsertDocument(db, {
      kind: "bill",
      jurisdiction: billJurisdiction,
      title: `${b.identifier} — ${b.title}`,
      summary,
      occurred_at: b.actions?.at(-1)?.date ?? b.updated_at,
      source: { name: "openstates", id: b.id, url: b.openstates_url },
      references: refs,
      raw: {
        session: b.session,
        actions: b.actions ?? [],
        abstracts: b.abstracts ?? [],
        subjects: b.subject ?? [],
        versions: b.versions ?? [],
        documents: b.documents ?? [],
        related_bills: b.related_bills ?? [],
        sponsorships: b.sponsorships ?? [],
      },
    });
  }
```

- [ ] **Step 5: Run test to confirm pass**

Run: `pnpm test tests/unit/adapters/openstates.test.ts`
Expected: PASS (including the existing tests, which continue
to work because new raw fields are additive).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/openstates.ts tests/unit/adapters/openstates.test.ts
git commit -m "feat(openstates): persist subjects, versions, documents, related_bills in Document.raw"
```

---

## Task 3: Adapter — `fetchBill` method for per-resource hydration

**Files:**
- Modify: `src/adapters/openstates.ts` (add public `fetchBill` method)
- Test: `tests/unit/adapters/openstates.test.ts` (append)

- [ ] **Step 1: Write failing test for `fetchBill`**

Append to `tests/unit/adapters/openstates.test.ts`:

```typescript
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("fetchBill", () => {
  it("fetches one bill by jurisdiction+session+identifier and upserts", async () => {
    server.use(
      http.get("https://v3.openstates.org/bills/ca/20252026/SB1338", ({ request }) => {
        const url = new URL(request.url);
        const includes = url.searchParams.getAll("include");
        expect(includes).toEqual(expect.arrayContaining([
          "sponsorships", "abstracts", "actions", "versions",
          "documents", "sources", "related_bills",
        ]));
        return HttpResponse.json({
          id: "ocd-bill/abc",
          identifier: "SB 1338",
          title: "Vehicles: repossession.",
          session: "20252026",
          updated_at: "2026-04-09T00:00:00Z",
          openstates_url: "https://openstates.org/ca/bills/20252026/SB1338/",
          jurisdiction: { id: "ocd-jurisdiction/country:us/state:ca/government" },
          subject: ["Vehicles", "Repossession"],
          abstracts: [{ abstract: "Existing law..." }],
          sponsorships: [],
          actions: [{ date: "2026-02-20", description: "Introduced." }],
          versions: [],
          documents: [],
          related_bills: [],
        });
      }),
    );
    const store = openStore(TEST_DB);
    seedJurisdictions(store.db);
    const adapter = new OpenStatesAdapter({ apiKey: "test" });
    await adapter.fetchBill(store.db, {
      jurisdiction: "us-ca",
      session: "20252026",
      identifier: "SB 1338",
    });
    const row = store.db
      .prepare("SELECT title FROM documents WHERE source_id = ?")
      .get("ocd-bill/abc") as { title: string } | undefined;
    expect(row?.title).toBe("SB 1338 — Vehicles: repossession.");
    store.close();
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `pnpm test tests/unit/adapters/openstates.test.ts -t "fetchBill"`
Expected: FAIL — `adapter.fetchBill is not a function`.

- [ ] **Step 3: Implement `fetchBill` on `OpenStatesAdapter`**

Insert after the existing `refresh()` method in `src/adapters/openstates.ts`
(approximately after line 120):

```typescript
  /** Fetches a single bill by (jurisdiction, session, identifier) and
   *  upserts it into the store. Used by detail tools (R14) — the
   *  jurisdiction-level `refresh()` path only covers recently-updated
   *  bills, so a bill from an earlier session must be fetched directly.
   *
   *  Path shape: `/bills/{abbr}/{session}/{identifier}` where abbr is
   *  the state postal code. Space in the identifier (e.g. "SB 1338")
   *  is URL-encoded. */
  async fetchBill(
    db: Database.Database,
    opts: { jurisdiction: string; session: string; identifier: string },
  ): Promise<void> {
    const abbr = opts.jurisdiction.replace(/^us-/, "").toLowerCase();
    const path = `/bills/${abbr}/${encodeURIComponent(opts.session)}/${encodeURIComponent(opts.identifier)}`;
    const url = new URL(`${BASE_URL}${path}`);
    for (const inc of ["sponsorships", "abstracts", "actions", "versions",
                       "documents", "sources", "related_bills"]) {
      url.searchParams.append("include", inc);
    }
    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
      headers: { "X-API-KEY": this.opts.apiKey },
    });
    if (res.status === 404) {
      throw new BillNotFoundError(opts.jurisdiction, opts.session, opts.identifier);
    }
    if (!res.ok) {
      throw new Error(`OpenStates ${path} returned ${res.status}`);
    }
    const body = (await res.json()) as OpenStatesBillDetail;
    this.upsertBill(db, body);
  }
```

Also add at the top of the file (after the imports, before `BASE_URL`):

```typescript
export class BillNotFoundError extends Error {
  constructor(
    public readonly jurisdiction: string,
    public readonly session: string,
    public readonly identifier: string,
  ) {
    super(`Bill ${identifier} not found in ${jurisdiction} ${session}`);
    this.name = "BillNotFoundError";
  }
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `pnpm test tests/unit/adapters/openstates.test.ts -t "fetchBill"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/openstates.ts tests/unit/adapters/openstates.test.ts
git commit -m "feat(openstates): add fetchBill for per-resource hydration"
```

---

## Task 4: Core — `ensureBillFresh` with per-document TTL

**Files:**
- Create: `src/core/hydrate_bill.ts`
- Test: `tests/unit/core/hydrate_bill.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/core/hydrate_bill.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { upsertDocument } from "../../../src/core/documents.js";
import { ensureBillFresh } from "../../../src/core/hydrate_bill.js";
import { OpenStatesAdapter } from "../../../src/adapters/openstates.js";

const TEST_DB = "./data/test-hydrate-bill.db";
let store: Store;
let fetchBillSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  fetchBillSpy = vi
    .spyOn(OpenStatesAdapter.prototype, "fetchBill")
    .mockResolvedValue(undefined);
});

afterEach(() => {
  store.close();
  fetchBillSpy.mockRestore();
});

describe("ensureBillFresh", () => {
  it("fetches upstream when the bill is missing", async () => {
    await ensureBillFresh(store.db, {
      jurisdiction: "us-ca", session: "20252026", identifier: "SB 1338",
    });
    expect(fetchBillSpy).toHaveBeenCalledOnce();
  });

  it("skips upstream when fetched_at is < 1h old", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-ca",
      title: "SB 1338 — Vehicles: repossession.",
      occurred_at: "2026-04-09T00:00:00Z",
      source: {
        name: "openstates", id: "ocd-bill/abc",
        url: "https://openstates.org/ca/bills/20252026/SB1338/",
      },
      raw: { session: "20252026" },
    });
    await ensureBillFresh(store.db, {
      jurisdiction: "us-ca", session: "20252026", identifier: "SB 1338",
    });
    expect(fetchBillSpy).not.toHaveBeenCalled();
  });

  it("refetches when fetched_at is > 1h old", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-ca",
      title: "SB 1338 — Vehicles: repossession.",
      occurred_at: "2026-04-09T00:00:00Z",
      source: {
        name: "openstates", id: "ocd-bill/abc",
        url: "https://openstates.org/ca/bills/20252026/SB1338/",
      },
      raw: { session: "20252026" },
    });
    // Age the row: overwrite fetched_at directly.
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    store.db
      .prepare("UPDATE documents SET fetched_at = ? WHERE source_id = ?")
      .run(twoHoursAgo, "ocd-bill/abc");
    await ensureBillFresh(store.db, {
      jurisdiction: "us-ca", session: "20252026", identifier: "SB 1338",
    });
    expect(fetchBillSpy).toHaveBeenCalledOnce();
  });

  it("returns stale_notice on upstream failure when local row exists", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-ca",
      title: "SB 1338 — Vehicles: repossession.",
      occurred_at: "2026-04-09T00:00:00Z",
      source: {
        name: "openstates", id: "ocd-bill/abc",
        url: "https://openstates.org/ca/bills/20252026/SB1338/",
      },
      raw: { session: "20252026" },
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    store.db
      .prepare("UPDATE documents SET fetched_at = ? WHERE source_id = ?")
      .run(twoHoursAgo, "ocd-bill/abc");
    fetchBillSpy.mockRejectedValueOnce(new Error("boom"));
    const result = await ensureBillFresh(store.db, {
      jurisdiction: "us-ca", session: "20252026", identifier: "SB 1338",
    });
    expect(result.stale_notice?.reason).toBe("upstream_failure");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `pnpm test tests/unit/core/hydrate_bill.test.ts`
Expected: FAIL — `ensureBillFresh` not found.

- [ ] **Step 3: Implement `src/core/hydrate_bill.ts`**

Create the file:

```typescript
import type Database from "better-sqlite3";
import type { StaleNotice } from "../mcp/shared.js";
import { OpenStatesAdapter, BillNotFoundError } from "../adapters/openstates.js";
import { logger } from "../util/logger.js";
import { getOpenStatesKey } from "../util/env.js";

const FRESH_TTL_MS = 60 * 60 * 1000;

export interface EnsureBillInput {
  jurisdiction: string;
  session: string;
  identifier: string;
}

export interface EnsureBillResult {
  ok: boolean;
  stale_notice?: StaleNotice;
}

interface Row { fetched_at: string }

/** Per-document freshness check (R14 / D11). Returns without
 *  hitting upstream when a row exists and fetched_at < 1h old.
 *  Otherwise fetches via OpenStates, upserts, and returns. On
 *  upstream failure serves the stale row with a stale_notice. */
export async function ensureBillFresh(
  db: Database.Database,
  input: EnsureBillInput,
): Promise<EnsureBillResult> {
  if (input.jurisdiction === "us-federal") {
    return {
      ok: false,
      stale_notice: {
        as_of: new Date().toISOString(),
        reason: "not_yet_supported",
        message: "Federal bill detail not yet implemented; use recent_bills for listings.",
      } as StaleNotice,
    };
  }

  const existing = db
    .prepare(
      `SELECT fetched_at FROM documents
        WHERE source_name = 'openstates' AND kind = 'bill'
          AND jurisdiction = ?
          AND title LIKE ? || ' — %'
          AND json_extract(raw, '$.session') = ?`,
    )
    .get(input.jurisdiction, input.identifier, input.session) as Row | undefined;

  if (existing) {
    const ageMs = Date.now() - Date.parse(existing.fetched_at);
    if (ageMs < FRESH_TTL_MS) return { ok: true };
  }

  try {
    const adapter = new OpenStatesAdapter({ apiKey: getOpenStatesKey() });
    await adapter.fetchBill(db, input);
    return { ok: true };
  } catch (err) {
    if (err instanceof BillNotFoundError) {
      return {
        ok: false,
        stale_notice: {
          as_of: new Date().toISOString(),
          reason: "not_found",
          message: err.message,
        } as StaleNotice,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("ensureBillFresh failed", {
      jurisdiction: input.jurisdiction, session: input.session,
      identifier: input.identifier, error: msg,
    });
    const as_of = existing?.fetched_at ?? new Date(0).toISOString();
    return {
      ok: existing !== undefined,
      stale_notice: {
        as_of,
        reason: "upstream_failure",
        message: `Upstream openstates fetch failed; ${existing ? "serving stale local data" : "no local data available"}. ${msg}`,
      },
    };
  }
}
```

Note: `reason: "not_yet_supported"` and `reason: "not_found"`
are new values for `StaleNotice.reason`. Step 4 widens the type.

- [ ] **Step 4: Widen `StaleNotice.reason` in `src/mcp/shared.ts`**

Locate the `StaleNotice` interface in `src/mcp/shared.ts` and
add `"not_yet_supported"` and `"not_found"` to the `reason`
union. Example (adjust to match existing shape):

```typescript
export interface StaleNotice {
  as_of: string;
  reason:
    | "upstream_failure"
    | "rate_limited"
    | "daily_budget_exhausted"
    | "partial_hydrate"
    | "not_yet_supported"
    | "not_found";
  message: string;
  retry_after_s?: number;
  completeness?: "active_session_only";
}
```

- [ ] **Step 5: Run test to confirm pass**

Run: `pnpm test tests/unit/core/hydrate_bill.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Commit**

```bash
git add src/core/hydrate_bill.ts src/mcp/shared.ts tests/unit/core/hydrate_bill.test.ts
git commit -m "feat(core): ensureBillFresh — per-document TTL for detail tools"
```

---

## Task 5: Tool schema

**Files:**
- Modify: `src/mcp/schemas.ts`

- [ ] **Step 1: Append `GetBillInput` to `src/mcp/schemas.ts`**

Append at the end of the file:

```typescript
export const GetBillInput = z.object({
  jurisdiction: z.string().min(1),
  session: z.string().min(1),
  identifier: z.string().min(1),
});
export type GetBillInput = z.infer<typeof GetBillInput>;
```

- [ ] **Step 2: Commit**

```bash
git add src/mcp/schemas.ts
git commit -m "feat(mcp): add GetBillInput schema"
```

---

## Task 6: Tool handler — `get_bill` projection

**Files:**
- Create: `src/mcp/tools/get_bill.ts`
- Test: `tests/unit/mcp/tools/get_bill.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/mcp/tools/get_bill.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleGetBill } from "../../../../src/mcp/tools/get_bill.js";

vi.mock("../../../../src/core/hydrate_bill.js", async (orig) => {
  const actual = await orig<typeof import("../../../../src/core/hydrate_bill.js")>();
  return { ...actual, ensureBillFresh: vi.fn() };
});
import { ensureBillFresh } from "../../../../src/core/hydrate_bill.js";
const mockEnsure = vi.mocked(ensureBillFresh);

const TEST_DB = "./data/test-get-bill.db";
let store: Store;

beforeEach(() => {
  mockEnsure.mockReset();
  mockEnsure.mockResolvedValue({ ok: true });
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  const { entity: jones } = upsertEntity(store.db, {
    kind: "person", name: "Brian Jones", jurisdiction: undefined,
    metadata: { party: "Republican", district: "40", chamber: "upper" },
  });

  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-ca",
    title: "SB 1338 — Vehicles: repossession.",
    summary: "Existing law prohibits interference...",
    occurred_at: "2026-04-09T00:00:00Z",
    source: {
      name: "openstates", id: "ocd-bill/abc",
      url: "https://openstates.org/ca/bills/20252026/SB1338/",
    },
    references: [{ entity_id: jones.id, role: "sponsor" }],
    raw: {
      session: "20252026",
      actions: [
        { date: "2026-02-20", description: "Introduced." },
        { date: "2026-04-09", description: "Set for hearing April 14." },
      ],
      abstracts: [{ abstract: "Existing law prohibits interference..." }],
      subjects: ["Vehicles", "Repossession"],
      versions: [{
        note: "Introduced", date: "2026-02-20",
        links: [{ url: "https://leginfo.legislature.ca.gov/xyz.pdf", media_type: "application/pdf" }],
      }],
      documents: [],
      related_bills: [],
      sponsorships: [{
        name: "Brian Jones", classification: "primary",
        person: { id: "ocd-person/xyz", name: "Brian Jones", party: "Republican" },
      }],
    },
  });
});
afterEach(() => store.close());

describe("get_bill tool", () => {
  it("returns full bill detail with entity-linked primary sponsor", async () => {
    const result = await handleGetBill(store.db, {
      jurisdiction: "us-ca", session: "20252026", identifier: "SB 1338",
    });
    expect(result.bill?.identifier).toBe("SB 1338");
    expect(result.bill?.title).toBe("Vehicles: repossession.");
    expect(result.bill?.subjects).toEqual(["Vehicles", "Repossession"]);
    expect(result.bill?.primary_sponsor?.name).toBe("Brian Jones");
    expect(result.bill?.primary_sponsor?.entity_id).toBeDefined();
    expect(result.bill?.versions).toHaveLength(1);
    expect(result.bill?.versions[0].text_url).toMatch(/leginfo\.legislature\.ca\.gov/);
    expect(result.bill?.actions).toHaveLength(2);
  });

  it("returns null bill + stale_notice when ensureBillFresh reports not_found", async () => {
    mockEnsure.mockResolvedValueOnce({
      ok: false,
      stale_notice: {
        as_of: new Date().toISOString(),
        reason: "not_found",
        message: "Bill ZZ 9999 not found in us-ca 20252026",
      },
    });
    const result = await handleGetBill(store.db, {
      jurisdiction: "us-ca", session: "20252026", identifier: "ZZ 9999",
    });
    expect(result.bill).toBeNull();
    expect(result.stale_notice?.reason).toBe("not_found");
  });

  it("returns not_yet_supported for us-federal", async () => {
    mockEnsure.mockResolvedValueOnce({
      ok: false,
      stale_notice: {
        as_of: new Date().toISOString(),
        reason: "not_yet_supported",
        message: "Federal bill detail not yet implemented; use recent_bills for listings.",
      },
    });
    const result = await handleGetBill(store.db, {
      jurisdiction: "us-federal", session: "118", identifier: "HR 1",
    });
    expect(result.bill).toBeNull();
    expect(result.stale_notice?.reason).toBe("not_yet_supported");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `pnpm test tests/unit/mcp/tools/get_bill.test.ts`
Expected: FAIL — `handleGetBill` not found.

- [ ] **Step 3: Implement `src/mcp/tools/get_bill.ts`**

Create the file:

```typescript
import type Database from "better-sqlite3";
import { findEntityById } from "../../core/entities.js";
import { ensureBillFresh } from "../../core/hydrate_bill.js";
import { GetBillInput } from "../schemas.js";
import type { StaleNotice } from "../shared.js";

export interface BillVersion {
  note: string | null;
  date: string | null;
  text_url: string | null;
  media_type: string | null;
}

export interface BillAction {
  date: string;
  description: string;
  classification?: string[];
}

export interface BillSponsor {
  entity_id: string | null;
  name: string;
  party?: string;
  classification: string;
}

export interface RelatedBill {
  identifier?: string;
  session?: string;
  relation?: string;
}

export interface BillDetail {
  id: string;
  jurisdiction: string;
  session: string;
  identifier: string;
  title: string;
  summary: string | null;
  subjects: string[];
  primary_sponsor: BillSponsor | null;
  cosponsors: BillSponsor[];
  actions: BillAction[];
  versions: BillVersion[];
  related_bills: RelatedBill[];
  latest_action: BillAction | null;
  introduced_date: string | null;
  source_url: string;
  fetched_at: string;
}

export interface GetBillResponse {
  bill: BillDetail | null;
  sources: Array<{ name: string; url: string }>;
  stale_notice?: StaleNotice;
}

interface Row {
  id: string; jurisdiction: string; title: string; summary: string | null;
  fetched_at: string; source_url: string; raw: string;
}

interface RawShape {
  session?: string;
  actions?: BillAction[];
  subjects?: string[];
  versions?: Array<{
    note?: string; date?: string;
    links?: Array<{ url?: string; media_type?: string }>;
  }>;
  related_bills?: Array<{
    identifier?: string; legislative_session?: string; relation_type?: string;
  }>;
  sponsorships?: Array<{
    name: string; classification: string;
    person?: { id?: string; name?: string; party?: string };
  }>;
}

export async function handleGetBill(
  db: Database.Database,
  rawInput: unknown,
): Promise<GetBillResponse> {
  const input = GetBillInput.parse(rawInput);

  const freshness = await ensureBillFresh(db, input);

  const row = db
    .prepare(
      `SELECT id, jurisdiction, title, summary, fetched_at, source_url, raw
         FROM documents
        WHERE source_name = 'openstates' AND kind = 'bill'
          AND jurisdiction = ?
          AND title LIKE ? || ' — %'
          AND json_extract(raw, '$.session') = ?`,
    )
    .get(input.jurisdiction, input.identifier, input.session) as Row | undefined;

  const sources = [{ name: "openstates", url: `https://openstates.org/${input.jurisdiction.replace(/^us-/, "")}/` }];

  if (!row) {
    return {
      bill: null,
      sources,
      ...(freshness.stale_notice ? { stale_notice: freshness.stale_notice } : {}),
    };
  }

  const raw = JSON.parse(row.raw) as RawShape;
  const [, ...titleParts] = row.title.split(" — ");
  const actions = raw.actions ?? [];

  const sponsorsRaw = raw.sponsorships ?? [];
  const resolveSponsor = (s: RawShape["sponsorships"] extends (infer U)[] | undefined ? U : never): BillSponsor => {
    const extId = s.person?.id;
    let entity_id: string | null = null;
    if (extId) {
      const ent = db
        .prepare(
          `SELECT id FROM entities
            WHERE json_extract(external_ids, '$.openstates_person') = ?`,
        )
        .get(extId) as { id: string } | undefined;
      entity_id = ent?.id ?? null;
    }
    const meta = entity_id ? findEntityById(db, entity_id)?.metadata : undefined;
    return {
      entity_id,
      name: s.name,
      party: s.person?.party ?? meta?.party,
      classification: s.classification,
    };
  };

  const primary = sponsorsRaw.find((s) => s.classification === "primary");
  const cosponsors = sponsorsRaw.filter((s) => s !== primary);

  const bill: BillDetail = {
    id: row.id,
    jurisdiction: row.jurisdiction,
    session: raw.session ?? input.session,
    identifier: input.identifier,
    title: titleParts.join(" — ").trim() || row.title,
    summary: row.summary,
    subjects: raw.subjects ?? [],
    primary_sponsor: primary ? resolveSponsor(primary) : null,
    cosponsors: cosponsors.map(resolveSponsor),
    actions,
    versions: (raw.versions ?? []).map((v) => ({
      note: v.note ?? null,
      date: v.date ?? null,
      text_url: v.links?.[0]?.url ?? null,
      media_type: v.links?.[0]?.media_type ?? null,
    })),
    related_bills: (raw.related_bills ?? []).map((r) => ({
      identifier: r.identifier,
      session: r.legislative_session,
      relation: r.relation_type,
    })),
    latest_action: actions.length ? actions[actions.length - 1] : null,
    introduced_date: actions[0]?.date ?? null,
    source_url: row.source_url,
    fetched_at: row.fetched_at,
  };

  return {
    bill,
    sources,
    ...(freshness.stale_notice ? { stale_notice: freshness.stale_notice } : {}),
  };
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `pnpm test tests/unit/mcp/tools/get_bill.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/get_bill.ts tests/unit/mcp/tools/get_bill.test.ts
git commit -m "feat(mcp): add get_bill tool handler"
```

---

## Task 7: Register tool in server

**Files:**
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/unit/mcp/server.test.ts` a check that the
`get_bill` tool is registered. Use the same pattern as existing
tool-registration assertions. Example:

```typescript
it("registers get_bill tool", () => {
  const { mcp } = buildServer({ dbPath: TEST_DB });
  const tools = (mcp as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  expect(tools).toHaveProperty("get_bill");
});
```

(If the existing tests use a different mechanism — e.g.
`mcp.listTools()` — mirror that pattern instead.)

- [ ] **Step 2: Run test to confirm it fails**

Run: `pnpm test tests/unit/mcp/server.test.ts`
Expected: FAIL — `get_bill` not registered.

- [ ] **Step 3: Register in `src/mcp/server.ts`**

Add import at the top of `src/mcp/server.ts`:

```typescript
import { handleGetBill } from "./tools/get_bill.js";
import { GetBillInput } from "./schemas.js";
```

(Adjust the `import { ... } from "./schemas.js"` to include
`GetBillInput` rather than adding a second line.)

Add the registration block after the `resolve_person`
registration (before `return { mcp, store };`):

```typescript
  mcp.registerTool(
    "get_bill",
    {
      description:
        "Fetch full detail for a single bill by (jurisdiction, session, " +
        "identifier). Returns subjects, abstracts, full actions history, " +
        "primary sponsor + cosponsors with entity IDs, versions with " +
        "text_url links (follow these URLs for bill text — the MCP does " +
        "not proxy text). OpenStates-only in V1; us-federal returns " +
        "stale_notice.reason=\"not_yet_supported\".",
      inputSchema: GetBillInput.shape,
    },
    async (input) => {
      const data = await handleGetBill(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );
```

- [ ] **Step 4: Run test to confirm pass**

Run: `pnpm test tests/unit/mcp/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/unit/mcp/server.test.ts
git commit -m "feat(mcp): register get_bill tool"
```

---

## Task 8: Integration test (msw end-to-end)

**Files:**
- Create: `tests/integration/fixtures/openstates-bill-detail.json`
- Create: `tests/integration/get-bill-e2e.test.ts`

- [ ] **Step 1: Write fixture**

Create `tests/integration/fixtures/openstates-bill-detail.json`:

```json
{
  "id": "ocd-bill/e2e-ca-sb1338",
  "identifier": "SB 1338",
  "title": "Vehicles: repossession.",
  "session": "20252026",
  "updated_at": "2026-04-09T00:00:00Z",
  "openstates_url": "https://openstates.org/ca/bills/20252026/SB1338/",
  "jurisdiction": { "id": "ocd-jurisdiction/country:us/state:ca/government" },
  "subject": ["Vehicles", "Repossession"],
  "abstracts": [{ "abstract": "Existing law prohibits interference with the transport of a vehicle..." }],
  "sponsorships": [{
    "name": "Brian Jones",
    "classification": "primary",
    "person": {
      "id": "ocd-person/e2e-jones",
      "name": "Brian Jones",
      "party": "Republican",
      "jurisdiction": { "id": "ocd-jurisdiction/country:us/state:ca/government" }
    }
  }],
  "actions": [
    { "date": "2026-02-20", "description": "Introduced." },
    { "date": "2026-04-09", "description": "Set for hearing April 14." }
  ],
  "versions": [
    {
      "note": "Introduced",
      "date": "2026-02-20",
      "links": [{ "url": "https://leginfo.legislature.ca.gov/faces/billPdfClient.xhtml?bill_id=202520260SB1338&version=INT", "media_type": "application/pdf" }]
    },
    {
      "note": "Amended Senate",
      "date": "2026-03-25",
      "links": [{ "url": "https://leginfo.legislature.ca.gov/faces/billPdfClient.xhtml?bill_id=202520260SB1338&version=AMD", "media_type": "application/pdf" }]
    }
  ],
  "documents": [],
  "related_bills": []
}
```

- [ ] **Step 2: Write the e2e test**

Create `tests/integration/get-bill-e2e.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { existsSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/core/seeds.js";
import { handleGetBill } from "../../src/mcp/tools/get_bill.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/openstates-bill-detail.json"), "utf-8"),
);

const TEST_DB = "./data/test-get-bill-e2e.db";
let store: Store;

const server = setupServer();
beforeAll(() => {
  process.env.OPENSTATES_API_KEY = "test-key";
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => {
  server.close();
  delete process.env.OPENSTATES_API_KEY;
});
beforeEach(() => {
  server.resetHandlers();
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});
afterEach(() => store.close());

describe("get_bill e2e", () => {
  it("hydrates a bill from upstream on first call and projects it", async () => {
    let hitCount = 0;
    server.use(
      http.get("https://v3.openstates.org/bills/ca/20252026/SB%201338", () => {
        hitCount += 1;
        return HttpResponse.json(fixture);
      }),
    );
    const result = await handleGetBill(store.db, {
      jurisdiction: "us-ca", session: "20252026", identifier: "SB 1338",
    });
    expect(hitCount).toBe(1);
    expect(result.bill?.title).toBe("Vehicles: repossession.");
    expect(result.bill?.versions).toHaveLength(2);
    expect(result.bill?.versions[1].text_url).toContain("version=AMD");
    expect(result.bill?.primary_sponsor?.name).toBe("Brian Jones");
    expect(result.bill?.primary_sponsor?.entity_id).toBeTruthy();
  });

  it("serves from cache on second call within TTL", async () => {
    let hitCount = 0;
    server.use(
      http.get("https://v3.openstates.org/bills/ca/20252026/SB%201338", () => {
        hitCount += 1;
        return HttpResponse.json(fixture);
      }),
    );
    await handleGetBill(store.db, {
      jurisdiction: "us-ca", session: "20252026", identifier: "SB 1338",
    });
    await handleGetBill(store.db, {
      jurisdiction: "us-ca", session: "20252026", identifier: "SB 1338",
    });
    expect(hitCount).toBe(1);
  });

  it("returns not_found stale_notice when upstream 404s", async () => {
    server.use(
      http.get("https://v3.openstates.org/bills/ca/20252026/XX%209999", () =>
        HttpResponse.json({ detail: "not found" }, { status: 404 }),
      ),
    );
    const result = await handleGetBill(store.db, {
      jurisdiction: "us-ca", session: "20252026", identifier: "XX 9999",
    });
    expect(result.bill).toBeNull();
    expect(result.stale_notice?.reason).toBe("not_found");
  });
});
```

- [ ] **Step 3: Run the e2e test**

Run: `pnpm test tests/integration/get-bill-e2e.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 4: Run the full suite to confirm no regressions**

Run: `pnpm test`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/fixtures/openstates-bill-detail.json tests/integration/get-bill-e2e.test.ts
git commit -m "test: get_bill e2e with msw fixture"
```

---

## Task 9: Documentation

**Files:**
- Modify: `docs/05-tool-surface.md`
- Modify: `CLAUDE.md` (note the new tool in the "How to think about this MCP" section)

- [ ] **Step 1: Add `get_bill` section to `docs/05-tool-surface.md`**

Locate the existing tool documentation and insert a new section
after `search_civic_documents` or wherever detail tools would
logically live. Content:

```markdown
### `get_bill`

Detail projection over a single bill. Inputs:

- `jurisdiction` (required) — `"us-<state>"`. `"us-federal"`
  returns a `stale_notice` with `reason="not_yet_supported"`
  until Phase 7b.
- `session` (required) — upstream session string (e.g.
  `"20252026"` for CA's 2025–2026 Regular Session).
- `identifier` (required) — bill identifier with space
  (e.g. `"SB 1338"`, not `"SB1338"`).

Returns `{ bill, sources, stale_notice? }` where `bill` is:

- `identifier`, `title`, `session`, `jurisdiction`
- `summary` — the Legislative Counsel's digest (first abstract)
- `subjects[]` — source-provided subject tags
- `primary_sponsor`, `cosponsors[]` — each with `entity_id`
  (resolved from `external_ids.openstates_person`), `name`,
  `party`, `classification`
- `actions[]` — full history (date, description, classification)
- `versions[]` — each with `note`, `date`, `text_url`,
  `media_type`. **The MCP does not proxy bill text;** follow
  `text_url` to fetch the PDF/HTML from the state leginfo site.
- `related_bills[]` — identifier + session + relation type
- `latest_action`, `introduced_date`, `source_url`, `fetched_at`

Freshness per R14 / D11: per-document TTL of 1h. Upstream
failures return the last-known row with a `stale_notice`.
```

- [ ] **Step 2: Note in `CLAUDE.md`**

In `CLAUDE.md`, the "How to think about this MCP" section
currently lists Feeds (B) and Entities (A). Add a third bullet
before the "Pass-through hydration" paragraph:

```markdown
- **Details (C):** `get_bill` (and future `get_vote`,
  `get_contribution`) — identifier-first, full projection.
  Uses per-document TTL (R14 / D11) rather than jurisdiction-
  level freshness.
```

- [ ] **Step 3: Commit**

```bash
git add docs/05-tool-surface.md CLAUDE.md
git commit -m "docs: document get_bill tool surface (phase-7)"
```

---

## Self-Review

**Spec coverage (mapped to the original data-point table):**

| Plural field | Task implementing |
|---|---|
| Bill Title | Task 6 projection |
| Summary (LC digest) | Task 2 (raw.abstracts) + Task 6 (`bill.summary`) |
| Source-Provided Subjects | Task 2 + Task 6 (`bill.subjects`) |
| Primary Author | Task 6 (`bill.primary_sponsor` with entity_id) |
| Bill Status (committee path) | Task 6 — reconstructable from `bill.actions[]` with classification `referral-committee`; not pre-computed |
| Latest Action date | Task 6 (`bill.latest_action`) |
| Introduced date | Task 6 (`bill.introduced_date`) |
| Document versions ("Introduced", "Amended Senate") | Task 2 + Task 6 (`bill.versions[]`) |
| View PDF / View Source links | Task 6 (`bill.versions[*].text_url`) |
| Full bill text | **Intentionally out of scope** — LLM follows `text_url` |
| Related Bills | Task 2 + Task 6 (`bill.related_bills[]`) |
| Activity log | Task 6 (`bill.actions[]`) |
| Plural AI Topics | **Out of scope** — violates R9/D3c |
| Plural AI Summary | **Out of scope** — violates R9/D3c |
| Amendment redline | **Out of scope** — follow two `text_url` entries and diff client-side |

All in-scope fields map to exactly one task. The three "out of
scope" items are intentional per the rationale in the pre-plan
discussion.

**Placeholder scan:** No `TODO`, `TBD`, or "add appropriate X"
references. Every code block is complete.

**Type consistency:** `BillDetail` (Task 6) consumes exactly the
`RawShape` fields written by `upsertBill` in Task 2. `ensureBillFresh`
(Task 4) returns `EnsureBillResult` consumed by `handleGetBill`
(Task 6) — both use `StaleNotice` from `src/mcp/shared.ts`
widened in Task 4 Step 4. `BillNotFoundError` (Task 3) is thrown
and caught by name-matching in Task 4.

**Federal deferred:** Task 4's `us-federal` guard returns
`not_yet_supported`; Task 6 test asserts this path. Phase 7b
will replace that guard with a `CongressAdapter.fetchBill`.

---

## Execution Handoff

Plan complete and saved to `docs/plans/phase-7-get-bill.md`.
Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent
   per task, review between tasks, commits on main per
   `feedback_workflow.md`.
2. **Inline Execution** — work through tasks in this session
   with checkpoints for review.

Which approach?

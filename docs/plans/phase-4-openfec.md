# Phase 4 — OpenFEC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Prerequisite:** Phase 3 complete (`docs/plans/phase-3-congress.md`
all checkboxes green). 84 tests pass.

**Goal:** Ingest federal campaign finance data from
`api.open.fec.gov/v1` into the same entity/document store as Phases 2
and 3. Ship the `recent_contributions` tool. Cross-link FEC candidates
who are sitting or former Members of Congress into the same Person
entity already created by the Congress.gov adapter. Extend the refresh
CLI to dispatch on `--source=openfec`.

**Architecture:** One new adapter (`src/adapters/openfec.ts`), one new
tool (`src/mcp/tools/recent_contributions.ts`), one new zod schema
(`RecentContributionsInput`), modifications to `src/cli/refresh.ts`
and `src/mcp/server.ts`. No schema migrations — `us-federal` is
already seeded, and `DocumentKind.contribution` and `.expenditure` are
already in `src/core/types.ts`.

**Load-bearing sub-decisions (from `docs/roadmap.md` Phase 4):**
- **Historical cycles:** current cycle (2026) + prior cycle (2024).
  Full history deferred. The adapter accepts a `cycles` option
  defaulting to `[2026, 2024]`.
- **Cross-source merge:** FEC candidate → Congress Person via the
  `fec_candidate` external ID carried on the FEC `Person` row. The
  adapter attempts a `json_extract` lookup on `external_ids.bioguide`
  through the committee's `principal_committee.candidate_ids` field if
  the FEC `/candidate/{id}` response provides a `bioguide` field;
  otherwise falls back to exact normalized-name + same state under
  step 3 of the resolution algorithm. Under-match bias: two rows is
  safer than one wrong merge.
- **Contributor resolution:** individual donors have no stable FEC
  entity ID. Use `upsertEntity` exactly as-is (exact normalized name
  + kind match, or create new). No fuzzy-matching on names alone per
  D3b. Two "John Smith" rows is fine; one wrong merge is not.
- **Contributor PII:** `raw` stores the full FEC line item (including
  address). Tool responses never expose address or employer fields.
- **Rate limit:** 15 req/min (900/hour — below the 1,000/hour cap).
  `RateLimiter({ tokensPerInterval: 15, intervalMs: 60_000 })`.

**API key prerequisite:** User must have an OpenFEC API key from
https://api.data.gov/signup/ (same registration as `CONGRESS_API_KEY`).
Store it in `.env.local` as `FEC_API_KEY=...`.

**Design decision on FEC candidate → bioguide linking:**
OpenFEC's `/candidate/{candidate_id}` response does not include a
`bioguide_id` field as of the OpenFEC v1 API. The linkage must be
inferred. The adapter uses exact normalized name + `principal_office`
state as a soft signal (step 3 of the resolution algorithm). This is
the under-match bias path. If a Congress.gov Person already exists with
the same normalized name and the candidate's `state` matches a federal
role in `metadata.roles[]`, `upsertEntity`'s step-3 exact-name match
fires automatically and the two records merge. If the name differs
even slightly (common with nicknames or name-order changes), two rows
are created. That's correct behavior — see `docs/04-entity-schema.md`.

---

## File structure produced by this phase

```
src/
├── adapters/
│   └── openfec.ts                          ← Task 2
├── cli/
│   └── refresh.ts                          (modified in Task 3)
├── mcp/
│   ├── server.ts                           (modified in Task 5)
│   ├── schemas.ts                          (modified in Task 4)
│   └── tools/
│       └── recent_contributions.ts         ← Task 4
tests/
├── unit/
│   └── adapters/
│       └── openfec.test.ts                 ← Task 2
│   └── mcp/
│       └── tools/
│           └── recent_contributions.test.ts ← Task 4
└── integration/
    ├── openfec-e2e.test.ts                 ← Task 6
    └── fixtures/
        ├── openfec-candidates-page1.json   ← Task 6
        ├── openfec-committees-page1.json   ← Task 6
        ├── openfec-schedule-a-page1.json   ← Task 6
        └── openfec-schedule-b-page1.json   ← Task 6
```

---

## Prerequisites

Before executing this phase:

- Phase 3 all checkboxes green, test suite green (`pnpm test` passes).
- `FEC_API_KEY` present in `.env.local`.
- `pnpm test` passes with no failures.

---

## Task 1: Verify no schema changes needed

**Files:** `src/core/types.ts` (read-only verification),
`tests/unit/core/store.test.ts` (add one assertion)

`DocumentKind` already includes `contribution` and `expenditure`; the
`us-federal` jurisdiction is already seeded; and `EntityKind` already
includes `pac`. This task is a checkpoint, not a migration.

- [ ] **Step 1.1: Confirm `contribution` and `expenditure` are in `DocumentKind`**

```bash
grep -n "contribution\|expenditure" src/core/types.ts
```

Expected output: two lines inside the `DocumentKind` enum. If either
is missing, add it before continuing. Both are present per the
`docs/04-entity-schema.md` schema snapshot (confirmed in Phase 3
planning).

- [ ] **Step 1.2: Confirm `pac` is in `EntityKind`**

```bash
grep -n '"pac"' src/core/types.ts
```

Expected output: one line inside the `EntityKind` enum. If missing,
add `"pac"` to the enum and update the corresponding zod schema in
`src/mcp/schemas.ts` (`SearchEntitiesInput.kind` enum).

- [ ] **Step 1.3: Add a smoke-test assertion to `tests/unit/core/store.test.ts`**

Inside the existing `describe("openStore")` block (after the existing
tests; do not restructure), add:

```ts
it("DocumentKind accepts contribution and expenditure", () => {
  // These parse calls throw if the value is not in the enum.
  const { DocumentKind } = await import("../../../src/core/types.js");
  expect(DocumentKind.parse("contribution")).toBe("contribution");
  expect(DocumentKind.parse("expenditure")).toBe("expenditure");
});
```

- [ ] **Step 1.4: Run test and commit**

```bash
pnpm test tests/unit/core/store.test.ts
git add src/core/types.ts tests/unit/core/store.test.ts
git commit -m "test: assert contribution and expenditure DocumentKinds exist"
```

---

## Task 2: OpenFEC adapter

**Files:** `src/adapters/openfec.ts`,
`tests/unit/adapters/openfec.test.ts`

This is the largest task. The adapter fetches `/candidates/search`,
`/committees`, `/schedules/schedule_a` (itemized contributions above
the itemization threshold — individual contributions ≥ $200 in an
election cycle), and `/schedules/schedule_b` (disbursements). It
normalizes them into `Entity` and `Document` rows using the same
`upsertEntity` / `upsertDocument` functions as `congress.ts`.

**OpenFEC API shape (key fields we use):**

`GET /candidates/search?election_year=2026&candidate_status=C&per_page=100`:
```json
{
  "results": [
    {
      "candidate_id": "H0AZ01234",
      "name": "SMITH, JOHN R.",
      "office": "H",
      "state": "AZ",
      "district": "01",
      "party": "REP",
      "election_years": [2024, 2026],
      "principal_committees": [
        { "committee_id": "C00123456", "name": "Smith for Congress" }
      ]
    }
  ],
  "pagination": { "count": 1, "per_page": 100, "page": 1, "pages": 1 }
}
```

`GET /committees?cycle=2026&per_page=100`:
```json
{
  "results": [
    {
      "committee_id": "C00123456",
      "name": "Smith for Congress",
      "committee_type": "H",
      "committee_type_full": "House",
      "state": "AZ",
      "party": "REP",
      "candidate_ids": ["H0AZ01234"]
    }
  ],
  "pagination": { "count": 1, "per_page": 100, "page": 1, "pages": 1 }
}
```

`GET /schedules/schedule_a?two_year_transaction_period=2026&per_page=100`:
```json
{
  "results": [
    {
      "transaction_id": "SA17.1234567",
      "committee_id": "C00123456",
      "contributor_name": "JONES, ALICE M.",
      "contributor_city": "PHOENIX",
      "contributor_state": "AZ",
      "contributor_zip": "85001",
      "contributor_employer": "Self-Employed",
      "contributor_occupation": "Attorney",
      "contribution_receipt_amount": 2800.0,
      "contribution_receipt_date": "2026-01-15",
      "memo_text": null,
      "line_number": "11AI"
    }
  ],
  "pagination": {
    "count": 1, "per_page": 100, "page": 1, "pages": 1,
    "last_indexes": { "last_index": "1234567", "last_contribution_receipt_date": "2026-01-15" }
  }
}
```

`GET /schedules/schedule_b?two_year_transaction_period=2026&per_page=100`:
```json
{
  "results": [
    {
      "transaction_id": "SB23.9876543",
      "committee_id": "C00123456",
      "recipient_name": "ABC MEDIA LLC",
      "recipient_city": "PHOENIX",
      "recipient_state": "AZ",
      "disbursement_amount": 15000.0,
      "disbursement_date": "2026-01-20",
      "disbursement_description": "DIGITAL ADVERTISING"
    }
  ],
  "pagination": {
    "count": 1, "per_page": 100, "page": 1, "pages": 1,
    "last_indexes": { "last_index": "9876543", "last_disbursement_date": "2026-01-20" }
  }
}
```

**Schedule A pagination note:** OpenFEC uses cursor-based pagination
for schedule_a and schedule_b (not page numbers). The `last_indexes`
field in the response carries the cursor for the next page. The adapter
passes `?last_index=<val>&last_contribution_receipt_date=<val>` (for
schedule_a) or `?last_index=<val>&last_disbursement_date=<val>` (for
schedule_b) to the next request. When `pagination.pages === 1` or the
`results` array is shorter than `per_page`, there are no more pages.

**Cross-source merge rule:**
`upsertEntity` step 1 (external-ID match) fires on
`fec_candidate = H0AZ01234`. If a Congress.gov Person was already
ingested with `external_ids.fec_candidate` set (possible only if a
prior run already merged them), they match immediately. More commonly,
the Congress Person was ingested without `fec_candidate` — then step 3
(exact normalized-name match) fires. Because FEC stores names in ALL
CAPS (`"SMITH, JOHN R."`), the adapter normalizes via `normalizeName`
before calling `upsertEntity`, producing the same lowercased form as
the Congress.gov ingested name. If names differ only in middle
initial/party suffix, the step-3 tiebreaker (exact-one-candidate rule)
fires; if ambiguous, `upsertEntity` creates a new row (under-match).

**Roles[] merge pattern:** same as `congress.ts` Task 2 — after
`upsertEntity`, if `created === false`, the adapter reads `metadata`,
checks whether a `federal_candidate` role for this cycle is already
present, and if not issues a targeted UPDATE. Do not refactor
`upsertEntity` itself (flagged as Phase 5 work).

- [ ] **Step 2.1: Write unit tests**

`tests/unit/adapters/openfec.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { upsertEntity } from "../../../src/core/entities.js";
import { OpenFecAdapter } from "../../../src/adapters/openfec.js";

const TEST_DB = "./data/test-openfec.db";
let store: Store;

// ── Minimal fixture data ──────────────────────────────────────────────

const SAMPLE_CANDIDATE = {
  candidate_id: "H0AZ01234",
  name: "SMITH, JOHN R.",
  office: "H",
  state: "AZ",
  district: "01",
  party: "REP",
  election_years: [2026],
  principal_committees: [
    { committee_id: "C00123456", name: "Smith for Congress" },
  ],
};

const SAMPLE_COMMITTEE = {
  committee_id: "C00123456",
  name: "Smith for Congress",
  committee_type: "H",
  committee_type_full: "House",
  state: "AZ",
  party: "REP",
  candidate_ids: ["H0AZ01234"],
};

const SAMPLE_SCHEDULE_A = {
  transaction_id: "SA17.1234567",
  committee_id: "C00123456",
  contributor_name: "JONES, ALICE M.",
  contributor_city: "PHOENIX",
  contributor_state: "AZ",
  contributor_zip: "85001",
  contributor_employer: "Self-Employed",
  contributor_occupation: "Attorney",
  contribution_receipt_amount: 2800.0,
  contribution_receipt_date: "2026-01-15",
  memo_text: null,
  line_number: "11AI",
};

const SAMPLE_SCHEDULE_B = {
  transaction_id: "SB23.9876543",
  committee_id: "C00123456",
  recipient_name: "ABC MEDIA LLC",
  recipient_city: "PHOENIX",
  recipient_state: "AZ",
  disbursement_amount: 15000.0,
  disbursement_date: "2026-01-20",
  disbursement_description: "DIGITAL ADVERTISING",
};

function noPagination(results: object[]) {
  return {
    results,
    pagination: { count: results.length, per_page: 100, page: 1, pages: 1 },
  };
}

function makeMockFetch(opts: {
  candidates?: object[];
  committees?: object[];
  scheduleA?: object[];
  scheduleB?: object[];
} = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/candidates/search")) {
      return new Response(
        JSON.stringify(noPagination(opts.candidates ?? [SAMPLE_CANDIDATE])),
        { status: 200 },
      );
    }
    if (u.includes("/committees")) {
      return new Response(
        JSON.stringify(noPagination(opts.committees ?? [SAMPLE_COMMITTEE])),
        { status: 200 },
      );
    }
    if (u.includes("/schedules/schedule_a")) {
      return new Response(
        JSON.stringify(noPagination(opts.scheduleA ?? [SAMPLE_SCHEDULE_A])),
        { status: 200 },
      );
    }
    if (u.includes("/schedules/schedule_b")) {
      return new Response(
        JSON.stringify(noPagination(opts.scheduleB ?? [SAMPLE_SCHEDULE_B])),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

describe("OpenFecAdapter", () => {
  // ── Test 1: Candidate upsert ──────────────────────────────────────
  it("upserts a federal candidate as a Person entity with NULL jurisdiction and fec_candidate ID", async () => {
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    const result = await adapter.refresh({ db: store.db });
    expect(result.errors).toEqual([]);
    expect(result.entitiesUpserted).toBeGreaterThan(0);

    const row = store.db
      .prepare(
        "SELECT name, external_ids, jurisdiction, metadata FROM entities WHERE kind = 'person'",
      )
      .get() as {
        name: string;
        external_ids: string;
        jurisdiction: string | null;
        metadata: string;
      };

    // FEC names are ALL CAPS; stored as normalized canonical form.
    // The adapter stores the normalized version from FEC as received.
    expect(row.name).toBeTruthy();
    expect(JSON.parse(row.external_ids).fec_candidate).toBe("H0AZ01234");

    // D3b: Persons are cross-jurisdiction — jurisdiction column NULL.
    expect(row.jurisdiction).toBeNull();

    // federal_candidate role in metadata.roles[].
    const meta = JSON.parse(row.metadata) as {
      roles?: Array<{ jurisdiction: string; role: string }>;
    };
    expect(meta.roles?.some((r) => r.role === "federal_candidate")).toBe(true);
    expect(meta.roles?.some((r) => r.jurisdiction === "us-federal")).toBe(true);
  });

  // ── Test 2: Committee upsert as Organization ──────────────────────
  it("upserts a campaign committee as an Organization with fec_committee ID and jurisdiction", async () => {
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db });

    const row = store.db
      .prepare(
        "SELECT name, kind, jurisdiction, external_ids FROM entities WHERE kind IN ('pac','committee','organization')",
      )
      .get() as {
        name: string;
        kind: string;
        jurisdiction: string | null;
        external_ids: string;
      } | undefined;

    expect(row).toBeDefined();
    expect(JSON.parse(row!.external_ids).fec_committee).toBe("C00123456");
    // Campaign committees belong to us-federal.
    expect(row!.jurisdiction).toBe("us-federal");
  });

  // ── Test 3: Contribution Document ────────────────────────────────
  it("upserts a Schedule A contribution as a Document of kind='contribution' with contributor and recipient references", async () => {
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db });

    const doc = store.db
      .prepare(
        "SELECT id, kind, jurisdiction, source_name, raw FROM documents WHERE kind = 'contribution'",
      )
      .get() as {
        id: string;
        kind: string;
        jurisdiction: string;
        source_name: string;
        raw: string;
      } | undefined;

    expect(doc).toBeDefined();
    expect(doc!.kind).toBe("contribution");
    expect(doc!.jurisdiction).toBe("us-federal");
    expect(doc!.source_name).toBe("openfec");

    // Raw stores the full line item for aggregate queries.
    const raw = JSON.parse(doc!.raw) as {
      amount: number;
      contributor_city?: string;
    };
    expect(raw.amount).toBe(2800.0);
    // Confirm address is in raw (stored for internal use).
    expect(raw.contributor_city).toBeDefined();

    // contributor (role='contributor') and recipient (role='recipient')
    // references both exist.
    const refs = store.db
      .prepare(
        "SELECT role FROM document_references WHERE document_id = ?",
      )
      .all(doc!.id) as Array<{ role: string }>;
    const roles = refs.map((r) => r.role);
    expect(roles).toContain("contributor");
    expect(roles).toContain("recipient");
  });

  // ── Test 4: Expenditure Document ─────────────────────────────────
  it("upserts a Schedule B disbursement as a Document of kind='expenditure' with spender and recipient references", async () => {
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db });

    const doc = store.db
      .prepare(
        "SELECT id, kind, raw FROM documents WHERE kind = 'expenditure'",
      )
      .get() as { id: string; kind: string; raw: string } | undefined;

    expect(doc).toBeDefined();
    expect(doc!.kind).toBe("expenditure");

    const raw = JSON.parse(doc!.raw) as { amount: number };
    expect(raw.amount).toBe(15000.0);

    // Spender (the committee) is role='contributor'; recipient is role='recipient'.
    const refs = store.db
      .prepare(
        "SELECT role FROM document_references WHERE document_id = ?",
      )
      .all(doc!.id) as Array<{ role: string }>;
    const roles = refs.map((r) => r.role);
    expect(roles).toContain("contributor");
    expect(roles).toContain("recipient");
  });

  // ── Test 5: Cross-source merge with Congress.gov Person ──────────
  it("merges an FEC candidate into an existing Congress.gov Person when normalized names match exactly", async () => {
    // Seed a Person row as if Congress.gov already ingested this Member.
    // The normalized form of "SMITH, JOHN R." → "smith john r" which
    // also matches "Smith, John R." from Congress.gov's casing.
    // upsertEntity step 3 fires on exact normalized-name match.
    const { entity: existing } = upsertEntity(store.db, {
      kind: "person",
      name: "Smith, John R.",
      jurisdiction: undefined,
      external_ids: { bioguide: "S001234" },
      metadata: {
        roles: [
          {
            jurisdiction: "us-federal",
            role: "representative",
            from: "2023-01-03T00:00:00.000Z",
            to: null,
          },
        ],
      },
    });

    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db });

    // Exactly ONE Person row must exist — the adapter merged, not split.
    const personCount = (
      store.db
        .prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'person'")
        .get() as { c: number }
    ).c;
    expect(personCount).toBe(1);

    // The merged row has both bioguide and fec_candidate external IDs.
    const row = store.db
      .prepare("SELECT external_ids, metadata FROM entities WHERE id = ?")
      .get(existing.id) as { external_ids: string; metadata: string };
    const extIds = JSON.parse(row.external_ids);
    expect(extIds.bioguide).toBe("S001234");
    expect(extIds.fec_candidate).toBe("H0AZ01234");

    // Both roles present in metadata.roles[].
    const meta = JSON.parse(row.metadata) as {
      roles?: Array<{ role: string; jurisdiction: string }>;
    };
    const roleNames = (meta.roles ?? []).map((r) => r.role);
    expect(roleNames).toContain("representative");
    expect(roleNames).toContain("federal_candidate");
  });

  // ── Test 6: Contributor identity isolation ────────────────────────
  it("creates distinct Person rows for contributors with different names (no false merges)", async () => {
    const secondContrib = {
      ...SAMPLE_SCHEDULE_A,
      transaction_id: "SA17.9999999",
      contributor_name: "JOHNSON, BOB",
      contribution_receipt_amount: 500.0,
    };

    vi.spyOn(global, "fetch").mockImplementation(
      makeMockFetch({ scheduleA: [SAMPLE_SCHEDULE_A, secondContrib] }),
    );
    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db });

    // Two distinct contributions, two distinct contributor entities.
    const contributors = store.db
      .prepare(
        `SELECT DISTINCT e.id FROM entities e
         JOIN document_references dr ON e.id = dr.entity_id
         WHERE dr.role = 'contributor' AND e.kind = 'person'`,
      )
      .all() as Array<{ id: string }>;
    expect(contributors.length).toBe(2);
  });

  // ── Test 7: Rate-limit resilience ────────────────────────────────
  it("surfaces errors cleanly when OpenFEC returns 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("Too Many Requests", { status: 429 }),
    );
    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    const result = await adapter.refresh({ db: store.db });
    // The adapter catches the error; it does not throw.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/429/);
  });
});
```

- [ ] **Step 2.2: Run tests to confirm failure**

```bash
pnpm test tests/unit/adapters/openfec.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 2.3: Implement `src/adapters/openfec.ts`**

```ts
import type Database from "better-sqlite3";
import { rateLimitedFetch, RateLimiter } from "../util/http.js";
import { upsertEntity } from "../core/entities.js";
import { upsertDocument } from "../core/documents.js";
import { normalizeName } from "../resolution/fuzzy.js";
import { logger } from "../util/logger.js";
import type { Adapter, AdapterOptions, RefreshResult } from "./base.js";

const BASE_URL = "https://api.open.fec.gov/v1";

// ── API types (minimal — only fields we use) ─────────────────────────

interface FecPrincipalCommittee {
  committee_id: string;
  name: string;
}

interface FecCandidate {
  candidate_id: string;
  name: string;           // ALL CAPS, e.g. "SMITH, JOHN R."
  office: string;         // "H" | "S" | "P"
  state?: string;
  district?: string | null;
  party?: string;
  election_years?: number[];
  principal_committees?: FecPrincipalCommittee[];
}

interface FecCommittee {
  committee_id: string;
  name: string;
  committee_type?: string;
  committee_type_full?: string;
  state?: string;
  party?: string;
  candidate_ids?: string[];
}

interface FecScheduleA {
  transaction_id: string;
  committee_id: string;
  contributor_name?: string;
  contributor_city?: string;
  contributor_state?: string;
  contributor_zip?: string;
  contributor_employer?: string;
  contributor_occupation?: string;
  contribution_receipt_amount?: number;
  contribution_receipt_date?: string;
  memo_text?: string | null;
  line_number?: string;
}

interface FecScheduleB {
  transaction_id: string;
  committee_id: string;
  recipient_name?: string;
  recipient_city?: string;
  recipient_state?: string;
  disbursement_amount?: number;
  disbursement_date?: string;
  disbursement_description?: string;
}

interface FecPagination {
  count?: number;
  per_page?: number;
  page?: number;
  pages?: number;
  last_indexes?: {
    last_index?: string;
    last_contribution_receipt_date?: string;
    last_disbursement_date?: string;
  };
}

interface FecPage<T> {
  results?: T[];
  pagination?: FecPagination;
}

export interface OpenFecAdapterOptions {
  apiKey: string;
  /**
   * Which two-year election cycles to fetch. Defaults to [2026, 2024]
   * per the Phase 4 load-bearing sub-decision (current + prior;
   * full history deferred).
   */
  cycles?: number[];
  rateLimiter?: RateLimiter;
}

// ── Normalisation helpers ─────────────────────────────────────────────

/**
 * Convert an FEC office code to a human-readable role string used in
 * metadata.roles[].
 */
function officeToRole(office: string): string {
  if (office === "H") return "federal_candidate_representative";
  if (office === "S") return "federal_candidate_senator";
  if (office === "P") return "federal_candidate_president";
  return "federal_candidate";
}

/**
 * Map FEC committee_type to our EntityKind. The FEC uses a large set of
 * single-letter codes; we collapse to three buckets:
 * - "H", "S", "P" principal campaign committees → "pac" (candidacy-linked)
 * - "Q", "N" PACs → "pac"
 * - Everything else → "organization"
 */
function committeeKind(type: string): "pac" | "organization" {
  const pac = new Set(["H", "S", "P", "Q", "N", "O", "V", "W"]);
  return pac.has(type.toUpperCase()) ? "pac" : "organization";
}

/** Convert an FEC ALL-CAPS name to Title Case for canonical storage.
 *
 * FEC names arrive as "SMITH, JOHN R." — we Title-Case them so that the
 * normalized form produced by normalizeName() matches Congress.gov's
 * "Smith, John R." (also normalized to "smith john r"). This is the
 * critical step that allows step-3 exact-name matching across sources.
 */
function titleCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Build the human-facing FEC candidate URL. */
function candidateUrl(candidateId: string): string {
  return `https://www.fec.gov/data/candidate/${candidateId}/`;
}

/** Build the human-facing FEC committee URL. */
function committeeUrl(committeeId: string): string {
  return `https://www.fec.gov/data/committee/${committeeId}/`;
}

// ── Adapter ───────────────────────────────────────────────────────────

export class OpenFecAdapter implements Adapter {
  readonly name = "openfec";
  private readonly rateLimiter: RateLimiter;
  private readonly cycles: number[];

  constructor(private readonly opts: OpenFecAdapterOptions) {
    this.rateLimiter =
      opts.rateLimiter ??
      new RateLimiter({ tokensPerInterval: 15, intervalMs: 60_000 });
    this.cycles = opts.cycles ?? [2026, 2024];
  }

  /**
   * Refresh federal campaign finance data from api.open.fec.gov.
   *
   * Order: candidates → committees → schedule_a → schedule_b.
   * Candidates are fetched first so that schedule_a contributions can
   * reference them as recipient committee owners. Committees are fetched
   * second so that contribution Documents have a committee Entity to
   * reference as the recipient.
   */
  async refresh(options: AdapterOptions): Promise<RefreshResult> {
    const result: RefreshResult = {
      source: this.name,
      entitiesUpserted: 0,
      documentsUpserted: 0,
      errors: [],
    };

    try {
      for (const cycle of this.cycles) {
        // 1. Candidates.
        const candidates = await this.fetchPages<FecCandidate>(
          `/candidates/search?election_year=${cycle}&candidate_status=C&per_page=100`,
          options.maxPages,
        );
        for (const c of candidates) {
          this.upsertCandidate(options.db, c, cycle);
          result.entitiesUpserted += 1;
        }

        // 2. Committees.
        const committees = await this.fetchPages<FecCommittee>(
          `/committees?cycle=${cycle}&per_page=100`,
          options.maxPages,
        );
        for (const c of committees) {
          this.upsertCommittee(options.db, c);
          result.entitiesUpserted += 1;
        }

        // 3. Schedule A (itemized contributions).
        const contribs = await this.fetchSchedule<FecScheduleA>(
          `/schedules/schedule_a?two_year_transaction_period=${cycle}&per_page=100`,
          "last_contribution_receipt_date",
          options.maxPages,
        );
        for (const item of contribs) {
          this.upsertContribution(options.db, item);
          result.documentsUpserted += 1;
        }

        // 4. Schedule B (disbursements).
        const disb = await this.fetchSchedule<FecScheduleB>(
          `/schedules/schedule_b?two_year_transaction_period=${cycle}&per_page=100`,
          "last_disbursement_date",
          options.maxPages,
        );
        for (const item of disb) {
          this.upsertExpenditure(options.db, item);
          result.documentsUpserted += 1;
        }
      }
    } catch (err) {
      const msg = String(err);
      logger.error("openfec refresh failed", { error: msg });
      result.errors.push(msg);
    }

    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────

  /**
   * Standard page-number pagination (used by /candidates/search and
   * /committees). Stops when page >= pages or results < per_page.
   */
  private async fetchPages<T>(
    firstPath: string,
    maxPages: number | undefined,
  ): Promise<T[]> {
    const all: T[] = [];
    let page = 1;

    while (true) {
      const sep = firstPath.includes("?") ? "&" : "?";
      const url = new URL(`${BASE_URL}${firstPath}${sep}page=${page}&api_key=${this.opts.apiKey}`);

      const res = await rateLimitedFetch(url.toString(), {
        userAgent: "civic-awareness-mcp/0.0.1 (+github)",
        rateLimiter: this.rateLimiter,
      });
      if (!res.ok) throw new Error(`OpenFEC ${firstPath} returned ${res.status}`);
      const body = (await res.json()) as FecPage<T>;
      const results = body.results ?? [];
      all.push(...results);

      const pages = body.pagination?.pages ?? 1;
      if (page >= pages || results.length < (body.pagination?.per_page ?? 100)) break;
      if (maxPages && page >= maxPages) break;
      page += 1;
    }

    return all;
  }

  /**
   * Cursor-based pagination for Schedule A and Schedule B. OpenFEC uses
   * `last_index` + a date cursor key instead of page numbers for these
   * high-volume endpoints. Pass `cursorDateKey` as the field name in
   * `last_indexes` that carries the date component of the cursor.
   */
  private async fetchSchedule<T>(
    firstPath: string,
    cursorDateKey: "last_contribution_receipt_date" | "last_disbursement_date",
    maxPages: number | undefined,
  ): Promise<T[]> {
    const all: T[] = [];
    let path = firstPath;
    let pageCount = 0;

    while (true) {
      const sep = path.includes("?") ? "&" : "?";
      const url = new URL(`${BASE_URL}${path}${sep}api_key=${this.opts.apiKey}`);

      const res = await rateLimitedFetch(url.toString(), {
        userAgent: "civic-awareness-mcp/0.0.1 (+github)",
        rateLimiter: this.rateLimiter,
      });
      if (!res.ok) throw new Error(`OpenFEC ${firstPath} returned ${res.status}`);
      const body = (await res.json()) as FecPage<T>;
      const results = body.results ?? [];
      all.push(...results);
      pageCount += 1;

      const lastIndexes = body.pagination?.last_indexes;
      const perPage = body.pagination?.per_page ?? 100;

      // No more pages if fewer results than page size, or no cursor.
      if (
        results.length < perPage ||
        !lastIndexes?.last_index ||
        !lastIndexes?.[cursorDateKey]
      ) {
        break;
      }
      if (maxPages && pageCount >= maxPages) break;

      // Build next cursor path.
      const sep2 = firstPath.includes("?") ? "&" : "?";
      path = `${firstPath}${sep2}last_index=${encodeURIComponent(lastIndexes.last_index)}&${cursorDateKey}=${encodeURIComponent(lastIndexes[cursorDateKey]!)}`;
    }

    return all;
  }

  private upsertCandidate(
    db: Database.Database,
    c: FecCandidate,
    cycle: number,
  ): string {
    const canonicalName = titleCase(c.name);
    const role = officeToRole(c.office);

    const newRole = {
      jurisdiction: "us-federal",
      role,
      from: `${cycle - 1}-01-01T00:00:00.000Z`,
      to: null as string | null,
    };

    const { entity, created } = upsertEntity(db, {
      kind: "person",
      name: canonicalName,
      jurisdiction: undefined,  // D3b: Persons are cross-jurisdiction
      external_ids: { fec_candidate: c.candidate_id },
      metadata: {
        party: c.party,
        state: c.state,
        office: c.office,
        roles: [newRole],
      },
    });

    // If the entity already existed (cross-source merge or re-refresh),
    // merge the new candidate role into metadata.roles[] without
    // overwriting existing roles. upsertEntity only merges external_ids
    // and aliases; metadata.roles[] is the adapter's responsibility.
    if (!created) {
      const existing = db
        .prepare("SELECT metadata FROM entities WHERE id = ?")
        .get(entity.id) as { metadata: string };
      const meta = JSON.parse(existing.metadata) as {
        roles?: typeof newRole[];
      };
      const currentRoles = meta.roles ?? [];
      const alreadyHasRole = currentRoles.some(
        (r) => r.jurisdiction === "us-federal" && r.role === role,
      );
      if (!alreadyHasRole) {
        const updatedMeta = { ...meta, roles: [...currentRoles, newRole] };
        db.prepare("UPDATE entities SET metadata = ? WHERE id = ?").run(
          JSON.stringify(updatedMeta),
          entity.id,
        );
      }
    }

    return entity.id;
  }

  private upsertCommittee(db: Database.Database, c: FecCommittee): string {
    const kind = committeeKind(c.committee_type ?? "");

    const { entity } = upsertEntity(db, {
      kind,
      name: c.name,
      jurisdiction: "us-federal",
      external_ids: { fec_committee: c.committee_id },
      metadata: {
        committee_type: c.committee_type,
        committee_type_full: c.committee_type_full,
        state: c.state,
        party: c.party,
        candidate_ids: c.candidate_ids ?? [],
      },
    });

    return entity.id;
  }

  private upsertContribution(db: Database.Database, item: FecScheduleA): void {
    if (!item.contribution_receipt_date || !item.contribution_receipt_amount) {
      // Skip malformed rows.
      return;
    }

    const occurredAt = item.contribution_receipt_date.includes("T")
      ? item.contribution_receipt_date
      : `${item.contribution_receipt_date}T00:00:00.000Z`;

    // Resolve the recipient committee entity by fec_committee external_id.
    const recipientRow = db
      .prepare(
        "SELECT id FROM entities WHERE json_extract(external_ids, '$.\"fec_committee\"') = ? LIMIT 1",
      )
      .get(item.committee_id) as { id: string } | undefined;

    let recipientId: string;
    if (recipientRow) {
      recipientId = recipientRow.id;
    } else {
      // Committee not yet in store (rare if fetch order is correct).
      // Create a minimal placeholder.
      const { entity } = upsertEntity(db, {
        kind: "pac",
        name: `Committee ${item.committee_id}`,
        jurisdiction: "us-federal",
        external_ids: { fec_committee: item.committee_id },
      });
      recipientId = entity.id;
    }

    // Resolve (or create) the contributor Person entity.
    // No fuzzy matching per D3b — exact normalized-name or create new.
    const contributorName = item.contributor_name
      ? titleCase(item.contributor_name)
      : "Unknown Contributor";
    const { entity: contributor } = upsertEntity(db, {
      kind: "person",
      name: contributorName,
      jurisdiction: undefined,
    });

    const title = `Contribution: ${contributorName} → ${item.committee_id} ($${item.contribution_receipt_amount.toFixed(2)})`;

    upsertDocument(db, {
      kind: "contribution",
      jurisdiction: "us-federal",
      title,
      occurred_at: occurredAt,
      source: {
        name: "openfec",
        id: item.transaction_id,
        url: committeeUrl(item.committee_id),
      },
      references: [
        { entity_id: contributor.id, role: "contributor" as const },
        { entity_id: recipientId, role: "recipient" as const },
      ],
      raw: {
        // Full FEC line item stored for aggregate queries.
        // Address fields are stored here but never exposed by tools.
        transaction_id: item.transaction_id,
        amount: item.contribution_receipt_amount,
        date: item.contribution_receipt_date,
        contributor_name: contributorName,
        contributor_city: item.contributor_city,
        contributor_state: item.contributor_state,
        contributor_zip: item.contributor_zip,
        contributor_employer: item.contributor_employer,
        contributor_occupation: item.contributor_occupation,
        committee_id: item.committee_id,
        line_number: item.line_number,
        memo_text: item.memo_text ?? null,
      },
    });
  }

  private upsertExpenditure(db: Database.Database, item: FecScheduleB): void {
    if (!item.disbursement_date || !item.disbursement_amount) {
      return;
    }

    const occurredAt = item.disbursement_date.includes("T")
      ? item.disbursement_date
      : `${item.disbursement_date}T00:00:00.000Z`;

    // The spender is the committee that filed Schedule B.
    const spenderRow = db
      .prepare(
        "SELECT id FROM entities WHERE json_extract(external_ids, '$.\"fec_committee\"') = ? LIMIT 1",
      )
      .get(item.committee_id) as { id: string } | undefined;

    let spenderId: string;
    if (spenderRow) {
      spenderId = spenderRow.id;
    } else {
      const { entity } = upsertEntity(db, {
        kind: "pac",
        name: `Committee ${item.committee_id}`,
        jurisdiction: "us-federal",
        external_ids: { fec_committee: item.committee_id },
      });
      spenderId = entity.id;
    }

    // Recipient is the payee — often a vendor, not a Person.
    const recipientName = item.recipient_name ?? "Unknown Recipient";
    const { entity: recipient } = upsertEntity(db, {
      kind: "organization",
      name: recipientName,
      jurisdiction: "us-federal",
    });

    const title = `Expenditure: ${item.committee_id} → ${recipientName} ($${item.disbursement_amount.toFixed(2)})`;

    upsertDocument(db, {
      kind: "expenditure",
      jurisdiction: "us-federal",
      title,
      occurred_at: occurredAt,
      source: {
        name: "openfec",
        id: item.transaction_id,
        url: committeeUrl(item.committee_id),
      },
      references: [
        { entity_id: spenderId, role: "contributor" as const },
        { entity_id: recipient.id, role: "recipient" as const },
      ],
      raw: {
        transaction_id: item.transaction_id,
        amount: item.disbursement_amount,
        date: item.disbursement_date,
        committee_id: item.committee_id,
        recipient_name: recipientName,
        recipient_city: item.recipient_city,
        recipient_state: item.recipient_state,
        disbursement_description: item.disbursement_description,
      },
    });
  }
}
```

- [ ] **Step 2.4: Run tests and confirm green**

```bash
pnpm test tests/unit/adapters/openfec.test.ts
pnpm typecheck
```

Expected: 7 tests pass, no type errors.

- [ ] **Step 2.5: Commit**

```bash
git add src/adapters/openfec.ts tests/unit/adapters/openfec.test.ts
git commit -m "feat: OpenFEC adapter for federal candidates, committees, contributions, and expenditures"
```

---

## Task 3: Extend the refresh CLI

**Files:** `src/cli/refresh.ts` (modify in place)

The existing `src/cli/refresh.ts` exits with `process.exit(1)` for any
`--source` other than `openstates` or `congress`. This task extends the
dispatch so `--source=openfec` invokes `OpenFecAdapter.refresh()` once
(federal singleton — no jurisdiction iteration).

- [ ] **Step 3.1: Write a CLI smoke test**

`tests/unit/cli/refresh.test.ts` already tests the `openstates` and
`congress` dispatch paths. Add two new `it` blocks to the existing
`describe("refresh CLI — congress source")` block (or create a new
sibling describe):

```ts
describe("refresh CLI — openfec source", () => {
  it("runs OpenFecAdapter.refresh() with no jurisdiction and returns no errors", async () => {
    // Seed jurisdictions so the adapter can write documents.
    vi.spyOn(global, "fetch").mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/candidates/search"))
        return new Response(
          JSON.stringify({ results: [], pagination: { count: 0, pages: 1 } }),
          { status: 200 },
        );
      if (u.includes("/committees"))
        return new Response(
          JSON.stringify({ results: [], pagination: { count: 0, pages: 1 } }),
          { status: 200 },
        );
      if (u.includes("/schedules/schedule_a"))
        return new Response(
          JSON.stringify({ results: [], pagination: { count: 0, pages: 1 } }),
          { status: 200 },
        );
      if (u.includes("/schedules/schedule_b"))
        return new Response(
          JSON.stringify({ results: [], pagination: { count: 0, pages: 1 } }),
          { status: 200 },
        );
      return new Response("not found", { status: 404 });
    });

    const { OpenFecAdapter } = await import("../../../src/adapters/openfec.js");
    const adapter = new OpenFecAdapter({ apiKey: "test-key", cycles: [2026] });
    const result = await adapter.refresh({ db: store.db, maxPages: 1 });
    expect(result.source).toBe("openfec");
    expect(result.errors).toEqual([]);
  });

  it("does not call fetch with a state-abbreviation path segment", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/candidates/search") || u.includes("/committees") ||
          u.includes("/schedules/schedule_a") || u.includes("/schedules/schedule_b")) {
        return new Response(
          JSON.stringify({ results: [], pagination: { count: 0, pages: 1 } }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const mockFetch = vi.mocked(global.fetch);
    const { OpenFecAdapter } = await import("../../../src/adapters/openfec.js");
    const adapter = new OpenFecAdapter({ apiKey: "test-key", cycles: [2026] });
    await adapter.refresh({ db: store.db, maxPages: 1 });
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    // OpenFEC URLs should never contain a bare 2-letter state path segment.
    expect(urls.every((u) => !/\/[a-z]{2}\//.test(u))).toBe(true);
  });
});
```

- [ ] **Step 3.2: Run the test to confirm it passes**

```bash
pnpm test tests/unit/cli/refresh.test.ts
```

Expected: PASS (new tests exercise `OpenFecAdapter` directly via
import; they do not depend on the CLI dispatch code).

- [ ] **Step 3.3: Update `src/cli/refresh.ts`**

Add the `OpenFecAdapter` import and a new `else if` branch. Replace the
full `main()` function (and the import block) with:

```ts
import { openStore } from "../core/store.js";
import { seedJurisdictions } from "../core/seeds.js";
import { OpenStatesAdapter } from "../adapters/openstates.js";
import { CongressAdapter } from "../adapters/congress.js";
import { OpenFecAdapter } from "../adapters/openfec.js";
import { requireEnv, optionalEnv } from "../util/env.js";
import { logger } from "../util/logger.js";

interface Args {
  source: string;
  maxPages?: number;
  jurisdictions?: string[];
}

function parseArgs(argv: string[]): Args {
  let source = "openstates";
  let maxPages: number | undefined;
  let jurisdictions: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) source = argv[++i];
    else if (argv[i].startsWith("--source=")) source = argv[i].slice("--source=".length);
    else if (argv[i] === "--max-pages" && argv[i + 1]) maxPages = parseInt(argv[++i], 10);
    else if (argv[i].startsWith("--max-pages=")) maxPages = parseInt(argv[i].slice("--max-pages=".length), 10);
    else if (argv[i] === "--jurisdictions" && argv[i + 1]) {
      jurisdictions = argv[++i].split(",").map((s) => s.trim().toLowerCase());
    } else if (argv[i].startsWith("--jurisdictions=")) {
      jurisdictions = argv[i]
        .slice("--jurisdictions=".length)
        .split(",")
        .map((s) => s.trim().toLowerCase());
    }
  }
  return { source, maxPages, jurisdictions };
}

function listStateJurisdictions(db: import("better-sqlite3").Database): string[] {
  const rows = db
    .prepare("SELECT id FROM jurisdictions WHERE level = 'state' ORDER BY id")
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id.replace(/^us-/, ""));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = optionalEnv("CIVIC_AWARENESS_DB_PATH", "./data/civic-awareness.db");
  const store = openStore(dbPath);
  seedJurisdictions(store.db);

  if (args.source === "openfec") {
    // Federal singleton — no jurisdiction iteration.
    const adapter = new OpenFecAdapter({
      apiKey: requireEnv("FEC_API_KEY"),
    });
    logger.info("refreshing source", { source: "openfec" });
    const result = await adapter.refresh({ db: store.db, maxPages: args.maxPages });
    logger.info("refresh complete", {
      source: result.source,
      entitiesUpserted: result.entitiesUpserted,
      documentsUpserted: result.documentsUpserted,
      errorCount: result.errors.length,
    });
    if (result.errors.length > 0) {
      logger.error("openfec refresh had errors", { errors: result.errors });
    }
  } else if (args.source === "congress") {
    const adapter = new CongressAdapter({
      apiKey: requireEnv("CONGRESS_API_KEY"),
    });
    logger.info("refreshing source", { source: "congress" });
    const result = await adapter.refresh({ db: store.db, maxPages: args.maxPages });
    logger.info("refresh complete", {
      source: result.source,
      entitiesUpserted: result.entitiesUpserted,
      documentsUpserted: result.documentsUpserted,
      errorCount: result.errors.length,
    });
    if (result.errors.length > 0) {
      logger.error("congress refresh had errors", { errors: result.errors });
    }
  } else if (args.source === "openstates") {
    const adapter = new OpenStatesAdapter({ apiKey: requireEnv("OPENSTATES_API_KEY") });
    const targets = args.jurisdictions ?? listStateJurisdictions(store.db);
    for (const state of targets) {
      logger.info("refreshing state", { state });
      const result = await adapter.refresh({
        db: store.db,
        maxPages: args.maxPages,
        jurisdiction: state,
      });
      logger.info("state refresh complete", {
        source: result.source,
        entitiesUpserted: result.entitiesUpserted,
        documentsUpserted: result.documentsUpserted,
        errorCount: result.errors.length,
      });
      if (result.errors.length > 0) {
        logger.error("state had errors", { state, errors: result.errors });
      }
    }
  } else {
    logger.error("unknown source; valid values: openstates, congress, openfec", {
      source: args.source,
    });
    process.exit(1);
  }

  store.close();
}

main().catch((err) => {
  logger.error("refresh failed", { error: String(err) });
  process.exit(1);
});
```

- [ ] **Step 3.4: Test and commit**

```bash
pnpm test tests/unit/cli/refresh.test.ts
pnpm typecheck
git add src/cli/refresh.ts tests/unit/cli/refresh.test.ts
git commit -m "feat: extend refresh CLI to dispatch --source=openfec"
```

---

## Task 4: `recent_contributions` tool

**Files:** `src/mcp/schemas.ts` (add `RecentContributionsInput`),
`src/mcp/tools/recent_contributions.ts`,
`tests/unit/mcp/tools/recent_contributions.test.ts`

Spec: `docs/05-tool-surface.md` → `recent_contributions` (Phase 4).

Input: `window.from` and `window.to` (ISO datetimes; **required** —
the spec explicitly requires a window, unlike `recent_bills` which
defaults `days`), `candidate_or_committee` (optional free-text,
entity-resolved), `min_amount` (optional).

Output: `ToolResponse<ContributionSummary>` where `ContributionSummary`
has `id`, `amount`, `date`, `contributor: { name; entity_id? }`,
`recipient: { name; entity_id }`, `source_url`.

The handler:
1. Parses and validates input via `RecentContributionsInput.parse`.
2. Queries `documents` for `kind='contribution'` within `window`.
3. If `candidate_or_committee` is given, resolves it to an entity UUID
   using a normalized-name fuzzy search (same SQL as `search_entities`
   but constrained to `kind IN ('pac','organization','person')`) and
   filters to contributions where that entity appears as a
   `document_references.entity_id` with `role='recipient'`.
4. If `min_amount` is given, filters rows where `raw.amount >= min_amount`.
5. For each matching document, reads `raw` for `amount` and `date`,
   loads contributor and recipient references, and resolves their names
   from `entities`. Addresses and employers from `raw` are NOT included
   in the output.
6. Returns `ContributionSummary[]` with provenance.

**Design note:** address/employer fields are present in `Document.raw`
but the tool must never expose them. The handler explicitly selects only
the fields it needs; it does not pass `raw` through to the response.

- [ ] **Step 4.1: Write the test**

`tests/unit/mcp/tools/recent_contributions.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleRecentContributions } from "../../../../src/mcp/tools/recent_contributions.js";

const TEST_DB = "./data/test-tool-recent-contributions.db";
let store: Store;

const RECENT = new Date().toISOString();
const OLD = new Date(Date.now() - 90 * 86400 * 1000).toISOString();

let committeeEntityId: string;
let contributorEntityId: string;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  // Create a committee (recipient) entity.
  const { entity: committee } = upsertEntity(store.db, {
    kind: "pac",
    name: "Smith for Congress",
    jurisdiction: "us-federal",
    external_ids: { fec_committee: "C00123456" },
  });
  committeeEntityId = committee.id;

  // Create a contributor entity.
  const { entity: contributor } = upsertEntity(store.db, {
    kind: "person",
    name: "Jones, Alice M.",
    jurisdiction: undefined,
  });
  contributorEntityId = contributor.id;

  // Seed a recent contribution document.
  upsertDocument(store.db, {
    kind: "contribution",
    jurisdiction: "us-federal",
    title: "Contribution: Jones, Alice M. → C00123456 ($2800.00)",
    occurred_at: RECENT,
    source: {
      name: "openfec",
      id: "SA17.1234567",
      url: "https://www.fec.gov/data/committee/C00123456/",
    },
    references: [
      { entity_id: contributorEntityId, role: "contributor" },
      { entity_id: committeeEntityId, role: "recipient" },
    ],
    raw: {
      transaction_id: "SA17.1234567",
      amount: 2800.0,
      date: RECENT.slice(0, 10),
      contributor_name: "Jones, Alice M.",
      contributor_city: "PHOENIX",   // stored but never exposed
      contributor_state: "AZ",
      contributor_zip: "85001",
      contributor_employer: "Self-Employed",
      committee_id: "C00123456",
    },
  });

  // Seed an old contribution outside any reasonable window.
  upsertDocument(store.db, {
    kind: "contribution",
    jurisdiction: "us-federal",
    title: "Contribution: Brown, Bob → C00123456 ($500.00)",
    occurred_at: OLD,
    source: {
      name: "openfec",
      id: "SA17.0000001",
      url: "https://www.fec.gov/data/committee/C00123456/",
    },
    references: [
      {
        entity_id: contributorEntityId,
        role: "contributor",
      },
      { entity_id: committeeEntityId, role: "recipient" },
    ],
    raw: {
      transaction_id: "SA17.0000001",
      amount: 500.0,
      date: OLD.slice(0, 10),
      contributor_name: "Brown, Bob",
      committee_id: "C00123456",
    },
  });
});

afterEach(() => store.close());

describe("recent_contributions tool", () => {
  it("returns only contributions within the required window", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();

    const result = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].amount).toBe(2800.0);
  });

  it("filters by min_amount", async () => {
    const oneYearAgo = new Date(Date.now() - 365 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();

    const result = await handleRecentContributions(store.db, {
      window: { from: oneYearAgo, to: now },
      min_amount: 1000,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].amount).toBe(2800.0);
  });

  it("filters by candidate_or_committee resolved to entity", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();

    const result = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
      candidate_or_committee: "Smith for Congress",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].recipient.name).toBe("Smith for Congress");
    expect(result.results[0].recipient.entity_id).toBe(committeeEntityId);
  });

  it("does not expose contributor address or employer in response", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();

    const result = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
    });
    expect(result.results).toHaveLength(1);
    const contrib = result.results[0];

    // These fields must not appear anywhere in the ContributionSummary.
    const serialized = JSON.stringify(contrib);
    expect(serialized).not.toContain("PHOENIX");
    expect(serialized).not.toContain("85001");
    expect(serialized).not.toContain("Self-Employed");
    expect(serialized).not.toContain("contributor_city");
    expect(serialized).not.toContain("contributor_zip");
    expect(serialized).not.toContain("contributor_employer");
  });

  it("includes contributor entity_id when the contributor is a known entity", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();

    const result = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
    });
    expect(result.results[0].contributor.entity_id).toBe(contributorEntityId);
  });

  it("includes source provenance", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();

    const result = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
    });
    expect(result.sources).toContainEqual(
      expect.objectContaining({ name: "openfec" }),
    );
  });

  it("rejects input with missing window", async () => {
    await expect(
      handleRecentContributions(store.db, {} as unknown),
    ).rejects.toThrow();
  });

  it("rejects input with window.from but missing window.to", async () => {
    await expect(
      handleRecentContributions(store.db, {
        window: { from: new Date().toISOString() },
      } as unknown),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4.2: Run the test to confirm failure**

```bash
pnpm test tests/unit/mcp/tools/recent_contributions.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 4.3: Add `RecentContributionsInput` to `src/mcp/schemas.ts`**

Append to the existing file (do not modify existing exports):

```ts
export const RecentContributionsInput = z.object({
  // window is REQUIRED per docs/05-tool-surface.md. There is no
  // sensible default window for contributions — callers must be explicit.
  window: z.object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),
  // Free-text name of a candidate or committee; resolved against the
  // entity store using normalized-name matching.
  candidate_or_committee: z.string().optional(),
  // Minimum contribution amount in USD. Filters out small contributions.
  min_amount: z.number().min(0).optional(),
});
export type RecentContributionsInput = z.infer<typeof RecentContributionsInput>;
```

- [ ] **Step 4.4: Implement `src/mcp/tools/recent_contributions.ts`**

```ts
import type Database from "better-sqlite3";
import { queryDocuments } from "../../core/documents.js";
import { RecentContributionsInput } from "../schemas.js";

export interface ContributorRef {
  name: string;
  entity_id?: string;
}

export interface RecipientRef {
  name: string;
  entity_id: string;
}

export interface ContributionSummary {
  id: string;
  amount: number;
  date: string;
  contributor: ContributorRef;
  recipient: RecipientRef;
  source_url: string;
}

export interface RecentContributionsResponse {
  results: ContributionSummary[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  window: { from: string; to: string };
}

export async function handleRecentContributions(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentContributionsResponse> {
  const input = RecentContributionsInput.parse(rawInput);

  // If candidate_or_committee is given, resolve it to an entity UUID.
  // We match against normalized name (lowercased, punct-stripped) using
  // a LIKE search consistent with search_entities — but limit to
  // kinds that appear as recipients on contribution documents.
  let recipientEntityId: string | undefined;
  if (input.candidate_or_committee) {
    const q = input.candidate_or_committee
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const match = db
      .prepare(
        `SELECT id FROM entities
         WHERE kind IN ('pac', 'organization', 'committee', 'person')
           AND name_normalized LIKE ?
         LIMIT 1`,
      )
      .get(`%${q}%`) as { id: string } | undefined;
    recipientEntityId = match?.id;
  }

  const docs = queryDocuments(db, {
    kind: "contribution",
    jurisdiction: "us-federal",
    from: input.window.from,
    to: input.window.to,
    limit: 200,
  });

  const results: ContributionSummary[] = [];

  for (const doc of docs) {
    const raw = doc.raw as {
      amount?: number;
      date?: string;
      contributor_name?: string;
    };

    const amount = raw.amount ?? 0;

    // min_amount filter.
    if (input.min_amount !== undefined && amount < input.min_amount) continue;

    // candidate_or_committee filter — check that the resolved entity is
    // the recipient on this document.
    if (recipientEntityId) {
      const isRecipient = doc.references.some(
        (r) => r.entity_id === recipientEntityId && r.role === "recipient",
      );
      if (!isRecipient) continue;
    }

    // Resolve contributor and recipient from document_references.
    const contribRef = doc.references.find((r) => r.role === "contributor");
    const recipientRef = doc.references.find((r) => r.role === "recipient");

    if (!recipientRef) continue;  // malformed document — skip

    // Look up entity names.
    const recipientRow = db
      .prepare("SELECT name FROM entities WHERE id = ?")
      .get(recipientRef.entity_id) as { name: string } | undefined;

    let contributorName = raw.contributor_name ?? "Unknown";
    let contributorEntityId: string | undefined;

    if (contribRef) {
      const contribRow = db
        .prepare("SELECT name FROM entities WHERE id = ?")
        .get(contribRef.entity_id) as { name: string } | undefined;
      if (contribRow) {
        contributorName = contribRow.name;
        contributorEntityId = contribRef.entity_id;
      }
    }

    results.push({
      id: doc.id,
      amount,
      date: raw.date ?? doc.occurred_at.slice(0, 10),
      // Address and employer deliberately omitted per docs/05-tool-surface.md.
      contributor: {
        name: contributorName,
        entity_id: contributorEntityId,
      },
      recipient: {
        name: recipientRow?.name ?? "Unknown",
        entity_id: recipientRef.entity_id,
      },
      source_url: doc.source.url,
    });
  }

  return {
    results,
    total: results.length,
    sources: results.length > 0
      ? [{ name: "openfec", url: "https://www.fec.gov/" }]
      : [],
    window: input.window,
  };
}
```

- [ ] **Step 4.5: Run tests and confirm green**

```bash
pnpm test tests/unit/mcp/tools/recent_contributions.test.ts
pnpm typecheck
```

Expected: 8 tests pass, no type errors.

- [ ] **Step 4.6: Commit**

```bash
git add src/mcp/schemas.ts src/mcp/tools/recent_contributions.ts \
        tests/unit/mcp/tools/recent_contributions.test.ts
git commit -m "feat: recent_contributions MCP tool for federal campaign finance"
```

---

## Task 5: Register `recent_contributions` in `server.ts`

**Files:** `src/mcp/server.ts` (modify in place)

Add the import and `mcp.registerTool` call. Bump the server version
to `"0.0.4"`. Update the `search_civic_documents` description to
mention contributions.

- [ ] **Step 5.1: Update `src/mcp/server.ts`**

Replace the full content of `src/mcp/server.ts` with:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openStore, type Store } from "../core/store.js";
import { handleRecentBills } from "./tools/recent_bills.js";
import { handleRecentVotes } from "./tools/recent_votes.js";
import { handleRecentContributions } from "./tools/recent_contributions.js";
import { handleSearchEntities } from "./tools/search_entities.js";
import { handleGetEntity } from "./tools/get_entity.js";
import { handleSearchDocuments } from "./tools/search_civic_documents.js";
import {
  RecentBillsInput,
  RecentVotesInput,
  RecentContributionsInput,
  SearchEntitiesInput,
  GetEntityInput,
  SearchDocumentsInput,
} from "./schemas.js";

export interface BuildServerOptions { dbPath: string }
export interface CivicAwarenessServer { mcp: McpServer; store: Store }

export function buildServer(opts: BuildServerOptions): CivicAwarenessServer {
  const store = openStore(opts.dbPath);
  const mcp = new McpServer(
    { name: "civic-awareness-mcp", version: "0.0.4" },
    { capabilities: { tools: {} } },
  );

  mcp.registerTool(
    "recent_bills",
    {
      description:
        "List recently-updated legislative bills. Jurisdiction is required — " +
        'pass "us-federal" for Congress.gov bills, or "us-<state>" (e.g. "us-tx") ' +
        "for OpenStates state bills.",
      inputSchema: RecentBillsInput.shape,
    },
    async (input) => {
      const data = await handleRecentBills(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "recent_votes",
    {
      description:
        "List recent roll-call votes for a jurisdiction. Jurisdiction is required — " +
        'pass "us-federal" for congressional votes. ' +
        "Optionally filter by chamber (upper=Senate, lower=House) or bill identifier.",
      inputSchema: RecentVotesInput.shape,
    },
    async (input) => {
      const data = await handleRecentVotes(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "recent_contributions",
    {
      description:
        "List itemized federal campaign contributions from OpenFEC. " +
        "A date window (from/to ISO datetimes) is required. " +
        "Optionally filter by candidate or committee name and minimum amount. " +
        "Contributor addresses and employer information are never exposed.",
      inputSchema: RecentContributionsInput.shape,
    },
    async (input) => {
      const data = await handleRecentContributions(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "search_entities",
    {
      description:
        "Search for people or organizations by name across all ingested jurisdictions " +
        "(U.S. state legislatures, federal Congress, and federal campaign committees).",
      inputSchema: SearchEntitiesInput.shape,
    },
    async (input) => {
      const data = await handleSearchEntities(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "get_entity",
    {
      description:
        "Fetch a single entity by ID with recent related documents. " +
        "For Persons, returns the cross-jurisdiction roles[] history spanning " +
        "state and federal offices and campaign candidacies.",
      inputSchema: GetEntityInput.shape,
    },
    async (input) => {
      const data = await handleGetEntity(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "search_civic_documents",
    {
      description:
        "Search civic documents (U.S. state and federal bills, votes, and " +
        "federal campaign contributions) by title across all ingested jurisdictions.",
      inputSchema: SearchDocumentsInput.shape,
    },
    async (input) => {
      const data = await handleSearchDocuments(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  return { mcp, store };
}
```

- [ ] **Step 5.2: Run the server test and commit**

```bash
pnpm test tests/unit/mcp/server.test.ts
pnpm typecheck
git add src/mcp/server.ts
git commit -m "feat: register recent_contributions tool and update server to v0.0.4"
```

---

## Task 6: End-to-end integration test with OpenFEC fixtures

**Files:** `tests/integration/openfec-e2e.test.ts`,
`tests/integration/fixtures/openfec-candidates-page1.json`,
`tests/integration/fixtures/openfec-committees-page1.json`,
`tests/integration/fixtures/openfec-schedule-a-page1.json`,
`tests/integration/fixtures/openfec-schedule-b-page1.json`

This test mirrors `tests/integration/congress-e2e.test.ts`: the
adapter runs against committed fixture files (mocked via
`vi.spyOn(global, "fetch")`), then the `recent_contributions` tool
queries the result. Additionally, it verifies cross-source merge
between an FEC candidate and a pre-seeded Congress.gov Person.

- [ ] **Step 6.1: Write the fixture files**

Option A — from the live API (requires `FEC_API_KEY`):

```bash
mkdir -p tests/integration/fixtures

curl -s "https://api.open.fec.gov/v1/candidates/search?election_year=2026&candidate_status=C&per_page=5&api_key=$FEC_API_KEY" \
  > tests/integration/fixtures/openfec-candidates-page1.json

curl -s "https://api.open.fec.gov/v1/committees?cycle=2026&per_page=5&api_key=$FEC_API_KEY" \
  > tests/integration/fixtures/openfec-committees-page1.json

curl -s "https://api.open.fec.gov/v1/schedules/schedule_a?two_year_transaction_period=2026&per_page=5&api_key=$FEC_API_KEY" \
  > tests/integration/fixtures/openfec-schedule-a-page1.json

curl -s "https://api.open.fec.gov/v1/schedules/schedule_b?two_year_transaction_period=2026&per_page=5&api_key=$FEC_API_KEY" \
  > tests/integration/fixtures/openfec-schedule-b-page1.json
```

Option B — hand-crafted fixtures (use if you don't have a key at
fixture-creation time):

`tests/integration/fixtures/openfec-candidates-page1.json`:
```json
{
  "results": [
    {
      "candidate_id": "H0AZ01234",
      "name": "SMITH, JOHN R.",
      "office": "H",
      "state": "AZ",
      "district": "01",
      "party": "REP",
      "election_years": [2026],
      "principal_committees": [
        { "committee_id": "C00123456", "name": "Smith for Congress" }
      ]
    }
  ],
  "pagination": { "count": 1, "per_page": 100, "page": 1, "pages": 1 }
}
```

`tests/integration/fixtures/openfec-committees-page1.json`:
```json
{
  "results": [
    {
      "committee_id": "C00123456",
      "name": "Smith for Congress",
      "committee_type": "H",
      "committee_type_full": "House",
      "state": "AZ",
      "party": "REP",
      "candidate_ids": ["H0AZ01234"]
    }
  ],
  "pagination": { "count": 1, "per_page": 100, "page": 1, "pages": 1 }
}
```

`tests/integration/fixtures/openfec-schedule-a-page1.json`:
```json
{
  "results": [
    {
      "transaction_id": "SA17.1234567",
      "committee_id": "C00123456",
      "contributor_name": "JONES, ALICE M.",
      "contributor_city": "PHOENIX",
      "contributor_state": "AZ",
      "contributor_zip": "85001",
      "contributor_employer": "Self-Employed",
      "contributor_occupation": "Attorney",
      "contribution_receipt_amount": 2800.0,
      "contribution_receipt_date": "2026-01-15",
      "memo_text": null,
      "line_number": "11AI"
    }
  ],
  "pagination": { "count": 1, "per_page": 100, "page": 1, "pages": 1 }
}
```

`tests/integration/fixtures/openfec-schedule-b-page1.json`:
```json
{
  "results": [
    {
      "transaction_id": "SB23.9876543",
      "committee_id": "C00123456",
      "recipient_name": "ABC MEDIA LLC",
      "recipient_city": "PHOENIX",
      "recipient_state": "AZ",
      "disbursement_amount": 15000.0,
      "disbursement_date": "2026-01-20",
      "disbursement_description": "DIGITAL ADVERTISING"
    }
  ],
  "pagination": { "count": 1, "per_page": 100, "page": 1, "pages": 1 }
}
```

- [ ] **Step 6.2: Write the integration test**

`tests/integration/openfec-e2e.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/core/seeds.js";
import { upsertEntity } from "../../src/core/entities.js";
import { OpenFecAdapter } from "../../src/adapters/openfec.js";
import { handleRecentContributions } from "../../src/mcp/tools/recent_contributions.js";

const TEST_DB = "./data/test-openfec-e2e.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  const candidatesFixture = readFileSync(
    "tests/integration/fixtures/openfec-candidates-page1.json",
    "utf-8",
  );
  const committeesFixture = readFileSync(
    "tests/integration/fixtures/openfec-committees-page1.json",
    "utf-8",
  );
  const scheduleAFixture = readFileSync(
    "tests/integration/fixtures/openfec-schedule-a-page1.json",
    "utf-8",
  );
  const scheduleBFixture = readFileSync(
    "tests/integration/fixtures/openfec-schedule-b-page1.json",
    "utf-8",
  );

  vi.spyOn(global, "fetch").mockImplementation(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/candidates/search")) return new Response(candidatesFixture, { status: 200 });
    if (u.includes("/committees"))        return new Response(committeesFixture,  { status: 200 });
    if (u.includes("/schedules/schedule_b")) return new Response(scheduleBFixture, { status: 200 });
    if (u.includes("/schedules/schedule_a")) return new Response(scheduleAFixture, { status: 200 });
    return new Response("", { status: 404 });
  });
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

describe("OpenFEC end-to-end", () => {
  it("refreshes and exposes contributions via recent_contributions", async () => {
    const adapter = new OpenFecAdapter({ apiKey: "fake", cycles: [2026] });
    const result = await adapter.refresh({ db: store.db, maxPages: 1 });
    expect(result.errors).toEqual([]);
    expect(result.documentsUpserted).toBeGreaterThan(0);

    // recent_contributions with a wide window to capture the fixture date.
    const contribs = await handleRecentContributions(store.db, {
      window: { from: "2025-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" },
    });
    expect(contribs.results.length).toBeGreaterThan(0);
    expect(contribs.sources[0].name).toBe("openfec");

    const contrib = contribs.results[0];
    expect(contrib.amount).toBe(2800.0);
    expect(contrib.recipient.name).toBeTruthy();

    // Address fields must not be in the response.
    const serialized = JSON.stringify(contrib);
    expect(serialized).not.toContain("PHOENIX");
    expect(serialized).not.toContain("85001");
    expect(serialized).not.toContain("Self-Employed");
  });

  it("candidate from fixtures appears in entity store with federal_candidate role", async () => {
    const adapter = new OpenFecAdapter({ apiKey: "fake", cycles: [2026] });
    await adapter.refresh({ db: store.db, maxPages: 1 });

    const rows = store.db
      .prepare(
        "SELECT name, external_ids, metadata FROM entities WHERE kind = 'person'",
      )
      .all() as Array<{ name: string; external_ids: string; metadata: string }>;

    // At least one candidate Person row.
    const candidateRows = rows.filter((r) => {
      const ext = JSON.parse(r.external_ids) as Record<string, string>;
      return ext.fec_candidate != null;
    });
    expect(candidateRows.length).toBeGreaterThan(0);

    // Each candidate has a federal_candidate role.
    for (const row of candidateRows) {
      const meta = JSON.parse(row.metadata) as {
        roles?: Array<{ role: string }>;
      };
      expect(meta.roles?.some((r) => r.role.startsWith("federal_candidate"))).toBe(true);
    }
  });

  it("cross-source merge: FEC candidate collapses into existing Congress.gov Person when names match", async () => {
    // Seed a Congress.gov Person whose name, after titleCase() and
    // normalizeName(), matches the fixture candidate "SMITH, JOHN R."
    // → titleCase → "Smith, John R." → normalizeName → "smith john r"
    const { entity: congressPerson } = upsertEntity(store.db, {
      kind: "person",
      name: "Smith, John R.",
      jurisdiction: undefined,
      external_ids: { bioguide: "S001234" },
      metadata: {
        roles: [
          {
            jurisdiction: "us-federal",
            role: "representative",
            from: "2023-01-03T00:00:00.000Z",
            to: null,
          },
        ],
      },
    });

    const adapter = new OpenFecAdapter({ apiKey: "fake", cycles: [2026] });
    await adapter.refresh({ db: store.db, maxPages: 1 });

    // After merge, only ONE Person row should exist for this individual.
    const personCount = (
      store.db
        .prepare(
          "SELECT COUNT(*) c FROM entities WHERE kind = 'person' AND name_normalized = 'smith john r'",
        )
        .get() as { c: number }
    ).c;
    expect(personCount).toBe(1);

    // The merged row carries both external IDs.
    const row = store.db
      .prepare("SELECT external_ids, metadata FROM entities WHERE id = ?")
      .get(congressPerson.id) as
      | { external_ids: string; metadata: string }
      | undefined;

    // If the merge happened, the existing row gains fec_candidate.
    // If upsertEntity created a new row instead (under-match), the test
    // fails, flagging that the name normalization is inconsistent between
    // the Congress adapter and the OpenFEC adapter.
    expect(row).toBeDefined();
    const extIds = JSON.parse(row!.external_ids);
    expect(extIds.bioguide).toBe("S001234");
    expect(extIds.fec_candidate).toBe("H0AZ01234");

    // Both roles present.
    const meta = JSON.parse(row!.metadata) as {
      roles?: Array<{ role: string }>;
    };
    const roleNames = (meta.roles ?? []).map((r) => r.role);
    expect(roleNames).toContain("representative");
    expect(roleNames.some((r) => r.startsWith("federal_candidate"))).toBe(true);
  });

  it("committee from fixtures appears as an Organization/PAC entity", () => {
    const adapter = new OpenFecAdapter({ apiKey: "fake", cycles: [2026] });
    return adapter.refresh({ db: store.db, maxPages: 1 }).then(() => {
      const rows = store.db
        .prepare(
          "SELECT name, kind, external_ids FROM entities WHERE kind IN ('pac', 'organization', 'committee')",
        )
        .all() as Array<{ name: string; kind: string; external_ids: string }>;
      const committees = rows.filter((r) => {
        const ext = JSON.parse(r.external_ids) as Record<string, string>;
        return ext.fec_committee != null;
      });
      expect(committees.length).toBeGreaterThan(0);
      expect(committees[0].kind).toMatch(/^(pac|organization|committee)$/);
    });
  });

  it("expenditure documents from Schedule B are stored with kind='expenditure'", async () => {
    const adapter = new OpenFecAdapter({ apiKey: "fake", cycles: [2026] });
    await adapter.refresh({ db: store.db, maxPages: 1 });

    const expRow = store.db
      .prepare("SELECT kind, raw FROM documents WHERE kind = 'expenditure'")
      .get() as { kind: string; raw: string } | undefined;

    expect(expRow).toBeDefined();
    const raw = JSON.parse(expRow!.raw) as { amount: number };
    expect(raw.amount).toBe(15000.0);
  });
});
```

- [ ] **Step 6.3: Run the integration test**

```bash
pnpm test tests/integration/openfec-e2e.test.ts
pnpm typecheck
```

Expected: 5 tests pass.

- [ ] **Step 6.4: Commit**

```bash
git add tests/integration/openfec-e2e.test.ts \
        tests/integration/fixtures/openfec-candidates-page1.json \
        tests/integration/fixtures/openfec-committees-page1.json \
        tests/integration/fixtures/openfec-schedule-a-page1.json \
        tests/integration/fixtures/openfec-schedule-b-page1.json
git commit -m "test: OpenFEC end-to-end integration tests with hand-crafted fixtures"
```

---

## Task 7: Extend `get_entity` with `fec.gov` source URL branch

**Files:** `src/mcp/tools/get_entity.ts` (modify in place)

Phase 3 Task 7 added an `openstates.org` and `congress.gov` source URL
branch to `get_entity`. Phase 4 extends that to also emit a `fec.gov`
URL when the entity has a `fec_candidate` or `fec_committee` external
ID. This makes `get_entity` responses self-contained for citation.

- [ ] **Step 7.1: Write the test**

In `tests/unit/mcp/tools/get_entity.test.ts`, add one new `it` block
inside the existing `describe("get_entity tool")`:

```ts
it("returns a fec.gov source_url when the entity has a fec_candidate external_id", async () => {
  const { entity } = upsertEntity(store.db, {
    kind: "person",
    name: "Smith, John R.",
    jurisdiction: undefined,
    external_ids: {
      fec_candidate: "H0AZ01234",
      bioguide: "S001234",
    },
    metadata: {
      roles: [
        { jurisdiction: "us-federal", role: "federal_candidate_representative" },
      ],
    },
  });

  const result = await handleGetEntity(store.db, { id: entity.id });
  const fecSource = result.sources?.find((s) =>
    s.url.includes("fec.gov"),
  );
  expect(fecSource).toBeDefined();
  expect(fecSource!.url).toBe(`https://www.fec.gov/data/candidate/${entity.external_ids.fec_candidate}/`);
});
```

- [ ] **Step 7.2: Run the test to confirm failure**

```bash
pnpm test tests/unit/mcp/tools/get_entity.test.ts
```

Expected: the new test fails; existing tests still pass.

- [ ] **Step 7.3: Update `src/mcp/tools/get_entity.ts`**

Locate the section where `get_entity` assembles the `sources` array.
This section already handles `bioguide` → `congress.gov` and
`openstates_person` → `openstates.org` links. Add the FEC branches
after the existing ones:

```ts
// FEC candidate.
if (entity.external_ids.fec_candidate) {
  sources.push({
    name: "openfec",
    url: `https://www.fec.gov/data/candidate/${entity.external_ids.fec_candidate}/`,
  });
}
// FEC committee.
if (entity.external_ids.fec_committee) {
  sources.push({
    name: "openfec",
    url: `https://www.fec.gov/data/committee/${entity.external_ids.fec_committee}/`,
  });
}
```

Read the current `get_entity.ts` carefully before editing to find the
exact location; the pattern above slots in adjacent to the existing
external-ID URL branches.

- [ ] **Step 7.4: Run tests and commit**

```bash
pnpm test tests/unit/mcp/tools/get_entity.test.ts
pnpm typecheck
git add src/mcp/tools/get_entity.ts tests/unit/mcp/tools/get_entity.test.ts
git commit -m "feat: get_entity emits fec.gov source URLs for FEC candidate and committee entities"
```

---

## Phase 4 completion checklist

Before marking Phase 4 done:

- [ ] `pnpm test` passes with no failures (target: all prior tests plus
  the new Phase 4 tests — expect the total to be ≥ 110 tests).
- [ ] `pnpm typecheck` reports no errors.
- [ ] `tests/unit/adapters/openfec.test.ts` — 7 tests green.
- [ ] `tests/unit/mcp/tools/recent_contributions.test.ts` — 8 tests green.
- [ ] `tests/integration/openfec-e2e.test.ts` — 5 tests green.
- [ ] `tests/unit/mcp/tools/get_entity.test.ts` — new FEC URL test green.
- [ ] `src/mcp/server.ts` exports `buildServer` at version `"0.0.4"`.
- [ ] `src/cli/refresh.ts` dispatches on `--source=openfec` and reads
  `FEC_API_KEY` from env.
- [ ] No contributor PII (address, ZIP, employer) appears in any tool
  response (confirmed by the `recent_contributions` PII test and
  manual review of `ContributionSummary`).
- [ ] `src/adapters/openfec.ts` uses `z.iso.datetime()` and `z.url()`
  (verify by grepping for `z.string().datetime` and `z.string().url` —
  should return no matches in the new file).
- [ ] No `json_extract` calls use LIKE (all use `=` on the extracted
  value — grep for `json_extract.*LIKE`; expect no matches).
- [ ] `documents.source_name = "openfec"` for all ingested rows (verify
  via a quick SQLite query after a test run).
- [ ] Commit history is clean: one commit per task, messages match the
  exact strings in the plan.

---

## Self-review

### Design calls worth flagging for human review

1. **`titleCase()` as the FEC→Congress bridge.** The entire cross-source
   merge depends on `"SMITH, JOHN R."` → `titleCase()` → `"Smith, John
   R."` producing the same `normalizeName()` output as Congress.gov's
   `"Smith, John R."`. This is fragile to cases where Congress.gov uses
   a different canonical form (e.g., `"Smith, John"` without the middle
   initial, or `"Smith, John Robert"`). The under-match bias means these
   cases produce two rows rather than a false merge — which is correct
   but worth noting. If the operator sees excessive splits after a live
   run, adding `fec_candidate` ID → bioguide mapping via a small lookup
   table is the clean fix (Phase 5 work).

2. **Schedule A/B cursor pagination vs. page pagination.** The adapter
   uses page-number pagination for `/candidates/search` and `/committees`
   and cursor-based pagination for `/schedules/schedule_a` and
   `/schedules/schedule_b`. The cursor logic has more branching than the
   page logic and deserves extra test coverage. The unit tests cover the
   single-page case (via `noPagination`); multi-page cursor behavior is
   not tested. Adding a multi-page cursor unit test is recommended before
   the first live run.

3. **`expenditure` recipient entity kind.** Expenditure payees are
   typically vendors (`"ABC MEDIA LLC"`), not registered political
   entities. The adapter upserts them as `kind='organization'` with
   `jurisdiction='us-federal'`. This will populate the entity store with
   many vendor Organizations that are only relevant to finance data.
   Phase 5's `search_entities` jurisdiction filter partially mitigates
   query noise — but if vendor entity clutter becomes a UX problem, a
   `kind='vendor'` addition to `EntityKind` (with a schema migration) is
   the right fix. Flagged for Phase 5 planning.

4. **`min_amount` is post-query filtering.** The handler fetches up to
   200 contributions then applies `min_amount` in-process. For large
   datasets this wastes a fetch. A future optimization pushes `min_amount`
   into the SQL `WHERE raw->>'amount' >= ?` clause via a generated
   column or JSON extract. Not urgent for V1 but noted here.

5. **Rate limiter default (15 req/min).** The plan sets
   `tokensPerInterval: 15` (900/hour). The OpenFEC documented limit is
   1,000/hour. This is conservative. If full-cycle ingestion is too slow
   in practice, bumping to 20 req/min (1,200/hour — slightly over but
   with burst tolerance) is a one-line change in the adapter constructor.
   The conservative default is the right call for initial deployment.

### What this phase ships

- `src/adapters/openfec.ts` — federal campaign finance adapter fetching
  candidates, committees, Schedule A contributions, and Schedule B
  expenditures.
- `src/mcp/tools/recent_contributions.ts` + `RecentContributionsInput`
  schema — the `recent_contributions` tool (6th registered tool).
- Cross-source merge path: FEC candidate + Congress.gov Person collapse
  to a single entity via normalized-name matching, carrying both
  `fec_candidate` and `bioguide` external IDs and all historical roles.
- `get_entity` extended with `fec.gov` source URL branches.
- Refresh CLI extended with `--source=openfec` (reads `FEC_API_KEY`).
- Server bumped to `v0.0.4`.
- Contributor PII (address, ZIP, employer) stored in `Document.raw` for
  aggregate queries, never exposed through any tool response.

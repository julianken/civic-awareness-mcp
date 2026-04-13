# Phase 3 — Congress.gov Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Prerequisite:** Phase 2 complete (`docs/plans/phase-2-openstates.md`
all checkboxes green).

**Goal:** Ingest U.S. federal legislative data from `api.congress.gov/v3`
into the same entity/document store as Phase 2. Ship the `recent_votes`
tool. Cross-link Members of Congress who previously served as state
legislators into a single cross-jurisdiction `Person` entity. Extend the
refresh CLI to dispatch on `--source=congress`.

**Architecture:** One new adapter (`src/adapters/congress.ts`), one new
tool (`src/mcp/tools/recent_votes.ts`), one new zod schema
(`RecentVotesInput`), modifications to `src/cli/refresh.ts` and
`src/mcp/server.ts`. No schema migrations — `us-federal` is already
seeded by Phase 1 (`src/core/seeds.ts`). Everything reads from and
writes to the same `entities` / `documents` / `document_references`
tables established in Phase 1.

**Load-bearing sub-decisions (from `docs/roadmap.md` Phase 3):**
- **Historical Congresses:** current (119th) + prior (118th). Full
  history deferred. The adapter accepts a `congresses` option
  defaulting to `[119, 118]`.
- **Cross-source merge:** tolerate under-match per R11 / D3b; never
  force a merge on name alone.
- **Federal votes:** `Document` of `kind='vote'`, each voter an
  `EntityReference` with `role='voter'` and `qualifier='yea'|'nay'|'present'`.

**API key prerequisite:** User must have a Congress.gov API key from
https://api.data.gov/signup/ (same registration as OpenFEC). Store it
in `.env.local` (gitignored) as `API_DATA_GOV_KEY=...`.

**Rate limit:** ~5,000 requests/hour with key (far more generous than
OpenStates). The adapter defaults to 80 requests per 60 s (well under
the per-hour cap; no daily cap concern).

---

## File structure produced by this phase

```
src/
├── adapters/
│   └── congress.ts                     ← Task 2
├── cli/
│   └── refresh.ts                      (modified in Task 3)
├── mcp/
│   ├── server.ts                       (modified in Task 5)
│   ├── schemas.ts                      (modified in Task 4)
│   └── tools/
│       ├── recent_votes.ts             ← Task 4
│       └── recent_bills.ts             (comment-updated in Task 5)
tests/
├── unit/
│   └── adapters/
│       └── congress.test.ts            ← Task 2
│   └── mcp/
│       └── tools/
│           └── recent_votes.test.ts    ← Task 4
└── integration/
    ├── congress-e2e.test.ts            ← Task 6
    └── fixtures/
        ├── congress-bills-page1.json   ← Task 6
        ├── congress-members-page1.json ← Task 6
        └── congress-votes-page1.json   ← Task 6
```

---

## Prerequisites

Before executing this phase:

- Phase 2 all checkboxes green, test suite green.
- `API_DATA_GOV_KEY` present in `.env.local`.
- `pnpm test` passes with no failures.

---

## Task 1: Verify `us-federal` seeding (no migration needed)

**Files:** `src/core/seeds.ts` (read-only verification),
`tests/unit/core/seeds.test.ts` (add one assertion)

The `jurisdictions` table already seeds `us-federal` in Phase 1. This
task verifies that assertion so Phase 3 never gets a foreign-key error
when inserting `jurisdiction = 'us-federal'` on a federal `Document`.

- [ ] **Step 1.1: Confirm `us-federal` is already seeded**

Read `src/core/seeds.ts` and check for `us-federal`. Expected: the
seeds function already inserts `{ id: 'us-federal', level: 'federal',
name: 'United States (Federal)' }` (or similar). If it does not, add it
before continuing.

```bash
grep -n "us-federal" src/core/seeds.ts
```

Expected output: at least one line matching. If missing, open
`src/core/seeds.ts` and add:

```ts
db.prepare(
  "INSERT OR IGNORE INTO jurisdictions (id, level, name) VALUES (?, ?, ?)",
).run("us-federal", "federal", "United States (Federal)");
```

- [ ] **Step 1.2: Add a seed-coverage assertion to the store test**

In `tests/unit/core/store.test.ts`, add one `it` inside the existing
`describe("openStore")` block (after the existing tests; do not
restructure):

```ts
it("us-federal jurisdiction is seeded after seedJurisdictions()", () => {
  const s = openStore(TEST_DB);
  const { seedJurisdictions } = await import("../../../src/core/seeds.js");
  seedJurisdictions(s.db);
  const row = s.db
    .prepare("SELECT id, level FROM jurisdictions WHERE id = 'us-federal'")
    .get() as { id: string; level: string } | undefined;
  expect(row?.id).toBe("us-federal");
  expect(row?.level).toBe("federal");
  s.close();
});
```

Because this is inside a Vitest `describe` block with an `afterEach`
cleanup, the `openStore` call uses the same `TEST_DB` constant already
defined at the top of the file. The dynamic import is needed because
`seedJurisdictions` is not imported at the top of that test file.

**Alternative without dynamic import:** if `seedJurisdictions` is
already imported at the top of `store.test.ts`, remove `await import`
and call it directly.

- [ ] **Step 1.3: Run test and commit**

```bash
pnpm test tests/unit/core/store.test.ts
git add src/core/seeds.ts tests/unit/core/store.test.ts
git commit -m "test: assert us-federal jurisdiction is seeded"
```

---

## Task 2: Congress.gov adapter

**Files:** `src/adapters/congress.ts`,
`tests/unit/adapters/congress.test.ts`

This is the largest task. The adapter fetches `/bill`, `/member`, and
`/votes` endpoints, normalizes them into `Entity` and `Document` rows
using the same `upsertEntity` / `upsertDocument` functions as
`openstates.ts`, and applies the cross-source merge heuristic from
`docs/04-entity-schema.md` step 1–4.

**Congress.gov API shape (key fields):**

`GET /member?congress=119&limit=250`:
```json
{
  "members": [
    {
      "bioguideId": "S000148",
      "name": "Schumer, Charles E.",
      "partyName": "Democrat",
      "state": "NY",
      "district": null,
      "terms": { "item": [{ "chamber": "Senate", "startYear": 1999, "endYear": null }] }
    }
  ],
  "pagination": { "count": 535, "next": "https://..." }
}
```

`GET /bill?congress=119&limit=250`:
```json
{
  "bills": [
    {
      "congress": 119,
      "type": "HR",
      "number": "1234",
      "title": "A bill to...",
      "introducedDate": "2025-01-15",
      "updateDate": "2025-03-01",
      "url": "https://api.congress.gov/v3/bill/119/hr/1234",
      "sponsors": [{ "bioguideId": "S000148", "fullName": "Sen. Charles E. Schumer [D-NY]" }],
      "latestAction": { "actionDate": "2025-03-01", "text": "Passed Senate" }
    }
  ],
  "pagination": { "count": 12000, "next": "https://..." }
}
```

`GET /vote?congress=119&limit=250` (roll-call votes):
```json
{
  "votes": [
    {
      "congress": 119,
      "chamber": "House",
      "rollNumber": 42,
      "date": "2025-02-10",
      "question": "On Passage",
      "result": "Passed",
      "bill": { "type": "HR", "number": "1234" },
      "positions": [
        { "member": { "bioguideId": "S000148", "name": "Schumer, Charles E." }, "votePosition": "Yea" }
      ],
      "totals": { "yea": 218, "nay": 210, "present": 0, "notVoting": 7 }
    }
  ],
  "pagination": { "count": 340, "next": "https://..." }
}
```

**Cross-source merge rule (from `docs/04-entity-schema.md`):**
Step 1 (external-ID match on `bioguide`) fires first. If a Member's
bioguide ID is already present on an OpenStates-sourced `Person`
(possible only if a prior adapter run already merged them), we get a
free match. If not found by external ID, step 3 (exact normalized-name
match) fires — `upsertEntity` in `entities.ts` already implements both.
We do NOT add new code to force fuzzy merges for Members of Congress:
the existing `upsertEntity` function is sufficient.

**Design note on `upsertEntity` and metadata.roles[]:**
`upsertEntity` currently only merges `external_ids` and `aliases` on an
existing entity; it does not merge `metadata`. For cross-source Person
merge to surface federal roles alongside state roles in
`metadata.roles[]`, we need to update the metadata on match. The
adapter handles this explicitly: after calling `upsertEntity`, if the
returned entity already existed and the adapter is adding a new role
not yet in `metadata.roles[]`, the adapter issues a targeted UPDATE to
append the new role. This is a surgical addition — do not refactor
`upsertEntity` itself.

- [ ] **Step 2.1: Write unit tests (4 required, 1 optional)**

`tests/unit/adapters/congress.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { upsertEntity } from "../../../src/core/entities.js";
import { CongressAdapter } from "../../../src/adapters/congress.js";

const TEST_DB = "./data/test-congress.db";
let store: Store;

// ── Minimal fixture data ──────────────────────────────────────────────

const SAMPLE_MEMBER = {
  bioguideId: "S000148",
  name: "Schumer, Charles E.",
  partyName: "Democrat",
  state: "NY",
  district: null,
  terms: { item: [{ chamber: "Senate", startYear: 1999, endYear: null }] },
};

const SAMPLE_BILL = {
  congress: 119,
  type: "HR",
  number: "1234",
  title: "A bill to improve civic awareness",
  introducedDate: "2025-01-15",
  updateDate: "2025-03-01T00:00:00Z",
  url: "https://api.congress.gov/v3/bill/119/hr/1234",
  sponsors: [{ bioguideId: "S000148", fullName: "Sen. Charles E. Schumer [D-NY]" }],
  latestAction: { actionDate: "2025-03-01", text: "Passed Senate" },
};

const SAMPLE_VOTE = {
  congress: 119,
  chamber: "House",
  rollNumber: 42,
  date: "2025-02-10T00:00:00Z",
  question: "On Passage",
  result: "Passed",
  bill: { type: "HR", number: "1234" },
  positions: [
    { member: { bioguideId: "S000148", name: "Schumer, Charles E." }, votePosition: "Yea" },
    { member: { bioguideId: "P000197", name: "Pelosi, Nancy" }, votePosition: "Yea" },
    { member: { bioguideId: "M001189", name: "Messer, Luke" }, votePosition: "Nay" },
  ],
  totals: { yea: 218, nay: 210, present: 0, notVoting: 7 },
};

function makeMockFetch(opts: {
  members?: object[];
  bills?: object[];
  votes?: object[];
} = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/member")) {
      return new Response(
        JSON.stringify({
          members: opts.members ?? [SAMPLE_MEMBER],
          pagination: { count: opts.members?.length ?? 1 },
        }),
        { status: 200 },
      );
    }
    if (u.includes("/vote")) {
      return new Response(
        JSON.stringify({
          votes: opts.votes ?? [SAMPLE_VOTE],
          pagination: { count: opts.votes?.length ?? 1 },
        }),
        { status: 200 },
      );
    }
    if (u.includes("/bill")) {
      return new Response(
        JSON.stringify({
          bills: opts.bills ?? [SAMPLE_BILL],
          pagination: { count: opts.bills?.length ?? 1 },
        }),
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

describe("CongressAdapter", () => {
  // ── Test 1: Member upsert ─────────────────────────────────────────
  it("upserts a Member of Congress as a Person entity with NULL jurisdiction and federal role", async () => {
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new CongressAdapter({ apiKey: "test-key" });
    const result = await adapter.refresh({ db: store.db });
    expect(result.errors).toEqual([]);
    expect(result.entitiesUpserted).toBeGreaterThan(0);

    const row = store.db
      .prepare(
        "SELECT name, external_ids, jurisdiction, metadata FROM entities WHERE kind = 'person'",
      )
      .get() as { name: string; external_ids: string; jurisdiction: string | null; metadata: string };

    // Name is stored as returned by Congress.gov (canonical form).
    expect(row.name).toBe("Schumer, Charles E.");
    expect(JSON.parse(row.external_ids).bioguide).toBe("S000148");

    // D3b: Persons are cross-jurisdiction — jurisdiction column NULL.
    expect(row.jurisdiction).toBeNull();

    // Federal role recorded in metadata.roles[].
    const meta = JSON.parse(row.metadata) as { roles?: Array<{ jurisdiction: string; role: string }> };
    expect(meta.roles?.some((r) => r.jurisdiction === "us-federal")).toBe(true);
    expect(meta.roles?.some((r) => r.role === "senator" || r.role === "representative")).toBe(true);
  });

  // ── Test 2: Bill upsert with sponsor reference ────────────────────
  it("upserts a federal bill as a Document with sponsor EntityReference", async () => {
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new CongressAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db });

    const doc = store.db
      .prepare(
        "SELECT title, kind, jurisdiction, source_name FROM documents WHERE kind = 'bill'",
      )
      .get() as { title: string; kind: string; jurisdiction: string; source_name: string };

    expect(doc.kind).toBe("bill");
    expect(doc.jurisdiction).toBe("us-federal");
    expect(doc.source_name).toBe("congress");

    // Title format: "HR1234 — A bill to improve civic awareness"
    expect(doc.title).toMatch(/^HR1234 — /);

    // Sponsor reference recorded.
    const refCount = (
      store.db.prepare("SELECT COUNT(*) c FROM document_references WHERE role = 'sponsor'").get() as { c: number }
    ).c;
    expect(refCount).toBeGreaterThan(0);
  });

  // ── Test 3: Cross-source Person merge ─────────────────────────────
  it("merges a Member of Congress into an existing OpenStates Person when the bioguide external_id already links them", async () => {
    // Seed a Person row as if OpenStates had already ingested this
    // legislator under their state-legislator role, WITH the bioguide
    // ID pre-set (simulates a case where OpenStates provides the
    // bioguide ID, or a prior adapter run already merged them).
    const { entity: existing } = upsertEntity(store.db, {
      kind: "person",
      name: "Schumer, Charles E.",
      jurisdiction: undefined,
      external_ids: {
        openstates_person: "ocd-person/ny-schumer",
        bioguide: "S000148",   // <-- linking signal: same bioguide
      },
      metadata: {
        roles: [
          { jurisdiction: "us-ny", role: "state_legislator", from: "1981-01-01", to: "1999-01-03" },
        ],
      },
    });

    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new CongressAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db });

    // Exactly ONE Person row must exist — the adapter merged, not split.
    const personCount = (
      store.db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'person'").get() as { c: number }
    ).c;
    expect(personCount).toBe(1);

    // The merged row must retain both external IDs.
    const row = store.db
      .prepare("SELECT external_ids, metadata FROM entities WHERE id = ?")
      .get(existing.id) as { external_ids: string; metadata: string };
    const extIds = JSON.parse(row.external_ids);
    expect(extIds.openstates_person).toBe("ocd-person/ny-schumer");
    expect(extIds.bioguide).toBe("S000148");

    // The merged row must have BOTH roles in metadata.roles[].
    const meta = JSON.parse(row.metadata) as { roles?: Array<{ role: string; jurisdiction: string }> };
    const jurisdictions = (meta.roles ?? []).map((r) => r.jurisdiction);
    expect(jurisdictions).toContain("us-ny");
    expect(jurisdictions).toContain("us-federal");
  });

  // ── Test 4: Vote document with voter references ───────────────────
  it("upserts a roll-call vote as a Document with yea/nay voter EntityReferences", async () => {
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new CongressAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db });

    const voteDoc = store.db
      .prepare("SELECT id, title, kind, raw FROM documents WHERE kind = 'vote'")
      .get() as { id: string; title: string; kind: string; raw: string } | undefined;
    expect(voteDoc).toBeDefined();
    expect(voteDoc!.kind).toBe("vote");

    const raw = JSON.parse(voteDoc!.raw) as {
      result: string;
      totals: { yea: number; nay: number };
    };
    expect(raw.result).toBe("Passed");
    expect(raw.totals.yea).toBe(218);

    // Each voter is a document_references row with role='voter' and
    // qualifier='yea' or 'nay'. Check at least the Yea voters are there.
    const voters = store.db
      .prepare(
        "SELECT qualifier FROM document_references WHERE document_id = ? AND role = 'voter'",
      )
      .all(voteDoc!.id) as Array<{ qualifier: string }>;
    expect(voters.length).toBeGreaterThan(0);
    const qualifiers = voters.map((v) => v.qualifier);
    expect(qualifiers).toContain("yea");
    expect(qualifiers).toContain("nay");
  });

  // ── Test 5 (optional): Rate-limit resilience ─────────────────────
  it("surfaces errors cleanly when Congress.gov returns a 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("Too Many Requests", { status: 429 }),
    );
    const adapter = new CongressAdapter({ apiKey: "test-key" });
    const result = await adapter.refresh({ db: store.db });
    // The adapter catches the error and reports it; it does not throw.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/429/);
  });
});
```

- [ ] **Step 2.2: Run tests to confirm failure**

```bash
pnpm test tests/unit/adapters/congress.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 2.3: Implement `src/adapters/congress.ts`**

```ts
import type Database from "better-sqlite3";
import { rateLimitedFetch, RateLimiter } from "../util/http.js";
import { upsertEntity } from "../core/entities.js";
import { upsertDocument } from "../core/documents.js";
import { logger } from "../util/logger.js";
import type { Adapter, AdapterOptions, RefreshResult } from "./base.js";

const BASE_URL = "https://api.congress.gov/v3";

// ── API types (minimal — only fields we use) ─────────────────────────

interface CongressMember {
  bioguideId: string;
  name: string;
  partyName?: string;
  state?: string;
  district?: number | null;
  terms?: { item?: Array<{ chamber: string; startYear?: number; endYear?: number | null }> };
}

interface CongressSponsor {
  bioguideId?: string;
  fullName?: string;
}

interface CongressBill {
  congress: number;
  type: string;
  number: string;
  title: string;
  introducedDate?: string;
  updateDate?: string;
  url: string;
  sponsors?: CongressSponsor[];
  latestAction?: { actionDate?: string; text?: string };
}

interface CongressVotePosition {
  member: { bioguideId: string; name: string };
  votePosition: string;  // "Yea" | "Nay" | "Present" | "Not Voting"
}

interface CongressVote {
  congress: number;
  chamber: string;
  rollNumber: number;
  date: string;
  question?: string;
  result?: string;
  bill?: { type: string; number: string };
  positions?: CongressVotePosition[];
  totals?: { yea?: number; nay?: number; present?: number; notVoting?: number };
}

interface PaginatedMembers {
  members?: CongressMember[];
  pagination?: { count?: number; next?: string };
}

interface PaginatedBills {
  bills?: CongressBill[];
  pagination?: { count?: number; next?: string };
}

interface PaginatedVotes {
  votes?: CongressVote[];
  pagination?: { count?: number; next?: string };
}

export interface CongressAdapterOptions {
  apiKey: string;
  /**
   * Which Congresses to fetch. Defaults to [119, 118] per the Phase 3
   * load-bearing sub-decision (current + prior; full history deferred).
   */
  congresses?: number[];
  rateLimiter?: RateLimiter;
}

// ── Normalisation helpers ─────────────────────────────────────────────

/** "HR" + "1234" → "HR1234". Follows Congress.gov bill-type casing. */
function billIdentifier(type: string, number: string): string {
  return `${type.toUpperCase()}${number}`;
}

/** Map Congress.gov "Senate"/"House" → our EntityReference role qualifier. */
function chamberToRole(chamber: string): "senator" | "representative" {
  return chamber.toLowerCase().includes("senate") ? "senator" : "representative";
}

/** Map Congress.gov votePosition string → lowercase qualifier. */
function normalizeVotePosition(pos: string): string {
  const lower = pos.toLowerCase().replace(/\s+/g, "_");
  // Map "not_voting" → "not_voting", "present" → "present", etc.
  if (lower === "yea") return "yea";
  if (lower === "nay") return "nay";
  if (lower === "present") return "present";
  return "not_voting";
}

/** Build a human-facing URL for a bill on congress.gov. */
function billUrl(congress: number, type: string, number: string): string {
  // e.g. https://www.congress.gov/bill/119th-congress/house-bill/1234
  const typeSuffix = type.toLowerCase() === "hr"
    ? "house-bill"
    : type.toLowerCase() === "s"
    ? "senate-bill"
    : `${type.toLowerCase()}-resolution`;
  return `https://www.congress.gov/bill/${congress}th-congress/${typeSuffix}/${number}`;
}

/** Build a human-facing URL for a roll-call vote on congress.gov. */
function voteUrl(congress: number, chamber: string, rollNumber: number): string {
  const ch = chamber.toLowerCase().includes("senate") ? "senate" : "house";
  return `https://www.congress.gov/roll-call-votes/${congress}/${ch}/${rollNumber}`;
}

// ── Adapter ───────────────────────────────────────────────────────────

export class CongressAdapter implements Adapter {
  readonly name = "congress";
  private readonly rateLimiter: RateLimiter;
  private readonly congresses: number[];

  constructor(private readonly opts: CongressAdapterOptions) {
    this.rateLimiter =
      opts.rateLimiter ?? new RateLimiter({ tokensPerInterval: 80, intervalMs: 60_000 });
    this.congresses = opts.congresses ?? [119, 118];
  }

  /**
   * Refresh federal members, bills, and votes from api.congress.gov.
   *
   * Congress.gov does not require a `jurisdiction` parameter (it is
   * always `us-federal`). The `AdapterOptions.jurisdiction` field is
   * ignored if supplied.
   */
  async refresh(options: AdapterOptions): Promise<RefreshResult> {
    const result: RefreshResult = {
      source: this.name,
      entitiesUpserted: 0,
      documentsUpserted: 0,
      errors: [],
    };

    try {
      // 1. Fetch and upsert all Members first so bills can reference them.
      for (const congress of this.congresses) {
        const members = await this.fetchAllPages<CongressMember, PaginatedMembers>(
          `/member?congress=${congress}&limit=250`,
          (body) => body.members ?? [],
          (body) => body.pagination?.next,
          options.maxPages,
        );
        for (const m of members) {
          this.upsertMember(options.db, m);
          result.entitiesUpserted += 1;
        }
      }

      // 2. Fetch bills.
      for (const congress of this.congresses) {
        const bills = await this.fetchAllPages<CongressBill, PaginatedBills>(
          `/bill?congress=${congress}&limit=250`,
          (body) => body.bills ?? [],
          (body) => body.pagination?.next,
          options.maxPages,
        );
        for (const b of bills) {
          this.upsertBill(options.db, b);
          result.documentsUpserted += 1;
        }
      }

      // 3. Fetch votes (roll calls).
      for (const congress of this.congresses) {
        const votes = await this.fetchAllPages<CongressVote, PaginatedVotes>(
          `/vote?congress=${congress}&limit=250`,
          (body) => body.votes ?? [],
          (body) => body.pagination?.next,
          options.maxPages,
        );
        for (const v of votes) {
          this.upsertVote(options.db, v);
          result.documentsUpserted += 1;
        }
      }
    } catch (err) {
      const msg = String(err);
      logger.error("congress refresh failed", { error: msg });
      result.errors.push(msg);
    }

    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async fetchAllPages<T, B>(
    firstPath: string,
    extract: (body: B) => T[],
    nextUrl: (body: B) => string | undefined,
    maxPages: number | undefined,
  ): Promise<T[]> {
    const all: T[] = [];
    let url: string | undefined = `${BASE_URL}${firstPath}`;
    let page = 0;

    while (url) {
      // Append the API key as a query parameter (Congress.gov convention).
      const reqUrl = new URL(url);
      reqUrl.searchParams.set("api_key", this.opts.apiKey);

      const res = await rateLimitedFetch(reqUrl.toString(), {
        userAgent: "civic-awareness-mcp/0.0.1 (+github)",
        rateLimiter: this.rateLimiter,
      });
      if (!res.ok) throw new Error(`Congress.gov ${firstPath} returned ${res.status}`);
      const body = (await res.json()) as B;
      all.push(...extract(body));
      page += 1;
      if (maxPages && page >= maxPages) break;
      url = nextUrl(body);
    }

    return all;
  }

  private upsertMember(db: Database.Database, m: CongressMember): string {
    // Determine chamber and role from the most recent term.
    const latestTerm = m.terms?.item?.at(-1);
    const chamber = latestTerm?.chamber ?? "unknown";
    const role = chamberToRole(chamber);
    const startYear = latestTerm?.startYear;
    const endYear = latestTerm?.endYear ?? null;

    const newRole = {
      jurisdiction: "us-federal",
      role,
      from: startYear ? `${startYear}-01-03T00:00:00.000Z` : undefined,
      to: endYear ? `${endYear}-01-03T00:00:00.000Z` : null,
    };

    const { entity, created } = upsertEntity(db, {
      kind: "person",
      name: m.name,
      jurisdiction: undefined,  // D3b: Persons are cross-jurisdiction
      external_ids: { bioguide: m.bioguideId },
      metadata: {
        party: m.partyName,
        state: m.state,
        chamber: role,
        roles: [newRole],
      },
    });

    // If the entity already existed (cross-source merge or re-refresh),
    // merge the new role into metadata.roles[] without overwriting any
    // existing roles. upsertEntity only merges external_ids and aliases;
    // we handle metadata.roles[] here explicitly.
    if (!created) {
      const existing = db
        .prepare("SELECT metadata FROM entities WHERE id = ?")
        .get(entity.id) as { metadata: string };
      const meta = JSON.parse(existing.metadata) as { roles?: typeof newRole[] };
      const currentRoles = meta.roles ?? [];
      const alreadyHasFederalRole = currentRoles.some(
        (r) => r.jurisdiction === "us-federal" && r.role === role,
      );
      if (!alreadyHasFederalRole) {
        const updatedRoles = [...currentRoles, newRole];
        const updatedMeta = { ...meta, roles: updatedRoles };
        db.prepare("UPDATE entities SET metadata = ? WHERE id = ?").run(
          JSON.stringify(updatedMeta),
          entity.id,
        );
      }
    }

    return entity.id;
  }

  private upsertBill(db: Database.Database, b: CongressBill): void {
    const identifier = billIdentifier(b.type, b.number);
    const occurred = b.updateDate ?? b.introducedDate ?? new Date().toISOString();
    // Ensure the date is ISO 8601 with time component.
    const occurredAt = occurred.includes("T") ? occurred : `${occurred}T00:00:00.000Z`;
    const humanUrl = billUrl(b.congress, b.type, b.number);

    // Resolve sponsors to entity IDs.
    const refs = (b.sponsors ?? []).map((s) => {
      let entityId: string;
      if (s.bioguideId) {
        // Fast path: sponsor has a bioguide ID — look up by external_id.
        const existing = db
          .prepare(
            "SELECT id FROM entities WHERE json_extract(external_ids, '$.\"bioguide\"') = ? LIMIT 1",
          )
          .get(s.bioguideId) as { id: string } | undefined;
        if (existing) {
          entityId = existing.id;
        } else {
          // Member not yet in store (can happen if members pagination
          // was limited). Create a minimal Person.
          const { entity } = upsertEntity(db, {
            kind: "person",
            name: s.fullName ?? s.bioguideId,
            jurisdiction: undefined,
            external_ids: { bioguide: s.bioguideId },
          });
          entityId = entity.id;
        }
      } else {
        // Bare-name fallback (should be rare with Congress.gov data).
        const { entity } = upsertEntity(db, {
          kind: "person",
          name: s.fullName ?? "Unknown",
          jurisdiction: undefined,
        });
        entityId = entity.id;
      }
      return { entity_id: entityId, role: "sponsor" as const };
    });

    const latestActionDate = b.latestAction?.actionDate;
    const latestActionText = b.latestAction?.text;

    upsertDocument(db, {
      kind: "bill",
      jurisdiction: "us-federal",
      title: `${identifier} — ${b.title}`,
      occurred_at: occurredAt,
      source: {
        name: "congress",
        id: `${b.congress}-${b.type.toLowerCase()}-${b.number}`,
        url: humanUrl,
      },
      references: refs,
      raw: {
        congress: b.congress,
        billType: b.type,
        billNumber: b.number,
        introducedDate: b.introducedDate,
        latestAction: latestActionDate
          ? { date: latestActionDate, description: latestActionText ?? "" }
          : null,
      },
    });
  }

  private upsertVote(db: Database.Database, v: CongressVote): void {
    const occurred = v.date.includes("T") ? v.date : `${v.date}T00:00:00.000Z`;
    const billId = v.bill ? billIdentifier(v.bill.type, v.bill.number) : "unknown";
    const title = `Vote ${v.congress}-${v.chamber}-${v.rollNumber}: ${billId} — ${v.question ?? ""}`;
    const humanUrl = voteUrl(v.congress, v.chamber, v.rollNumber);

    // Each voter is an EntityReference with role='voter' and
    // qualifier equal to the normalised vote position.
    // We wrap this in a transaction because we may create/lookup many
    // Person entities before calling upsertDocument. Without a
    // transaction, a crash mid-loop would leave orphaned entity rows
    // that have no corresponding document reference.
    //
    // NOTE: upsertDocument itself is already wrapped in db.transaction;
    // SQLite supports nested transactions via savepoints when using
    // better-sqlite3, but we don't need nesting here — the member
    // upserts below are pure INSERTs/SELECTs and do not need the same
    // atomicity as the document write. We therefore collect refs first,
    // then call upsertDocument (which handles its own transaction).
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
      },
    });
  }
}
```

- [ ] **Step 2.4: Run tests and confirm green**

```bash
pnpm test tests/unit/adapters/congress.test.ts
pnpm typecheck
```

Expected: 5 tests pass, no type errors.

- [ ] **Step 2.5: Commit**

```bash
git add src/adapters/congress.ts tests/unit/adapters/congress.test.ts
git commit -m "feat: Congress.gov adapter for federal bills, legislators, and votes"
```

---

## Task 3: Extend the refresh CLI

**Files:** `src/cli/refresh.ts` (modify in place)

The existing `src/cli/refresh.ts` exits with `process.exit(1)` for any
`--source` other than `openstates`. This task extends that dispatch so
`--source=congress` invokes `CongressAdapter.refresh()` once (federal is
a singleton — no jurisdiction iteration loop).

- [ ] **Step 3.1: Write a CLI smoke test**

`tests/unit/cli/refresh.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { CongressAdapter } from "../../../src/adapters/congress.js";

// This test validates the dispatch logic in isolation, not the full
// CLI (which uses process.argv). We test the handler function exported
// by the module rather than the CLI entry point.
//
// Specifically: the CLI, when source=congress, should create exactly
// ONE CongressAdapter and call refresh() once with no jurisdiction.
//
// We test this by checking that a minimal in-process simulation
// (same logic as main()) writes congress-sourced documents.

const TEST_DB = "./data/test-refresh-congress.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  vi.spyOn(global, "fetch").mockImplementation(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/member"))
      return new Response(
        JSON.stringify({ members: [], pagination: { count: 0 } }),
        { status: 200 },
      );
    if (u.includes("/bill"))
      return new Response(
        JSON.stringify({ bills: [], pagination: { count: 0 } }),
        { status: 200 },
      );
    if (u.includes("/vote"))
      return new Response(
        JSON.stringify({ votes: [], pagination: { count: 0 } }),
        { status: 200 },
      );
    return new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

describe("refresh CLI — congress source", () => {
  it("runs CongressAdapter.refresh() with no jurisdiction and returns no errors", async () => {
    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.refresh({ db: store.db, maxPages: 1 });
    expect(result.source).toBe("congress");
    expect(result.errors).toEqual([]);
  });

  it("does not call fetch with a state-abbreviation path segment", async () => {
    const mockFetch = vi.mocked(global.fetch);
    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    await adapter.refresh({ db: store.db, maxPages: 1 });
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    // Congress.gov URLs should never contain a 2-letter state abbr path segment.
    expect(urls.every((u) => !/\/[a-z]{2}\//.test(u))).toBe(true);
  });
});
```

- [ ] **Step 3.2: Run the test to confirm it passes (uses CongressAdapter directly)**

```bash
pnpm test tests/unit/cli/refresh.test.ts
```

Expected: PASS (test uses CongressAdapter directly, no CLI import yet).

- [ ] **Step 3.3: Update `src/cli/refresh.ts`**

Replace the block starting at `if (args.source !== "openstates")` with
the full dispatch below. Keep all existing imports and the `parseArgs` /
`listStateJurisdictions` helpers unchanged.

```ts
import { openStore } from "../core/store.js";
import { seedJurisdictions } from "../core/seeds.js";
import { OpenStatesAdapter } from "../adapters/openstates.js";
import { CongressAdapter } from "../adapters/congress.js";
import { requireEnv, optionalEnv } from "../util/env.js";
import { logger } from "../util/logger.js";

interface Args {
  source: string;
  maxPages?: number;
  /** Comma-separated state codes (e.g. "tx,ca"). If omitted, iterate
   *  all state jurisdictions from the jurisdictions table. */
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

  if (args.source === "congress") {
    // Federal is a singleton — no jurisdiction iteration.
    // The API_DATA_GOV_KEY must be set in env or .env.local.
    const adapter = new CongressAdapter({
      apiKey: requireEnv("API_DATA_GOV_KEY"),
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
    // NOTE: OpenStates free tier is 500 requests/day. See the
    // note in Phase 2 refresh.ts for backfill and resumability guidance.
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
    logger.error("unknown source; valid values: openstates, congress", { source: args.source });
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
git commit -m "feat: extend refresh CLI to dispatch --source=congress"
```

---

## Task 4: `recent_votes` tool

**Files:** `src/mcp/schemas.ts` (add `RecentVotesInput`),
`src/mcp/tools/recent_votes.ts`,
`tests/unit/mcp/tools/recent_votes.test.ts`

Spec: `docs/05-tool-surface.md` → `recent_votes` (Phase 3).

Input: `jurisdiction` (required), `days` (default 7, max 90),
`chamber?`, `bill_identifier?`.

Output: `ToolResponse<VoteSummary>` where `VoteSummary` has
`id, bill_identifier, chamber, date, result, tally, source_url`.

The handler queries `documents` for `kind='vote'` within the window,
reads `tally` from `raw.totals`, and extracts `bill_identifier` and
`result` from `raw`. It does NOT join `document_references` — the
per-voter references are stored for `entity_activity` / Phase 5 graph
queries, but the tool response is a summary only.

- [ ] **Step 4.1: Write the test**

`tests/unit/mcp/tools/recent_votes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleRecentVotes } from "../../../../src/mcp/tools/recent_votes.js";

const TEST_DB = "./data/test-tool-recent-votes.db";
let store: Store;

const RECENT = new Date().toISOString();
const OLD = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

function seedVote(id: string, occurred: string, chamber: string, billId: string, result: string) {
  upsertDocument(store.db, {
    kind: "vote",
    jurisdiction: "us-federal",
    title: `Vote 119-${chamber}-${id}: ${billId} — On Passage`,
    occurred_at: occurred,
    source: {
      name: "congress",
      id: `vote-119-${chamber.toLowerCase()}-${id}`,
      url: `https://www.congress.gov/roll-call-votes/119/${chamber.toLowerCase()}/${id}`,
    },
    raw: {
      congress: 119,
      chamber,
      rollNumber: parseInt(id, 10),
      question: "On Passage",
      result,
      bill: { type: "HR", number: billId.replace("HR", "") },
      totals: { yea: 218, nay: 210, present: 2, notVoting: 5 },
    },
  });
}

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  // Seed a Member of Congress as a Person.
  upsertEntity(store.db, {
    kind: "person",
    name: "Schumer, Charles E.",
    jurisdiction: undefined,
    external_ids: { bioguide: "S000148" },
    metadata: {
      roles: [{ jurisdiction: "us-federal", role: "senator", from: "1999-01-03T00:00:00.000Z", to: null }],
    },
  });

  // Two recent votes, one old vote, one in a different chamber.
  seedVote("42", RECENT, "House", "HR1234", "Passed");
  seedVote("43", RECENT, "Senate", "S567", "Failed");
  seedVote("10", OLD, "House", "HR99", "Passed");     // outside window
});
afterEach(() => store.close());

describe("recent_votes tool", () => {
  it("returns only votes within the time window", async () => {
    const result = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    expect(result.results).toHaveLength(2);
  });

  it("filters by chamber", async () => {
    const result = await handleRecentVotes(store.db, {
      jurisdiction: "us-federal",
      days: 7,
      chamber: "upper",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].chamber).toBe("Senate");
  });

  it("filters by bill_identifier", async () => {
    const result = await handleRecentVotes(store.db, {
      jurisdiction: "us-federal",
      days: 7,
      bill_identifier: "HR1234",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].bill_identifier).toBe("HR1234");
  });

  it("returns tally from raw.totals", async () => {
    const result = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    const vote = result.results.find((v) => v.bill_identifier === "HR1234");
    expect(vote?.tally.yea).toBe(218);
    expect(vote?.tally.nay).toBe(210);
    expect(vote?.tally.present).toBe(2);
    expect(vote?.tally.absent).toBe(5);
  });

  it("includes result field", async () => {
    const result = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    const passed = result.results.find((v) => v.bill_identifier === "HR1234");
    expect(passed?.result).toBe("Passed");
  });

  it("includes source provenance", async () => {
    const result = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    expect(result.sources).toContainEqual(
      expect.objectContaining({ name: "congress" }),
    );
  });

  it("rejects input with no jurisdiction", async () => {
    await expect(
      handleRecentVotes(store.db, { days: 7 } as unknown),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4.2: Run the test to confirm failure**

```bash
pnpm test tests/unit/mcp/tools/recent_votes.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 4.3: Add `RecentVotesInput` to `src/mcp/schemas.ts`**

Append to the existing file (do not modify existing exports):

```ts
export const RecentVotesInput = z.object({
  jurisdiction: z.string().min(1),
  days: z.number().int().min(1).max(90).default(7),
  // "upper" = Senate (federal) or upper chamber (state)
  // "lower" = House (federal) or lower chamber (state)
  chamber: z.enum(["upper", "lower"]).optional(),
  // Optional bill identifier filter, e.g. "HR1234" or "SB89".
  bill_identifier: z.string().optional(),
});
export type RecentVotesInput = z.infer<typeof RecentVotesInput>;
```

- [ ] **Step 4.4: Implement `src/mcp/tools/recent_votes.ts`**

```ts
import type Database from "better-sqlite3";
import { queryDocuments } from "../../core/documents.js";
import { RecentVotesInput } from "../schemas.js";

export interface VoteTally {
  yea: number;
  nay: number;
  present: number;
  absent: number;
}

export interface VoteSummary {
  id: string;
  bill_identifier: string;
  chamber: string;
  date: string;
  result: string;
  tally: VoteTally;
  source_url: string;
}

export interface RecentVotesResponse {
  results: VoteSummary[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  window: { from: string; to: string };
}

// Map our "upper"/"lower" chamber filter to the raw chamber strings
// stored by the congress adapter ("Senate" / "House").
const CHAMBER_MAP: Record<string, string> = {
  upper: "senate",
  lower: "house",
};

export async function handleRecentVotes(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentVotesResponse> {
  const input = RecentVotesInput.parse(rawInput);
  const to = new Date();
  const from = new Date(to.getTime() - input.days * 86400 * 1000);

  const docs = queryDocuments(db, {
    kind: "vote",
    jurisdiction: input.jurisdiction,
    from: from.toISOString(),
    to: to.toISOString(),
    limit: 200,
  });

  const chamberFilter = input.chamber ? CHAMBER_MAP[input.chamber] : undefined;

  const filtered = docs.filter((d) => {
    const raw = d.raw as {
      chamber?: string;
      bill?: { type?: string; number?: string };
    };

    if (chamberFilter) {
      const docChamber = (raw.chamber ?? "").toLowerCase();
      if (!docChamber.includes(chamberFilter)) return false;
    }

    if (input.bill_identifier) {
      const bill = raw.bill;
      if (!bill) return false;
      const docBillId = `${bill.type ?? ""}${bill.number ?? ""}`.toUpperCase();
      if (docBillId !== input.bill_identifier.toUpperCase()) return false;
    }

    return true;
  });

  const results: VoteSummary[] = filtered.map((d) => {
    const raw = d.raw as {
      chamber?: string;
      result?: string;
      bill?: { type?: string; number?: string };
      totals?: { yea?: number; nay?: number; present?: number; notVoting?: number };
    };

    const totals = raw.totals ?? {};
    const tally: VoteTally = {
      yea: totals.yea ?? 0,
      nay: totals.nay ?? 0,
      present: totals.present ?? 0,
      absent: totals.notVoting ?? 0,
    };

    const bill = raw.bill;
    const billIdentifier = bill ? `${bill.type ?? ""}${bill.number ?? ""}`.toUpperCase() : "unknown";

    return {
      id: d.id,
      bill_identifier: billIdentifier,
      chamber: raw.chamber ?? "unknown",
      date: d.occurred_at,
      result: raw.result ?? "unknown",
      tally,
      source_url: d.source.url,
    };
  });

  return {
    results,
    total: results.length,
    sources: results.length > 0 ? [{ name: "congress", url: "https://www.congress.gov/" }] : [],
    window: { from: from.toISOString(), to: to.toISOString() },
  };
}
```

- [ ] **Step 4.5: Run tests and confirm green**

```bash
pnpm test tests/unit/mcp/tools/recent_votes.test.ts
pnpm typecheck
```

Expected: 7 tests pass.

- [ ] **Step 4.6: Commit**

```bash
git add src/mcp/schemas.ts src/mcp/tools/recent_votes.ts tests/unit/mcp/tools/recent_votes.test.ts
git commit -m "feat: recent_votes MCP tool for federal roll-call votes"
```

---

## Task 5: Register `recent_votes` + update `recent_bills` description

**Files:** `src/mcp/server.ts` (modify), `src/mcp/tools/recent_bills.ts`
(comment-only update)

- [ ] **Step 5.1: Register `recent_votes` in `src/mcp/server.ts`**

Add the import and registration. The complete updated `buildServer`
function (replacing the existing one):

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openStore, type Store } from "../core/store.js";
import { handleRecentBills } from "./tools/recent_bills.js";
import { handleRecentVotes } from "./tools/recent_votes.js";
import { handleSearchEntities } from "./tools/search_entities.js";
import { handleGetEntity } from "./tools/get_entity.js";
import { handleSearchDocuments } from "./tools/search_civic_documents.js";
import {
  RecentBillsInput,
  RecentVotesInput,
  SearchEntitiesInput,
  GetEntityInput,
  SearchDocumentsInput,
} from "./schemas.js";

export interface BuildServerOptions { dbPath: string }
export interface CivicAwarenessServer { mcp: McpServer; store: Store }

export function buildServer(opts: BuildServerOptions): CivicAwarenessServer {
  const store = openStore(opts.dbPath);
  const mcp = new McpServer(
    { name: "civic-awareness-mcp", version: "0.0.3" },
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
    "search_entities",
    {
      description:
        "Search for people or organizations by name across all ingested jurisdictions " +
        "(U.S. state legislatures and federal Congress).",
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
        "state and federal offices.",
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
        "Search civic documents (U.S. state and federal bills, votes) " +
        "by title across all ingested jurisdictions.",
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

**Note:** `mcp.registerTool(name, { description, inputSchema }, cb)` is
the correct call form. Do NOT use the deprecated `mcp.tool(name, desc,
schema, cb)` four-argument form.

- [ ] **Step 5.2: Update `recent_bills.ts` description comment**

At the top of `src/mcp/tools/recent_bills.ts`, update the JSDoc comment
on `handleRecentBills` (or add one if absent) to note that it now also
accepts `jurisdiction = "us-federal"`:

```ts
/**
 * Returns recently-updated bills for the given jurisdiction.
 * As of Phase 3, also accepts `jurisdiction = "us-federal"` to query
 * federal bills ingested by the Congress.gov adapter.
 *
 * Title format is always "IDENTIFIER — TITLE" — the handler splits on
 * " — " to separate `identifier` from `title` in the response.
 */
```

No logic changes to `recent_bills.ts` are needed: `queryDocuments`
filters by `jurisdiction` already and `us-federal` is a valid value.

- [ ] **Step 5.3: Run the server test and commit**

```bash
pnpm test tests/unit/mcp/server.test.ts
pnpm typecheck
git add src/mcp/server.ts src/mcp/tools/recent_bills.ts
git commit -m "feat: register recent_votes tool and update server to v0.0.3"
```

---

## Task 6: End-to-end integration test with Congress.gov fixtures

**Files:** `tests/integration/congress-e2e.test.ts`,
`tests/integration/fixtures/congress-members-page1.json`,
`tests/integration/fixtures/congress-bills-page1.json`,
`tests/integration/fixtures/congress-votes-page1.json`

This test mirrors the pattern from
`tests/integration/openstates-e2e.test.ts`: the adapter runs against
committed fixture files (mocked via `vi.spyOn(global, "fetch")`),
then the `recent_bills` and `recent_votes` tools query the result.

- [ ] **Step 6.1: Record the fixture files**

Option A — from the live API (recommended; requires `API_DATA_GOV_KEY`):

```bash
mkdir -p tests/integration/fixtures

curl -s "https://api.congress.gov/v3/member?congress=119&limit=5&api_key=$API_DATA_GOV_KEY" \
  > tests/integration/fixtures/congress-members-page1.json

curl -s "https://api.congress.gov/v3/bill?congress=119&limit=5&api_key=$API_DATA_GOV_KEY" \
  > tests/integration/fixtures/congress-bills-page1.json

# The /vote endpoint may not be available in all Congress.gov access tiers.
# If it returns 404, use the hand-crafted fixture below (Option B).
curl -s "https://api.congress.gov/v3/vote?congress=119&limit=5&api_key=$API_DATA_GOV_KEY" \
  > tests/integration/fixtures/congress-votes-page1.json
```

Option B — hand-crafted fixture (use if `/vote` endpoint is unavailable
or you don't have a key at fixture-creation time):

`tests/integration/fixtures/congress-members-page1.json`:
```json
{
  "members": [
    {
      "bioguideId": "S000148",
      "name": "Schumer, Charles E.",
      "partyName": "Democrat",
      "state": "NY",
      "district": null,
      "terms": { "item": [{ "chamber": "Senate", "startYear": 1999, "endYear": null }] }
    },
    {
      "bioguideId": "P000197",
      "name": "Pelosi, Nancy",
      "partyName": "Democrat",
      "state": "CA",
      "district": 11,
      "terms": { "item": [{ "chamber": "House", "startYear": 1987, "endYear": null }] }
    }
  ],
  "pagination": { "count": 2 }
}
```

`tests/integration/fixtures/congress-bills-page1.json`:
```json
{
  "bills": [
    {
      "congress": 119,
      "type": "HR",
      "number": "1234",
      "title": "Civic Awareness and Transparency Enhancement Act",
      "introducedDate": "2025-01-15",
      "updateDate": "2025-03-01T00:00:00Z",
      "url": "https://api.congress.gov/v3/bill/119/hr/1234",
      "sponsors": [{ "bioguideId": "P000197", "fullName": "Rep. Nancy Pelosi [D-CA-11]" }],
      "latestAction": { "actionDate": "2025-03-01", "text": "Passed House" }
    }
  ],
  "pagination": { "count": 1 }
}
```

`tests/integration/fixtures/congress-votes-page1.json`:
```json
{
  "votes": [
    {
      "congress": 119,
      "chamber": "House",
      "rollNumber": 42,
      "date": "2025-03-01T00:00:00Z",
      "question": "On Passage",
      "result": "Passed",
      "bill": { "type": "HR", "number": "1234" },
      "positions": [
        { "member": { "bioguideId": "P000197", "name": "Pelosi, Nancy" }, "votePosition": "Yea" },
        { "member": { "bioguideId": "S000148", "name": "Schumer, Charles E." }, "votePosition": "Nay" }
      ],
      "totals": { "yea": 218, "nay": 210, "present": 0, "notVoting": 7 }
    }
  ],
  "pagination": { "count": 1 }
}
```

- [ ] **Step 6.2: Write the integration test**

`tests/integration/congress-e2e.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/core/seeds.js";
import { CongressAdapter } from "../../src/adapters/congress.js";
import { handleRecentBills } from "../../src/mcp/tools/recent_bills.js";
import { handleRecentVotes } from "../../src/mcp/tools/recent_votes.js";

const TEST_DB = "./data/test-congress-e2e.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  const membersFixture = readFileSync(
    "tests/integration/fixtures/congress-members-page1.json",
    "utf-8",
  );
  const billsFixture = readFileSync(
    "tests/integration/fixtures/congress-bills-page1.json",
    "utf-8",
  );
  const votesFixture = readFileSync(
    "tests/integration/fixtures/congress-votes-page1.json",
    "utf-8",
  );

  vi.spyOn(global, "fetch").mockImplementation(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/member")) return new Response(membersFixture, { status: 200 });
    if (u.includes("/vote"))   return new Response(votesFixture,   { status: 200 });
    if (u.includes("/bill"))   return new Response(billsFixture,   { status: 200 });
    return new Response("", { status: 404 });
  });
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

describe("Congress.gov end-to-end", () => {
  it("refreshes and exposes federal bills via recent_bills", async () => {
    const adapter = new CongressAdapter({ apiKey: "fake", congresses: [119] });
    const result = await adapter.refresh({ db: store.db, maxPages: 1 });
    expect(result.errors).toEqual([]);
    expect(result.documentsUpserted).toBeGreaterThan(0);

    // Bills are visible via recent_bills with jurisdiction=us-federal.
    // Use a wide window because fixture dates may not be within 7 days.
    const bills = await handleRecentBills(store.db, {
      days: 365,
      jurisdiction: "us-federal",
    });
    expect(bills.results.length).toBeGreaterThan(0);
    expect(bills.sources[0].name).toBe("congress");

    // Verify identifier+title splitting:
    // "HR1234 — Civic Awareness..." → identifier="HR1234", title starts
    // with "Civic Awareness".
    const bill = bills.results[0];
    expect(bill.identifier).toBe("HR1234");
    expect(bill.title).toMatch(/Civic Awareness/);
  });

  it("refreshes and exposes federal votes via recent_votes", async () => {
    const adapter = new CongressAdapter({ apiKey: "fake", congresses: [119] });
    await adapter.refresh({ db: store.db, maxPages: 1 });

    const votes = await handleRecentVotes(store.db, {
      jurisdiction: "us-federal",
      days: 365,
    });
    expect(votes.results.length).toBeGreaterThan(0);
    expect(votes.results[0].tally.yea).toBe(218);
    expect(votes.results[0].result).toBe("Passed");
    expect(votes.sources[0].name).toBe("congress");
  });

  it("Members of Congress appear in the entity store with federal role metadata", () => {
    const adapter = new CongressAdapter({ apiKey: "fake", congresses: [119] });
    return adapter.refresh({ db: store.db, maxPages: 1 }).then(() => {
      const rows = store.db
        .prepare("SELECT name, metadata FROM entities WHERE kind = 'person'")
        .all() as Array<{ name: string; metadata: string }>;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const meta = JSON.parse(row.metadata) as { roles?: Array<{ jurisdiction: string }> };
        expect(meta.roles?.some((r) => r.jurisdiction === "us-federal")).toBe(true);
      }
    });
  });

  it("cross-source merge: an OpenStates person with matching bioguide collapses to one entity row", async () => {
    // Pre-seed: an OpenStates-sourced Person with the same bioguide ID
    // that the Congress.gov fixture returns for Pelosi.
    const { upsertEntity } = await import("../../src/core/entities.js");
    upsertEntity(store.db, {
      kind: "person",
      name: "Pelosi, Nancy",
      jurisdiction: undefined,
      external_ids: {
        openstates_person: "ocd-person/ca-pelosi",
        bioguide: "P000197",
      },
      metadata: {
        roles: [
          { jurisdiction: "us-ca", role: "state_legislator", from: "1980-01-01", to: "1987-01-01" },
        ],
      },
    });

    const adapter = new CongressAdapter({ apiKey: "fake", congresses: [119] });
    await adapter.refresh({ db: store.db, maxPages: 1 });

    const count = (
      store.db
        .prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'person'")
        .get() as { c: number }
    ).c;
    // Should have exactly 2 rows: merged Pelosi + Schumer (who has no
    // pre-existing OpenStates row in this test).
    expect(count).toBe(2);

    // The merged Pelosi row must carry both roles.
    const pelosiRow = store.db
      .prepare(
        "SELECT metadata FROM entities WHERE json_extract(external_ids, '$.\"bioguide\"') = 'P000197'",
      )
      .get() as { metadata: string };
    const meta = JSON.parse(pelosiRow.metadata) as {
      roles?: Array<{ jurisdiction: string; role: string }>;
    };
    const jurisdictions = (meta.roles ?? []).map((r) => r.jurisdiction);
    expect(jurisdictions).toContain("us-ca");
    expect(jurisdictions).toContain("us-federal");
  });
});
```

- [ ] **Step 6.3: Run the end-to-end test**

```bash
pnpm test tests/integration/congress-e2e.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 6.4: Run the full test suite**

```bash
pnpm test
pnpm typecheck
```

Expected: all tests pass, no type errors.

- [ ] **Step 6.5: Commit**

```bash
git add \
  tests/integration/congress-e2e.test.ts \
  tests/integration/fixtures/congress-members-page1.json \
  tests/integration/fixtures/congress-bills-page1.json \
  tests/integration/fixtures/congress-votes-page1.json
git commit -m "test: Congress.gov end-to-end integration with committed fixtures"
```

---

## Task 7 (optional): Enrich `get_entity` response for cross-jurisdiction Persons

**Files:** `src/mcp/tools/get_entity.ts` (modify in place)

This task is optional but strongly recommended: a sitting Senator who
was previously a state legislator now has both state and federal roles
in `metadata.roles[]`. The current `handleGetEntity` response exposes
`entity.metadata` as raw JSON, so the roles are technically visible —
but they don't surface cleanly in the `sources` array. This task adds a
`roles_summary` field and a per-jurisdiction source URL for the entity
response.

- [ ] **Step 7.1: Write the additional test assertion**

In `tests/unit/mcp/tools/get_entity.test.ts`, add a new `it` block
inside the existing `describe("get_entity")`:

```ts
it("surfaces federal role URL in sources when entity has a bioguide ID", async () => {
  // Pre-seed a Person who is a sitting Senator.
  const { entity } = upsertEntity(store.db, {
    kind: "person",
    name: "Schumer, Charles E.",
    jurisdiction: undefined,
    external_ids: { bioguide: "S000148" },
    metadata: {
      roles: [
        { jurisdiction: "us-ny",      role: "state_legislator", from: "1981-01-01T00:00:00.000Z", to: "1999-01-03T00:00:00.000Z" },
        { jurisdiction: "us-federal", role: "senator",          from: "1999-01-03T00:00:00.000Z", to: null },
      ],
    },
  });
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-federal", title: "HR1 — A federal bill",
    occurred_at: new Date().toISOString(),
    source: {
      name: "congress",
      id: "119-hr-1",
      url: "https://www.congress.gov/bill/119th-congress/house-bill/1",
    },
    references: [{ entity_id: entity.id, role: "sponsor" }],
  });

  const res = await handleGetEntity(store.db, { id: entity.id });
  // The entity's metadata.roles[] should contain both jurisdictions.
  const roles = (res.entity.metadata.roles ?? []) as Array<{ jurisdiction: string }>;
  const jurisdictions = roles.map((r) => r.jurisdiction);
  expect(jurisdictions).toContain("us-ny");
  expect(jurisdictions).toContain("us-federal");

  // The sources array should include a congress.gov URL for the federal role.
  const congressSource = res.sources.find((s) => s.name === "congress");
  expect(congressSource?.url).toMatch(/congress\.gov/);
});
```

- [ ] **Step 7.2: Update `src/mcp/tools/get_entity.ts` to emit congress source URLs**

Inside `handleGetEntity`, in the `sources` map construction, add a
branch for `congress` (alongside the existing `openstates` branch):

```ts
const sources = Array.from(sourceKeys.values()).map(({ name, jurisdiction }) => {
  if (name === "openstates") {
    const stateAbbr = jurisdiction.replace(/^us-/, "");
    return { name, url: `https://openstates.org/${stateAbbr}/` };
  }
  if (name === "congress") {
    return { name, url: "https://www.congress.gov/" };
  }
  return { name, url: "" };
});
```

This is a two-line change. No other logic changes are needed.

- [ ] **Step 7.3: Run tests and commit**

```bash
pnpm test tests/unit/mcp/tools/get_entity.test.ts
git add src/mcp/tools/get_entity.ts tests/unit/mcp/tools/get_entity.test.ts
git commit -m "feat: get_entity surfaces congress.gov source URL for federal entities"
```

---

## Phase 3 completion checklist

- [ ] All unit tests pass: `pnpm test tests/unit/`
- [ ] All integration tests pass: `pnpm test tests/integration/`
- [ ] `pnpm test` (full suite) passes with no failures
- [ ] `pnpm typecheck` passes with no type errors
- [ ] `pnpm build` produces a working `dist/`
- [ ] Manual smoke: `API_DATA_GOV_KEY=... pnpm refresh --source=congress --max-pages=1`
      completes without errors against the live API. Logs report
      `entitiesUpserted > 0` and `documentsUpserted > 0`.
- [ ] In Claude Desktop (configured per README), asking "what federal
      bills were updated this week?" returns results citing at least one
      `congress.gov` URL.
- [ ] In Claude Desktop, asking "what were the most recent votes in the
      House?" returns a `recent_votes` response with tally and result.
- [ ] In Claude Desktop, asking about a sitting Member of Congress (e.g.
      "who is Chuck Schumer?") via `get_entity` returns the
      `metadata.roles[]` history spanning both federal and state roles
      if they exist.
- [ ] Existing OpenStates tests still pass (no regression).

---

## Self-review

- **Spec coverage:** `recent_votes` from `docs/05-tool-surface.md`
  Phase 3 is implemented. `recent_bills` now covers `us-federal` via the
  Congress.gov adapter without code changes to `recent_bills.ts`. The
  existing tools (`search_entities`, `get_entity`,
  `search_civic_documents`) expand automatically because they query the
  shared store — no logic changes needed for those tools.
- **Cross-source merge:** The merge path in Task 2 (Test 3 + Task 6 e2e
  Test 4) validates that a Member of Congress with a pre-existing
  OpenStates `Person` sharing the same `bioguide` ID collapses to one
  entity row with both roles in `metadata.roles[]`. The adapter does NOT
  add a fuzzy-match pass for Members with no bioguide pre-link; that is
  intentional (under-match is tolerated per D3b and R11).
- **No placeholders:** Every step has complete code and runnable bash
  commands.
- **Type consistency:** `z.iso.datetime()` and `z.url()` are used
  throughout — not the deprecated `z.string().datetime()` /
  `z.string().url()`. All zod schemas are in `src/mcp/schemas.ts` and
  re-exported; no inline schema objects in `server.ts`.
- **`mcp.registerTool` only:** The `mcp.tool(...)` four-argument
  deprecated form does not appear anywhere in this phase.
- **Env var:** `CIVIC_AWARENESS_DB_PATH` (D6). `API_DATA_GOV_KEY` for
  the new adapter.
- **UUIDs:** All entity and document IDs are generated via `randomUUID()`
  (already in `entities.ts` and `documents.ts`); no changes needed.
- **`db.transaction()`:** `upsertDocument` in `documents.ts` already
  wraps multi-statement sequences in a transaction. The Congress adapter
  relies on that and does not add its own outer transaction.
- **`json_extract` not LIKE:** All external-ID lookups (in the adapter
  and in `entities.ts`) use `json_extract(external_ids, '$.\"bioguide\"')`.
- **Commit message exactness:** All commit messages in this plan are
  exact strings in the bash blocks; no ellipsis or placeholders.
- **Plan–code alignment:** The four required unit tests in Task 2 assert
  exactly the behaviour implemented in Task 2's `congress.ts` —
  specifically: (1) NULL jurisdiction + `us-federal` role in
  `metadata.roles[]`; (2) bill document with `us-federal` jurisdiction
  and sponsor ref; (3) single-row merge on matching bioguide; (4) vote
  document with `yea`/`nay` qualifiers. The `handleRecentVotes` handler
  maps `raw.totals.notVoting` → `VoteTally.absent`, which is the field
  the test asserts via `expect(vote?.tally.absent).toBe(5)`.

**Design calls worth flagging for human review:**

1. **`/vote` endpoint availability.** Congress.gov's documented `/vote`
   endpoint exists but is relatively new and may require a higher API
   access tier. If it returns 404 in practice, Option B (hand-crafted
   fixtures) keeps all tests green, but the live integration smoke test
   will need to skip the votes assertion. The plan includes a fallback
   note but does not add a conditional skip in the test — the human
   reviewer should decide whether to add `skipIf` guards.

2. **Congress.gov pagination cursor vs. `count` field.** The API
   provides a `pagination.next` URL as a cursor rather than a
   `max_page` integer (unlike OpenStates). The `fetchAllPages` helper
   follows `pagination.next` as a URL cursor. The `count` field in
   `pagination` is a total-result count, not a page count; it is not
   used for pagination logic. If Congress.gov changes the cursor field
   name, the adapter silently stops paginating rather than erroring —
   that trade-off (silent under-fetch vs. loud error) is intentional
   per the under-match bias in D3b, but the reviewer may prefer an
   explicit check.

3. **`metadata.roles[]` merge in the adapter (not in `upsertEntity`).**
   The decision to handle `metadata.roles[]` merging in the adapter
   rather than inside `upsertEntity` keeps the core function simple but
   means every future adapter must remember to do its own role-merge
   pass. Phase 4 (OpenFEC) will face the same requirement. An
   alternative would be to extend `UpsertInput` with a `roles` field and
   let `upsertEntity` handle the merge. That refactor is deferred to
   avoid touching Phase 2 code; it would be a clean Phase 4 prep task.

4. **Vote `source_id` format.** The adapter stores votes as
   `source_id = "vote-119-house-42"`. The `UNIQUE(source_name, source_id)`
   constraint in the `documents` table means re-runs are idempotent per
   this key. The format is stable as long as Congress number + chamber +
   roll number are unique per API, which they are by definition. No
   concern here, but flagged for visibility.

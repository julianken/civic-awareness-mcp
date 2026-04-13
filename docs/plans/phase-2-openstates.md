# Phase 2 — OpenStates Bills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Prerequisite:** Phase 1 complete (`docs/plans/phase-1-foundation.md`
all checkboxes green).

**Goal:** Fetch bills from U.S. state legislatures via OpenStates (all
50 states + D.C./PR, jurisdiction per call), store them in the entity
graph as `Document`s with `Person` references for sponsors, and expose
four MCP tools that answer real questions about state legislation in
any supported jurisdiction.

**Architecture:** One adapter (`src/adapters/openstates.ts`) translates
OpenStates API responses into normalized `Entity` upserts and
`Document` upserts. A refresh CLI invokes the adapter. Four MCP tools
read from the store.

**Tech Stack:** unchanged from Phase 1.

**API key prerequisite:** User must have an OpenStates API key from
https://open.pluralpolicy.com. Store it in a `.env.local` file (which
is gitignored) as `OPENSTATES_API_KEY=...`.

---

## File structure produced by this phase

```
src/
├── adapters/
│   ├── base.ts                         ← Task 1
│   └── openstates.ts                   ← Task 2
├── cli/
│   └── refresh.ts                      ← Task 3
├── mcp/
│   ├── server.ts                       (modified in Task 4)
│   ├── schemas.ts                      ← Task 4
│   └── tools/
│       ├── recent_bills.ts             ← Task 4
│       ├── search_entities.ts          ← Task 5
│       ├── get_entity.ts               ← Task 6
│       └── search_civic_documents.ts   ← Task 7
└── util/
    └── env.ts                          ← Task 1
tests/
├── unit/
│   └── adapters/
│       └── openstates.test.ts          ← Task 2
└── integration/
    └── openstates-e2e.test.ts          ← Task 8
```

---

## Task 1: Adapter base interface + env loader

**Files:** `src/adapters/base.ts`, `src/util/env.ts`,
`tests/unit/util/env.test.ts`

- [ ] **Step 1.1: Write env test**

```ts
// tests/unit/util/env.test.ts
import { describe, it, expect } from "vitest";
import { requireEnv, optionalEnv } from "../../../src/util/env.js";

describe("env loaders", () => {
  it("requireEnv throws when missing", () => {
    delete process.env.TEST_VAR;
    expect(() => requireEnv("TEST_VAR")).toThrow(/TEST_VAR/);
  });
  it("requireEnv returns value when present", () => {
    process.env.TEST_VAR = "hello";
    expect(requireEnv("TEST_VAR")).toBe("hello");
  });
  it("optionalEnv returns default", () => {
    delete process.env.TEST_VAR;
    expect(optionalEnv("TEST_VAR", "fallback")).toBe("fallback");
  });
});
```

- [ ] **Step 1.2: Implement `src/util/env.ts`**

```ts
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
```

- [ ] **Step 1.3: Implement `src/adapters/base.ts`**

```ts
import type Database from "better-sqlite3";

export interface RefreshResult {
  source: string;
  entitiesUpserted: number;
  documentsUpserted: number;
  errors: string[];
}

export interface AdapterOptions {
  db: Database.Database;
  /** Limit on results fetched — useful for dev/testing. */
  maxPages?: number;
  /**
   * Jurisdiction to refresh. Required by per-jurisdiction adapters
   * (e.g., OpenStates iterates one state per call); optional for
   * single-jurisdiction adapters (Congress.gov is always
   * `us-federal`; OpenFEC is always federal campaign finance).
   */
  jurisdiction?: string;
}

export interface Adapter {
  readonly name: string;
  refresh(opts: AdapterOptions): Promise<RefreshResult>;
}
```

- [ ] **Step 1.4: Test, commit**

```bash
pnpm test tests/unit/util/env.test.ts
git add src/adapters/base.ts src/util/env.ts tests/unit/util/env.test.ts
git commit -m "feat: adapter interface and env loader"
```

---

## Task 2: OpenStates adapter

**Files:** `src/adapters/openstates.ts`, `tests/unit/adapters/openstates.test.ts`

- [ ] **Step 2.1: Write unit test with mocked fetch**

`tests/unit/adapters/openstates.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { OpenStatesAdapter } from "../../../src/adapters/openstates.js";

const TEST_DB = "./data/test-openstates.db";
let store: Store;

const SAMPLE_PERSON = {
  id: "ocd-person/abc",
  name: "Jane Doe",
  party: "Democratic",
  current_role: { title: "Representative", district: "15", org_classification: "lower" },
  jurisdiction: { id: "ocd-jurisdiction/country:us/state:tx/government" },
};

const SAMPLE_BILL = {
  id: "ocd-bill/xyz",
  identifier: "HB1234",
  title: "An act relating to civic awareness",
  session: "89R",
  updated_at: "2026-04-01T10:00:00Z",
  openstates_url: "https://openstates.org/tx/bills/HB1234",
  jurisdiction: { id: "ocd-jurisdiction/country:us/state:tx/government" },
  sponsorships: [{ name: "Jane Doe", classification: "primary", person: SAMPLE_PERSON }],
  actions: [{ date: "2026-04-01", description: "Introduced" }],
};

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
    const u = String(url);
    if (u.includes("/people")) {
      return new Response(
        JSON.stringify({ results: [SAMPLE_PERSON], pagination: { max_page: 1, page: 1 } }),
        { status: 200 },
      );
    }
    if (u.includes("/bills")) {
      return new Response(
        JSON.stringify({ results: [SAMPLE_BILL], pagination: { max_page: 1, page: 1 } }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

describe("OpenStatesAdapter", () => {
  it("upserts legislators as Person entities (Persons have NULL jurisdiction per D3b; roles[] carries it)", async () => {
    const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
    const result = await adapter.refresh({ db: store.db, jurisdiction: "tx" });
    expect(result.entitiesUpserted).toBeGreaterThan(0);
    const row = store.db
      .prepare("SELECT name, external_ids, jurisdiction, metadata FROM entities WHERE kind = 'person'")
      .get() as { name: string; external_ids: string; jurisdiction: string | null; metadata: string };
    expect(row.name).toBe("Jane Doe");
    expect(JSON.parse(row.external_ids).openstates_person).toBe("ocd-person/abc");
    // Per D3b: Persons are cross-jurisdiction — jurisdiction column is NULL,
    // per-role jurisdictions live in metadata.roles[].
    expect(row.jurisdiction).toBeNull();
    const meta = JSON.parse(row.metadata) as { roles?: Array<{ jurisdiction: string; role: string }> };
    expect(meta.roles?.[0]?.jurisdiction).toBe("us-tx");
    expect(meta.roles?.[0]?.role).toBe("state_legislator");
  });

  it("upserts bills as Document with sponsor references", async () => {
    const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db, jurisdiction: "tx" });
    const doc = store.db
      .prepare("SELECT title, kind, jurisdiction FROM documents WHERE source_name = 'openstates'")
      .get() as { title: string; kind: string; jurisdiction: string };
    expect(doc.kind).toBe("bill");
    expect(doc.title).toContain("HB1234");
    expect(doc.jurisdiction).toBe("us-tx");
    const refs = store.db.prepare("SELECT COUNT(*) c FROM document_references").get() as { c: number };
    expect(refs.c).toBe(1);
  });

  it("handles a different state (California) without code changes", async () => {
    // Proves the adapter is jurisdiction-parametric, not AZ-specific.
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      const u = String(url);
      const caPerson = {
        id: "ocd-person/ca-1",
        name: "Alex Rivera",
        party: "Democratic",
        current_role: { title: "Assemblymember", district: "42", org_classification: "lower" },
        jurisdiction: { id: "ocd-jurisdiction/country:us/state:ca/government" },
      };
      const caBill = {
        id: "ocd-bill/ca-1",
        identifier: "AB123",
        title: "An act relating to data privacy",
        session: "20252026",
        updated_at: "2026-04-01T10:00:00Z",
        openstates_url: "https://openstates.org/ca/bills/AB123",
        jurisdiction: { id: "ocd-jurisdiction/country:us/state:ca/government" },
        sponsorships: [{ name: "Alex Rivera", classification: "primary", person: caPerson }],
        actions: [{ date: "2026-04-01", description: "Introduced" }],
      };
      if (u.includes("/people")) {
        return new Response(JSON.stringify({ results: [caPerson], pagination: { max_page: 1, page: 1 } }), { status: 200 });
      }
      if (u.includes("/bills")) {
        return new Response(JSON.stringify({ results: [caBill], pagination: { max_page: 1, page: 1 } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
    const result = await adapter.refresh({ db: store.db, jurisdiction: "ca" });
    expect(result.errors).toEqual([]);
    expect(result.documentsUpserted).toBeGreaterThan(0);
    const doc = store.db
      .prepare("SELECT jurisdiction FROM documents WHERE source_id = 'ocd-bill/ca-1'")
      .get() as { jurisdiction: string };
    expect(doc.jurisdiction).toBe("us-ca");
  });
});
```

- [ ] **Step 2.2: Implement `src/adapters/openstates.ts`**

```ts
import type Database from "better-sqlite3";
import { rateLimitedFetch, RateLimiter } from "../util/http.js";
import { upsertEntity } from "../core/entities.js";
import { upsertDocument } from "../core/documents.js";
import { logger } from "../util/logger.js";
import type { Adapter, AdapterOptions, RefreshResult } from "./base.js";

const BASE_URL = "https://v3.openstates.org";

/** "ocd-jurisdiction/country:us/state:tx/government" → "tx".
 *  OpenStates v3 `/bills?jurisdiction=tx` accepts the bare abbr, so
 *  we only need the OCD→abbr direction, not the inverse. */
function extractStateAbbr(ocdId: string | undefined): string | undefined {
  if (!ocdId) return undefined;
  const m = ocdId.match(/state:([a-z]{2})/i);
  return m ? m[1].toLowerCase() : undefined;
}

interface OpenStatesPerson {
  id: string;
  name: string;
  party?: string;
  current_role?: {
    title?: string;
    district?: string;
    org_classification?: string;
  };
  jurisdiction?: { id?: string };
}

interface OpenStatesSponsorship {
  name: string;
  classification: string;
  person?: OpenStatesPerson;
}

interface OpenStatesBill {
  id: string;
  identifier: string;
  title: string;
  session: string;
  updated_at: string;
  openstates_url: string;
  jurisdiction?: { id?: string };
  sponsorships?: OpenStatesSponsorship[];
  actions?: Array<{ date: string; description: string }>;
  abstracts?: Array<{ abstract: string }>;
}

interface Page<T> {
  results: T[];
  pagination: { max_page: number; page: number };
}

export interface OpenStatesAdapterOptions {
  apiKey: string;
  /**
   * Token bucket rate limiter; defaults to 8 requests per 60s (under
   * the 10/min OpenStates free-tier quota). NOTE: OpenStates also
   * enforces a 500-requests-per-day cap on the free tier. Per-minute
   * pacing alone does not protect against the daily cap when we
   * iterate all 50 states; daily-cap safety is the responsibility of
   * the refresh CLI, which must be both resumable and incremental
   * (`--since=<date>`) so a multi-state run can span multiple days.
   */
  rateLimiter?: RateLimiter;
}

export class OpenStatesAdapter implements Adapter {
  readonly name = "openstates";
  private readonly rateLimiter: RateLimiter;

  constructor(private readonly opts: OpenStatesAdapterOptions) {
    this.rateLimiter = opts.rateLimiter
      ?? new RateLimiter({ tokensPerInterval: 8, intervalMs: 60_000 });
  }

  /**
   * Refresh a single U.S. state's legislators + bills from OpenStates.
   *
   * IMPORTANT — OpenStates free-tier constraint: per-minute pacing is
   * handled by the rate limiter, but the 500-requests-per-day cap
   * cannot be protected by rate limiting inside one run. A full
   * 50-state cold refresh is not possible in one day on the free
   * tier. The refresh CLI (Task 3) calls `refresh()` once per state
   * in a loop, MUST:
   *   1. Prioritize states with active sessions first.
   *   2. Support `--since=<date>` incremental refresh.
   *   3. Be resumable — a run that dies at state 32 picks up there
   *      on the next invocation.
   * See `docs/03-data-sources.md` → "Scaling consideration".
   */
  async refresh(options: AdapterOptions & { jurisdiction: string }): Promise<RefreshResult> {
    const stateAbbr = options.jurisdiction.toLowerCase();
    const result: RefreshResult = {
      source: this.name,
      entitiesUpserted: 0,
      documentsUpserted: 0,
      errors: [],
    };
    try {
      const legislators = await this.fetchAllPages<OpenStatesPerson>(
        "/people",
        { jurisdiction: stateAbbr },
        options.maxPages,
      );
      for (const p of legislators) {
        this.upsertPerson(options.db, p);
        result.entitiesUpserted += 1;
      }

      const bills = await this.fetchAllPages<OpenStatesBill>(
        "/bills",
        {
          jurisdiction: stateAbbr,
          sort: "updated_desc",
          include: "sponsorships,abstracts,actions",
        },
        options.maxPages,
      );
      for (const b of bills) {
        this.upsertBill(options.db, b);
        result.documentsUpserted += 1;
      }
    } catch (err) {
      const msg = String(err);
      logger.error("openstates refresh failed", { error: msg, jurisdiction: stateAbbr });
      result.errors.push(msg);
    }
    return result;
  }

  private async fetchAllPages<T>(
    path: string,
    params: Record<string, string>,
    maxPages: number | undefined,
  ): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    while (true) {
      const url = new URL(`${BASE_URL}${path}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", "20");

      const res = await rateLimitedFetch(url.toString(), {
        userAgent: "civic-awareness-mcp/0.0.1 (+github)",
        rateLimiter: this.rateLimiter,
        headers: { "X-API-KEY": this.opts.apiKey },
      });
      if (!res.ok) throw new Error(`OpenStates ${path} returned ${res.status}`);
      const body = (await res.json()) as Page<T>;
      all.push(...body.results);
      if (page >= body.pagination.max_page) break;
      if (maxPages && page >= maxPages) break;
      page += 1;
    }
    return all;
  }

  private upsertPerson(db: Database.Database, p: OpenStatesPerson): string {
    // Per D3b: Person entities are cross-jurisdiction. We do NOT set
    // `entities.jurisdiction` for Persons — the career-level role
    // history lives in `metadata.roles[]` so a Senator who once
    // served in a state legislature collapses to one Person row.
    const chamber = p.current_role?.org_classification;
    const stateAbbr = extractStateAbbr(p.jurisdiction?.id);
    const now = new Date().toISOString();
    const roles = stateAbbr
      ? [{
          jurisdiction: `us-${stateAbbr}`,
          role: "state_legislator",
          from: now,
          to: null as string | null,
        }]
      : [];
    const { entity } = upsertEntity(db, {
      kind: "person",
      name: p.name,
      jurisdiction: undefined,
      external_ids: { openstates_person: p.id },
      metadata: {
        party: p.party,
        title: p.current_role?.title,
        district: p.current_role?.district,
        chamber,
        roles,
      },
    });
    return entity.id;
  }

  private upsertBill(db: Database.Database, b: OpenStatesBill): void {
    const billStateAbbr =
      extractStateAbbr((b as { jurisdiction?: { id?: string } }).jurisdiction?.id)
      ?? extractStateAbbr(b.sponsorships?.[0]?.person?.jurisdiction?.id);
    if (!billStateAbbr) {
      throw new Error(`Cannot determine state for bill ${b.id}`);
    }
    const billJurisdiction = `us-${billStateAbbr}`;

    const refs = (b.sponsorships ?? []).map((s) => {
      // Bare-name fallback sponsor still has no jurisdiction on the
      // Person (D3b); the bill-side jurisdiction is on the Document.
      const personId = s.person
        ? this.upsertPerson(db, s.person)
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
      occurred_at: b.updated_at,
      source: { name: "openstates", id: b.id, url: b.openstates_url },
      references: refs,
      raw: { session: b.session, actions: b.actions ?? [] },
    });
  }
}
```

- [ ] **Step 2.3: Test and commit**

```bash
pnpm test tests/unit/adapters/openstates.test.ts
git add src/adapters/openstates.ts tests/unit/adapters/openstates.test.ts
git commit -m "feat: OpenStates adapter for multi-state bills and legislators"
```

---

## Task 3: Refresh CLI

**Files:** `src/cli/refresh.ts`, modify `package.json`

- [ ] **Step 3.1: Implement `src/cli/refresh.ts`**

```ts
import { openStore } from "../core/store.js";
import { seedJurisdictions } from "../core/seeds.js";
import { OpenStatesAdapter } from "../adapters/openstates.js";
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
    else if (argv[i] === "--jurisdictions" && argv[i + 1]) {
      jurisdictions = argv[++i].split(",").map((s) => s.trim().toLowerCase());
    } else if (argv[i].startsWith("--jurisdictions=")) {
      jurisdictions = argv[i].slice("--jurisdictions=".length)
        .split(",").map((s) => s.trim().toLowerCase());
    }
  }
  return { source, maxPages, jurisdictions };
}

function listStateJurisdictions(db: import("better-sqlite3").Database): string[] {
  // "us-tx" → "tx", filter to state-level only.
  const rows = db.prepare(
    "SELECT id FROM jurisdictions WHERE level = 'state' ORDER BY id",
  ).all() as Array<{ id: string }>;
  return rows.map((r) => r.id.replace(/^us-/, ""));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = optionalEnv("CIVIC_AWARENESS_DB_PATH", "./data/civic-awareness.db");
  const store = openStore(dbPath);
  seedJurisdictions(store.db);

  if (args.source !== "openstates") {
    logger.error("unknown source", { source: args.source });
    process.exit(1);
  }

  const adapter = new OpenStatesAdapter({ apiKey: requireEnv("OPENSTATES_API_KEY") });
  const targets = args.jurisdictions ?? listStateJurisdictions(store.db);
  // NOTE: OpenStates free tier is 500 requests/day. A full 50-state
  // cold refresh exceeds that. For free-tier users this loop must be
  // invoked with a subset (`--jurisdictions=tx,ca,...`) or repeated
  // across days; a future enhancement should persist progress in the
  // DB so subsequent runs skip states that already completed today.
  for (const state of targets) {
    logger.info("refreshing state", { state });
    const result = await adapter.refresh({
      db: store.db,
      maxPages: args.maxPages,
      jurisdiction: state,
    });
    logger.info("state refresh complete", result);
    if (result.errors.length > 0) {
      // Don't abort the whole loop on a single state's failure — the
      // other 49 are independent.
      logger.error("state had errors", { state, errors: result.errors });
    }
  }
  store.close();
}

main().catch((err) => {
  logger.error("refresh failed", { error: String(err) });
  process.exit(1);
});
```

- [ ] **Step 3.2: Add `pnpm refresh` script**

Ensure `package.json` has:
```json
"refresh": "tsx src/cli/refresh.ts"
```

(Already in Task 1 of Phase 1.)

- [ ] **Step 3.3: Smoke test against real OpenStates (optional)**

```bash
export OPENSTATES_API_KEY=your-key-here
# Free-tier friendly: one state, one page. Swap `tx` for any state
# code. Omit `--jurisdictions` to iterate all state rows in the
# jurisdictions table (NOT free-tier friendly).
pnpm refresh --source=openstates --jurisdictions=tx --max-pages=1
```

Expected: logs report upserts for ~20 legislators and ~20 bills from
Texas.

- [ ] **Step 3.4: Commit**

```bash
git add src/cli/refresh.ts
git commit -m "feat: refresh CLI for OpenStates adapter"
```

---

## Task 4: `recent_bills` tool

**Files:** `src/mcp/schemas.ts`, `src/mcp/tools/recent_bills.ts`,
modify `src/mcp/server.ts`, `tests/unit/mcp/tools/recent_bills.test.ts`

- [ ] **Step 4.1: Write test**

`tests/unit/mcp/tools/recent_bills.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleRecentBills } from "../../../../src/mcp/tools/recent_bills.js";

const TEST_DB = "./data/test-tool-recent-bills.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  // Per D3b: Person entities are cross-jurisdiction — no jurisdiction
  // column is set. Roles history lives in metadata.roles[].
  const { entity } = upsertEntity(store.db, {
    kind: "person", name: "Jane Doe", jurisdiction: undefined,
    metadata: {
      party: "Democratic", district: "15", chamber: "lower",
      roles: [{ jurisdiction: "us-tx", role: "state_legislator",
                from: new Date().toISOString(), to: null }],
    },
  });

  const now = new Date().toISOString();
  const old = new Date(Date.now() - 40 * 86400 * 1000).toISOString();
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx",
    title: "HB1 — recent bill", occurred_at: now,
    source: { name: "openstates", id: "1", url: "https://openstates.org/tx/bills/HB1" },
    references: [{ entity_id: entity.id, role: "sponsor" }],
  });
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx",
    title: "HB2 — old bill", occurred_at: old,
    source: { name: "openstates", id: "2", url: "https://openstates.org/tx/bills/HB2" },
  });
  // Cross-state fixture to prove the jurisdiction filter is real.
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-ca",
    title: "AB123 — california bill", occurred_at: now,
    source: { name: "openstates", id: "3", url: "https://openstates.org/ca/bills/AB123" },
  });
});
afterEach(() => store.close());

describe("recent_bills tool", () => {
  it("returns only bills within the window for the specified state", async () => {
    const result = await handleRecentBills(store.db, { days: 7, jurisdiction: "us-tx" });
    expect(result.results).toHaveLength(1);
    // Title gets split into identifier + body: "HB1 — recent bill"
    // becomes identifier="HB1", title="recent bill".
    expect(result.results[0].identifier).toBe("HB1");
    expect(result.results[0].title).toBe("recent bill");
  });
  it("scopes to the requested jurisdiction (TX vs CA)", async () => {
    const ca = await handleRecentBills(store.db, { days: 7, jurisdiction: "us-ca" });
    expect(ca.results).toHaveLength(1);
    expect(ca.results[0].identifier).toBe("AB123");
    expect(ca.results[0].title).toBe("california bill");
  });
  it("includes sponsor info", async () => {
    const result = await handleRecentBills(store.db, { days: 7, jurisdiction: "us-tx" });
    expect(result.results[0].sponsors[0].name).toBe("Jane Doe");
    expect(result.results[0].sponsors[0].party).toBe("Democratic");
  });
  it("includes source provenance with a jurisdiction-aware URL", async () => {
    const result = await handleRecentBills(store.db, { days: 7, jurisdiction: "us-tx" });
    expect(result.sources).toContainEqual({
      name: "openstates",
      url: expect.stringContaining("/tx/"),
    });
  });
  it("rejects input with no jurisdiction", async () => {
    await expect(
      handleRecentBills(store.db, { days: 7 } as unknown),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4.2: Implement `src/mcp/schemas.ts`**

```ts
import { z } from "zod";

export const RecentBillsInput = z.object({
  days: z.number().int().min(1).max(90).default(7),
  // REQUIRED. "us-federal", "us-<state>" (e.g. "us-tx"), or "*" to
  // query across all. No default — the caller must state which
  // jurisdiction they want. See docs/05-tool-surface.md.
  jurisdiction: z.string().min(1),
  chamber: z.enum(["upper", "lower"]).optional(),
  session: z.string().optional(),
});
export type RecentBillsInput = z.infer<typeof RecentBillsInput>;

export const SearchEntitiesInput = z.object({
  q: z.string().min(1),
  kind: z.enum(["person", "organization", "committee", "pac", "agency"]).optional(),
  jurisdiction: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type SearchEntitiesInput = z.infer<typeof SearchEntitiesInput>;

export const GetEntityInput = z.object({
  id: z.string().min(1),
});
export type GetEntityInput = z.infer<typeof GetEntityInput>;

export const SearchDocumentsInput = z.object({
  q: z.string().min(1),
  kinds: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type SearchDocumentsInput = z.infer<typeof SearchDocumentsInput>;
```

- [ ] **Step 4.3: Implement `src/mcp/tools/recent_bills.ts`**

```ts
import type Database from "better-sqlite3";
import { queryDocuments } from "../../core/documents.js";
import { findEntityById } from "../../core/entities.js";
import { RecentBillsInput } from "../schemas.js";

export interface BillSummary {
  id: string;
  identifier: string;
  title: string;
  latest_action: { date: string; description: string } | null;
  sponsors: Array<{ name: string; party?: string; district?: string; chamber?: string }>;
  source_url: string;
}

export interface RecentBillsResponse {
  results: BillSummary[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  window: { from: string; to: string };
}

export async function handleRecentBills(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentBillsResponse> {
  const input = RecentBillsInput.parse(rawInput);
  const to = new Date();
  const from = new Date(to.getTime() - input.days * 86400 * 1000);

  const docs = queryDocuments(db, {
    kind: "bill",
    jurisdiction: input.jurisdiction,
    from: from.toISOString(),
    to: to.toISOString(),
    limit: 50,
  });

  const filtered = input.chamber
    ? docs.filter((d) => {
        const sponsor = d.references.find((r) => r.role === "sponsor");
        if (!sponsor) return false;
        const ent = findEntityById(db, sponsor.entity_id);
        return ent?.metadata.chamber === input.chamber;
      })
    : docs;

  const results: BillSummary[] = filtered.map((d) => {
    const [identifier, ...titleParts] = d.title.split(" — ");
    const actions = (d.raw.actions as Array<{ date: string; description: string }> | undefined) ?? [];
    const latest = actions.length ? actions[actions.length - 1] : null;
    const sponsors = d.references
      .filter((r) => r.role === "sponsor" || r.role === "cosponsor")
      .map((r) => {
        const e = findEntityById(db, r.entity_id);
        return {
          name: e?.name ?? "Unknown",
          party: e?.metadata.party as string | undefined,
          district: e?.metadata.district as string | undefined,
          chamber: e?.metadata.chamber as string | undefined,
        };
      });
    return {
      id: d.id,
      identifier: identifier?.trim() ?? d.title,
      title: titleParts.join(" — ").trim() || d.title,
      latest_action: latest,
      sponsors,
      source_url: d.source.url,
    };
  });

  // Build a jurisdiction-aware source URL: "us-tx" → "/tx/".
  // For "*" (cross-state), link to the OpenStates root.
  const stateAbbr = input.jurisdiction.replace(/^us-/, "");
  const openstatesUrl = input.jurisdiction === "*"
    ? "https://openstates.org/"
    : `https://openstates.org/${stateAbbr}/`;
  const sourceUrls = new Map<string, string>();
  for (const d of filtered) sourceUrls.set(d.source.name, openstatesUrl);

  return {
    results,
    total: results.length,
    sources: Array.from(sourceUrls, ([name, url]) => ({ name, url })),
    window: { from: from.toISOString(), to: to.toISOString() },
  };
}
```

- [ ] **Step 4.4: Register the tool in `src/mcp/server.ts`**

Replace the `buildServer` function:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openStore, type Store } from "../core/store.js";
import { handleRecentBills } from "./tools/recent_bills.js";
import { RecentBillsInput } from "./schemas.js";

export interface BuildServerOptions { dbPath: string }
export interface CivicAwarenessServer { mcp: McpServer; store: Store }

export function buildServer(opts: BuildServerOptions): CivicAwarenessServer {
  const store = openStore(opts.dbPath);
  const mcp = new McpServer(
    { name: "civic-awareness-mcp", version: "0.0.2" },
    { capabilities: { tools: {} } },
  );

  mcp.tool(
    "recent_bills",
    "List recently-updated U.S. state legislative bills for a given state, with sponsors. Jurisdiction is required — pass e.g. \"us-tx\" or \"us-ca\".",
    RecentBillsInput.shape,
    async (input) => {
      const data = await handleRecentBills(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  return { mcp, store };
}
```

- [ ] **Step 4.5: Test and commit**

```bash
pnpm test tests/unit/mcp/tools/recent_bills.test.ts
git add src/mcp/schemas.ts src/mcp/tools/recent_bills.ts src/mcp/server.ts tests/unit/mcp/tools/recent_bills.test.ts
git commit -m "feat: recent_bills MCP tool"
```

---

## Task 5: `search_entities` tool

**Files:** `src/mcp/tools/search_entities.ts`,
`tests/unit/mcp/tools/search_entities.test.ts`, modify `src/mcp/server.ts`

- [ ] **Step 5.1: Write test**

```ts
// tests/unit/mcp/tools/search_entities.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { handleSearchEntities } from "../../../../src/mcp/tools/search_entities.js";

const TEST_DB = "./data/test-tool-search-entities.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  // Per D3b: Persons have NULL jurisdiction. Organizations keep one.
  // Mix two states to prove the tool is jurisdiction-agnostic.
  upsertEntity(store.db, { kind: "person", name: "Jane Doe", jurisdiction: undefined });
  upsertEntity(store.db, { kind: "person", name: "John Smith", jurisdiction: undefined });
  upsertEntity(store.db, { kind: "organization", name: "Doe Industries", jurisdiction: "us-tx" });
  upsertEntity(store.db, { kind: "organization", name: "Smith Ranch LLC", jurisdiction: "us-ca" });
});
afterEach(() => store.close());

describe("search_entities tool", () => {
  it("matches by substring", async () => {
    const res = await handleSearchEntities(store.db, { q: "doe" });
    expect(res.results).toHaveLength(2);
  });
  it("filters by kind", async () => {
    const res = await handleSearchEntities(store.db, { q: "doe", kind: "person" });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].name).toBe("Jane Doe");
  });
});
```

- [ ] **Step 5.2: Implement `src/mcp/tools/search_entities.ts`**

```ts
import type Database from "better-sqlite3";
import { SearchEntitiesInput } from "../schemas.js";
import { normalizeName } from "../../resolution/fuzzy.js";

export interface EntityMatch {
  id: string;
  kind: string;
  name: string;
  jurisdiction?: string;
  roles_seen: string[];
  last_seen_at: string;
}

export interface SearchEntitiesResponse {
  results: EntityMatch[];
  total: number;
  sources: Array<{ name: string; url: string }>;
}

interface Row {
  id: string;
  kind: string;
  name: string;
  jurisdiction: string | null;
  last_seen_at: string;
  roles: string | null;
}

export async function handleSearchEntities(
  db: Database.Database,
  rawInput: unknown,
): Promise<SearchEntitiesResponse> {
  const input = SearchEntitiesInput.parse(rawInput);
  const needle = `%${normalizeName(input.q)}%`;

  const clauses = ["e.name_normalized LIKE ?"];
  const params: unknown[] = [needle];
  if (input.kind) { clauses.push("e.kind = ?"); params.push(input.kind); }
  if (input.jurisdiction) { clauses.push("e.jurisdiction = ?"); params.push(input.jurisdiction); }
  params.push(input.limit);

  const rows = db.prepare(
    `SELECT e.id, e.kind, e.name, e.jurisdiction, e.last_seen_at,
            GROUP_CONCAT(DISTINCT r.role) AS roles
     FROM entities e
     LEFT JOIN document_references r ON r.entity_id = e.id
     WHERE ${clauses.join(" AND ")}
     GROUP BY e.id
     ORDER BY e.last_seen_at DESC
     LIMIT ?`,
  ).all(...params) as Row[];

  const results: EntityMatch[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    jurisdiction: r.jurisdiction ?? undefined,
    roles_seen: r.roles ? r.roles.split(",") : [],
    last_seen_at: r.last_seen_at,
  }));

  return { results, total: results.length, sources: [] };
}
```

- [ ] **Step 5.3: Register the tool in `server.ts`**

Add inside `buildServer`:

```ts
mcp.registerTool(
  "search_entities",
  {
    description: "Search for people or organizations by name across all U.S. state legislatures.",
    inputSchema: SearchEntitiesInput.shape,
  },
  async (input) => {
    const data = await handleSearchEntities(store.db, input);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);
```

And the matching import.

- [ ] **Step 5.4: Test and commit**

```bash
pnpm test tests/unit/mcp/tools/search_entities.test.ts
git add src/mcp/tools/search_entities.ts tests/unit/mcp/tools/search_entities.test.ts src/mcp/server.ts
git commit -m "feat: search_entities MCP tool"
```

---

## Task 6: `get_entity` tool

**Files:** `src/mcp/tools/get_entity.ts`,
`tests/unit/mcp/tools/get_entity.test.ts`, modify `src/mcp/server.ts`

- [x] **Step 6.1: Write test**

```ts
// tests/unit/mcp/tools/get_entity.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleGetEntity } from "../../../../src/mcp/tools/get_entity.js";

const TEST_DB = "./data/test-tool-get-entity.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});
afterEach(() => store.close());

describe("get_entity", () => {
  it("returns entity with recent documents", async () => {
    // Person: NULL jurisdiction per D3b; bill uses us-tx.
    const { entity } = upsertEntity(store.db, {
      kind: "person", name: "Jane Doe", jurisdiction: undefined,
      metadata: {
        roles: [{ jurisdiction: "us-tx", role: "state_legislator",
                  from: new Date().toISOString(), to: null }],
      },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB1",
      occurred_at: new Date().toISOString(),
      source: { name: "openstates", id: "1", url: "https://openstates.org/tx/bills/HB1" },
      references: [{ entity_id: entity.id, role: "sponsor" }],
    });
    const res = await handleGetEntity(store.db, { id: entity.id });
    expect(res.entity.name).toBe("Jane Doe");
    expect(res.recent_documents).toHaveLength(1);
  });
  it("throws for unknown id", async () => {
    await expect(handleGetEntity(store.db, { id: "missing" })).rejects.toThrow();
  });
});
```

- [x] **Step 6.2: Implement `src/mcp/tools/get_entity.ts`**

```ts
import type Database from "better-sqlite3";
import { GetEntityInput } from "../schemas.js";
import { findEntityById } from "../../core/entities.js";
import { findDocumentsByEntity } from "../../core/documents.js";
import type { Entity, Document } from "../../core/types.js";

export interface GetEntityResponse {
  entity: Entity;
  recent_documents: Array<{
    id: string;
    kind: string;
    title: string;
    occurred_at: string;
    source_url: string;
  }>;
  sources: Array<{ name: string; url: string }>;
}

export async function handleGetEntity(
  db: Database.Database,
  rawInput: unknown,
): Promise<GetEntityResponse> {
  const input = GetEntityInput.parse(rawInput);
  const entity = findEntityById(db, input.id);
  if (!entity) throw new Error(`Entity not found: ${input.id}`);

  const docs = findDocumentsByEntity(db, entity.id, 10);
  // Collect (source_name, jurisdiction) pairs so we can emit a
  // jurisdiction-aware "browse" URL per source. Entities can now span
  // multiple states (a Senator who was once a state legislator
  // appears as one Person with roles across several jurisdictions),
  // so we may emit multiple OpenStates links.
  const sourceKeys = new Map<string, { name: string; jurisdiction: string }>();
  const simplified = docs.map((d: Document) => {
    const key = `${d.source.name}|${d.jurisdiction}`;
    sourceKeys.set(key, { name: d.source.name, jurisdiction: d.jurisdiction });
    return {
      id: d.id,
      kind: d.kind,
      title: d.title,
      occurred_at: d.occurred_at,
      source_url: d.source.url,
    };
  });

  const sources = Array.from(sourceKeys.values()).map(({ name, jurisdiction }) => {
    if (name === "openstates") {
      const stateAbbr = jurisdiction.replace(/^us-/, "");
      return { name, url: `https://openstates.org/${stateAbbr}/` };
    }
    return { name, url: "" };
  });

  return {
    entity,
    recent_documents: simplified,
    sources,
  };
}
```

- [x] **Step 6.3: Register in `server.ts`**

```ts
mcp.registerTool(
  "get_entity",
  {
    description:
      "Fetch a single entity by ID with recent related documents. " +
      "For Persons, returns the cross-jurisdiction roles[] history.",
    inputSchema: GetEntityInput.shape,
  },
  async (input) => {
    const data = await handleGetEntity(store.db, input);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);
```

- [x] **Step 6.4: Test and commit**

```bash
pnpm test tests/unit/mcp/tools/get_entity.test.ts
git add src/mcp/tools/get_entity.ts tests/unit/mcp/tools/get_entity.test.ts src/mcp/server.ts
git commit -m "feat: get_entity MCP tool"
```

---

## Task 7: `search_civic_documents` tool

**Files:** `src/mcp/tools/search_civic_documents.ts`,
`tests/unit/mcp/tools/search_civic_documents.test.ts`, modify `src/mcp/server.ts`

For Phase 2, this tool searches `documents` by title text (SQL `LIKE`).
Phase 3+ adds full-text indexing.

- [x] **Step 7.1: Write test**

```ts
// tests/unit/mcp/tools/search_civic_documents.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleSearchDocuments } from "../../../../src/mcp/tools/search_civic_documents.js";

const TEST_DB = "./data/test-tool-search-docs.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  // Mix states to prove the tool doesn't assume a single jurisdiction.
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx",
    title: "HB1234 — civic awareness and transparency",
    occurred_at: new Date().toISOString(),
    source: { name: "openstates", id: "1", url: "https://openstates.org/tx/bills/HB1234" },
  });
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx",
    title: "HB9999 — unrelated matter",
    occurred_at: new Date().toISOString(),
    source: { name: "openstates", id: "2", url: "https://openstates.org/tx/bills/HB9999" },
  });
  // California's identifier style differs (AB/SB for Assembly/Senate).
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-ca",
    title: "AB123 — california civic awareness act",
    occurred_at: new Date().toISOString(),
    source: { name: "openstates", id: "3", url: "https://openstates.org/ca/bills/AB123" },
  });
});
afterEach(() => store.close());

describe("search_civic_documents", () => {
  it("matches by title substring across jurisdictions", async () => {
    const res = await handleSearchDocuments(store.db, { q: "civic awareness" });
    // Matches both the TX HB1234 and the CA AB123.
    expect(res.results).toHaveLength(2);
    const titles = res.results.map((r) => r.title);
    expect(titles.some((t) => t.includes("HB1234"))).toBe(true);
    expect(titles.some((t) => t.includes("AB123"))).toBe(true);
  });
  it("filters by source", async () => {
    const res = await handleSearchDocuments(store.db, {
      q: "HB", sources: ["openstates"],
    });
    expect(res.results).toHaveLength(2);
  });
});
```

- [x] **Step 7.2: Implement `src/mcp/tools/search_civic_documents.ts`**

```ts
import type Database from "better-sqlite3";
import { SearchDocumentsInput } from "../schemas.js";

export interface DocumentMatch {
  id: string;
  kind: string;
  title: string;
  summary?: string;
  occurred_at: string;
  source_url: string;
}

export interface SearchDocumentsResponse {
  results: DocumentMatch[];
  total: number;
  sources: Array<{ name: string; url: string }>;
}

interface Row {
  id: string; kind: string; title: string; summary: string | null;
  occurred_at: string; source_url: string; source_name: string;
  jurisdiction: string;
}

export async function handleSearchDocuments(
  db: Database.Database,
  rawInput: unknown,
): Promise<SearchDocumentsResponse> {
  const input = SearchDocumentsInput.parse(rawInput);
  const clauses = ["title LIKE ?"];
  const params: unknown[] = [`%${input.q}%`];
  if (input.kinds?.length) {
    const qs = input.kinds.map(() => "?").join(",");
    clauses.push(`kind IN (${qs})`);
    params.push(...input.kinds);
  }
  if (input.sources?.length) {
    const qs = input.sources.map(() => "?").join(",");
    clauses.push(`source_name IN (${qs})`);
    params.push(...input.sources);
  }
  if (input.from) { clauses.push("occurred_at >= ?"); params.push(input.from); }
  if (input.to)   { clauses.push("occurred_at <= ?"); params.push(input.to); }
  params.push(input.limit);

  const rows = db.prepare(
    `SELECT id, kind, title, summary, occurred_at, source_url, source_name, jurisdiction
     FROM documents WHERE ${clauses.join(" AND ")}
     ORDER BY occurred_at DESC LIMIT ?`,
  ).all(...params) as Row[];

  // (source_name, jurisdiction) → jurisdiction-aware browse URL.
  const sourceKeys = new Map<string, { name: string; jurisdiction: string }>();
  const results: DocumentMatch[] = rows.map((r) => {
    sourceKeys.set(`${r.source_name}|${r.jurisdiction}`, {
      name: r.source_name, jurisdiction: r.jurisdiction,
    });
    return {
      id: r.id, kind: r.kind, title: r.title,
      summary: r.summary ?? undefined,
      occurred_at: r.occurred_at, source_url: r.source_url,
    };
  });

  const sources = Array.from(sourceKeys.values()).map(({ name, jurisdiction }) => {
    if (name === "openstates") {
      const stateAbbr = jurisdiction.replace(/^us-/, "");
      return { name, url: `https://openstates.org/${stateAbbr}/` };
    }
    return { name, url: "" };
  });

  return { results, total: results.length, sources };
}
```

- [x] **Step 7.3: Register and commit**

```ts
// in src/mcp/server.ts buildServer()
mcp.registerTool(
  "search_civic_documents",
  {
    description:
      "Search civic documents (currently U.S. state legislative bills) " +
      "by title across all ingested jurisdictions.",
    inputSchema: SearchDocumentsInput.shape,
  },
  async (input) => {
    const data = await handleSearchDocuments(store.db, input);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);
```

```bash
pnpm test tests/unit/mcp/tools/search_civic_documents.test.ts
git add src/mcp/tools/search_civic_documents.ts tests/unit/mcp/tools/search_civic_documents.test.ts src/mcp/server.ts docs/plans/phase-2-openstates.md
git commit -m "feat: search_civic_documents MCP tool (title substring)"
```

---

## Task 8: End-to-end integration test

**Files:** `tests/integration/openstates-e2e.test.ts`,
modify `vitest.config.ts`

Runs the real adapter against a local DB using recorded fixtures — or
against the live API, guarded by an env flag.

- [ ] **Step 8.1: Record a fixture** (optional; skip if running live)

```bash
mkdir -p tests/integration/fixtures
# Record a non-Arizona state to prove the adapter is not AZ-locked.
# Any state works; TX is used here because its session is typically
# active and has healthy sponsor metadata.
curl -H "X-API-KEY: $OPENSTATES_API_KEY" \
  "https://v3.openstates.org/bills?jurisdiction=tx&per_page=5&page=1&include=sponsorships,abstracts,actions" \
  > tests/integration/fixtures/openstates-bills-page1.json
curl -H "X-API-KEY: $OPENSTATES_API_KEY" \
  "https://v3.openstates.org/people?jurisdiction=tx&per_page=5&page=1" \
  > tests/integration/fixtures/openstates-people-page1.json
```

- [ ] **Step 8.2: Write the integration test**

```ts
// tests/integration/openstates-e2e.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/core/seeds.js";
import { OpenStatesAdapter } from "../../src/adapters/openstates.js";
import { handleRecentBills } from "../../src/mcp/tools/recent_bills.js";

const TEST_DB = "./data/test-openstates-e2e.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  const billsFixture = readFileSync("tests/integration/fixtures/openstates-bills-page1.json", "utf-8");
  const peopleFixture = readFileSync("tests/integration/fixtures/openstates-people-page1.json", "utf-8");
  vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
    const u = String(url);
    if (u.includes("/people")) return new Response(peopleFixture, { status: 200 });
    if (u.includes("/bills"))  return new Response(billsFixture,  { status: 200 });
    return new Response("", { status: 404 });
  });
});
afterEach(() => { store.close(); vi.restoreAllMocks(); });

describe("openstates end-to-end", () => {
  it("refreshes and exposes via recent_bills", async () => {
    const adapter = new OpenStatesAdapter({ apiKey: "fake" });
    const result = await adapter.refresh({ db: store.db, maxPages: 1, jurisdiction: "tx" });
    expect(result.errors).toEqual([]);
    expect(result.documentsUpserted).toBeGreaterThan(0);

    const bills = await handleRecentBills(store.db, { days: 365, jurisdiction: "us-tx" });
    expect(bills.results.length).toBeGreaterThan(0);
    expect(bills.sources[0].name).toBe("openstates");
    expect(bills.sources[0].url).toContain("/tx/");
  });
});
```

- [ ] **Step 8.3: Update vitest.config.ts to include integration tests**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 15000,
  },
});
```

(Already includes `tests/**` — no change needed.)

- [ ] **Step 8.4: Run and commit**

```bash
pnpm test
git add tests/integration/openstates-e2e.test.ts tests/integration/fixtures/
git commit -m "test: openstates end-to-end integration"
```

---

## Phase 2 completion checklist

- [ ] All tests pass (unit + integration)
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` produces a working dist
- [ ] `OPENSTATES_API_KEY=... pnpm refresh --source=openstates --jurisdictions=tx --max-pages=1`
      completes without errors against the real API for at least one
      state. A separate run with `--jurisdictions=ca` also completes
      cleanly (proves the adapter is not state-specific).
- [ ] In Claude Desktop (configured per README), asking "what bills did
      the Texas House update this week?" returns an answer citing at
      least one OpenStates URL under `/tx/`. Repeating the question
      for California (or any other state) works identically.

---

## Self-review

- **Spec coverage:** The four tools from `docs/05-tool-surface.md` for
  Phase 2 (`recent_bills`, `search_entities`, `get_entity`,
  `search_civic_documents`) are implemented. The OpenStates adapter
  produces `Person` entities and `Bill` documents with `sponsor` /
  `cosponsor` references, matching `docs/04-entity-schema.md`.
- **No placeholders:** Every step has concrete code and runnable
  commands.
- **Type consistency:** Tool input schemas in `src/mcp/schemas.ts` are
  referenced consistently from tool implementations and the server
  registration.
- **Handler naming consistency:** Every tool exports a `handle*`
  function used by both the test and the server registration.

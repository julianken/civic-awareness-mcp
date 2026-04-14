import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { OpenStatesAdapter, BillNotFoundError, type OpenStatesBillDetail } from "../../../src/adapters/openstates.js";

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

  it("writes latest-action date into occurred_at, not updated_at", async () => {
    const billWithLateAction = {
      ...SAMPLE_BILL,
      updated_at: "2026-04-10T10:00:00Z",
      actions: [
        { date: "2025-09-17", description: "Introduced" },
        { date: "2025-09-18", description: "Became law" },
      ],
    };
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
          JSON.stringify({ results: [billWithLateAction], pagination: { max_page: 1, page: 1 } }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const adapter = new OpenStatesAdapter({ apiKey: "test" });
    await adapter.refresh({ db: store.db, jurisdiction: "tx" });

    const row = store.db
      .prepare("SELECT occurred_at FROM documents WHERE kind = 'bill'")
      .get() as { occurred_at: string };
    expect(row.occurred_at).toMatch(/^2025-09-18T/);
  });

  it("falls back to updated_at when actions[] is empty", async () => {
    const billWithoutActions = { ...SAMPLE_BILL, actions: [] };
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
          JSON.stringify({ results: [billWithoutActions], pagination: { max_page: 1, page: 1 } }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const adapter = new OpenStatesAdapter({ apiKey: "test" });
    await adapter.refresh({ db: store.db, jurisdiction: "tx" });

    const row = store.db
      .prepare("SELECT occurred_at FROM documents WHERE kind = 'bill'")
      .get() as { occurred_at: string };
    // SAMPLE_BILL.updated_at is "2026-04-01T10:00:00Z"
    expect(row.occurred_at).toMatch(/^2026-04-01T/);
  });

  it("falls back to updated_at when last action lacks a date field", async () => {
    const bill = {
      ...SAMPLE_BILL,
      updated_at: "2026-04-10T10:00:00Z",
      actions: [
        { date: "2025-09-17", description: "introduced" },
        { description: "no date recorded" },
      ],
    };
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
          JSON.stringify({ results: [bill], pagination: { max_page: 1, page: 1 } }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const adapter = new OpenStatesAdapter({ apiKey: "test" });
    await adapter.refresh({ db: store.db, jurisdiction: "tx" });

    const row = store.db
      .prepare("SELECT occurred_at FROM documents WHERE kind = 'bill'")
      .get() as { occurred_at: string };
    // Last action has no date → adapter falls through to updated_at.
    expect(row.occurred_at).toMatch(/^2026-04-10T/);
  });

  it("populates roles[] from bill jurisdiction when sponsor person lacks jurisdiction", async () => {
    // Sponsorship-only person: has current_role but no jurisdiction
    // (matches OpenStates' actual sponsorship payload shape).
    const sponsorPerson = {
      id: "ocd-person/sponsor-only",
      name: "Brandon Creighton",
      party: "Republican",
      current_role: { title: "Senator", district: "4", org_classification: "upper" },
      // deliberately no jurisdiction field
    };
    const bill = {
      ...SAMPLE_BILL,
      id: "ocd-bill/with-sponsor-only",
      sponsorships: [{ name: "Brandon Creighton", classification: "primary", person: sponsorPerson }],
    };
    // /people returns empty (so the person is ONLY created via the sponsorship
    // path), /bills returns the above bill.
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes("/people")) {
        return new Response(
          JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }),
          { status: 200 },
        );
      }
      if (u.includes("/bills")) {
        return new Response(
          JSON.stringify({ results: [bill], pagination: { max_page: 1, page: 1 } }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const adapter = new OpenStatesAdapter({ apiKey: "test" });
    await adapter.refresh({ db: store.db, jurisdiction: "tx" });

    const row = store.db.prepare(
      "SELECT metadata FROM entities WHERE json_extract(external_ids, '$.openstates_person') = ?",
    ).get("ocd-person/sponsor-only") as { metadata: string };
    const meta = JSON.parse(row.metadata);
    expect(meta.roles).toHaveLength(1);
    expect(meta.roles[0]).toMatchObject({
      jurisdiction: "us-tx",
      role: "state_legislator",
      to: null,
    });
    // Scalar metadata from the sponsorship's current_role should still land too.
    expect(meta).toMatchObject({
      party: "Republican",
      title: "Senator",
      district: "4",
      chamber: "upper",
    });
  });

  it("stops paginating when deadline has already passed", async () => {
    const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
    const past = Date.now() - 1;
    const r = await adapter.refresh({ db: store.db, jurisdiction: "tx", deadline: past });
    expect(r.documentsUpserted).toBe(0);
    expect(r.entitiesUpserted).toBe(0);
  });

  // Regression test: OpenStates v3 rejects comma-separated `include`
  // with HTTP 422. The API expects `include` as a repeated query
  // parameter (include=sponsorships&include=abstracts&include=actions),
  // not a single comma-joined value. Verified against the live API
  // 2026-04-13 during first Phase 5 preload.
  it("sends /bills include fields as repeated query params, not comma-separated", async () => {
    const mockFetch = vi.mocked(global.fetch);
    const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db, jurisdiction: "tx" });
    const billsUrl = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("/bills"));
    expect(billsUrl).toBeDefined();
    // Must have each include as its own param — not "include=A,B,C".
    expect(billsUrl).toContain("include=sponsorships");
    expect(billsUrl).toContain("include=abstracts");
    expect(billsUrl).toContain("include=actions");
    expect(billsUrl).not.toMatch(/include=[^&]*,/);
  });
});

describe("upsertBill persists detail fields in raw", () => {
  it("stores subjects, versions, documents, related_bills, sponsorships", () => {
    const detailDb = openStore("./data/test-openstates-detail.db");
    seedJurisdictions(detailDb.db);
    const adapter = new OpenStatesAdapter({ apiKey: "test" });
    (adapter as unknown as {
      upsertBill: (db: Database.Database, b: OpenStatesBillDetail) => void
    }).upsertBill(detailDb.db, {
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
    const row = detailDb.db
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
    detailDb.close();
  });
});

describe("fetchBill", () => {
  const FETCHBILL_DB = "./data/test-openstates-fetchbill.db";
  const FETCHBILL_404_DB = "./data/test-openstates-fetchbill-404.db";

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(FETCHBILL_DB)) rmSync(FETCHBILL_DB, { force: true });
    if (existsSync(FETCHBILL_404_DB)) rmSync(FETCHBILL_404_DB, { force: true });
  });

  it("fetches one bill by jurisdiction+session+identifier and upserts", async () => {
    let capturedUrl: string | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({
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
      }), { status: 200 });
    });

    if (existsSync(FETCHBILL_DB)) rmSync(FETCHBILL_DB, { force: true });
    const db = openStore(FETCHBILL_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test" });
      await adapter.fetchBill(db.db, {
        jurisdiction: "us-ca",
        session: "20252026",
        identifier: "SB 1338",
      });

      expect(capturedUrl).toBeDefined();
      expect(capturedUrl).toContain("/bills/ca/20252026/SB%201338");
      for (const inc of ["sponsorships", "abstracts", "actions", "versions",
                         "documents", "sources", "related_bills"]) {
        expect(capturedUrl).toContain(`include=${inc}`);
      }

      const row = db.db
        .prepare("SELECT title FROM documents WHERE source_id = ?")
        .get("ocd-bill/abc") as { title: string } | undefined;
      expect(row?.title).toBe("SB 1338 — Vehicles: repossession.");
    } finally {
      db.close();
    }
  });

  it("throws BillNotFoundError on 404", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ detail: "not found" }), { status: 404 }),
    );

    if (existsSync(FETCHBILL_404_DB)) rmSync(FETCHBILL_404_DB, { force: true });
    const db = openStore(FETCHBILL_404_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test" });
      await expect(
        adapter.fetchBill(db.db, {
          jurisdiction: "us-ca", session: "20252026", identifier: "XX 9999",
        })
      ).rejects.toThrow(BillNotFoundError);
    } finally {
      db.close();
    }
  });
});

describe("OpenStatesAdapter.fetchRecentBills", () => {
  const FRB_DB = "./data/test-openstates-frb.db";
  const FRB_SINCE_DB = "./data/test-openstates-frb-since.db";

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(FRB_DB)) rmSync(FRB_DB, { force: true });
    if (existsSync(FRB_SINCE_DB)) rmSync(FRB_SINCE_DB, { force: true });
  });

  it("fetches one page of recently-updated bills for a jurisdiction and writes them", async () => {
    let capturedUrl: string | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({
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
        pagination: { max_page: 5, page: 1 },
      }), { status: 200 });
    });

    if (existsSync(FRB_DB)) rmSync(FRB_DB, { force: true });
    const db = openStore(FRB_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      const result = await adapter.fetchRecentBills(db.db, { jurisdiction: "us-tx" });

      expect(capturedUrl).toBeDefined();
      const u = new URL(capturedUrl!);
      expect(u.searchParams.get("jurisdiction")).toBe("tx");
      expect(u.searchParams.get("sort")).toBe("updated_desc");
      expect(u.searchParams.get("per_page")).toBe("20");
      expect(u.searchParams.get("updated_since")).toBeNull();

      expect(result.documentsUpserted).toBe(1);
      const bills = db.db.prepare(
        "SELECT id, title FROM documents WHERE source_name='openstates' AND kind='bill'",
      ).all() as Array<{ id: string; title: string }>;
      expect(bills).toHaveLength(1);
      expect(bills[0].title).toMatch(/^HB1 — /);
    } finally {
      db.close();
    }
  });

  it("passes updated_since when provided", async () => {
    let capturedUrl: string | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }),
        { status: 200 },
      );
    });

    if (existsSync(FRB_SINCE_DB)) rmSync(FRB_SINCE_DB, { force: true });
    const db = openStore(FRB_SINCE_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      await adapter.fetchRecentBills(db.db, {
        jurisdiction: "us-tx",
        updated_since: "2026-04-01",
      });

      expect(capturedUrl).toBeDefined();
      const u = new URL(capturedUrl!);
      expect(u.searchParams.get("updated_since")).toBe("2026-04-01");
    } finally {
      db.close();
    }
  });

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
});

describe("OpenStatesAdapter.searchPeople", () => {
  const SP_DB = "./data/test-openstates-sp.db";
  const SP_EMPTY_DB = "./data/test-openstates-sp-empty.db";

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(SP_DB)) rmSync(SP_DB, { force: true });
    if (existsSync(SP_EMPTY_DB)) rmSync(SP_EMPTY_DB, { force: true });
  });

  it("fetches /people with jurisdiction+name params and writes upserted persons", async () => {
    let capturedUrl: string | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({
        results: [
          {
            id: "ocd-person/tx-1",
            name: "Jane Doe",
            party: "Democratic",
            current_role: { title: "Representative", district: "15", org_classification: "lower" },
            jurisdiction: { id: "ocd-jurisdiction/country:us/state:tx/government" },
          },
        ],
        pagination: { max_page: 1, page: 1 },
      }), { status: 200 });
    });

    if (existsSync(SP_DB)) rmSync(SP_DB, { force: true });
    const db = openStore(SP_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      const result = await adapter.searchPeople(db.db, {
        jurisdiction: "us-tx",
        name: "Jane",
      });

      expect(capturedUrl).toBeDefined();
      const u = new URL(capturedUrl!);
      expect(u.searchParams.get("jurisdiction")).toBe("tx");
      expect(u.searchParams.get("name")).toBe("Jane");
      expect(u.searchParams.get("per_page")).toBe("20");

      expect(result.entitiesUpserted).toBe(1);
      const rows = db.db
        .prepare("SELECT name FROM entities WHERE kind = 'person'")
        .all() as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("Jane Doe");
    } finally {
      db.close();
    }
  });

  it("returns 0 entitiesUpserted for an empty results body", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }),
        { status: 200 },
      ),
    );

    if (existsSync(SP_EMPTY_DB)) rmSync(SP_EMPTY_DB, { force: true });
    const db = openStore(SP_EMPTY_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      const result = await adapter.searchPeople(db.db, {
        jurisdiction: "us-tx",
        name: "Nonexistent",
      });
      expect(result.entitiesUpserted).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("OpenStatesAdapter.fetchBillsBySponsor", () => {
  const FBS_DB = "./data/test-openstates-fbs.db";

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(FBS_DB)) rmSync(FBS_DB, { force: true });
  });

  it("fetches /bills with sponsor= and upserts returned bills", async () => {
    let capturedUrl: string | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({
        results: [
          {
            id: "ocd-bill/tx-1",
            identifier: "HB1",
            title: "Test Bill",
            session: "89R",
            updated_at: "2026-04-10T00:00:00Z",
            openstates_url: "https://openstates.org/tx/bills/89R/HB1",
            jurisdiction: { id: "ocd-jurisdiction/country:us/state:tx/government" },
            sponsorships: [],
            actions: [{ date: "2026-04-10", description: "Introduced" }],
          },
        ],
        pagination: { max_page: 1, page: 1 },
      }), { status: 200 });
    });

    if (existsSync(FBS_DB)) rmSync(FBS_DB, { force: true });
    const db = openStore(FBS_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      const result = await adapter.fetchBillsBySponsor(db.db, {
        sponsor: "ocd-person/tx-1",
      });

      expect(capturedUrl).toBeDefined();
      const u = new URL(capturedUrl!);
      expect(u.searchParams.get("sponsor")).toBe("ocd-person/tx-1");
      expect(u.searchParams.get("sort")).toBe("updated_desc");
      for (const inc of ["sponsorships", "abstracts", "actions"]) {
        expect(capturedUrl).toContain(`include=${inc}`);
      }

      expect(result.documentsUpserted).toBe(1);
      const bills = db.db.prepare(
        "SELECT id, title FROM documents WHERE source_name='openstates' AND kind='bill'",
      ).all() as Array<{ id: string; title: string }>;
      expect(bills).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("OpenStatesAdapter.fetchPerson", () => {
  const FP_DB = "./data/test-openstates-fp.db";
  const FP_404_DB = "./data/test-openstates-fp-404.db";

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(FP_DB)) rmSync(FP_DB, { force: true });
    if (existsSync(FP_404_DB)) rmSync(FP_404_DB, { force: true });
  });

  it("fetches /people/{ocdId} and upserts the returned Person", async () => {
    let capturedUrl: string | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({
        id: "ocd-person/tx-1",
        name: "Jane Doe",
        party: "Democratic",
        current_role: { title: "Representative", district: "15", org_classification: "lower" },
        jurisdiction: { id: "ocd-jurisdiction/country:us/state:tx/government" },
      }), { status: 200 });
    });

    if (existsSync(FP_DB)) rmSync(FP_DB, { force: true });
    const db = openStore(FP_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      const result = await adapter.fetchPerson(db.db, "ocd-person/tx-1");

      expect(capturedUrl).toBeDefined();
      expect(capturedUrl).toContain("/people/ocd-person%2Ftx-1");
      expect(result.entitiesUpserted).toBe(1);
      const rows = db.db
        .prepare("SELECT name FROM entities WHERE json_extract(external_ids, '$.openstates_person') = ?")
        .all("ocd-person/tx-1") as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("Jane Doe");
    } finally {
      db.close();
    }
  });

  it("returns entitiesUpserted=0 on 404 without throwing", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ detail: "not found" }), { status: 404 }),
    );

    if (existsSync(FP_404_DB)) rmSync(FP_404_DB, { force: true });
    const db = openStore(FP_404_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      const result = await adapter.fetchPerson(db.db, "ocd-person/does-not-exist");
      expect(result.entitiesUpserted).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("OpenStatesAdapter.listBills", () => {
  const LB_PARAMS_DB = "./data/test-openstates-lb-params.db";
  const LB_DATES_DB = "./data/test-openstates-lb-dates.db";
  const LB_SORT_DB = "./data/test-openstates-lb-sort.db";
  const LB_WRITE_DB = "./data/test-openstates-lb-write.db";
  const LB_SPONSOR_DB = "./data/test-openstates-lb-sponsor.db";
  const LB_FAIL_DB = "./data/test-openstates-lb-fail.db";

  afterEach(() => {
    vi.restoreAllMocks();
    for (const p of [LB_PARAMS_DB, LB_DATES_DB, LB_SORT_DB, LB_WRITE_DB, LB_SPONSOR_DB, LB_FAIL_DB]) {
      if (existsSync(p)) rmSync(p, { force: true });
    }
  });

  it("maps jurisdiction, session, chamber, classification, subject to query params", async () => {
    let capturedUrl: string | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }),
        { status: 200 },
      );
    });

    if (existsSync(LB_PARAMS_DB)) rmSync(LB_PARAMS_DB, { force: true });
    const db = openStore(LB_PARAMS_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      await adapter.listBills(db.db, {
        jurisdiction: "us-tx",
        session: "89R",
        chamber: "upper",
        classification: "bill",
        subject: "Vehicles",
        sort: "updated_desc",
        limit: 20,
      });

      expect(capturedUrl).toBeDefined();
      const params = new URL(capturedUrl!).searchParams;
      expect(params.get("jurisdiction")).toBe("tx");
      expect(params.get("session")).toBe("89R");
      expect(params.get("chamber")).toBe("upper");
      expect(params.get("classification")).toBe("bill");
      expect(params.get("subject")).toBe("Vehicles");
      expect(params.get("sort")).toBe("updated_desc");
      expect(params.get("per_page")).toBe("20");
    } finally {
      db.close();
    }
  });

  it("maps introduced_since to created_since and updated_since directly", async () => {
    let capturedUrl: string | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }),
        { status: 200 },
      );
    });

    if (existsSync(LB_DATES_DB)) rmSync(LB_DATES_DB, { force: true });
    const db = openStore(LB_DATES_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      await adapter.listBills(db.db, {
        jurisdiction: "us-tx",
        introduced_since: "2026-01-01",
        updated_since: "2026-03-01",
        sort: "updated_desc",
        limit: 20,
      });

      expect(capturedUrl).toBeDefined();
      const params = new URL(capturedUrl!).searchParams;
      expect(params.get("created_since")).toBe("2026-01-01");
      expect(params.get("updated_since")).toBe("2026-03-01");
      expect(params.has("created_before")).toBe(false);
      expect(params.has("updated_before")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("maps introduced_desc sort to first_action_desc", async () => {
    let capturedUrl: string | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }),
        { status: 200 },
      );
    });

    if (existsSync(LB_SORT_DB)) rmSync(LB_SORT_DB, { force: true });
    const db = openStore(LB_SORT_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      await adapter.listBills(db.db, {
        jurisdiction: "us-tx",
        sort: "introduced_desc",
        limit: 20,
      });

      expect(capturedUrl).toBeDefined();
      expect(new URL(capturedUrl!).searchParams.get("sort")).toBe("first_action_desc");
    } finally {
      db.close();
    }
  });

  it("writes through with upsertBill on successful fetch", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
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
        pagination: { max_page: 1, page: 1 },
      }), { status: 200 }),
    );

    if (existsSync(LB_WRITE_DB)) rmSync(LB_WRITE_DB, { force: true });
    const db = openStore(LB_WRITE_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      const result = await adapter.listBills(db.db, {
        jurisdiction: "us-tx", sort: "updated_desc", limit: 20,
      });

      expect(result.documentsUpserted).toBe(1);
      const rows = db.db.prepare(
        "SELECT title FROM documents WHERE source_name='openstates' AND kind='bill'",
      ).all() as Array<{ title: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toMatch(/^HB42 — /);
    } finally {
      db.close();
    }
  });

  it("passes sponsor as the sponsor query parameter when provided", async () => {
    let capturedUrl: string | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }),
        { status: 200 },
      );
    });

    if (existsSync(LB_SPONSOR_DB)) rmSync(LB_SPONSOR_DB, { force: true });
    const db = openStore(LB_SPONSOR_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      await adapter.listBills(db.db, {
        jurisdiction: "us-tx",
        sponsor: "ocd-person/abc",
        sort: "updated_desc",
        limit: 20,
      });

      expect(capturedUrl).toBeDefined();
      expect(new URL(capturedUrl!).searchParams.get("sponsor")).toBe("ocd-person/abc");
    } finally {
      db.close();
    }
  });

  it("throws on non-200 response", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () =>
      new Response("boom", { status: 500 }),
    );

    if (existsSync(LB_FAIL_DB)) rmSync(LB_FAIL_DB, { force: true });
    const db = openStore(LB_FAIL_DB);
    seedJurisdictions(db.db);
    try {
      const adapter = new OpenStatesAdapter({ apiKey: "test-key" });
      await expect(
        adapter.listBills(db.db, { jurisdiction: "us-tx", sort: "updated_desc", limit: 20 }),
      ).rejects.toThrow(/OpenStates \/bills returned 500/);
    } finally {
      db.close();
    }
  });
});

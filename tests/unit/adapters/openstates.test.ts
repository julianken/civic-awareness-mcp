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

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

    // Use a focused mock that only returns Schumer's data (no other members/votes)
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch({
      members: [SAMPLE_MEMBER],
      bills: [],
      votes: [],
    }));
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

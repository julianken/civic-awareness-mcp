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
  it(
    "surfaces errors cleanly when Congress.gov returns a 429",
    { timeout: 30_000 },
    async () => {
      // The adapter has three independent try/catches (members, bills,
      // votes). A 429 on all three paths triggers rateLimitedFetch's
      // exponential backoff per section (≈7s each, 21s total), so the
      // default 10s vitest timeout isn't enough. Bump to 30s.
      vi.spyOn(global, "fetch").mockResolvedValue(
        new Response("Too Many Requests", { status: 429 }),
      );
      const adapter = new CongressAdapter({ apiKey: "test-key" });
      const result = await adapter.refresh({ db: store.db });
      // The adapter catches errors per-section; it does not throw.
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/429/);
    },
  );

  // Characterization test for the storage chokepoint. Proves the
  // adapter's `if (!occurred.includes("T"))` shortcut at upsertBill
  // is redundant — `upsertDocument` normalizes any valid ISO string,
  // including date-only, to canonical millisecond Z form. If this
  // passes both before and after deleting that shortcut, the
  // shortcut was dead weight.
  it("stores canonical millisecond Z form when updateDate is date-only", async () => {
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch({
      bills: [{ ...SAMPLE_BILL, updateDate: "2025-04-04" }],
      members: [],
      votes: [],
    }));
    const adapter = new CongressAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db });
    const doc = store.db
      .prepare("SELECT occurred_at FROM documents WHERE kind = 'bill'")
      .get() as { occurred_at: string };
    expect(doc.occurred_at).toBe("2025-04-04T00:00:00.000Z");
  });

  // ── Deadline test ─────────────────────────────────────────────────
  it("stops paginating when deadline has already passed", async () => {
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new CongressAdapter({ apiKey: "test-key" });
    const past = Date.now() - 1;
    const r = await adapter.refresh({ db: store.db, deadline: past });
    expect(r.documentsUpserted).toBe(0);
    expect(r.entitiesUpserted).toBe(0);
  });

  // ── Test 6: /vote 404 is graceful degradation, not an error ──────
  it("does not count /vote 404 as an error (graceful degradation)", async () => {
    // Members + bills succeed (empty results); /vote returns 404 as
    // some Congress.gov API tiers don't expose the endpoint.
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes("/vote")) {
        return new Response("Not Found", { status: 404 });
      }
      if (u.includes("/member")) {
        return new Response(
          JSON.stringify({ members: [], pagination: { count: 0 } }),
          { status: 200 },
        );
      }
      if (u.includes("/bill")) {
        return new Response(
          JSON.stringify({ bills: [], pagination: { count: 0 } }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.refresh({ db: store.db });
    // /vote 404 was logged as warn but NOT counted as an error — the
    // refresh is still considered successful.
    expect(result.errors).toEqual([]);
  });
});

describe("CongressAdapter.fetchRecentBills", () => {
  it("fetches one page of recent bills with fromDateTime filter", async () => {
    let capturedUrl: string | null = null;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({
          bills: [
            {
              congress: 119,
              type: "HR",
              number: "123",
              title: "Test Bill",
              updateDate: "2026-04-10",
              url: "https://api.congress.gov/v3/bill/119/HR/123",
              sponsors: [{ bioguideId: "T000001", fullName: "Rep. T" }],
              latestAction: { actionDate: "2026-04-10", text: "Introduced" },
            },
          ],
          pagination: { count: 1 },
        }),
        { status: 200 },
      );
    });

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchRecentBills(store.db, {
      fromDateTime: "2026-04-01T00:00:00Z",
    });

    expect(capturedUrl).toBeTruthy();
    const u = new URL(capturedUrl!);
    expect(u.searchParams.get("fromDateTime")).toBe("2026-04-01T00:00:00Z");
    expect(u.searchParams.get("sort")).toBe("updateDate+desc");
    expect(u.searchParams.get("limit")).toBe("250");
    expect(u.searchParams.get("congress")).toBe("119");
    expect(u.searchParams.get("api_key")).toBe("test-key");

    expect(result.documentsUpserted).toBe(1);
    const bills = store.db
      .prepare(
        "SELECT id, title FROM documents WHERE source_name='congress' AND kind='bill'",
      )
      .all() as Array<{ id: string; title: string }>;
    expect(bills).toHaveLength(1);
  });

  it("filters by chamber when provided (upper = Senate, S prefix)", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          bills: [
            {
              congress: 119,
              type: "HR",
              number: "1",
              title: "House Bill",
              updateDate: "2026-04-10",
              url: "https://api.congress.gov/v3/bill/119/HR/1",
              sponsors: [],
              latestAction: null,
            },
            {
              congress: 119,
              type: "S",
              number: "2",
              title: "Senate Bill",
              updateDate: "2026-04-10",
              url: "https://api.congress.gov/v3/bill/119/S/2",
              sponsors: [],
              latestAction: null,
            },
          ],
          pagination: { count: 2 },
        }),
        { status: 200 },
      );
    });

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchRecentBills(store.db, {
      fromDateTime: "2026-04-01T00:00:00Z",
      chamber: "upper",
    });

    expect(result.documentsUpserted).toBe(1);
    const titles = store.db
      .prepare(
        "SELECT title FROM documents WHERE source_name='congress' AND kind='bill'",
      )
      .all() as Array<{ title: string }>;
    expect(titles).toHaveLength(1);
    expect(titles[0].title).toMatch(/Senate Bill/);
  });

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
});

describe("CongressAdapter.fetchRecentVotes", () => {
  it("fetches votes for current congress and writes them", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        votes: [{
          congress: 119, chamber: "Senate", rollNumber: 42,
          date: "2026-04-10T12:00:00Z",
          question: "Motion to proceed",
          result: "Passed",
          bill: { type: "S", number: "1234" },
          positions: [],
          totals: { yea: 60, nay: 40 },
        }],
        pagination: { count: 1 },
      }), { status: 200 }),
    );

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchRecentVotes(store.db);

    expect(result.documentsUpserted).toBe(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/\/vote\?/);
    expect(url).toMatch(/congress=119/);
    expect(url).toMatch(/api_key=test-key/);
    const written = store.db.prepare(
      "SELECT kind FROM documents WHERE source_name='congress' AND kind='vote'",
    ).all();
    expect(written).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("gracefully degrades on 404 (free-tier API limitation) — logs warn and returns 0", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 404 }),
    );
    const { logger } = await import("../../../src/util/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchRecentVotes(store.db);

    expect(result.documentsUpserted).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/free tier limitation/),
      expect.objectContaining({ endpoint: "/vote", status: 404 }),
    );
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("chamber filter selects senate/house votes client-side", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        votes: [
          { congress: 119, chamber: "Senate", rollNumber: 1, date: "2026-04-10", positions: [], totals: {} },
          { congress: 119, chamber: "House", rollNumber: 2, date: "2026-04-10", positions: [], totals: {} },
        ],
        pagination: { count: 2 },
      }), { status: 200 }),
    );

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchRecentVotes(store.db, { chamber: "upper" });

    expect(result.documentsUpserted).toBe(1);
    fetchSpy.mockRestore();
  });
});

describe("CongressAdapter.searchMembers", () => {
  it("fetches /member for the current congress and writes upserted members", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        members: [SAMPLE_MEMBER],
        pagination: { count: 1 },
      }), { status: 200 }),
    );

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.searchMembers(store.db);

    expect(result.entitiesUpserted).toBe(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/\/member/);
    expect(url).toMatch(/congress=119/);
    expect(url).toMatch(/limit=250/);
    expect(url).toMatch(/api_key=test-key/);

    const rows = store.db
      .prepare(
        "SELECT name FROM entities WHERE json_extract(external_ids, '$.bioguide') = ?",
      )
      .all("S000148") as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("returns 0 entitiesUpserted for an empty members body", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ members: [], pagination: { count: 0 } }), { status: 200 }),
    );

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.searchMembers(store.db);
    expect(result.entitiesUpserted).toBe(0);
  });
});

describe("CongressAdapter.fetchMember", () => {
  it("fetches /member/{bioguideId} and upserts the returned Member", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ member: SAMPLE_MEMBER }), { status: 200 }),
    );

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchMember(store.db, "S000148");

    expect(result.entitiesUpserted).toBe(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/\/member\/S000148/);
    expect(url).toMatch(/api_key=test-key/);

    const rows = store.db
      .prepare(
        "SELECT name FROM entities WHERE json_extract(external_ids, '$.bioguide') = ?",
      )
      .all("S000148") as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("returns entitiesUpserted=0 on 404 without throwing AND logs warn", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );
    const { logger } = await import("../../../src/util/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchMember(store.db, "Z999999");
    expect(result.entitiesUpserted).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/member 404/),
      expect.objectContaining({ bioguideId: "Z999999", status: 404 }),
    );
    warnSpy.mockRestore();
  });

  it("returns 0 when body omits the member field AND logs warn", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const { logger } = await import("../../../src/util/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchMember(store.db, "S000148");
    expect(result.entitiesUpserted).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/no member field/),
      expect.objectContaining({ bioguideId: "S000148" }),
    );
    warnSpy.mockRestore();
  });
});

describe("CongressAdapter.fetchMemberSponsoredBills", () => {
  it("fetches /member/{bioguideId}/sponsored-legislation and upserts returned bills", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ sponsoredLegislation: [SAMPLE_BILL] }),
        { status: 200 },
      ),
    );

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchMemberSponsoredBills(store.db, "S000148");

    expect(result.documentsUpserted).toBe(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/\/member\/S000148\/sponsored-legislation/);
    expect(url).toMatch(/api_key=test-key/);

    const bills = store.db
      .prepare("SELECT id FROM documents WHERE source_name='congress' AND kind='bill'")
      .all() as Array<{ id: string }>;
    expect(bills).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("returns documentsUpserted=0 on 404 without throwing AND logs warn", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );
    const { logger } = await import("../../../src/util/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchMemberSponsoredBills(store.db, "Z999999");
    expect(result.documentsUpserted).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/sponsored-legislation 404/),
      expect.objectContaining({ bioguideId: "Z999999", status: 404 }),
    );
    warnSpy.mockRestore();
  });
});

describe("CongressAdapter.fetchMemberCosponsoredBills", () => {
  it("fetches /member/{bioguideId}/cosponsored-legislation and upserts returned bills", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ cosponsoredLegislation: [SAMPLE_BILL] }),
        { status: 200 },
      ),
    );

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchMemberCosponsoredBills(store.db, "S000148");

    expect(result.documentsUpserted).toBe(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/\/member\/S000148\/cosponsored-legislation/);
    expect(url).toMatch(/api_key=test-key/);

    const bills = store.db
      .prepare("SELECT id FROM documents WHERE source_name='congress' AND kind='bill'")
      .all() as Array<{ id: string }>;
    expect(bills).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("returns documentsUpserted=0 on 404 without throwing AND logs warn", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );
    const { logger } = await import("../../../src/util/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.fetchMemberCosponsoredBills(store.db, "Z999999");
    expect(result.documentsUpserted).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/cosponsored-legislation 404/),
      expect.objectContaining({ bioguideId: "Z999999", status: 404 }),
    );
    warnSpy.mockRestore();
  });
});

describe("upsertVote persists per-member positions in raw.positions", () => {
  it("stores bioguideId, name, party, state, and position for each voter", async () => {
    const adapter = new CongressAdapter({ apiKey: "test" });
    (adapter as unknown as {
      upsertVote: (db: typeof store.db, v: unknown) => void;
    }).upsertVote(store.db, {
      congress: 119,
      chamber: "Senate",
      rollNumber: 42,
      date: "2026-04-01",
      question: "On Passage of HR 1234",
      result: "Passed",
      bill: { type: "HR", number: "1234" },
      positions: [
        {
          member: {
            bioguideId: "S000148",
            name: "Schumer, Charles E.",
            partyName: "Democratic",
            state: "NY",
          },
          votePosition: "Yea",
        },
        {
          member: {
            bioguideId: "M000355",
            name: "McConnell, Mitch",
            partyName: "Republican",
            state: "KY",
          },
          votePosition: "Nay",
        },
      ],
      totals: { yea: 1, nay: 1, present: 0, notVoting: 0 },
    });

    const row = store.db
      .prepare("SELECT raw FROM documents WHERE source_id = ?")
      .get("vote-119-senate-42") as { raw: string };
    const raw = JSON.parse(row.raw) as {
      positions: Array<{
        bioguideId: string;
        name: string;
        party: string | null;
        state: string | null;
        position: string;
      }>;
    };
    expect(raw.positions).toHaveLength(2);
    expect(raw.positions[0]).toMatchObject({
      bioguideId: "S000148",
      name: "Schumer, Charles E.",
      party: "Democratic",
      state: "NY",
      position: "yea",
    });
    expect(raw.positions[1].position).toBe("nay");
  });
});

describe("CongressAdapter.fetchVote", () => {
  it("fetches one roll-call vote by composite and upserts with positions", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          voteInformation: {
            congress: 119,
            chamber: "Senate",
            rollNumber: 42,
            date: "2026-04-01",
            question: "On Passage of HR 1234",
            result: "Passed",
            bill: { type: "HR", number: "1234" },
            totals: { yea: 1, nay: 1, present: 0, notVoting: 0 },
            members: {
              item: [
                {
                  bioguideId: "S000148",
                  name: "Schumer, Charles E.",
                  partyName: "Democratic",
                  state: "NY",
                  votePosition: "Yea",
                },
                {
                  bioguideId: "M000355",
                  name: "McConnell, Mitch",
                  partyName: "Republican",
                  state: "KY",
                  votePosition: "Nay",
                },
              ],
            },
          },
        }),
        { status: 200 },
      ),
    );

    const adapter = new CongressAdapter({ apiKey: "test-key" });
    const result = await adapter.fetchVote(store.db, {
      congress: 119, chamber: "upper", session: 1, roll_number: 42,
    });

    const calledUrl = String(fetchSpy.mock.calls[0][0]);
    expect(calledUrl).toMatch(/\/senate-vote\/119\/1\/42/);
    expect(calledUrl).toMatch(/api_key=test-key/);
    expect(calledUrl).toMatch(/format=json/);

    expect(result.documentId).toBeTruthy();
    const row = store.db
      .prepare("SELECT id, raw FROM documents WHERE source_id = ?")
      .get("vote-119-senate-42") as { id: string; raw: string };
    expect(row.id).toBe(result.documentId);
    const raw = JSON.parse(row.raw) as {
      positions: Array<{ bioguideId: string; position: string }>;
    };
    expect(raw.positions).toHaveLength(2);
    fetchSpy.mockRestore();
  });

  it("enriches a previously-seen entity with party and state metadata", async () => {
    // Seed the entity via a feed-list-style call that carries no party/state.
    const seeded = upsertEntity(store.db, {
      kind: "person",
      name: "Schumer, Charles E.",
      external_ids: { bioguide: "S000148" },
      metadata: {},
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          voteInformation: {
            congress: 119,
            chamber: "Senate",
            rollNumber: 42,
            date: "2026-04-01",
            question: "On Passage",
            result: "Passed",
            bill: { type: "HR", number: "1234" },
            totals: { yea: 1, nay: 0, present: 0, notVoting: 0 },
            members: {
              item: [
                {
                  bioguideId: "S000148",
                  name: "Schumer, Charles E.",
                  partyName: "Democratic",
                  state: "NY",
                  votePosition: "Yea",
                },
              ],
            },
          },
        }),
        { status: 200 },
      ),
    );

    const adapter = new CongressAdapter({ apiKey: "test-key" });
    await adapter.fetchVote(store.db, {
      congress: 119, chamber: "upper", session: 1, roll_number: 42,
    });

    const row = store.db
      .prepare("SELECT id, metadata FROM entities WHERE id = ?")
      .get(seeded.entity.id) as { id: string; metadata: string };
    expect(row).toBeDefined();
    const meta = JSON.parse(row.metadata) as { party?: string; state?: string };
    expect(meta.party).toBe("Democratic");
    expect(meta.state).toBe("NY");
    fetchSpy.mockRestore();
  });

  it("throws VoteNotFoundError on 404", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );
    const adapter = new CongressAdapter({ apiKey: "test-key" });
    await expect(
      adapter.fetchVote(store.db, {
        congress: 119, chamber: "lower", session: 1, roll_number: 9999,
      }),
    ).rejects.toThrow(/not found/i);
  });
});

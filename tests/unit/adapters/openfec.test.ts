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

beforeEach(async () => {
  vi.restoreAllMocks();
  if (existsSync(TEST_DB)) {
    rmSync(TEST_DB);
    // Give the filesystem time to fully release the file
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});

afterEach(() => {
  store.close();
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

    // Sample candidate has office="H" → role="federal_candidate_representative".
    // Other office codes map to "_senator" / "_president" / generic
    // "federal_candidate" — see officeToRole in src/adapters/openfec.ts.
    const meta = JSON.parse(row.metadata) as {
      roles?: Array<{ jurisdiction: string; role: string }>;
    };
    expect(meta.roles?.some((r) => r.role === "federal_candidate_representative")).toBe(true);
    expect(meta.roles?.some((r) => r.jurisdiction === "us-federal")).toBe(true);
  });

  // ── Test 2: Committee upsert as Organization ──────────────────────
  it("upserts a campaign committee as an Organization with fec_committee ID and jurisdiction", async () => {
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db });

    // Query for the specific committee by name
    const row = store.db
      .prepare(
        "SELECT name, kind, jurisdiction, external_ids FROM entities WHERE name = ? AND kind IN ('pac','committee','organization')",
      )
      .get("Smith for Congress") as {
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

    // Use a focused mock that only returns the candidate and committee (no contributions/expenditures)
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch({
      candidates: [SAMPLE_CANDIDATE],
      committees: [SAMPLE_COMMITTEE],
      scheduleA: [],
      scheduleB: [],
    }));
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
    expect(roleNames).toContain("federal_candidate_representative");
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

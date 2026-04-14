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

  // Characterization tests for the storage chokepoint. Prove the
  // adapter's `if (!date.includes("T"))` shortcuts at upsertContribution
  // and upsertExpenditure are redundant — `upsertDocument` normalizes
  // any valid ISO string, including date-only, to canonical
  // millisecond Z form. If these pass both before and after deleting
  // the shortcuts, the shortcuts were dead weight.
  it("stores contribution occurred_at as canonical Z form from a date-only contribution_receipt_date", async () => {
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db });
    const doc = store.db
      .prepare("SELECT occurred_at FROM documents WHERE kind = 'contribution'")
      .get() as { occurred_at: string };
    expect(doc.occurred_at).toBe("2026-01-15T00:00:00.000Z");
  });

  it("stores expenditure occurred_at as canonical Z form from a date-only disbursement_date", async () => {
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    await adapter.refresh({ db: store.db });
    const doc = store.db
      .prepare("SELECT occurred_at FROM documents WHERE kind = 'expenditure'")
      .get() as { occurred_at: string };
    expect(doc.occurred_at).toBe("2026-01-20T00:00:00.000Z");
  });

  // ── Deadline test ─────────────────────────────────────────────────
  it("stops paginating when deadline has already passed", async () => {
    vi.spyOn(global, "fetch").mockImplementation(makeMockFetch());
    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    const past = Date.now() - 1;
    const r = await adapter.refresh({ db: store.db, deadline: past });
    expect(r.documentsUpserted).toBe(0);
    expect(r.entitiesUpserted).toBe(0);
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

  // ── Test 8: Documents the titleCase/normalizeName under-match case ─
  //
  // Phase 4 self-review design call #1 flagged the FEC → Congress name
  // bridge as fragile. This test pins down the exact under-match
  // behavior: when the FEC and Congress.gov representations of the
  // same person differ beyond the bridge's reach (e.g., middle-name
  // word-order, missing suffix), two Person rows are created rather
  // than merged. That's the designed safety behavior — under-match
  // beats false-merge. If this test ever fails "too aggressively"
  // toward merging, reviewers MUST confirm the new behavior doesn't
  // produce false positives on common-name collisions.
  it("under-matches when FEC and Congress.gov name shapes differ materially (no false merge)", async () => {
    // Congress.gov-ingested Person with a slightly different name shape
    // than FEC returns. "John R. Smith" vs "SMITH, JOHN R." normalize
    // to "john r smith" vs "smith john r" — same tokens, different
    // order, so normalizeName outputs differ. upsertEntity creates a
    // new row rather than merging. Intentional under-match.
    upsertEntity(store.db, {
      kind: "person",
      name: "John R. Smith",   // NOTE: forward order, not "Smith, John R."
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

    // Fetch all persons. There will be more than two because the
    // contribution fixture also creates a contributor Person row
    // ("Jones, Alice M."). We don't care about that one — what we're
    // documenting is that the *candidate* row and the *bioguide* row
    // did NOT merge.
    const rows = store.db
      .prepare(
        "SELECT id, name, external_ids FROM entities WHERE kind = 'person'",
      )
      .all() as Array<{ id: string; name: string; external_ids: string }>;

    // Exactly one row has bioguide (the pre-seeded Congress row); the
    // other has fec_candidate only. Neither row has both — that's the
    // under-match outcome. If a future change collapses these into one,
    // reviewers MUST confirm the new normalization doesn't also merge
    // "John R. Smith" with an unrelated "John Robert Smith" from a
    // different context.
    const bioguideRows = rows.filter(
      (r) => (JSON.parse(r.external_ids) as Record<string, string>).bioguide != null,
    );
    const fecRows = rows.filter(
      (r) => (JSON.parse(r.external_ids) as Record<string, string>).fec_candidate != null,
    );
    expect(bioguideRows.length).toBe(1);
    expect(fecRows.length).toBe(1);
    // Confirm they're distinct rows, not the same row counted twice —
    // THE under-match assertion.
    expect(bioguideRows[0].id).not.toBe(fecRows[0].id);
    // And no row has both external IDs set (no accidental merge).
    const mergedRows = rows.filter((r) => {
      const ext = JSON.parse(r.external_ids) as Record<string, string>;
      return ext.bioguide != null && ext.fec_candidate != null;
    });
    expect(mergedRows.length).toBe(0);
  });

  // ── Test 9: Schedule A multi-page cursor pagination ───────────────
  it("follows Schedule A last_index cursor across multiple pages", async () => {
    // Build 100 contributions (per_page) on page 1, 1 contribution on
    // page 2 with no cursor → adapter should stop after page 2 having
    // accumulated all 101 rows.
    const page1Results = Array.from({ length: 100 }, (_, i) => ({
      ...SAMPLE_SCHEDULE_A,
      transaction_id: `SA17.page1-${i}`,
      contributor_name: `PAGE1 DONOR ${i}`,
    }));
    const page2Results = [
      {
        ...SAMPLE_SCHEDULE_A,
        transaction_id: "SA17.page2-0",
        contributor_name: "PAGE2 DONOR",
      },
    ];

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      // Non-schedule_a endpoints return empty responses so the refresh
      // doesn't blow up before reaching the cursor path.
      if (u.includes("/candidates/search") || u.includes("/committees")) {
        return new Response(
          JSON.stringify({
            results: [],
            pagination: { count: 0, per_page: 100, page: 1, pages: 1 },
          }),
          { status: 200 },
        );
      }
      if (u.includes("/schedules/schedule_b")) {
        return new Response(
          JSON.stringify({
            results: [],
            pagination: { count: 0, per_page: 100, page: 1, pages: 1 },
          }),
          { status: 200 },
        );
      }
      if (u.includes("/schedules/schedule_a")) {
        // Cursor param present on the second call → return page 2.
        if (u.includes("last_index=CURSOR-X")) {
          return new Response(
            JSON.stringify({
              results: page2Results,
              pagination: {
                count: 101, per_page: 100, page: 2, pages: 2,
                // No last_indexes → adapter stops here.
              },
            }),
            { status: 200 },
          );
        }
        // First call → return page 1 with a cursor.
        return new Response(
          JSON.stringify({
            results: page1Results,
            pagination: {
              count: 101, per_page: 100, page: 1, pages: 2,
              last_indexes: {
                last_index: "CURSOR-X",
                last_contribution_receipt_date: "2026-01-15",
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.spyOn(global, "fetch").mockImplementation(fetchMock);

    // Use a single cycle so we exercise the cursor within one
    // fetchSchedule invocation (the adapter calls fetchSchedule once per
    // cycle; default [2026, 2024] would give 4 total calls here and muddy
    // the cursor assertion).
    const adapter = new OpenFecAdapter({ apiKey: "test-key", cycles: [2026] });
    const result = await adapter.refresh({ db: store.db });
    expect(result.errors).toEqual([]);

    // All 101 contribution Documents should be in the store.
    const docCount = (
      store.db
        .prepare("SELECT COUNT(*) c FROM documents WHERE kind = 'contribution'")
        .get() as { c: number }
    ).c;
    expect(docCount).toBe(101);

    // Exactly 2 calls (page 1 + cursor page 2), and the second carries
    // both cursor params.
    const scheduleACalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/schedules/schedule_a"));
    expect(scheduleACalls.length).toBe(2);
    expect(scheduleACalls[1]).toContain("last_index=CURSOR-X");
    expect(scheduleACalls[1]).toContain("last_contribution_receipt_date=2026-01-15");
  });
});

describe("OpenFecAdapter.fetchRecentContributions", () => {
  it("fetches schedule_a page with date range", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        results: [{
          transaction_id: "T1", committee_id: "C001",
          contributor_name: "SMITH, JANE",
          contribution_receipt_amount: 2500,
          contribution_receipt_date: "2026-04-10",
        }],
        pagination: { per_page: 100 },
      }), { status: 200 }),
    );

    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    const result = await adapter.fetchRecentContributions(store.db, {
      min_date: "04/01/2026",
      max_date: "04/30/2026",
    });

    expect(result.documentsUpserted).toBe(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/\/schedules\/schedule_a/);
    expect(url).toMatch(/min_date=04%2F01%2F2026/);
    expect(url).toMatch(/max_date=04%2F30%2F2026/);
    expect(url).toMatch(/api_key=test-key/);
    const written = store.db.prepare(
      "SELECT kind FROM documents WHERE source_name='openfec' AND kind='contribution'",
    ).all();
    expect(written).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("passes committee_id when provided", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [], pagination: { per_page: 100 } }), { status: 200 }),
    );

    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    await adapter.fetchRecentContributions(store.db, {
      min_date: "04/01/2026",
      committee_ids: ["C001", "C002"],
    });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/committee_id=C001/);
    expect(url).toMatch(/committee_id=C002/);
    fetchSpy.mockRestore();
  });
});

describe("OpenFecAdapter.searchCandidates", () => {
  it("fetches /candidates/search with q param and writes upserted candidates", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        results: [SAMPLE_CANDIDATE],
        pagination: { per_page: 20, page: 1, pages: 1 },
      }), { status: 200 }),
    );

    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    const result = await adapter.searchCandidates(store.db, { q: "Smith" });

    expect(result.entitiesUpserted).toBe(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/\/candidates\/search/);
    expect(url).toMatch(/q=Smith/);
    expect(url).toMatch(/per_page=20/);
    expect(url).toMatch(/api_key=test-key/);

    const rows = store.db
      .prepare(
        "SELECT name FROM entities WHERE json_extract(external_ids, '$.fec_candidate') = ?",
      )
      .all("H0AZ01234") as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("returns 0 entitiesUpserted for an empty results body", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [], pagination: { per_page: 20 } }), { status: 200 }),
    );

    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    const result = await adapter.searchCandidates(store.db, { q: "Nonexistent" });
    expect(result.entitiesUpserted).toBe(0);
  });
});

describe("OpenFecAdapter.fetchContributionsToCandidate", () => {
  it("fetches candidate then schedule_a filtered by principal committee IDs", async () => {
    const scheduleACalls: string[] = [];
    vi.spyOn(global, "fetch").mockImplementation(async (input: any) => {
      const u = String(input);
      if (u.includes("/candidate/H0AZ01234/")) {
        return new Response(
          JSON.stringify({
            results: [SAMPLE_CANDIDATE],
            pagination: { per_page: 20, page: 1, pages: 1 },
          }),
          { status: 200 },
        );
      }
      if (u.includes("/schedules/schedule_a")) {
        scheduleACalls.push(u);
        return new Response(
          JSON.stringify({
            results: [SAMPLE_SCHEDULE_A],
            pagination: { per_page: 100, page: 1, pages: 1 },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    const result = await adapter.fetchContributionsToCandidate(store.db, {
      candidateId: "H0AZ01234",
    });

    expect(result.documentsUpserted).toBe(1);
    expect(scheduleACalls).toHaveLength(1);
    // Principal committee filter must be present in schedule_a call.
    expect(scheduleACalls[0]).toMatch(/committee_id=C00123456/);
    const docs = store.db.prepare(
      "SELECT kind FROM documents WHERE source_name='openfec' AND kind='contribution'",
    ).all();
    expect(docs).toHaveLength(1);
  });

  it("returns 0 when candidate lookup 404s", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );

    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    const result = await adapter.fetchContributionsToCandidate(store.db, {
      candidateId: "H9ZZ99999",
    });
    expect(result.documentsUpserted).toBe(0);
  });

  it("returns 0 when candidate has no principal committees", async () => {
    const scheduleACalls: string[] = [];
    vi.spyOn(global, "fetch").mockImplementation(async (input: any) => {
      const u = String(input);
      if (u.includes("/candidate/H0AZ01234/")) {
        return new Response(
          JSON.stringify({
            results: [{ ...SAMPLE_CANDIDATE, principal_committees: [] }],
            pagination: { per_page: 20, page: 1, pages: 1 },
          }),
          { status: 200 },
        );
      }
      if (u.includes("/schedules/schedule_a")) {
        scheduleACalls.push(u);
        return new Response(
          JSON.stringify({ results: [], pagination: { per_page: 100 } }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    const result = await adapter.fetchContributionsToCandidate(store.db, {
      candidateId: "H0AZ01234",
    });
    expect(result.documentsUpserted).toBe(0);
    // Must NOT have called schedule_a — no committees to filter by.
    expect(scheduleACalls).toHaveLength(0);
  });
});

describe("OpenFecAdapter.fetchCandidate", () => {
  it("fetches /candidate/{id}/ and upserts the returned candidate", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        results: [SAMPLE_CANDIDATE],
        pagination: { per_page: 20, page: 1, pages: 1 },
      }), { status: 200 }),
    );

    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    const result = await adapter.fetchCandidate(store.db, "H0AZ01234");

    expect(result.entitiesUpserted).toBe(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/\/candidate\/H0AZ01234\//);
    expect(url).toMatch(/api_key=test-key/);

    const rows = store.db
      .prepare(
        "SELECT name FROM entities WHERE json_extract(external_ids, '$.fec_candidate') = ?",
      )
      .all("H0AZ01234") as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("returns entitiesUpserted=0 on 404 without throwing", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );

    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    const result = await adapter.fetchCandidate(store.db, "H9ZZ99999");
    expect(result.entitiesUpserted).toBe(0);
  });

  it("returns 0 when results array is empty", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [], pagination: { per_page: 20 } }), { status: 200 }),
    );

    const adapter = new OpenFecAdapter({ apiKey: "test-key" });
    const result = await adapter.fetchCandidate(store.db, "H0AZ01234");
    expect(result.entitiesUpserted).toBe(0);
  });
});

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

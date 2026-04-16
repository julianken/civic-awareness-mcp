import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/federal/seeds.js";
import { CongressAdapter } from "../../src/federal/adapters/congress.js";
import { upsertEntity } from "../../src/core/entities.js";

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
    if (u.includes("/bill")) return new Response(billsFixture, { status: 200 });
    if (u.includes("/vote")) return new Response(votesFixture, { status: 200 });
    if (u.includes("/member")) return new Response(membersFixture, { status: 200 });
    return new Response("", { status: 404 });
  });
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

describe("Congress.gov end-to-end", () => {
  it("Members of Congress appear in the entity store with federal role metadata", async () => {
    const adapter = new CongressAdapter({ apiKey: "fake", congresses: [119] });
    await adapter.refresh({ db: store.db, maxPages: 1 });
    const rows = store.db
      .prepare("SELECT name, metadata FROM entities WHERE kind = 'person'")
      .all() as Array<{ name: string; metadata: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const meta = JSON.parse(row.metadata) as { roles?: Array<{ jurisdiction: string }> };
      expect(meta.roles?.some((r) => r.jurisdiction === "us-federal")).toBe(true);
    }
  });

  it("cross-source merge: an OpenStates person with matching bioguide collapses to one entity row", async () => {
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
      store.db.prepare("SELECT COUNT(*) c FROM entities WHERE kind = 'person'").get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(2);

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

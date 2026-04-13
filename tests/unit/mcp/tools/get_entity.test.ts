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
  it("surfaces federal role URL in sources when entity has a bioguide ID", async () => {
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
    const roles = (res.entity.metadata.roles ?? []) as Array<{ jurisdiction: string }>;
    const jurisdictions = roles.map((r) => r.jurisdiction);
    expect(jurisdictions).toContain("us-ny");
    expect(jurisdictions).toContain("us-federal");

    const congressSource = res.sources.find((s) => s.name === "congress");
    expect(congressSource?.url).toMatch(/congress\.gov/);
  });

  it("emits fec.gov source URL when entity has a fec_candidate external_id", async () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Smith, John R.",
      jurisdiction: undefined,
      external_ids: { fec_candidate: "H0AZ01234", bioguide: "S001234" },
      metadata: {
        roles: [{ jurisdiction: "us-federal", role: "federal_candidate_representative" }],
      },
    });

    const res = await handleGetEntity(store.db, { id: entity.id });
    const fecSource = res.sources.find((s) => s.url.includes("fec.gov/data/candidate"));
    expect(fecSource).toBeDefined();
    expect(fecSource!.url).toBe("https://www.fec.gov/data/candidate/H0AZ01234/");
  });

  it("recent_documents exposes action_date on each item and sorts by it", async () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person", name: "Sen. B",
      external_ids: { openstates_person: "ocd-person/b" },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "SB 1 — Older action",
      occurred_at: "2025-06-01T00:00:00Z",
      source: { name: "openstates", id: "1", url: "https://example.com/1" },
      references: [{ entity_id: entity.id, role: "sponsor" }],
      raw: { actions: [{ date: "2025-06-01", description: "intro" }] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "SB 2 — Newer action",
      occurred_at: "2025-09-18T00:00:00Z",
      source: { name: "openstates", id: "2", url: "https://example.com/2" },
      references: [{ entity_id: entity.id, role: "sponsor" }],
      raw: { actions: [{ date: "2025-09-18", description: "enacted" }] },
    });
    const res = await handleGetEntity(store.db, { id: entity.id });
    expect(res.recent_documents.map((d) => d.title)).toEqual([
      "SB 2 — Newer action",
      "SB 1 — Older action",
    ]);
    expect(res.recent_documents[0].action_date).toBe("2025-09-18");
    expect(res.recent_documents[0].occurred_at).toMatch(/^2025-09-18T/);
  });

  it("emits fec.gov source URL when entity has a fec_committee external_id", async () => {
    const { entity } = upsertEntity(store.db, {
      kind: "pac",
      name: "Smith for Congress",
      jurisdiction: "us-federal",
      external_ids: { fec_committee: "C00123456" },
    });

    const res = await handleGetEntity(store.db, { id: entity.id });
    const fecSource = res.sources.find((s) => s.url.includes("fec.gov/data/committee"));
    expect(fecSource).toBeDefined();
    expect(fecSource!.url).toBe("https://www.fec.gov/data/committee/C00123456/");
  });
});

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
    expect(result.results[0].identifier).toBe("HB1");
    expect(result.results[0].title).toBe("recent bill");
  });
  it("scopes to the requested jurisdiction (TX vs CA)", async () => {
    const ca = await handleRecentBills(store.db, { days: 7, jurisdiction: "us-ca" });
    expect(ca.results).toHaveLength(1);
    expect(ca.results[0].identifier).toBe("AB123");
    expect(ca.results[0].title).toBe("california bill");
  });
  it("includes sponsor info via sponsor_summary", async () => {
    const result = await handleRecentBills(store.db, { days: 7, jurisdiction: "us-tx" });
    const r = result.results[0];
    expect(r).toHaveProperty("sponsor_summary");
    expect(r).not.toHaveProperty("sponsors");
    expect(r.sponsor_summary.top[0].name).toBe("Jane Doe");
    expect(r.sponsor_summary.top[0].party).toBe("Democratic");
    expect(r.sponsor_summary.top[0].role).toBe("sponsor");
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
      handleRecentBills(store.db, { days: 7 }),
    ).rejects.toThrow();
  });

  it("returns sponsor_summary (count + by_party + top-5), not full sponsors[]", async () => {
    const sponsorIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { entity } = upsertEntity(store.db, {
        kind: "person", name: `TestSponsor${i}Alpha`,
        metadata: { party: i < 6 ? "Republican" : "Democratic" },
      });
      sponsorIds.push(entity.id);
    }
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "SB 1 — Test",
      occurred_at: new Date().toISOString(),
      source: { name: "openstates", id: "1b", url: "https://ex" },
      references: sponsorIds.map((id, i) => ({
        entity_id: id,
        role: (i === 0 ? "sponsor" : "cosponsor") as "sponsor" | "cosponsor",
      })),
      raw: { actions: [] },
    });

    const res = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 });
    const billWithSummary = res.results.find((r) => r.identifier === "SB 1");
    expect(billWithSummary).toBeDefined();
    const r = billWithSummary!;
    expect(r).toHaveProperty("sponsor_summary");
    expect(r).not.toHaveProperty("sponsors");
    expect(r.sponsor_summary).toMatchObject({
      count: 10,
      by_party: { Republican: 6, Democratic: 4 },
    });
    expect(r.sponsor_summary.top).toHaveLength(5);
    expect(r.sponsor_summary.top[0].role).toBe("sponsor");
  });

  it("20-bill response fits under 30KB", async () => {
    for (let b = 0; b < 20; b++) {
      const refs: Array<{ entity_id: string; role: "sponsor" | "cosponsor" }> = [];
      for (let s = 0; s < 50; s++) {
        const { entity } = upsertEntity(store.db, {
          kind: "person", name: `BulkBill${b}Sponsor${s}`,
          metadata: { party: s % 2 === 0 ? "R" : "D" },
        });
        refs.push({ entity_id: entity.id, role: s === 0 ? "sponsor" : "cosponsor" });
      }
      upsertDocument(store.db, {
        kind: "bill", jurisdiction: "us-tx", title: `B${b} — Test`,
        occurred_at: new Date().toISOString(),
        source: { name: "openstates", id: `b${b}bulk`, url: "https://ex" },
        references: refs,
        raw: { actions: [] },
      });
    }
    const res = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 });
    const bytes = Buffer.byteLength(JSON.stringify(res), "utf8");
    expect(bytes).toBeLessThan(30 * 1024);
  });
});

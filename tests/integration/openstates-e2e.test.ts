import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/core/seeds.js";
import { OpenStatesAdapter } from "../../src/adapters/openstates.js";
import { handleRecentBills } from "../../src/mcp/tools/recent_bills.js";

const TEST_DB = "./data/test-openstates-e2e.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  const billsFixture = readFileSync("tests/integration/fixtures/openstates-bills-page1.json", "utf-8");
  const peopleFixture = readFileSync("tests/integration/fixtures/openstates-people-page1.json", "utf-8");
  vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
    const u = String(url);
    if (u.includes("/people")) return new Response(peopleFixture, { status: 200 });
    if (u.includes("/bills"))  return new Response(billsFixture,  { status: 200 });
    return new Response("", { status: 404 });
  });
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

describe("openstates end-to-end", () => {
  it("refreshes and exposes via recent_bills", async () => {
    const adapter = new OpenStatesAdapter({ apiKey: "fake" });
    const result = await adapter.refresh({ db: store.db, maxPages: 1, jurisdiction: "tx" });
    expect(result.errors).toEqual([]);
    expect(result.documentsUpserted).toBeGreaterThan(0);

    const bills = await handleRecentBills(store.db, { days: 90, jurisdiction: "us-tx" });
    expect(bills.results.length).toBeGreaterThan(0);
    expect(bills.sources[0].name).toBe("openstates");
    expect(bills.sources[0].url).toContain("/tx/");
  });
});

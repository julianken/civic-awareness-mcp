import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/federal/seeds.js";
import { handleGetBill } from "../../src/state/tools/get_bill.js";
import { _resetLimitersForTesting } from "../../src/state/limiters.js";

const TEST_DB = "./data/test-get-bill-e2e.db";
let store: Store;

const fixture = readFileSync("tests/integration/fixtures/openstates-bill-detail.json", "utf-8");

beforeEach(() => {
  process.env.OPENSTATES_API_KEY = "test-key";
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  _resetLimitersForTesting();
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  delete process.env.OPENSTATES_API_KEY;
});

describe("get_bill e2e", () => {
  it("hydrates a bill from upstream on first call and projects it", async () => {
    let hits = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      hits += 1;
      const u = String(url);
      if (u.includes("/bills/ca/20252026/SB")) {
        return new Response(fixture, { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const result = await handleGetBill(store.db, {
      jurisdiction: "us-ca",
      session: "20252026",
      identifier: "SB 1338",
    });

    expect(hits).toBe(1);
    expect(result.bill?.title).toBe("Vehicles: repossession.");
    expect(result.bill?.versions).toHaveLength(2);
    expect(result.bill?.versions[1].text_url).toContain("version=AMD");
    expect(result.bill?.primary_sponsor?.name).toBe("Brian Jones");
    expect(result.bill?.primary_sponsor?.entity_id).toBeTruthy();
  });

  it("serves from cache on second call within TTL", async () => {
    let hits = 0;
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      hits += 1;
      return new Response(fixture, { status: 200 });
    });

    await handleGetBill(store.db, {
      jurisdiction: "us-ca",
      session: "20252026",
      identifier: "SB 1338",
    });
    await handleGetBill(store.db, {
      jurisdiction: "us-ca",
      session: "20252026",
      identifier: "SB 1338",
    });

    expect(hits).toBe(1);
  });

  it("returns not_found stale_notice when upstream 404s", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    });

    const result = await handleGetBill(store.db, {
      jurisdiction: "us-ca",
      session: "20252026",
      identifier: "XX 9999",
    });

    expect(result.bill).toBeNull();
    expect(result.stale_notice?.reason).toBe("not_found");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { refreshSource } from "../../../src/core/refresh.js";

const TEST_DB = "./data/test-core-refresh.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  process.env.API_DATA_GOV_KEY = "test-key";
  process.env.OPENSTATES_API_KEY = "test-key";
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  delete process.env.API_DATA_GOV_KEY;
  delete process.env.OPENSTATES_API_KEY;
});

describe("refreshSource — source dispatch", () => {
  it("dispatches openfec to OpenFecAdapter and returns aggregated result", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ results: [], pagination: { pages: 1 } }), {
        status: 200,
      }),
    );
    const result = await refreshSource(store.db, {
      source: "openfec",
      maxPages: 1,
    });
    expect(result.source).toBe("openfec");
    expect(result.errors).toEqual([]);
    expect(result.entitiesUpserted).toBe(0);
    expect(result.documentsUpserted).toBe(0);
  });

  it("dispatches congress to CongressAdapter", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ members: [], bills: [], votes: [], pagination: {} }), {
        status: 200,
      }),
    );
    const result = await refreshSource(store.db, {
      source: "congress",
      maxPages: 1,
    });
    expect(result.source).toBe("congress");
    expect(result.errors).toEqual([]);
  });

  it("iterates jurisdictions for openstates and aggregates counts", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ results: [], pagination: { max_page: 1 } }), {
        status: 200,
      }),
    );
    const result = await refreshSource(store.db, {
      source: "openstates",
      jurisdictions: ["tx", "ca"],
      maxPages: 1,
    });
    expect(result.source).toBe("openstates");
    expect(result.jurisdictionsProcessed).toEqual(["tx", "ca"]);
    expect(result.errors).toEqual([]);
  });

  it("throws on unknown source", async () => {
    await expect(
      refreshSource(store.db, { source: "bogus" as never, maxPages: 1 }),
    ).rejects.toThrow(/unknown source/i);
  });
});

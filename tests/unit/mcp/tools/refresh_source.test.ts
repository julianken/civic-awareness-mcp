import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { handleRefreshSource } from "../../../../src/mcp/tools/refresh_source.js";

const TEST_DB = "./data/test-tool-refresh-source.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  process.env.API_DATA_GOV_KEY = "test-key";
  process.env.OPENSTATES_API_KEY = "test-key";
  vi.spyOn(global, "fetch").mockImplementation(async () =>
    new Response(
      JSON.stringify({ results: [], members: [], bills: [], votes: [], pagination: { pages: 1, max_page: 1 } }),
      { status: 200 },
    ),
  );
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  delete process.env.API_DATA_GOV_KEY;
  delete process.env.OPENSTATES_API_KEY;
});

describe("refresh_source tool handler", () => {
  it("returns expected response shape for congress", async () => {
    const result = await handleRefreshSource(store.db, {
      source: "congress",
      max_pages: 1,
    });
    expect(result.source).toBe("congress");
    expect(result.entities_upserted).toBe(0);
    expect(result.documents_upserted).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.jurisdictions_processed).toBeUndefined();
  });

  it("returns jurisdictions_processed for openstates", async () => {
    const result = await handleRefreshSource(store.db, {
      source: "openstates",
      jurisdictions: ["tx"],
      max_pages: 1,
    });
    expect(result.source).toBe("openstates");
    expect(result.jurisdictions_processed).toEqual(["tx"]);
  });

  it("rejects invalid source via zod", async () => {
    await expect(
      handleRefreshSource(store.db, { source: "bogus", max_pages: 1 }),
    ).rejects.toThrow();
  });

  it("caps max_pages to a sane upper bound", async () => {
    await expect(
      handleRefreshSource(store.db, { source: "congress", max_pages: 9999 }),
    ).rejects.toThrow();
  });
});

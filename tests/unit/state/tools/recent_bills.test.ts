import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/federal/seeds.js";
import { _resetToolCacheForTesting } from "../../../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../../../src/state/limiters.js";
import { handleRecentBills } from "../../../../src/state/tools/recent_bills.js";

vi.stubEnv("OPENSTATES_API_KEY", "test-key");

let store: Store;

beforeEach(() => {
  _resetToolCacheForTesting();
  _resetLimitersForTesting();
  store = openStore(":memory:");
  seedJurisdictions(store.db);
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

describe("state/recent_bills — Bug 1: updated_since Z-suffix", () => {
  it("sends updated_since without Z suffix (OpenStates rejects trailing Z)", async () => {
    let capturedUrl: string | undefined;

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      capturedUrl = typeof input === "string" ? input : String(input);
      return new Response(JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }), {
        status: 200,
      });
    });

    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 });

    expect(capturedUrl).toBeDefined();
    const url = new URL(capturedUrl!);
    const updatedSince = url.searchParams.get("updated_since");
    expect(updatedSince).not.toBeNull();
    expect(updatedSince).not.toMatch(/Z$/);
    expect(updatedSince).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it("sends updated_since without Z suffix when limit is provided", async () => {
    let capturedUrl: string | undefined;

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      capturedUrl = typeof input === "string" ? input : String(input);
      return new Response(JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }), {
        status: 200,
      });
    });

    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7, limit: 5 });

    expect(capturedUrl).toBeDefined();
    const url = new URL(capturedUrl!);
    const updatedSince = url.searchParams.get("updated_since");
    expect(updatedSince).not.toBeNull();
    expect(updatedSince).not.toMatch(/Z$/);
    expect(updatedSince).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

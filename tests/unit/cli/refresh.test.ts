import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { CongressAdapter } from "../../../src/adapters/congress.js";

const TEST_DB = "./data/test-refresh-congress.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  vi.spyOn(global, "fetch").mockImplementation(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/member"))
      return new Response(
        JSON.stringify({ members: [], pagination: { count: 0 } }),
        { status: 200 },
      );
    if (u.includes("/bill"))
      return new Response(
        JSON.stringify({ bills: [], pagination: { count: 0 } }),
        { status: 200 },
      );
    if (u.includes("/vote"))
      return new Response(
        JSON.stringify({ votes: [], pagination: { count: 0 } }),
        { status: 200 },
      );
    return new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

describe("refresh CLI — congress source", () => {
  it("runs CongressAdapter.refresh() with no jurisdiction and returns no errors", async () => {
    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    const result = await adapter.refresh({ db: store.db, maxPages: 1 });
    expect(result.source).toBe("congress");
    expect(result.errors).toEqual([]);
  });

  it("does not call fetch with a state-abbreviation path segment", async () => {
    const mockFetch = vi.mocked(global.fetch);
    const adapter = new CongressAdapter({ apiKey: "test-key", congresses: [119] });
    await adapter.refresh({ db: store.db, maxPages: 1 });
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => !/\/[a-z]{2}\//.test(u))).toBe(true);
  });
});

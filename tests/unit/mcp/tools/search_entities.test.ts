import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { handleSearchEntities } from "../../../../src/mcp/tools/search_entities.js";

const TEST_DB = "./data/test-tool-search-entities.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  upsertEntity(store.db, { kind: "person", name: "Jane Doe", jurisdiction: undefined });
  upsertEntity(store.db, { kind: "person", name: "John Smith", jurisdiction: undefined });
  upsertEntity(store.db, {
    kind: "organization",
    name: "Doe Industries",
    jurisdiction: "us-tx",
  });
  upsertEntity(store.db, {
    kind: "organization",
    name: "Smith Ranch LLC",
    jurisdiction: "us-ca",
  });
});
afterEach(() => store.close());

describe("search_entities tool", () => {
  it("matches by substring", async () => {
    const res = await handleSearchEntities(store.db, { q: "doe" });
    expect(res.results).toHaveLength(2);
  });
  it("filters by kind", async () => {
    const res = await handleSearchEntities(store.db, { q: "doe", kind: "person" });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].name).toBe("Jane Doe");
  });
});

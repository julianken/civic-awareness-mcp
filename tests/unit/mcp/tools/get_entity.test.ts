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
});

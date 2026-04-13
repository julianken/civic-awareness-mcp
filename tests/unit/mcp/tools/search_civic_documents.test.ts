import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleSearchDocuments } from "../../../../src/mcp/tools/search_civic_documents.js";

const TEST_DB = "./data/test-tool-search-docs.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx",
    title: "HB1234 — civic awareness and transparency",
    occurred_at: new Date().toISOString(),
    source: { name: "openstates", id: "1", url: "https://openstates.org/tx/bills/HB1234" },
  });
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx",
    title: "HB9999 — unrelated matter",
    occurred_at: new Date().toISOString(),
    source: { name: "openstates", id: "2", url: "https://openstates.org/tx/bills/HB9999" },
  });
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-ca",
    title: "AB123 — california civic awareness act",
    occurred_at: new Date().toISOString(),
    source: { name: "openstates", id: "3", url: "https://openstates.org/ca/bills/AB123" },
  });
});
afterEach(() => store.close());

describe("search_civic_documents", () => {
  it("matches by title substring across jurisdictions", async () => {
    const res = await handleSearchDocuments(store.db, { q: "civic awareness" });
    expect(res.results).toHaveLength(2);
    const titles = res.results.map((r) => r.title);
    expect(titles.some((t) => t.includes("HB1234"))).toBe(true);
    expect(titles.some((t) => t.includes("AB123"))).toBe(true);
  });
  it("filters by source", async () => {
    const res = await handleSearchDocuments(store.db, {
      q: "HB", sources: ["openstates"],
    });
    expect(res.results).toHaveLength(2);
  });
});

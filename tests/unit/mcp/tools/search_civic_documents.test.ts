import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/federal/seeds.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleSearchDocuments } from "../../../../src/federal/tools/search_civic_documents.js";

const TEST_DB = "./data/test-tool-search-docs.db";
let store: Store;

function seedDocs() {
  upsertDocument(store.db, {
    kind: "bill",
    jurisdiction: "us-tx",
    title: "HB1234 — civic awareness and transparency",
    occurred_at: "2026-04-10T00:00:00Z",
    source: { name: "openstates", id: "1", url: "https://openstates.org/tx/bills/HB1234" },
  });
  upsertDocument(store.db, {
    kind: "bill",
    jurisdiction: "us-tx",
    title: "HB9999 — unrelated matter",
    occurred_at: "2026-04-09T00:00:00Z",
    source: { name: "openstates", id: "2", url: "https://openstates.org/tx/bills/HB9999" },
  });
  upsertDocument(store.db, {
    kind: "bill",
    jurisdiction: "us-ca",
    title: "AB123 — california civic awareness act",
    occurred_at: "2026-04-08T00:00:00Z",
    source: { name: "openstates", id: "3", url: "https://openstates.org/ca/bills/AB123" },
  });
  upsertDocument(store.db, {
    kind: "vote",
    jurisdiction: "us-tx",
    title: "Vote on HB1234 civic awareness",
    occurred_at: "2026-04-07T00:00:00Z",
    source: { name: "openstates", id: "v1", url: "https://openstates.org/tx/votes/v1" },
  });
}

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});
afterEach(() => store.close());

describe("search_civic_documents", () => {
  it("matches by title substring across jurisdictions", async () => {
    seedDocs();
    const res = await handleSearchDocuments(store.db, { q: "civic awareness" });
    expect(res.results.length).toBeGreaterThanOrEqual(2);
    const titles = res.results.map((r) => r.title);
    expect(titles.some((t) => t.includes("HB1234"))).toBe(true);
    expect(titles.some((t) => t.includes("AB123"))).toBe(true);
  });

  it("filters by jurisdiction", async () => {
    seedDocs();
    const res = await handleSearchDocuments(store.db, {
      q: "civic awareness",
      jurisdiction: "us-tx",
    });
    expect(res.results.length).toBeGreaterThanOrEqual(1);
    for (const r of res.results) {
      expect(r.title).not.toContain("AB123");
    }
  });

  it("filters by kinds", async () => {
    seedDocs();
    const res = await handleSearchDocuments(store.db, {
      q: "civic awareness",
      kinds: ["vote"],
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].kind).toBe("vote");
  });

  it("filters by source", async () => {
    seedDocs();
    const res = await handleSearchDocuments(store.db, {
      q: "HB",
      sources: ["openstates"],
    });
    expect(res.results.length).toBeGreaterThanOrEqual(2);
    const srcs = res.sources.map((s) => s.name);
    expect(srcs).toContain("openstates");
  });

  it("filters by from/to window", async () => {
    seedDocs();
    const res = await handleSearchDocuments(store.db, {
      q: "civic awareness",
      from: "2026-04-09T00:00:00Z",
      to: "2026-04-11T00:00:00Z",
    });
    const titles = res.results.map((r) => r.title);
    expect(titles.some((t) => t.includes("HB1234"))).toBe(true);
    expect(titles.some((t) => t.includes("AB123"))).toBe(false);
  });

  it("respects limit", async () => {
    seedDocs();
    const res = await handleSearchDocuments(store.db, { q: "civic awareness", limit: 1 });
    expect(res.results).toHaveLength(1);
  });

  it("sets empty_reason: store_not_warmed when local store is empty", async () => {
    const result = await handleSearchDocuments(store.db, { q: "test", limit: 10 });
    expect(result.results).toEqual([]);
    expect(result.empty_reason).toBe("store_not_warmed");
    expect(result.hint).toContain("warm the cache");
  });

  it("sets empty_reason: store_not_warmed when jurisdiction has no docs", async () => {
    seedDocs();
    const result = await handleSearchDocuments(store.db, {
      q: "anything",
      jurisdiction: "us-ny",
      limit: 10,
    });
    expect(result.results).toEqual([]);
    expect(result.empty_reason).toBe("store_not_warmed");
    expect(result.hint).toContain("us-ny");
  });

  it("does NOT set empty_reason when store has docs but none match query", async () => {
    seedDocs();
    const result = await handleSearchDocuments(store.db, { q: "nomatch-xyz", limit: 10 });
    expect(result.results).toEqual([]);
    expect(result.empty_reason).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });
});

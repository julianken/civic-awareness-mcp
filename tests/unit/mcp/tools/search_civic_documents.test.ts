import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleSearchDocuments } from "../../../../src/mcp/tools/search_civic_documents.js";

vi.mock("../../../../src/core/hydrate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/core/hydrate.js")>();
  return { ...actual, ensureFresh: vi.fn() };
});
import { ensureFresh } from "../../../../src/core/hydrate.js";
const mockEnsureFresh = vi.mocked(ensureFresh);

const TEST_DB = "./data/test-tool-search-docs.db";
let store: Store;

beforeEach(() => {
  mockEnsureFresh.mockReset();
  mockEnsureFresh.mockResolvedValue({ ok: true });

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

  it("hydration: no jurisdiction filter — ensureFresh never called", async () => {
    const res = await handleSearchDocuments(store.db, { q: "civic awareness" });
    expect(mockEnsureFresh).not.toHaveBeenCalled();
    expect(res.stale_notice).toBeUndefined();
    expect(res.results).toHaveLength(2);
  });

  it("hydration: jurisdiction filter + success — results returned without stale_notice", async () => {
    mockEnsureFresh.mockResolvedValue({ ok: true });
    const res = await handleSearchDocuments(store.db, {
      q: "civic awareness", jurisdiction: "us-tx",
    });
    expect(mockEnsureFresh).toHaveBeenCalled();
    expect(res.stale_notice).toBeUndefined();
    expect(res.results).toHaveLength(1);
    expect(res.results[0].title).toContain("HB1234");
  });

  it("hydration: jurisdiction filter + upstream failure — stale_notice attached", async () => {
    const notice = {
      as_of: "2026-04-13T00:00:00.000Z",
      reason: "upstream_failure" as const,
      message: "Upstream openstates fetch failed; serving stale local data.",
    };
    mockEnsureFresh.mockResolvedValue({ ok: false, stale_notice: notice });
    const res = await handleSearchDocuments(store.db, {
      q: "civic awareness", jurisdiction: "us-tx",
    });
    expect(res.stale_notice?.reason).toBe("upstream_failure");
    // Local data still served
    expect(res.results).toHaveLength(1);
  });
});

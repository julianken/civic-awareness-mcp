import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { handleSearchEntities } from "../../../../src/mcp/tools/search_entities.js";

vi.mock("../../../../src/core/hydrate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/core/hydrate.js")>();
  return { ...actual, ensureFresh: vi.fn() };
});
import { ensureFresh } from "../../../../src/core/hydrate.js";
const mockEnsureFresh = vi.mocked(ensureFresh);

const TEST_DB = "./data/test-tool-search-entities.db";
let store: Store;

beforeEach(() => {
  mockEnsureFresh.mockReset();
  mockEnsureFresh.mockResolvedValue({ ok: true });

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

  // ── hydration ─────────────────────────────────────────────────────────────

  it("hydration: no jurisdiction → ensureFresh not called", async () => {
    await handleSearchEntities(store.db, { q: "doe" });
    expect(mockEnsureFresh).not.toHaveBeenCalled();
  });

  it("hydration: jurisdiction provided → ensureFresh called with scope=full", async () => {
    await handleSearchEntities(store.db, { q: "doe", jurisdiction: "us-tx" });
    expect(mockEnsureFresh).toHaveBeenCalledWith(
      store.db,
      "openstates",
      "us-tx",
      "full",
      expect.any(Function),
    );
  });

  it("hydration: ok=true → no stale_notice on response", async () => {
    mockEnsureFresh.mockResolvedValue({ ok: true });
    const res = await handleSearchEntities(store.db, { q: "doe", jurisdiction: "us-tx" });
    expect(res.stale_notice).toBeUndefined();
  });

  it("hydration: upstream failure → stale_notice attached, results still returned", async () => {
    const notice = {
      as_of: "2026-04-13T00:00:00.000Z",
      reason: "upstream_failure" as const,
      message: "Upstream openstates fetch failed; serving stale local data.",
    };
    mockEnsureFresh.mockResolvedValue({ ok: false, stale_notice: notice });
    const res = await handleSearchEntities(store.db, { q: "doe", jurisdiction: "us-tx" });
    expect(res.stale_notice?.reason).toBe("upstream_failure");
    expect(res.results.length).toBeGreaterThan(0);
  });

  it("hydration: us-federal jurisdiction → ensureFresh called for congress and openfec", async () => {
    await handleSearchEntities(store.db, { q: "doe", jurisdiction: "us-federal" });
    const calls = mockEnsureFresh.mock.calls.map((c) => c[1]);
    expect(calls).toContain("congress");
    expect(calls).toContain("openfec");
  });
});

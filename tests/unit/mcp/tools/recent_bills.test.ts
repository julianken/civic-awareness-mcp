import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { upsertFetchLog } from "../../../../src/core/fetch_log.js";
import { hashArgs } from "../../../../src/core/args_hash.js";
import { _resetToolCacheForTesting } from "../../../../src/core/tool_cache.js";
import { _resetLimitersForTesting, _setLimiterForTesting } from "../../../../src/core/limiters.js";
import { RateLimiter } from "../../../../src/util/http.js";
import { OpenStatesAdapter } from "../../../../src/adapters/openstates.js";
import { CongressAdapter } from "../../../../src/adapters/congress.js";
import { handleRecentBills, type RecentBillsResponse } from "../../../../src/mcp/tools/recent_bills.js";
import { RecentBillsInput } from "../../../../src/mcp/schemas.js";

/** Cast for existing tests that are provably outside the gate path (limit ≤ 500). */
async function callBills(
  db: Parameters<typeof handleRecentBills>[0],
  input: Parameters<typeof handleRecentBills>[1],
): Promise<RecentBillsResponse> {
  return handleRecentBills(db, input) as Promise<RecentBillsResponse>;
}

const TEST_DB = "./data/test-tool-recent-bills.db";
let store: Store;

/**
 * Pre-seeds a fetch_log row for (source, endpoint_path, args) so
 * `withShapedFetch` takes the TTL-hit path — the adapter method is
 * NOT called, and the handler runs the SQL projection directly. Used
 * for tests that focus on projection behaviour rather than hydration.
 */
function seedFetchLogFresh(
  source: "openstates" | "congress",
  endpoint_path: string,
  args: Record<string, unknown>,
): void {
  upsertFetchLog(store.db, {
    source,
    endpoint_path,
    args_hash: hashArgs("recent_bills", args),
    scope: "recent",
    fetched_at: new Date().toISOString(),
    last_rowcount: 1,
  });
}

beforeEach(() => {
  _resetToolCacheForTesting();
  _resetLimitersForTesting();
  process.env.OPENSTATES_API_KEY = "test-key";
  process.env.API_DATA_GOV_KEY = "test-key";

  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  const { entity } = upsertEntity(store.db, {
    kind: "person", name: "Jane Doe", jurisdiction: undefined,
    metadata: {
      party: "Democratic", district: "15", chamber: "lower",
      roles: [{ jurisdiction: "us-tx", role: "state_legislator",
                from: new Date().toISOString(), to: null }],
    },
  });

  const now = new Date().toISOString();
  const old = new Date(Date.now() - 40 * 86400 * 1000).toISOString();
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx",
    title: "HB1 — recent bill", occurred_at: now,
    source: { name: "openstates", id: "1", url: "https://openstates.org/tx/bills/HB1" },
    references: [{ entity_id: entity.id, role: "sponsor" }],
  });
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx",
    title: "HB2 — old bill", occurred_at: old,
    source: { name: "openstates", id: "2", url: "https://openstates.org/tx/bills/HB2" },
  });
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-ca",
    title: "AB123 — california bill", occurred_at: now,
    source: { name: "openstates", id: "3", url: "https://openstates.org/ca/bills/AB123" },
  });
});
afterEach(() => {
  store.close();
  delete process.env.OPENSTATES_API_KEY;
  delete process.env.API_DATA_GOV_KEY;
});

describe("recent_bills tool — projection (TTL-hit path)", () => {
  it("returns only bills within the window for the specified state", async () => {
    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-tx", days: 7, chamber: undefined, session: undefined });
    const result = await callBills(store.db, { days: 7, jurisdiction: "us-tx" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].identifier).toBe("HB1");
    expect(result.results[0].title).toBe("recent bill");
  });

  it("scopes to the requested jurisdiction (TX vs CA)", async () => {
    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-ca", days: 7, chamber: undefined, session: undefined });
    const ca = await callBills(store.db, { days: 7, jurisdiction: "us-ca" });
    expect(ca.results).toHaveLength(1);
    expect(ca.results[0].identifier).toBe("AB123");
    expect(ca.results[0].title).toBe("california bill");
  });

  it("includes sponsor info via sponsor_summary", async () => {
    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-tx", days: 7, chamber: undefined, session: undefined });
    const result = await callBills(store.db, { days: 7, jurisdiction: "us-tx" });
    const r = result.results[0];
    expect(r).toHaveProperty("sponsor_summary");
    expect(r).not.toHaveProperty("sponsors");
    expect(r.sponsor_summary.top[0].name).toBe("Jane Doe");
    expect(r.sponsor_summary.top[0].party).toBe("Democratic");
    expect(r.sponsor_summary.top[0].role).toBe("sponsor");
  });

  it("includes source provenance with a jurisdiction-aware URL", async () => {
    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-tx", days: 7, chamber: undefined, session: undefined });
    const result = await callBills(store.db, { days: 7, jurisdiction: "us-tx" });
    expect(result.sources).toContainEqual({
      name: "openstates",
      url: expect.stringContaining("/tx/"),
    });
  });

  it("rejects input with no jurisdiction", async () => {
    await expect(
      handleRecentBills(store.db, { days: 7 }),
    ).rejects.toThrow();
  });

  it("returns sponsor_summary (count + by_party + top-5), not full sponsors[]", async () => {
    const sponsorIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { entity } = upsertEntity(store.db, {
        kind: "person", name: `TestSponsor${i}Alpha`,
        metadata: { party: i < 6 ? "Republican" : "Democratic" },
      });
      sponsorIds.push(entity.id);
    }
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "SB 1 — Test",
      occurred_at: new Date().toISOString(),
      source: { name: "openstates", id: "1b", url: "https://ex" },
      references: sponsorIds.map((id, i) => ({
        entity_id: id,
        role: (i === 0 ? "sponsor" : "cosponsor") as "sponsor" | "cosponsor",
      })),
      raw: { actions: [] },
    });

    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-tx", days: 7, chamber: undefined, session: undefined });
    const res = await callBills(store.db, { jurisdiction: "us-tx", days: 7 });
    const billWithSummary = res.results.find((r) => r.identifier === "SB 1");
    expect(billWithSummary).toBeDefined();
    const r = billWithSummary!;
    expect(r).toHaveProperty("sponsor_summary");
    expect(r).not.toHaveProperty("sponsors");
    expect(r.sponsor_summary).toMatchObject({
      count: 10,
      by_party: { Republican: 6, Democratic: 4 },
    });
    expect(r.sponsor_summary.top).toHaveLength(5);
    expect(r.sponsor_summary.top[0].role).toBe("sponsor");
  });

  it("falls back to by_party.unknown when a sponsor lacks party metadata", async () => {
    const { entity: withParty } = upsertEntity(store.db, {
      kind: "person", name: "HasParty",
      external_ids: { openstates_person: "hp" },
      metadata: { party: "Republican" },
    });
    const { entity: noParty } = upsertEntity(store.db, {
      kind: "person", name: "NoPartyPerson",
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "SB X — Test",
      occurred_at: new Date().toISOString(),
      source: { name: "openstates", id: "x", url: "https://ex" },
      references: [
        { entity_id: withParty.id, role: "sponsor" },
        { entity_id: noParty.id,   role: "cosponsor" },
      ],
      raw: { actions: [] },
    });
    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-tx", days: 7, chamber: undefined, session: undefined });
    const res = await callBills(store.db, { jurisdiction: "us-tx", days: 7 });
    const target = res.results.find((r) => r.identifier === "SB X");
    expect(target).toBeDefined();
    expect(target!.sponsor_summary.by_party).toMatchObject({
      Republican: 1,
      unknown: 1,
    });
  });

  it("accepts days up to 365", async () => {
    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-or", days: 365, chamber: undefined, session: undefined });
    const res = await callBills(store.db, { jurisdiction: "us-or", days: 365 });
    expect(res.window.from).toBeDefined();
  });

  it("rejects days above 365", async () => {
    await expect(
      handleRecentBills(store.db, { jurisdiction: "us-or", days: 366 }),
    ).rejects.toThrow();
  });

  it("accepts limit between 1 and 20", () => {
    expect(() =>
      RecentBillsInput.parse({ jurisdiction: "us-tx", days: 7, limit: 5 }),
    ).not.toThrow();
  });

  it("rejects limit=0", async () => {
    await expect(
      handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7, limit: 0 }),
    ).rejects.toThrow();
  });

  it("rejects limit above 20", async () => {
    await expect(
      handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7, limit: 21 }),
    ).rejects.toThrow();
  });

  it("filters by session when session parameter is provided", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "SB 1 — Eight-Ninety-Two",
      occurred_at: "2025-09-18T00:00:00Z",
      source: { name: "openstates", id: "892-1", url: "https://ex" },
      references: [], raw: { session: "892", actions: [] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "SB 99 — Eight-Ninety-One",
      occurred_at: "2024-06-01T00:00:00Z",
      source: { name: "openstates", id: "891-99", url: "https://ex" },
      references: [], raw: { session: "891", actions: [] },
    });

    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-tx", days: 7, chamber: undefined, session: "892" });
    const res = await callBills(store.db, {
      jurisdiction: "us-tx",
      days: 7,        // window excludes both bills
      session: "892", // bypass window; filter to session 892
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].title).toBe("Eight-Ninety-Two");
  });

  it("attaches empty_reason diagnostic when results are empty", async () => {
    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-or", days: 7, chamber: undefined, session: undefined });
    const res = await callBills(store.db, { jurisdiction: "us-or", days: 7 });
    expect(res.results).toHaveLength(0);
    expect(res).toHaveProperty("empty_reason", "no_events_in_window");
    expect(res).toHaveProperty("data_freshness");
    expect(res).toHaveProperty("hint");
  });

  it("chamber=upper returns only upper-chamber bills (from_organization.classification)", async () => {
    const now = new Date().toISOString();
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "SB 10 — upper bill",
      occurred_at: now,
      source: { name: "openstates", id: "upper-1", url: "https://openstates.org/tx/bills/SB10" },
      references: [], raw: { from_organization: { classification: "upper" }, actions: [] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB 20 — lower bill",
      occurred_at: now,
      source: { name: "openstates", id: "lower-1", url: "https://openstates.org/tx/bills/HB20" },
      references: [], raw: { from_organization: { classification: "lower" }, actions: [] },
    });

    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-tx", days: 7, chamber: "upper", session: undefined, limit: undefined });
    const res = await callBills(store.db, { jurisdiction: "us-tx", days: 7, chamber: "upper" });
    const identifiers = res.results.map((r) => r.identifier);
    expect(identifiers).toContain("SB 10");
    expect(identifiers).not.toContain("HB 20");
    // HB1 from beforeEach has no from_organization — excluded when chamber filter is active
    expect(identifiers).not.toContain("HB1");
  });

  it("chamber=lower with all-upper bills returns empty + empty_reason=filter_eliminated_all", async () => {
    const now = new Date().toISOString();
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-or", title: "SB 1 — upper only",
      occurred_at: now,
      source: { name: "openstates", id: "or-upper-1", url: "https://openstates.org/or/bills/SB1" },
      references: [], raw: { from_organization: { classification: "upper" }, actions: [] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-or", title: "SB 2 — upper only",
      occurred_at: now,
      source: { name: "openstates", id: "or-upper-2", url: "https://openstates.org/or/bills/SB2" },
      references: [], raw: { from_organization: { classification: "upper" }, actions: [] },
    });

    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-or", days: 7, chamber: "lower", session: undefined, limit: undefined });
    const res = await callBills(store.db, { jurisdiction: "us-or", days: 7, chamber: "lower" });
    expect(res.results).toHaveLength(0);
    expect(res.empty_reason).toBe("filter_eliminated_all");
    expect(res).toHaveProperty("hint");
    // filters_applied must name chamber
    expect(res.hint).toMatch(/chamber/);
  });

  it("omits empty_reason on non-empty responses", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-or", title: "SB 1 — Test",
      occurred_at: new Date().toISOString(),
      source: { name: "openstates", id: "or-1", url: "https://ex" },
      references: [], raw: { actions: [] },
    });
    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-or", days: 7, chamber: undefined, session: undefined });
    const res = await callBills(store.db, { jurisdiction: "us-or", days: 7 });
    expect(res.results).toHaveLength(1);
    expect(res).not.toHaveProperty("empty_reason");
  });

  it("20-bill response fits under 30KB", async () => {
    for (let b = 0; b < 20; b++) {
      const refs: Array<{ entity_id: string; role: "sponsor" | "cosponsor" }> = [];
      for (let s = 0; s < 50; s++) {
        const { entity } = upsertEntity(store.db, {
          kind: "person", name: `BulkBill${b}Sponsor${s}`,
          metadata: { party: s % 2 === 0 ? "R" : "D" },
        });
        refs.push({ entity_id: entity.id, role: s === 0 ? "sponsor" : "cosponsor" });
      }
      upsertDocument(store.db, {
        kind: "bill", jurisdiction: "us-tx", title: `B${b} — Test`,
        occurred_at: new Date().toISOString(),
        source: { name: "openstates", id: `b${b}bulk`, url: "https://ex" },
        references: refs,
        raw: { actions: [] },
      });
    }
    seedFetchLogFresh("openstates", "/bills",
      { jurisdiction: "us-tx", days: 7, chamber: undefined, session: undefined });
    const res = await callBills(store.db, { jurisdiction: "us-tx", days: 7 });
    const bytes = Buffer.byteLength(JSON.stringify(res), "utf8");
    expect(bytes).toBeLessThan(30 * 1024);
  });
});

describe("recent_bills tool — R15 hydration path", () => {
  it("state jurisdiction: invokes OpenStates fetchRecentBills on cache miss", async () => {
    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    const res = await callBills(store.db, { jurisdiction: "us-tx", days: 7 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    // Local projection still runs — HB1 fixture is in-window.
    expect(res.results).toHaveLength(1);
    expect(res.results[0].identifier).toBe("HB1");
    expect(res.stale_notice).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("us-federal: invokes Congress fetchRecentBills", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { jurisdiction: "us-federal", days: 7 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it("cache hit: does NOT call the adapter on the second call within TTL", async () => {
    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 });
    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it("wildcard jurisdiction `*` is local-only — no adapter call", async () => {
    const openstatesSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));
    const congressSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    const res = await callBills(store.db, { jurisdiction: "*", days: 7 });

    expect(openstatesSpy).not.toHaveBeenCalled();
    expect(congressSpy).not.toHaveBeenCalled();
    // TX and CA fixtures both land in the "*" window.
    expect(res.results.length).toBeGreaterThanOrEqual(2);

    openstatesSpy.mockRestore();
    congressSpy.mockRestore();
  });

  it("upstream failure with no cached data propagates the error", async () => {
    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockRejectedValue(new Error("network down"));

    await expect(
      handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 }),
    ).rejects.toThrow(/network down/);

    fetchSpy.mockRestore();
  });

  it("upstream failure with stale cached data surfaces stale_notice and still serves local data", async () => {
    // Seed a stale fetch_log row so withShapedFetch chooses the stale
    // fallback branch instead of propagating the upstream error.
    upsertFetchLog(store.db, {
      source: "openstates",
      endpoint_path: "/bills",
      args_hash: hashArgs("recent_bills", {
        jurisdiction: "us-tx", days: 7, chamber: undefined, session: undefined,
      }),
      scope: "recent",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 1,
    });

    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockRejectedValue(new Error("simulated upstream failure"));

    const res = await callBills(store.db, { jurisdiction: "us-tx", days: 7 });

    expect(res.stale_notice?.reason).toBe("upstream_failure");
    expect(res.results.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("rate-limited: stale cached data returns stale_notice without hitting upstream", async () => {
    upsertFetchLog(store.db, {
      source: "openstates",
      endpoint_path: "/bills",
      args_hash: hashArgs("recent_bills", {
        jurisdiction: "us-tx", days: 7, chamber: undefined, session: undefined,
      }),
      scope: "recent",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 1,
    });

    // Drain the openstates limiter so peekWaitMs() > 2.5s threshold.
    const drained = new RateLimiter({ tokensPerInterval: 1, intervalMs: 60_000 });
    await drained.acquire();
    _setLimiterForTesting("openstates", drained);

    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    const res = await callBills(store.db, { jurisdiction: "us-tx", days: 7 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.stale_notice?.reason).toBe("upstream_failure");
    expect(res.stale_notice?.message).toMatch(/rate.?limit/i);
    expect(res.results.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("cold fetch with limit=5: calls OpenStates fetchRecentBills WITHOUT updated_since", async () => {
    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { jurisdiction: "us-mt", days: 7, limit: 5 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const callOpts = fetchSpy.mock.calls[0][1];
    expect(callOpts).toMatchObject({ jurisdiction: "us-mt", limit: 5 });
    expect(callOpts.updated_since).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("cold fetch with limit=5: caps the local projection at 5 results", async () => {
    // Seed 10 bills for us-tx so the projection has plenty to cap.
    for (let i = 0; i < 10; i++) {
      upsertDocument(store.db, {
        kind: "bill", jurisdiction: "us-tx",
        title: `SB ${100 + i} — Bulk ${i}`,
        occurred_at: new Date(Date.now() - i * 86400 * 1000).toISOString(),
        source: { name: "openstates", id: `bulk-${i}`, url: `https://ex/${i}` },
        references: [], raw: { actions: [] },
      });
    }
    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 10 }));

    const res = await callBills(store.db, {
      jurisdiction: "us-tx", days: 7, limit: 5,
    });

    expect(res.results).toHaveLength(5);
    fetchSpy.mockRestore();
  });

  it("distinct limit values produce distinct fetch_log rows", async () => {
    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7, limit: 5 });
    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7, limit: 10 });
    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 });

    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const rows = store.db
      .prepare(
        `SELECT DISTINCT args_hash FROM fetch_log
         WHERE source='openstates' AND endpoint_path='/bills'`,
      )
      .all() as Array<{ args_hash: string }>;
    expect(rows.length).toBe(3);

    fetchSpy.mockRestore();
  });

  it("limit unset: still passes updated_since (existing behaviour)", async () => {
    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 });

    const callOpts = fetchSpy.mock.calls[0][1];
    expect(callOpts.updated_since).toBeDefined();
    expect(callOpts.limit).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("us-federal with limit: threads limit into Congress adapter", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { jurisdiction: "us-federal", days: 7, limit: 5 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const callOpts = fetchSpy.mock.calls[0][1];
    expect(callOpts.limit).toBe(5);
    expect(callOpts.fromDateTime).toBeDefined();

    fetchSpy.mockRestore();
  });

  it("stale_notice propagates into empty-results diagnostic response", async () => {
    upsertFetchLog(store.db, {
      source: "openstates",
      endpoint_path: "/bills",
      args_hash: hashArgs("recent_bills", {
        jurisdiction: "us-or", days: 7, chamber: undefined, session: undefined,
      }),
      scope: "recent",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 0,
    });

    const fetchSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "fetchRecentBills")
      .mockRejectedValue(new Error("upstream down"));

    // us-or has no bills in store.
    const res = await callBills(store.db, { jurisdiction: "us-or", days: 7 });
    expect(res.results).toHaveLength(0);
    expect(res).toHaveProperty("empty_reason");
    expect(res.stale_notice?.reason).toBe("upstream_failure");

    fetchSpy.mockRestore();
  });
});

describe("recent_bills tool — high-cost confirmation gate", () => {
  it("returns confirmation envelope when limit > 500 without acknowledgement", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(global, "fetch").mockImplementation(fetchMock);

    const result = await handleRecentBills(store.db, {
      jurisdiction: "us-ca",
      days: 7,
      limit: 1000,
    });

    expect("requires_confirmation" in result && result.requires_confirmation).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    if ("requires_confirmation" in result) {
      expect(result.requested_limit).toBe(1000);
      expect(result.estimated_cost.upstream_calls).toBe(50);
      expect(result.estimated_cost.openstates_daily_budget_pct).toBe(10);
    }
  });

  it("executes when limit > 500 with acknowledge_high_cost: true", async () => {
    seedFetchLogFresh("openstates", "/bills", {
      jurisdiction: "us-ca",
      days: 7,
      chamber: undefined,
      session: undefined,
      limit: 1000,
    });
    const result = await handleRecentBills(store.db, {
      jurisdiction: "us-ca",
      days: 7,
      limit: 1000,
      acknowledge_high_cost: true,
    });

    expect("results" in result).toBe(true);
    expect("requires_confirmation" in result).toBe(false);
  });

  it("does not gate at limit = 500 (boundary)", async () => {
    seedFetchLogFresh("openstates", "/bills", {
      jurisdiction: "us-ca",
      days: 7,
      chamber: undefined,
      session: undefined,
      limit: 500,
    });
    const result = await handleRecentBills(store.db, {
      jurisdiction: "us-ca",
      days: 7,
      limit: 500,
    });

    expect("requires_confirmation" in result).toBe(false);
  });

  it("uses congress source costing for us-federal", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(global, "fetch").mockImplementation(fetchMock);

    const result = await handleRecentBills(store.db, {
      jurisdiction: "us-federal",
      days: 7,
      limit: 1000,
    });

    expect("requires_confirmation" in result && result.requires_confirmation).toBe(true);
    if ("requires_confirmation" in result) {
      expect(result.estimated_cost.upstream_calls).toBe(4);
      expect(result.estimated_cost.congress_hourly_budget_pct).toBeCloseTo(0.08, 2);
      expect(result.estimated_cost.openstates_daily_budget_pct).toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not gate wildcard jurisdiction even with limit > 500", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(global, "fetch").mockImplementation(fetchMock);

    const result = await handleRecentBills(store.db, {
      jurisdiction: "*",
      days: 7,
      limit: 1000,
    });

    expect("requires_confirmation" in result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

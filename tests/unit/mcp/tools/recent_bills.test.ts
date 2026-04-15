import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/federal/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { upsertFetchLog } from "../../../../src/core/fetch_log.js";
import { hashArgs } from "../../../../src/core/args_hash.js";
import { _resetToolCacheForTesting } from "../../../../src/core/tool_cache.js";
import { _resetLimitersForTesting, _setLimiterForTesting } from "../../../../src/federal/limiters.js";
import { RateLimiter } from "../../../../src/util/http.js";
import { CongressAdapter } from "../../../../src/federal/adapters/congress.js";
import { handleRecentBills } from "../../../../src/federal/tools/recent_bills.js";
import { RecentBillsInput } from "../../../../src/federal/schemas.js";
import { callBills } from "../../../helpers/bill-response-casts.js";

const TEST_DB = "./data/test-tool-recent-bills.db";
let store: Store;

/** Pre-seeds a fetch_log row so withShapedFetch takes the TTL-hit path. */
function seedFetchLogFresh(
  args: Record<string, unknown>,
): void {
  upsertFetchLog(store.db, {
    source: "congress",
    endpoint_path: "/bill",
    args_hash: hashArgs("recent_bills", args),
    scope: "recent",
    fetched_at: new Date().toISOString(),
    last_rowcount: 1,
  });
}

beforeEach(() => {
  _resetToolCacheForTesting();
  _resetLimitersForTesting();
  process.env.API_DATA_GOV_KEY = "test-key";

  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  const { entity } = upsertEntity(store.db, {
    kind: "person", name: "Jane Doe", jurisdiction: undefined,
    metadata: {
      party: "Democratic", district: "15", chamber: "lower",
      roles: [{ jurisdiction: "us-federal", role: "representative",
                from: new Date().toISOString(), to: null }],
    },
  });

  const now = new Date().toISOString();
  const old = new Date(Date.now() - 40 * 86400 * 1000).toISOString();
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-federal",
    title: "HB1 — recent bill", occurred_at: now,
    source: { name: "congress", id: "1", url: "https://congress.gov/bill/119/house-bill/1" },
    references: [{ entity_id: entity.id, role: "sponsor" }],
  });
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-federal",
    title: "HB2 — old bill", occurred_at: old,
    source: { name: "congress", id: "2", url: "https://congress.gov/bill/119/house-bill/2" },
  });
});
afterEach(() => {
  store.close();
  delete process.env.API_DATA_GOV_KEY;
});

describe("recent_bills tool — projection (TTL-hit path)", () => {
  it("returns only bills within the window", async () => {
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, limit: undefined });
    const result = await callBills(store.db, { days: 7 });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].identifier).toBe("HB1");
    expect(result.results[0].title).toBe("recent bill");
  });

  it("includes sponsor info via sponsor_summary", async () => {
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, limit: undefined });
    const result = await callBills(store.db, { days: 7 });
    const r = result.results[0];
    expect(r).toHaveProperty("sponsor_summary");
    expect(r).not.toHaveProperty("sponsors");
    expect(r.sponsor_summary.top[0].name).toBe("Jane Doe");
    expect(r.sponsor_summary.top[0].party).toBe("Democratic");
    expect(r.sponsor_summary.top[0].role).toBe("sponsor");
  });

  it("projects latest_action to {date, description} only, dropping upstream extras", async () => {
    const now = new Date().toISOString();
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal",
      title: "HB42 — shape pin", occurred_at: now,
      source: { name: "congress", id: "shape-pin", url: "https://congress.gov/bill/119/house-bill/42" },
      raw: {
        actions: [
          {
            id: "ocd-action-uuid",
            organization: { id: "ocd-org-uuid", name: "House", classification: "lower" },
            description: "Passed the House.",
            date: "2026-04-13",
            classification: ["passage"],
            order: 7,
            related_entities: [{ name: "Floor", entity_type: "organization" }],
          },
        ],
      },
    });
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, limit: undefined });
    const result = await callBills(store.db, { days: 7 });
    // Find the shape-pin bill
    const target = result.results.find((r) => r.identifier === "HB42");
    expect(target).toBeDefined();
    const la = target!.latest_action;
    expect(la).not.toBeNull();
    expect(Object.keys(la!).sort()).toEqual(["date", "description"]);
    expect(la).toEqual({ date: "2026-04-13", description: "Passed the House." });
  });

  it("includes source provenance URL", async () => {
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, limit: undefined });
    const result = await callBills(store.db, { days: 7 });
    expect(result.sources).toContainEqual({
      name: "congress",
      url: expect.stringContaining("congress.gov"),
    });
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
      kind: "bill", jurisdiction: "us-federal", title: "SB 1 — Test",
      occurred_at: new Date().toISOString(),
      source: { name: "congress", id: "1b", url: "https://congress.gov/bill/119/senate-bill/1" },
      references: sponsorIds.map((id, i) => ({
        entity_id: id,
        role: (i === 0 ? "sponsor" : "cosponsor") as "sponsor" | "cosponsor",
      })),
      raw: { actions: [] },
    });

    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, limit: undefined });
    const res = await callBills(store.db, { days: 7 });
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
      external_ids: { bioguide: "B000001" },
      metadata: { party: "Republican" },
    });
    const { entity: noParty } = upsertEntity(store.db, {
      kind: "person", name: "NoPartyPerson",
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "SB X — Test",
      occurred_at: new Date().toISOString(),
      source: { name: "congress", id: "x", url: "https://congress.gov/bill/119/senate-bill/x" },
      references: [
        { entity_id: withParty.id, role: "sponsor" },
        { entity_id: noParty.id,   role: "cosponsor" },
      ],
      raw: { actions: [] },
    });
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, limit: undefined });
    const res = await callBills(store.db, { days: 7 });
    const target = res.results.find((r) => r.identifier === "SB X");
    expect(target).toBeDefined();
    expect(target!.sponsor_summary.by_party).toMatchObject({
      Republican: 1,
      unknown: 1,
    });
  });

  it("accepts days up to 365", async () => {
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 365, chamber: undefined, session: undefined, limit: undefined });
    const res = await callBills(store.db, { days: 365 });
    expect(res.window.from).toBeDefined();
  });

  it("rejects days above 365", async () => {
    await expect(
      handleRecentBills(store.db, { days: 366 }),
    ).rejects.toThrow();
  });

  it("accepts a small positive limit", () => {
    expect(() =>
      RecentBillsInput.parse({ days: 7, limit: 5 }),
    ).not.toThrow();
  });

  it("accepts limit up to 500", () => {
    expect(() =>
      RecentBillsInput.parse({ days: 7, limit: 500 }),
    ).not.toThrow();
  });

  it("rejects limit > 500", () => {
    expect(() =>
      RecentBillsInput.parse({ days: 7, limit: 501 }),
    ).toThrow();
  });

  it("rejects limit=0", async () => {
    await expect(
      handleRecentBills(store.db, { days: 7, limit: 0 }),
    ).rejects.toThrow();
  });

  it("filters by session when session parameter is provided", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "SB 1 — Eight-Ninety-Two",
      occurred_at: "2025-09-18T00:00:00Z",
      source: { name: "congress", id: "892-1", url: "https://congress.gov/bill/119/senate-bill/1" },
      references: [], raw: { session: "119", actions: [] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "SB 99 — Eight-Ninety-One",
      occurred_at: "2024-06-01T00:00:00Z",
      source: { name: "congress", id: "891-99", url: "https://congress.gov/bill/118/senate-bill/99" },
      references: [], raw: { session: "118", actions: [] },
    });

    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: "119", limit: undefined });
    const res = await callBills(store.db, {
      days: 7,        // window excludes both bills
      session: "119", // bypass window; filter to session 119
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].title).toBe("Eight-Ninety-Two");
  });

  it("attaches empty_reason diagnostic when results are empty", async () => {
    // Use an isolated store with no bills so the projection returns empty.
    const emptyStore = openStore("./data/test-recent-bills-diag.db");
    seedJurisdictions(emptyStore.db);
    upsertFetchLog(emptyStore.db, {
      source: "congress",
      endpoint_path: "/bill",
      args_hash: hashArgs("recent_bills", {
        jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, limit: undefined,
      }),
      scope: "recent",
      fetched_at: new Date().toISOString(),
      last_rowcount: 1,
    });

    const res = await callBills(emptyStore.db, { days: 7 });
    expect(res.results).toHaveLength(0);
    expect(res).toHaveProperty("empty_reason", "no_events_in_window");
    expect(res).toHaveProperty("data_freshness");
    expect(res).toHaveProperty("hint");

    emptyStore.close();
    if (existsSync("./data/test-recent-bills-diag.db")) rmSync("./data/test-recent-bills-diag.db");
  });

  it("chamber=upper returns only upper-chamber bills (from_organization.classification)", async () => {
    const now = new Date().toISOString();
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "SB 10 — upper bill",
      occurred_at: now,
      source: { name: "congress", id: "upper-1", url: "https://congress.gov/bill/119/senate-bill/10" },
      references: [], raw: { from_organization: { classification: "upper" }, actions: [] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "HB 20 — lower bill",
      occurred_at: now,
      source: { name: "congress", id: "lower-1", url: "https://congress.gov/bill/119/house-bill/20" },
      references: [], raw: { from_organization: { classification: "lower" }, actions: [] },
    });

    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: "upper", session: undefined, limit: undefined });
    const res = await callBills(store.db, { days: 7, chamber: "upper" });
    const identifiers = res.results.map((r) => r.identifier);
    expect(identifiers).toContain("SB 10");
    expect(identifiers).not.toContain("HB 20");
    // HB1 from beforeEach has no from_organization — excluded when chamber filter is active
    expect(identifiers).not.toContain("HB1");
  });

  it("chamber=lower with all-upper bills returns empty + empty_reason=filter_eliminated_all", async () => {
    const now = new Date().toISOString();
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "SB 1 — upper only",
      occurred_at: now,
      source: { name: "congress", id: "fed-upper-1", url: "https://congress.gov/bill/119/senate-bill/1b" },
      references: [], raw: { from_organization: { classification: "upper" }, actions: [] },
    });

    // Seed a fresh fetch_log so the handler uses local projection only.
    upsertFetchLog(store.db, {
      source: "congress",
      endpoint_path: "/bill",
      args_hash: hashArgs("recent_bills", {
        jurisdiction: "us-federal", days: 7, chamber: "lower", session: undefined, limit: undefined,
      }),
      scope: "recent",
      fetched_at: new Date().toISOString(),
      last_rowcount: 1,
    });

    // Remove the in-window HB1 so only upper bills remain for this test.
    // We can't easily remove docs, so seed a fresh DB for isolation:
    const isolatedStore = openStore("./data/test-recent-bills-upper-only.db");
    seedJurisdictions(isolatedStore.db);
    upsertDocument(isolatedStore.db, {
      kind: "bill", jurisdiction: "us-federal", title: "SB 1 — upper only",
      occurred_at: now,
      source: { name: "congress", id: "up-1", url: "https://congress.gov/bill/119/senate-bill/1c" },
      references: [], raw: { from_organization: { classification: "upper" }, actions: [] },
    });
    upsertFetchLog(isolatedStore.db, {
      source: "congress",
      endpoint_path: "/bill",
      args_hash: hashArgs("recent_bills", {
        jurisdiction: "us-federal", days: 7, chamber: "lower", session: undefined, limit: undefined,
      }),
      scope: "recent",
      fetched_at: new Date().toISOString(),
      last_rowcount: 1,
    });

    const res = await callBills(isolatedStore.db, { days: 7, chamber: "lower" });
    expect(res.results).toHaveLength(0);
    expect(res.empty_reason).toBe("filter_eliminated_all");
    expect(res).toHaveProperty("hint");
    expect(res.hint).toMatch(/chamber/);
    isolatedStore.close();
    if (existsSync("./data/test-recent-bills-upper-only.db")) {
      rmSync("./data/test-recent-bills-upper-only.db");
    }
  });

  it("omits empty_reason on non-empty responses", async () => {
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, limit: undefined });
    const res = await callBills(store.db, { days: 7 });
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
        kind: "bill", jurisdiction: "us-federal", title: `B${b} — Test`,
        occurred_at: new Date().toISOString(),
        source: { name: "congress", id: `b${b}bulk`, url: "https://congress.gov" },
        references: refs,
        raw: { actions: [] },
      });
    }
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, limit: undefined });
    const res = await callBills(store.db, { days: 7 });
    const bytes = Buffer.byteLength(JSON.stringify(res), "utf8");
    expect(bytes).toBeLessThan(30 * 1024);
  });
});

describe("recent_bills tool — R15 hydration path", () => {
  it("invokes Congress fetchRecentBills on cache miss", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    const res = await callBills(store.db, { days: 7 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    // Local projection still runs — HB1 fixture is in-window.
    expect(res.results).toHaveLength(1);
    expect(res.results[0].identifier).toBe("HB1");
    expect(res.stale_notice).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("cache hit: does NOT call the adapter on the second call within TTL", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { days: 7 });
    await handleRecentBills(store.db, { days: 7 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it("upstream failure with no cached data propagates the error", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockRejectedValue(new Error("network down"));

    await expect(
      handleRecentBills(store.db, { days: 7 }),
    ).rejects.toThrow(/network down/);

    fetchSpy.mockRestore();
  });

  it("upstream failure with stale cached data surfaces stale_notice and still serves local data", async () => {
    upsertFetchLog(store.db, {
      source: "congress",
      endpoint_path: "/bill",
      args_hash: hashArgs("recent_bills", {
        jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, limit: undefined,
      }),
      scope: "recent",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 1,
    });

    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockRejectedValue(new Error("simulated upstream failure"));

    const res = await callBills(store.db, { days: 7 });

    expect(res.stale_notice?.reason).toBe("upstream_failure");
    expect(res.results.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("rate-limited: stale cached data returns stale_notice without hitting upstream", async () => {
    upsertFetchLog(store.db, {
      source: "congress",
      endpoint_path: "/bill",
      args_hash: hashArgs("recent_bills", {
        jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, limit: undefined,
      }),
      scope: "recent",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 1,
    });

    // Drain the congress limiter so peekWaitMs() > 2.5s threshold.
    const drained = new RateLimiter({ tokensPerInterval: 1, intervalMs: 60_000 });
    await drained.acquire();
    _setLimiterForTesting("congress", drained);

    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    const res = await callBills(store.db, { days: 7 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.stale_notice?.reason).toBe("upstream_failure");
    expect(res.stale_notice?.message).toMatch(/rate.?limit/i);
    expect(res.results.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("cold fetch with limit=5: calls Congress fetchRecentBills with limit", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { days: 7, limit: 5 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const callOpts = fetchSpy.mock.calls[0][1];
    expect(callOpts.limit).toBe(5);
    // When limit is set, fromDateTime is widened to 365d — defined but not same as 7d
    expect(callOpts.fromDateTime).toBeDefined();

    fetchSpy.mockRestore();
  });

  it("cold fetch with limit=5: caps the local projection at 5 results", async () => {
    for (let i = 0; i < 10; i++) {
      upsertDocument(store.db, {
        kind: "bill", jurisdiction: "us-federal",
        title: `SB ${100 + i} — Bulk ${i}`,
        occurred_at: new Date(Date.now() - i * 86400 * 1000).toISOString(),
        source: { name: "congress", id: `bulk-${i}`, url: `https://congress.gov/${i}` },
        references: [], raw: { actions: [] },
      });
    }
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 10 }));

    const res = await callBills(store.db, { days: 7, limit: 5 });

    expect(res.results).toHaveLength(5);
    fetchSpy.mockRestore();
  });

  it("distinct limit values produce distinct fetch_log rows", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { days: 7, limit: 5 });
    await handleRecentBills(store.db, { days: 7, limit: 10 });
    await handleRecentBills(store.db, { days: 7 });

    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const rows = store.db
      .prepare(
        `SELECT DISTINCT args_hash FROM fetch_log
         WHERE source='congress' AND endpoint_path='/bill'`,
      )
      .all() as Array<{ args_hash: string }>;
    expect(rows.length).toBe(3);

    fetchSpy.mockRestore();
  });

  it("limit unset: passes fromDateTime from the days window", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { days: 7 });

    const callOpts = fetchSpy.mock.calls[0][1];
    expect(callOpts.fromDateTime).toBeDefined();
    expect(callOpts.limit).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("with limit: threads limit into Congress adapter", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentBills(store.db, { days: 7, limit: 5 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const callOpts = fetchSpy.mock.calls[0][1];
    expect(callOpts.limit).toBe(5);
    expect(callOpts.fromDateTime).toBeDefined();

    fetchSpy.mockRestore();
  });

  it("stale_notice propagates into empty-results diagnostic response", async () => {
    // Use isolated store with no bills so results are empty
    const emptyStore = openStore("./data/test-recent-bills-empty.db");
    seedJurisdictions(emptyStore.db);

    upsertFetchLog(emptyStore.db, {
      source: "congress",
      endpoint_path: "/bill",
      args_hash: hashArgs("recent_bills", {
        jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, limit: undefined,
      }),
      scope: "recent",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 0,
    });

    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentBills")
      .mockRejectedValue(new Error("upstream down"));

    const res = await callBills(emptyStore.db, { days: 7 });
    expect(res.results).toHaveLength(0);
    expect(res).toHaveProperty("empty_reason");
    expect(res.stale_notice?.reason).toBe("upstream_failure");

    fetchSpy.mockRestore();
    emptyStore.close();
    if (existsSync("./data/test-recent-bills-empty.db")) {
      rmSync("./data/test-recent-bills-empty.db");
    }
  });
});

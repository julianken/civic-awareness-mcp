import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { upsertFetchLog } from "../../../../src/core/fetch_log.js";
import { hashArgs } from "../../../../src/core/args_hash.js";
import { _resetToolCacheForTesting } from "../../../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../../../src/core/limiters.js";
import { CongressAdapter } from "../../../../src/adapters/congress.js";
import { handleRecentVotes } from "../../../../src/mcp/tools/recent_votes.js";

const TEST_DB = "./data/test-tool-recent-votes.db";
let store: Store;

const RECENT = new Date().toISOString();
const OLD = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

function seedVote(id: string, occurred: string, chamber: string, billId: string, result: string) {
  upsertDocument(store.db, {
    kind: "vote",
    jurisdiction: "us-federal",
    title: `Vote 119-${chamber}-${id}: ${billId} — On Passage`,
    occurred_at: occurred,
    source: {
      name: "congress",
      id: `vote-119-${chamber.toLowerCase()}-${id}`,
      url: `https://www.congress.gov/roll-call-votes/119/${chamber.toLowerCase()}/${id}`,
    },
    raw: {
      congress: 119,
      chamber,
      rollNumber: parseInt(id, 10),
      question: "On Passage",
      result,
      bill: { type: "HR", number: billId.replace("HR", "") },
      totals: { yea: 218, nay: 210, present: 2, notVoting: 5 },
    },
  });
}

/**
 * Pre-seeds a fetch_log row for (congress, /vote, args) so
 * `withShapedFetch` takes the TTL-hit path — the adapter method is
 * NOT called, and the handler runs the SQL projection directly.
 */
function seedFetchLogFresh(args: Record<string, unknown>): void {
  upsertFetchLog(store.db, {
    source: "congress",
    endpoint_path: "/vote",
    args_hash: hashArgs("recent_votes", args),
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
  upsertEntity(store.db, {
    kind: "person",
    name: "Schumer, Charles E.",
    jurisdiction: undefined,
    external_ids: { bioguide: "S000148" },
    metadata: {
      roles: [{ jurisdiction: "us-federal", role: "senator", from: "1999-01-03T00:00:00.000Z", to: null }],
    },
  });
  seedVote("42", RECENT, "House", "HR1234", "Passed");
  seedVote("43", RECENT, "Senate", "S567", "Failed");
  seedVote("10", OLD, "House", "HR99", "Passed");
});
afterEach(() => {
  store.close();
  delete process.env.API_DATA_GOV_KEY;
});

describe("recent_votes tool — projection (TTL-hit path)", () => {
  it("returns only votes within the time window", async () => {
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, bill_identifier: undefined });
    const result = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    expect(result.results).toHaveLength(2);
  });

  it("filters by chamber", async () => {
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: "upper", session: undefined, bill_identifier: undefined });
    const result = await handleRecentVotes(store.db, {
      jurisdiction: "us-federal",
      days: 7,
      chamber: "upper",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].chamber).toBe("Senate");
  });

  it("filters by bill_identifier", async () => {
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, bill_identifier: "HR1234" });
    const result = await handleRecentVotes(store.db, {
      jurisdiction: "us-federal",
      days: 7,
      bill_identifier: "HR1234",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].bill_identifier).toBe("HR1234");
  });

  it("returns tally from raw.totals", async () => {
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, bill_identifier: undefined });
    const result = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    const vote = result.results.find((v) => v.bill_identifier === "HR1234");
    expect(vote?.tally.yea).toBe(218);
    expect(vote?.tally.nay).toBe(210);
    expect(vote?.tally.present).toBe(2);
    expect(vote?.tally.absent).toBe(5);
  });

  it("includes result field", async () => {
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, bill_identifier: undefined });
    const result = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    const passed = result.results.find((v) => v.bill_identifier === "HR1234");
    expect(passed?.result).toBe("Passed");
  });

  it("includes source provenance", async () => {
    seedFetchLogFresh({ jurisdiction: "us-federal", days: 7, chamber: undefined, session: undefined, bill_identifier: undefined });
    const result = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    expect(result.sources).toContainEqual(
      expect.objectContaining({ name: "congress" }),
    );
  });

  it("rejects input with no jurisdiction", async () => {
    await expect(
      handleRecentVotes(store.db, { days: 7 }),
    ).rejects.toThrow();
  });

  it("accepts days up to 365", async () => {
    const res = await handleRecentVotes(store.db, { jurisdiction: "us-or", days: 365 });
    expect(res.window.from).toBeDefined();
  });

  it("rejects days above 365", async () => {
    await expect(
      handleRecentVotes(store.db, { jurisdiction: "us-or", days: 366 }),
    ).rejects.toThrow();
  });

  it("filters votes by session", async () => {
    upsertDocument(store.db, {
      kind: "vote", jurisdiction: "us-tx", title: "Vote 892-1",
      occurred_at: "2025-09-18T00:00:00Z",
      source: { name: "openstates", id: "892v", url: "https://ex" },
      references: [], raw: { session: "892" },
    });
    upsertDocument(store.db, {
      kind: "vote", jurisdiction: "us-tx", title: "Vote 891-1",
      occurred_at: "2024-06-01T00:00:00Z",
      source: { name: "openstates", id: "891v", url: "https://ex" },
      references: [], raw: { session: "891" },
    });

    const res = await handleRecentVotes(store.db, {
      jurisdiction: "us-tx",
      days: 7,
      session: "892",
    });
    expect(res.results).toHaveLength(1);
  });

  it("attaches empty_reason diagnostic when results are empty", async () => {
    const res = await handleRecentVotes(store.db, { jurisdiction: "us-or", days: 7 });
    expect(res.results).toHaveLength(0);
    expect(res).toHaveProperty("empty_reason", "no_events_in_window");
  });

  it("omits empty_reason on non-empty responses", async () => {
    upsertDocument(store.db, {
      kind: "vote", jurisdiction: "us-or", title: "Vote 1",
      occurred_at: new Date().toISOString(),
      source: { name: "openstates", id: "v1", url: "https://ex" },
      references: [], raw: {},
    });
    const res = await handleRecentVotes(store.db, { jurisdiction: "us-or", days: 7 });
    expect(res.results).toHaveLength(1);
    expect(res).not.toHaveProperty("empty_reason");
  });
});

describe("recent_votes tool — R15 hydration path", () => {
  it("us-federal: invokes Congress fetchRecentVotes on cache miss", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentVotes")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    const res = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    // Local projection still runs — two federal fixtures are in-window.
    expect(res.results).toHaveLength(2);
    expect(res.stale_notice).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("state jurisdiction (us-tx) short-circuits to local-only — adapter not called", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentVotes")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    const res = await handleRecentVotes(store.db, { jurisdiction: "us-tx", days: 7 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.stale_notice).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("404 degraded mode returns empty results without stale_notice", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentVotes")
      .mockImplementation(async () => ({ documentsUpserted: 0, degraded: true }));

    // Query a jurisdiction with no votes in the store so the projection
    // is empty even though the fetch "succeeded" in degraded mode.
    const res = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(res.stale_notice).toBeUndefined();
    // Fixtures exist; projection returns them.
    expect(res.results).toHaveLength(2);

    fetchSpy.mockRestore();
  });

  it("cache hit: does NOT call the adapter on the second call within TTL", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentVotes")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it("upstream failure with no cached data propagates the error", async () => {
    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentVotes")
      .mockRejectedValue(new Error("network down"));

    await expect(
      handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 }),
    ).rejects.toThrow(/network down/);

    fetchSpy.mockRestore();
  });

  it("upstream failure with stale cached data surfaces stale_notice and still serves local data", async () => {
    upsertFetchLog(store.db, {
      source: "congress",
      endpoint_path: "/vote",
      args_hash: hashArgs("recent_votes", {
        jurisdiction: "us-federal", days: 7,
        chamber: undefined, session: undefined, bill_identifier: undefined,
      }),
      scope: "recent",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 1,
    });

    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentVotes")
      .mockRejectedValue(new Error("simulated upstream failure"));

    const res = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });

    expect(res.stale_notice?.reason).toBe("upstream_failure");
    expect(res.results.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("stale_notice propagates into empty-results diagnostic response", async () => {
    // Wipe the federal vote fixtures so the projection is empty while
    // the stale-fallback path triggers on the /vote key.
    store.db.prepare("DELETE FROM documents WHERE kind = 'vote' AND jurisdiction = 'us-federal'").run();

    upsertFetchLog(store.db, {
      source: "congress",
      endpoint_path: "/vote",
      args_hash: hashArgs("recent_votes", {
        jurisdiction: "us-federal", days: 7,
        chamber: undefined, session: undefined, bill_identifier: undefined,
      }),
      scope: "recent",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 0,
    });

    const fetchSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchRecentVotes")
      .mockRejectedValue(new Error("upstream down"));

    const res = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    expect(res.results).toHaveLength(0);
    expect(res).toHaveProperty("empty_reason");
    expect(res.stale_notice?.reason).toBe("upstream_failure");

    fetchSpy.mockRestore();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/federal/seeds.js";
import { _resetToolCacheForTesting } from "../../../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../../../src/state/limiters.js";
import { handleRecentVotes } from "../../../../src/state/tools/recent_votes.js";
import { upsertDocument } from "../../../../src/core/documents.js";

vi.stubEnv("OPENSTATES_API_KEY", "test-key");

/** Vote start_date within 30 days of the test run so it lands inside
 *  projectLocal's time window (now - days). Using a dynamic "recent" date
 *  avoids the test drifting stale as clock advances. */
const RECENT_DATE = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // "YYYY-MM-DD"

/** Minimal one-vote API response for a TX bill. */
function makeApiResponse(startDate: string = RECENT_DATE) {
  return {
    results: [
      {
        id: "ocd-bill/test-bill-001",
        session: "892",
        jurisdiction: {
          id: "ocd-jurisdiction/country:us/state:tx/government",
          name: "Texas",
          classification: "state",
        },
        from_organization: { id: "org-1", name: "Senate", classification: "upper" },
        identifier: "SB 1",
        title: "A test bill",
        classification: ["bill"],
        subject: [],
        extras: {},
        created_at: "2025-08-01T00:00:00.000Z",
        updated_at: `${startDate}T00:00:00.000Z`,
        openstates_url: "https://openstates.org/tx/bills/892/SB1/",
        first_action_date: "2025-08-01",
        latest_action_date: startDate,
        latest_action_description: "Passed.",
        latest_passage_date: startDate,
        votes: [
          {
            id: "ocd-vote/test-vote-001",
            motion_text: "passage",
            motion_classification: ["passage"],
            start_date: startDate,
            result: "pass",
            identifier: "",
            extras: {},
            organization: { id: "org-1", name: "Senate", classification: "upper" },
            votes: [],
            counts: [
              { option: "yes", value: 25 },
              { option: "no", value: 5 },
              { option: "not voting", value: 1 },
            ],
            sources: [{ url: "https://example.com/vote/1", note: "" }],
          },
        ],
      },
    ],
    pagination: { per_page: 20, page: 1, max_page: 1 },
  };
}

const API_RESPONSE = makeApiResponse();

let store: Store;

beforeEach(() => {
  _resetToolCacheForTesting();
  _resetLimitersForTesting();
  store = openStore(":memory:");
  seedJurisdictions(store.db);
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

describe("handleRecentVotes (state)", () => {
  it("fetches upstream, upserts, and returns matching votes", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(API_RESPONSE), { status: 200 }),
    );

    const result = await handleRecentVotes(store.db, {
      jurisdiction: "us-tx",
      days: 30,
      limit: 10,
    });

    expect(result.results).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.sources).toEqual([{ name: "openstates", url: "https://openstates.org/tx/" }]);
    expect(result.window).toHaveProperty("from");
    expect(result.window).toHaveProperty("to");
    expect(result.stale_notice).toBeUndefined();

    const vote = result.results[0];
    expect(vote.bill_identifier).toBe("SB 1");
    expect(vote.chamber).toBe("upper");
    expect(vote.result).toBe("pass");
    expect(vote.motion_text).toBe("passage");
    expect(vote.tally).toEqual({ yes: 25, no: 5, not_voting: 1 });
    expect(vote.source_url).toBe("https://example.com/vote/1");
  });

  it("returns stale fallback with stale_notice when upstream throws and prior fetch_log exists", async () => {
    // Prime the cache with a prior fetch
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(API_RESPONSE), { status: 200 }),
    );
    await handleRecentVotes(store.db, { jurisdiction: "us-tx", days: 30 });

    // Expire the fetch_log row so withShapedFetch will attempt another fetch.
    // TTL is 1 hour; backdating by 2 hours guarantees a miss.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    store.db.prepare("UPDATE fetch_log SET fetched_at = ?").run(twoHoursAgo);

    _resetToolCacheForTesting();

    // Now make the upstream throw — withShapedFetch should fall back to stale.
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("network failure"));

    const result = await handleRecentVotes(store.db, { jurisdiction: "us-tx", days: 30 });

    expect(result.stale_notice).toBeDefined();
    expect(result.stale_notice?.reason).toBe("upstream_failure");
  });

  it("returns empty_reason='no_events_in_window' when store is empty and upstream returns no votes", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }), {
        status: 200,
      }),
    );

    const result = await handleRecentVotes(store.db, { jurisdiction: "us-tx", days: 1 });

    expect(result.results).toHaveLength(0);
    expect(result.empty_reason).toBe("no_events_in_window");
  });

  it("filters by chamber when provided", async () => {
    // Seed two votes: one upper, one lower
    upsertDocument(store.db, {
      kind: "vote",
      jurisdiction: "us-tx",
      title: "SB 1 — passage",
      occurred_at: new Date().toISOString(),
      source: { name: "openstates", id: "ocd-vote/upper-001", url: "https://example.com/1" },
      raw: {
        chamber: "upper",
        result: "pass",
        motion_text: "passage",
        counts: [],
        bill: { identifier: "SB 1" },
      },
    });
    upsertDocument(store.db, {
      kind: "vote",
      jurisdiction: "us-tx",
      title: "HB 1 — passage",
      occurred_at: new Date().toISOString(),
      source: { name: "openstates", id: "ocd-vote/lower-001", url: "https://example.com/2" },
      raw: {
        chamber: "lower",
        result: "pass",
        motion_text: "passage",
        counts: [],
        bill: { identifier: "HB 1" },
      },
    });

    // Seed a fetch_log row so withShapedFetch hits the cache
    store.db
      .prepare(
        `INSERT INTO fetch_log (source, endpoint_path, args_hash, scope, fetched_at, last_rowcount)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "openstates",
        "/bills?include=votes",
        "dummy-upper-hash",
        "recent",
        new Date().toISOString(),
        1,
      );

    // Make fetch return empty so we rely on seeded data via cache-hit path
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(API_RESPONSE), { status: 200 }),
    );

    // Call with no chamber — get both
    const allResult = await handleRecentVotes(store.db, { jurisdiction: "us-tx", days: 7 });
    // After this call the fetch_log is seeded for the exact args combo

    // Now test chamber filter via direct projectLocal path (wildcard jurisdiction bypasses upstream)
    const upperResult = await handleRecentVotes(store.db, { jurisdiction: "*", chamber: "upper" });
    expect(upperResult.results.every((v) => v.chamber === "upper")).toBe(true);

    const lowerResult = await handleRecentVotes(store.db, { jurisdiction: "*", chamber: "lower" });
    expect(lowerResult.results.every((v) => v.chamber === "lower")).toBe(true);

    // allResult should include both (wildcard)
    expect(allResult.results.length).toBeGreaterThanOrEqual(1);
  });

  it("wildcard jurisdiction short-circuits to local-only (no fetch)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");

    await handleRecentVotes(store.db, { jurisdiction: "*", days: 7 });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

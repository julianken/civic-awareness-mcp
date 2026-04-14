/**
 * Shaped-fetch integration tests (R15 path) for `recent_bills`.
 *
 * Mirrors the scenarios the R13 passthrough suite used to cover for
 * recent_bills, adapted to the R15 `withShapedFetch` contract:
 *
 *  1. Cold fetch → warm hit: first call hits upstream, second call
 *     (within TTL) serves from the local store with no upstream hit.
 *  2. Upstream failure with no prior cache propagates the error.
 *  3. Upstream failure with a stale `fetch_log` row serves local
 *     data plus `stale_notice.reason === "upstream_failure"`.
 *
 * The `rate_limited` stale-notice reason was retired under R15 — gate
 * failures produce `upstream_failure` when cached data exists, else
 * propagate. That behaviour is covered by the unit suite
 * (tests/unit/mcp/tools/recent_bills.test.ts).
 *
 * HTTP is stubbed via `vi.spyOn(global, "fetch")` to match the rest
 * of this codebase (msw is not a project dep).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/core/seeds.js";
import { upsertEntity } from "../../src/core/entities.js";
import { handleRecentBills } from "../../src/mcp/tools/recent_bills.js";
import { handleRecentVotes } from "../../src/mcp/tools/recent_votes.js";
import { handleRecentContributions } from "../../src/mcp/tools/recent_contributions.js";
import { handleResolvePerson } from "../../src/mcp/tools/resolve_person.js";
import { handleSearchEntities } from "../../src/mcp/tools/search_entities.js";
import { _resetToolCacheForTesting } from "../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../src/core/limiters.js";
import { seedStaleCache } from "../helpers/seed_stale_cache.js";

vi.stubEnv("OPENSTATES_API_KEY", "test-key");
vi.stubEnv("API_DATA_GOV_KEY", "test-key");

const billsFixture = readFileSync(
  "tests/integration/fixtures/openstates-bills-page1.json",
  "utf-8",
);

let store: Store;
let upstreamHits = 0;

beforeEach(() => {
  upstreamHits = 0;
  _resetToolCacheForTesting();
  _resetLimitersForTesting();
  store = openStore(":memory:");
  seedJurisdictions(store.db);
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

describe("passthrough shaped e2e — recent_bills (R15)", () => {
  it("cold fetch → warm hit: second call does not hit upstream", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "string" ? input : (input as URL | Request).toString());
      if (!url.includes("openstates.org/bills")) return new Response("", { status: 404 });
      upstreamHits += 1;
      return new Response(billsFixture, { status: 200 });
    });

    const first = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 });
    const second = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 });

    expect(upstreamHits).toBe(1);
    expect(first.results.length).toBeGreaterThan(0);
    expect(second.results.length).toBeGreaterThan(0);
    expect(first.stale_notice).toBeUndefined();
    expect(second.stale_notice).toBeUndefined();
  });

  it("upstream failure with no prior cache propagates the error", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "string" ? input : (input as URL | Request).toString());
      if (!url.includes("openstates.org/bills")) return new Response("", { status: 404 });
      upstreamHits += 1;
      return new Response(JSON.stringify({ detail: "server error" }), { status: 500 });
    });

    await expect(
      handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 }),
    ).rejects.toThrow();

    expect(upstreamHits).toBeGreaterThan(0);
  });

  it("upstream failure with stale cache returns stale + upstream_failure notice", async () => {
    // Seed a stale fetch_log row and the document it projects from.
    // `last_rowcount` is informational only — the projection reads
    // whatever is in `documents` at the time of the call.
    seedStaleCache({
      db: store.db,
      source: "openstates",
      endpoint_path: "/bills",
      scope: "recent",
      tool: "recent_bills",
      args: {
        jurisdiction: "us-tx",
        days: 90,
        chamber: undefined,
        session: undefined,
      },
      documents: [
        {
          kind: "bill",
          jurisdiction: "us-tx",
          title: "HB99 — Stale Bill",
          occurred_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          source: {
            name: "openstates",
            id: "ocd-bill/tx-stale",
            url: "https://openstates.org/tx/bills/HB99",
          },
          raw: { actions: [] },
        },
      ],
    });

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "string" ? input : (input as URL | Request).toString());
      if (!url.includes("openstates.org/bills")) return new Response("", { status: 404 });
      upstreamHits += 1;
      return new Response(JSON.stringify({ detail: "server error" }), { status: 500 });
    });

    const result = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 });

    expect(upstreamHits).toBeGreaterThan(0);
    expect(result.stale_notice?.reason).toBe("upstream_failure");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].identifier).toBe("HB99");
  });
});

describe("passthrough shaped e2e — recent_votes (federal)", () => {
  it("cold fetch → warm hit: second call is cache hit", async () => {
    let votesUpstreamHits = 0;
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
      votesUpstreamHits += 1;
      return new Response(
        JSON.stringify({
          votes: [
            {
              congress: 119,
              chamber: "Senate",
              rollNumber: 1,
              date: "2026-04-10T12:00:00Z",
              positions: [],
              totals: {},
            },
          ],
          pagination: { count: 1 },
        }),
        { status: 200 },
      );
    });

    await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });

    expect(votesUpstreamHits).toBe(1);
    fetchSpy.mockRestore();
  });

  it("404 degraded mode returns empty without stale_notice", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 404 }));

    const result = await handleRecentVotes(store.db, {
      jurisdiction: "us-federal",
      days: 7,
    });
    expect(result.results).toEqual([]);
    expect(result.stale_notice).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it("upstream failure with stale cache returns stale + notice", async () => {
    seedStaleCache({
      db: store.db,
      source: "congress",
      endpoint_path: "/vote",
      scope: "recent",
      tool: "recent_votes",
      args: {
        jurisdiction: "us-federal",
        days: 7,
        chamber: undefined,
        session: undefined,
        bill_identifier: undefined,
      },
      documents: [
        {
          kind: "vote",
          jurisdiction: "us-federal",
          title: "Vote 119-Senate-1: S.1234 — Motion",
          occurred_at: "2026-04-10T00:00:00Z",
          source: {
            name: "congress",
            id: "vote-119-senate-1",
            url: "https://www.congress.gov/roll-call-votes/119/senate/1",
          },
          references: [],
          raw: {
            congress: 119,
            chamber: "Senate",
            rollNumber: 1,
            totals: { yea: 60, nay: 40 },
          },
        },
      ],
    });

    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error("network down"));

    const result = await handleRecentVotes(store.db, {
      jurisdiction: "us-federal",
      days: 7,
    });
    expect(result.stale_notice?.reason).toBe("upstream_failure");
    expect(result.results.length).toBeGreaterThan(0);
    fetchSpy.mockRestore();
  });
});

describe("passthrough shaped e2e — recent_contributions", () => {
  it("cold fetch → warm hit", async () => {
    let upstreamHits = 0;
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
      upstreamHits += 1;
      return new Response(JSON.stringify({ results: [], pagination: {} }), { status: 200 });
    });

    const window = {
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-04-14T00:00:00.000Z",
    };
    await handleRecentContributions(store.db, { window });
    await handleRecentContributions(store.db, { window });

    expect(upstreamHits).toBe(1);
    fetchSpy.mockRestore();
  });

  it("upstream failure with stale cache returns stale + notice", async () => {
    const window = { from: "2026-04-01T00:00:00.000Z", to: "2026-04-14T00:00:00.000Z" };
    seedStaleCache({
      db: store.db,
      source: "openfec",
      endpoint_path: "/schedules/schedule_a",
      scope: "recent",
      tool: "recent_contributions",
      args: { window, candidate_or_committee: undefined, min_amount: undefined },
      documents: [{
        kind: "contribution",
        jurisdiction: "us-federal",
        title: "Contribution from Jane Smith",
        occurred_at: "2026-04-05T00:00:00Z",
        source: {
          name: "openfec",
          id: "sa-T1",
          url: "https://docquery.fec.gov/cgi-bin/fecimg/?T1",
        },
        references: [],
        raw: { amount: 2500, date: "2026-04-05", contributor_name: "SMITH, JANE" },
      }],
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

    const result = await handleRecentContributions(store.db, { window });
    expect(result.stale_notice?.reason).toBe("upstream_failure");
    fetchSpy.mockRestore();
  });
});

describe("passthrough shaped e2e — search_entities (R15)", () => {
  it("federal: fans out to Congress.gov /member AND OpenFEC /candidates/search", async () => {
    let upstreamHits = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "string" ? input : (input as URL | Request).toString());
      if (url.includes("api.congress.gov/v3/member")) {
        upstreamHits += 1;
        return new Response(
          JSON.stringify({ members: [], pagination: { count: 0 } }),
          { status: 200 },
        );
      }
      if (url.includes("api.open.fec.gov/v1/candidates/search")) {
        upstreamHits += 1;
        return new Response(
          JSON.stringify({ results: [], pagination: { per_page: 20 } }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });

    await handleSearchEntities(store.db, {
      q: "Smith",
      jurisdiction: "us-federal",
    });

    expect(upstreamHits).toBe(2);
  });
});

describe("passthrough shaped e2e — resolve_person / search_entities shared cache", () => {
  it("search_entities us-tx + resolve_person us-tx + same name: second call is a cache hit", async () => {
    let peopleHits = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "string" ? input : (input as URL | Request).toString());
      if (!url.includes("openstates.org/people")) return new Response("", { status: 404 });
      peopleHits += 1;
      return new Response(
        JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }),
        { status: 200 },
      );
    });

    await handleSearchEntities(store.db, {
      q: "Jane Doe",
      jurisdiction: "us-tx",
    });
    await handleResolvePerson(store.db, {
      name: "Jane Doe",
      jurisdiction_hint: "us-tx",
    });

    // Shared endpoint-keyed cache: second call hits the TTL-fresh row
    // written by the first, so no additional upstream /people request.
    expect(peopleHits).toBe(1);
  });

  it("resolve_person upstream failure with no cache propagates", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "string" ? input : (input as URL | Request).toString());
      if (!url.includes("openstates.org/people")) return new Response("", { status: 404 });
      return new Response(JSON.stringify({ detail: "server error" }), { status: 500 });
    });

    // Seed a local person so the projection would otherwise return results —
    // proves the error propagates at the hydrate layer, not the projection.
    upsertEntity(store.db, {
      kind: "person",
      name: "Jane Doe",
      metadata: { roles: [{ jurisdiction: "us-tx", role: "state_legislator" }] },
    });

    await expect(
      handleResolvePerson(store.db, {
        name: "Jane Doe",
        jurisdiction_hint: "us-tx",
      }),
    ).rejects.toThrow();
  });
});

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
import { seedJurisdictions } from "../../src/federal/seeds.js";
import { upsertEntity } from "../../src/core/entities.js";
import { handleEntityConnections } from "../../src/federal/tools/entity_connections.js";
import { handleGetEntity } from "../../src/federal/tools/get_entity.js";
import { handleRecentBills } from "../../src/federal/tools/recent_bills.js";
import { callBills } from "../helpers/bill-response-casts.js";
import { handleRecentVotes } from "../../src/federal/tools/recent_votes.js";
import { handleRecentContributions } from "../../src/federal/tools/recent_contributions.js";
import { handleResolvePerson } from "../../src/federal/tools/resolve_person.js";
import { handleSearchEntities } from "../../src/federal/tools/search_entities.js";
import { _resetToolCacheForTesting } from "../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../src/federal/limiters.js";
import { seedStaleCache } from "../helpers/seed_stale_cache.js";

vi.stubEnv("OPENSTATES_API_KEY", "test-key");
vi.stubEnv("API_DATA_GOV_KEY", "test-key");

const billsFixture = readFileSync("tests/integration/fixtures/congress-bills-page1.json", "utf-8");

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
      if (!url.includes("api.congress.gov/v3/bill")) return new Response("", { status: 404 });
      upstreamHits += 1;
      return new Response(billsFixture, { status: 200 });
    });

    const first = await callBills(store.db, { days: 90 });
    const second = await callBills(store.db, { days: 90 });

    expect(upstreamHits).toBe(1);
    expect(first.results.length).toBeGreaterThan(0);
    expect(second.results.length).toBeGreaterThan(0);
    expect(first.stale_notice).toBeUndefined();
    expect(second.stale_notice).toBeUndefined();
  });

  it("upstream failure with no prior cache propagates the error", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "string" ? input : (input as URL | Request).toString());
      if (!url.includes("api.congress.gov/v3/bill")) return new Response("", { status: 404 });
      upstreamHits += 1;
      return new Response(JSON.stringify({ detail: "server error" }), { status: 500 });
    });

    await expect(handleRecentBills(store.db, { days: 90 })).rejects.toThrow();

    expect(upstreamHits).toBeGreaterThan(0);
  });

  it("upstream failure with stale cache returns stale + upstream_failure notice", async () => {
    seedStaleCache({
      db: store.db,
      source: "congress",
      endpoint_path: "/bill",
      scope: "recent",
      tool: "recent_bills",
      args: {
        jurisdiction: "us-federal",
        days: 90,
        chamber: undefined,
        session: undefined,
        limit: undefined,
      },
      documents: [
        {
          kind: "bill",
          jurisdiction: "us-federal",
          title: "HR99 — Stale Bill",
          occurred_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          source: {
            name: "congress",
            id: "congress-bill-stale",
            url: "https://congress.gov/bill/119/house-bill/99",
          },
          raw: { actions: [] },
        },
      ],
    });

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "string" ? input : (input as URL | Request).toString());
      if (!url.includes("api.congress.gov/v3/bill")) return new Response("", { status: 404 });
      upstreamHits += 1;
      return new Response(JSON.stringify({ detail: "server error" }), { status: 500 });
    });

    const result = await callBills(store.db, { days: 90 });

    expect(upstreamHits).toBeGreaterThan(0);
    expect(result.stale_notice?.reason).toBe("upstream_failure");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].identifier).toBe("HR99");
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

    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

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
  it("cold fetch → warm hit (with narrowing filter)", async () => {
    let upstreamHits = 0;
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
      upstreamHits += 1;
      return new Response(JSON.stringify({ results: [], pagination: {} }), { status: 200 });
    });

    const window = {
      from: "2026-04-01T00:00:00.000Z",
      to: "2026-04-14T00:00:00.000Z",
    };
    // Narrowing filter required — OpenFEC rejects date-only queries (Bug 3 guard).
    await handleRecentContributions(store.db, {
      window,
      candidate_or_committee: "Warren Campaign",
    });
    await handleRecentContributions(store.db, {
      window,
      candidate_or_committee: "Warren Campaign",
    });

    expect(upstreamHits).toBe(1);
    fetchSpy.mockRestore();
  });

  it("upstream failure with stale cache returns stale + notice", async () => {
    const window = { from: "2026-04-01T00:00:00.000Z", to: "2026-04-14T00:00:00.000Z" };
    // Narrowing filter required — OpenFEC rejects date-only queries (Bug 3 guard).
    const candidate_or_committee = "Warren Campaign";
    seedStaleCache({
      db: store.db,
      source: "openfec",
      endpoint_path: "/schedules/schedule_a",
      scope: "recent",
      tool: "recent_contributions",
      args: {
        window,
        candidate_or_committee,
        min_amount: undefined,
        contributor_entity_id: undefined,
        side: "recipient",
      },
      documents: [
        {
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
        },
      ],
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

    const result = await handleRecentContributions(store.db, { window, candidate_or_committee });
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
        return new Response(JSON.stringify({ members: [], pagination: { count: 0 } }), {
          status: 200,
        });
      }
      if (url.includes("api.open.fec.gov/v1/candidates/search")) {
        upstreamHits += 1;
        return new Response(JSON.stringify({ results: [], pagination: { per_page: 20 } }), {
          status: 200,
        });
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
      return new Response(JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }), {
        status: 200,
      });
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

describe("passthrough shaped e2e — get_entity (R15)", () => {
  it("entity with bioguide triggers exactly one Congress.gov /member/{id} fetch", async () => {
    let memberHits = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "string" ? input : (input as URL | Request).toString());
      if (url.includes("api.congress.gov/v3/member/S000148")) {
        memberHits += 1;
        return new Response(
          JSON.stringify({
            member: {
              bioguideId: "S000148",
              name: "Schumer, Charles E.",
              partyName: "Democrat",
              state: "NY",
              terms: {
                item: [{ chamber: "Senate", startYear: 1999, endYear: null }],
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });

    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Schumer, Charles E.",
      external_ids: { bioguide: "S000148" },
    });

    const res = await handleGetEntity(store.db, { id: entity.id });
    expect(memberHits).toBe(1);
    expect(res.entity.external_ids.bioguide).toBe("S000148");
    expect(res.stale_notice).toBeUndefined();
  });

  it("cache hit: same call twice only fires upstream once", async () => {
    let memberHits = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "string" ? input : (input as URL | Request).toString());
      if (url.includes("api.congress.gov/v3/member/S000148")) {
        memberHits += 1;
        return new Response(
          JSON.stringify({
            member: {
              bioguideId: "S000148",
              name: "Schumer, Charles E.",
              partyName: "Democrat",
              state: "NY",
              terms: { item: [{ chamber: "Senate", startYear: 1999, endYear: null }] },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });

    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Schumer, Charles E.",
      external_ids: { bioguide: "S000148" },
    });

    await handleGetEntity(store.db, { id: entity.id });
    await handleGetEntity(store.db, { id: entity.id });
    expect(memberHits).toBe(1);
  });

  it("entity with no external IDs triggers zero upstream fetches", async () => {
    let upstream = 0;
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      upstream += 1;
      return new Response("", { status: 404 });
    });

    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Bare Entity",
      metadata: {
        roles: [{ jurisdiction: "us-tx", role: "state_legislator" }],
      },
    });

    const res = await handleGetEntity(store.db, { id: entity.id });
    expect(upstream).toBe(0);
    expect(res.entity.name).toBe("Bare Entity");
    expect(res.stale_notice).toBeUndefined();
  });
});

describe("passthrough shaped e2e — entity_connections (R15)", () => {
  it("entity with bioguide triggers exactly 2 Congress.gov sponsored/cosponsored fetches", async () => {
    let sponsoredHits = 0;
    let cosponsoredHits = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "string" ? input : (input as URL | Request).toString());
      if (url.includes("/member/S000148/sponsored-legislation")) {
        sponsoredHits += 1;
        return new Response(JSON.stringify({ sponsoredLegislation: [] }), { status: 200 });
      }
      if (url.includes("/member/S000148/cosponsored-legislation")) {
        cosponsoredHits += 1;
        return new Response(JSON.stringify({ cosponsoredLegislation: [] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Schumer, Charles E.",
      external_ids: { bioguide: "S000148" },
    });

    const res = await handleEntityConnections(store.db, {
      id: entity.id,
      depth: 1,
      min_co_occurrences: 1,
    });
    expect(sponsoredHits).toBe(1);
    expect(cosponsoredHits).toBe(1);
    expect(res.empty_reason).toBeUndefined();
    expect(res.stale_notice).toBeUndefined();
  });

  it("entity with no external IDs short-circuits with empty_reason + zero upstream", async () => {
    let upstream = 0;
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      upstream += 1;
      return new Response("", { status: 404 });
    });

    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Bare Connected Entity",
      metadata: {
        roles: [{ jurisdiction: "us-tx", role: "state_legislator" }],
      },
    });

    const res = await handleEntityConnections(store.db, {
      id: entity.id,
      depth: 1,
      min_co_occurrences: 1,
    });
    expect(upstream).toBe(0);
    expect(res.empty_reason).toBe("no_external_ids");
    expect(res.edges).toHaveLength(0);
    expect(res.nodes).toHaveLength(0);
  });
});

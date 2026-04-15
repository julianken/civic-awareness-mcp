/**
 * Shaped-fetch integration tests (R15 path) for `list_bills`.
 *
 * Four scenarios:
 *   1. Cold fetch writes through; warm hit (same args) serves from
 *      the local store with no additional upstream fetch.
 *   2. Distinct args produce distinct cache rows — two calls, two
 *      upstream hits.
 *   3. `us-federal` returns `not_yet_supported` without ever
 *      touching upstream.
 *   4. Upstream failure with no cached data propagates.
 *
 * HTTP is stubbed via `vi.spyOn(global, "fetch")` to match the rest
 * of this codebase (msw is not a project dep). The plan's
 * `setupServer` example translates directly: each `http.get` handler
 * becomes a branch inside the `fetch` mock keyed on the request URL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/core/seeds.js";
import { handleListBills, type ListBillsResponse } from "../../src/mcp/tools/list_bills.js";

/** Cast for e2e tests that are provably outside the gate path (all use default/low limits). */
async function callListBills(
  db: Parameters<typeof handleListBills>[0],
  input: Parameters<typeof handleListBills>[1],
): Promise<ListBillsResponse> {
  return handleListBills(db, input) as Promise<ListBillsResponse>;
}
import { _resetToolCacheForTesting } from "../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../src/core/limiters.js";
import { seedStaleCache } from "../helpers/seed_stale_cache.js";

vi.stubEnv("OPENSTATES_API_KEY", "test-key");

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

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return String(typeof input === "string" ? input : (input as URL | Request).toString());
}

describe("list_bills — R15 shaped e2e", () => {
  it("cold fetch writes through, warm hit serves from cache (upstream hit once)", async () => {
    let upstreamHits = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (!url.includes("openstates.org/bills")) {
        return new Response("", { status: 404 });
      }
      upstreamHits += 1;
      const parsed = new URL(url);
      expect(parsed.searchParams.get("jurisdiction")).toBe("ca");
      expect(parsed.searchParams.get("subject")).toBe("Vehicles");
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "ocd-bill/ca/1",
              identifier: "SB1338",
              title: "Vehicles: repossession.",
              session: "20252026",
              updated_at: "2026-04-10T00:00:00Z",
              openstates_url: "https://openstates.org/ca/bills/20252026/SB1338",
              jurisdiction: {
                id: "ocd-jurisdiction/country:us/state:ca/government",
              },
              sponsorships: [],
              actions: [{ date: "2026-02-20", description: "Introduced" }],
              subject: ["Vehicles"],
            },
          ],
          pagination: { max_page: 1 },
        }),
        { status: 200 },
      );
    });

    const first = await callListBills(store.db, {
      jurisdiction: "us-ca",
      subject: "Vehicles",
    });
    const second = await callListBills(store.db, {
      jurisdiction: "us-ca",
      subject: "Vehicles",
    });

    expect(upstreamHits).toBe(1);
    expect(first.results).toHaveLength(1);
    expect(first.results[0].identifier).toBe("SB1338");
    expect(second.results).toHaveLength(1);
  });

  it("distinct args produce distinct cache rows (two upstream hits)", async () => {
    let upstreamHits = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (!url.includes("openstates.org/bills")) {
        return new Response("", { status: 404 });
      }
      upstreamHits += 1;
      return new Response(
        JSON.stringify({ results: [], pagination: { max_page: 1 } }),
        { status: 200 },
      );
    });

    await handleListBills(store.db, { jurisdiction: "us-ca", subject: "Vehicles" });
    await handleListBills(store.db, { jurisdiction: "us-ca", subject: "Education" });

    expect(upstreamHits).toBe(2);
  });

  it("us-federal returns not_yet_supported without upstream hits", async () => {
    let hit = 0;
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      hit += 1;
      return new Response("{}", { status: 200 });
    });

    const res = await callListBills(store.db, { jurisdiction: "us-federal" });
    expect(res.stale_notice?.reason).toBe("not_yet_supported");
    expect(hit).toBe(0);
  });

  it("upstream failure with no cached data propagates", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (!url.includes("openstates.org/bills")) {
        return new Response("", { status: 404 });
      }
      throw new Error("network down");
    });

    await expect(
      handleListBills(store.db, { jurisdiction: "us-ca" }),
    ).rejects.toThrow();
  });

  it("projects upstream sponsorships through to sponsor_summary.top", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (!url.includes("openstates.org/bills")) {
        return new Response("", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "ocd-bill/ca/sp1",
              identifier: "AB100",
              title: "Sponsor projection bill.",
              session: "20252026",
              updated_at: "2026-04-10T00:00:00Z",
              openstates_url: "https://openstates.org/ca/bills/20252026/AB100",
              jurisdiction: {
                id: "ocd-jurisdiction/country:us/state:ca/government",
              },
              from_organization: { classification: "lower" },
              subject: ["Test Subject"],
              sponsorships: [
                {
                  name: "Test Senator",
                  classification: "primary",
                  person: {
                    id: "ocd-person/abc",
                    name: "Test Senator",
                    party: "Democratic",
                    current_role: {
                      title: "Senator",
                      district: "1",
                      org_classification: "upper",
                    },
                    jurisdiction: {
                      id: "ocd-jurisdiction/country:us/state:ca/government",
                    },
                  },
                },
              ],
              actions: [{ date: "2026-02-20", description: "Introduced" }],
            },
          ],
          pagination: { max_page: 1 },
        }),
        { status: 200 },
      );
    });

    const res = await callListBills(store.db, { jurisdiction: "us-ca" });
    expect(res.results).toHaveLength(1);
    const top = res.results[0].sponsor_summary?.top ?? [];
    expect(top.length).toBeGreaterThan(0);
    expect(top[0].name).toBe("Test Senator");
  });

  it("upstream failure with stale cache returns stale + upstream_failure notice", async () => {
    seedStaleCache({
      db: store.db,
      source: "openstates",
      endpoint_path: "/bills/list",
      scope: "recent",
      tool: "list_bills",
      args: {
        jurisdiction: "us-ca",
        session: undefined,
        chamber: undefined,
        sponsor_entity_id: undefined,
        classification: undefined,
        subject: "Vehicles",
        introduced_since: undefined,
        introduced_until: undefined,
        updated_since: undefined,
        updated_until: undefined,
        sort: "updated_desc",
        limit: 20,
      },
      documents: [
        {
          kind: "bill",
          jurisdiction: "us-ca",
          title: "SB1338 — Vehicles: repossession.",
          occurred_at: "2026-04-10T00:00:00Z",
          source: {
            name: "openstates",
            id: "ocd-bill/ca/stale-1",
            url: "https://openstates.org/ca/bills/20252026/SB1338",
          },
          raw: {
            subjects: ["Vehicles"],
            actions: [{ date: "2026-02-20", description: "Introduced" }],
          },
        },
      ],
    });

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (!url.includes("openstates.org/bills")) {
        return new Response("", { status: 404 });
      }
      throw new Error("network down");
    });

    const result = await callListBills(store.db, {
      jurisdiction: "us-ca",
      subject: "Vehicles",
    });

    expect(result.stale_notice?.reason).toBe("upstream_failure");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].identifier).toBe("SB1338");
  });
});

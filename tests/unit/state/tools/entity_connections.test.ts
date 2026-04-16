import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/federal/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { _resetToolCacheForTesting } from "../../../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../../../src/state/limiters.js";
import { OpenStatesAdapter } from "../../../../src/state/adapters/openstates.js";
import { handleEntityConnections } from "../../../../src/state/tools/entity_connections.js";

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

describe("state/entity_connections — Bug 2: fetchBillsBySponsor jurisdiction param", () => {
  it("passes jurisdiction query param to OpenStates /bills when entity has a jurisdiction", async () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Test Sponsor",
      jurisdiction: "us-tx",
      external_ids: { openstates_person: "ocd-person/tx-sponsor-1" },
    });

    let capturedUrl: string | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      capturedUrl = typeof input === "string" ? input : String(input);
      return new Response(JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }), {
        status: 200,
      });
    });

    await handleEntityConnections(store.db, { id: entity.id, depth: 1 });

    expect(capturedUrl).toBeDefined();
    const url = new URL(capturedUrl!);
    // OpenStates /bills requires jurisdiction or q; must not be missing
    expect(url.searchParams.get("jurisdiction")).toBe("tx");
    expect(url.searchParams.get("sponsor")).toBe("ocd-person/tx-sponsor-1");
  });

  it("skips fetchBillsBySponsor with not_yet_supported when entity jurisdiction is null (cross-jurisdiction person)", async () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Cross Jurisdiction Senator",
      jurisdiction: undefined,
      external_ids: { openstates_person: "ocd-person/cross-jur-1" },
    });

    const spy = vi.spyOn(OpenStatesAdapter.prototype, "fetchBillsBySponsor");

    const res = await handleEntityConnections(store.db, { id: entity.id, depth: 1 });

    expect(spy).not.toHaveBeenCalled();
    expect(res.stale_notice?.reason).toBe("not_yet_supported");
  });
});

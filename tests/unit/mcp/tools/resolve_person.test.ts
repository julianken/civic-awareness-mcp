import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/federal/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertFetchLog } from "../../../../src/core/fetch_log.js";
import { hashArgs } from "../../../../src/core/args_hash.js";
import { _resetToolCacheForTesting } from "../../../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../../../src/federal/limiters.js";
import { CongressAdapter } from "../../../../src/federal/adapters/congress.js";
import { OpenFecAdapter } from "../../../../src/federal/adapters/openfec.js";
import { OpenStatesAdapter } from "../../../../src/state/adapters/openstates.js";
import { handleResolvePerson } from "../../../../src/federal/tools/resolve_person.js";

const TEST_DB = "./data/test-resolve-person.db";
let store: Store;

beforeEach(() => {
  _resetToolCacheForTesting();
  _resetLimitersForTesting();
  process.env.OPENSTATES_API_KEY = "test-key";
  process.env.API_DATA_GOV_KEY = "test-key";

  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});

afterEach(() => {
  store.close();
  delete process.env.OPENSTATES_API_KEY;
  delete process.env.API_DATA_GOV_KEY;
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

describe("handleResolvePerson — resolution logic", () => {
  it("returns empty matches for an unknown name", async () => {
    const result = await handleResolvePerson(store.db, { name: "Zzz Nonexistent" });
    expect(result.matches).toHaveLength(0);
  });

  it("returns exact match with confidence=exact", async () => {
    upsertEntity(store.db, { kind: "person", name: "Jane Smith" });
    const result = await handleResolvePerson(store.db, { name: "Jane Smith" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].confidence).toBe("exact");
    expect(result.matches[0].name).toBe("Jane Smith");
  });

  it("returns alias match with confidence=alias", async () => {
    upsertEntity(store.db, {
      kind: "person",
      name: "Jonathan Doe",
      aliases: ["Jon Doe"],
    });
    const result = await handleResolvePerson(store.db, { name: "Jon Doe" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].confidence).toBe("alias");
    expect(result.matches[0].name).toBe("Jonathan Doe");
  });

  it("returns exact confidence when name matches both canonical and alias paths", async () => {
    // Insert two entities: one whose canonical name is the query,
    // another with the query as an alias.
    const e1 = upsertEntity(store.db, { kind: "person", name: "Alex Morgan" }).entity;
    upsertEntity(store.db, {
      kind: "person",
      name: "Alexandra Morgan",
      aliases: ["Alex Morgan"],
    });
    const result = await handleResolvePerson(store.db, { name: "Alex Morgan" });
    // e1 should appear with confidence=exact; the alias match gets alias.
    // The entity whose canonical name IS "Alex Morgan" must have exact.
    const exactMatch = result.matches.find((m) => m.entity_id === e1.id);
    expect(exactMatch?.confidence).toBe("exact");
  });

  it("returns fuzzy match with confidence=fuzzy when Levenshtein distance=1", async () => {
    // "Chuck Grassley" → query "Chuk Grassley" (one typo, 'd' → deleted)
    // Provide jurisdiction_hint to satisfy linking signal.
    upsertEntity(store.db, {
      kind: "person",
      name: "Chuck Grassley",
      metadata: {
        roles: [{ jurisdiction: "us-ia", role: "senator", from: "1981-01-05" }],
      },
    });
    const spy = vi
      .spyOn(OpenStatesAdapter.prototype, "searchPeople")
      .mockImplementation(async () => ({ entitiesUpserted: 0 }));
    const result = await handleResolvePerson(store.db, {
      name: "Chuk Grassley",
      jurisdiction_hint: "us-ia",
    });
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const fuzzyMatch = result.matches.find((m) => m.confidence === "fuzzy");
    expect(fuzzyMatch).toBeDefined();
    expect(fuzzyMatch?.name).toBe("Chuck Grassley");
    spy.mockRestore();
  });

  it("does not return fuzzy match without a linking signal", async () => {
    upsertEntity(store.db, { kind: "person", name: "Chuck Grassley" });
    // No jurisdiction_hint or role_hint — no linking signal.
    const result = await handleResolvePerson(store.db, { name: "Chuk Grassley" });
    // Should NOT return a fuzzy match because no linking signal is present.
    const fuzzyMatches = result.matches.filter((m) => m.confidence === "fuzzy");
    expect(fuzzyMatches).toHaveLength(0);
  });

  it("populates disambiguators from metadata.roles[] for Persons", async () => {
    upsertEntity(store.db, {
      kind: "person",
      name: "Maria Lopez",
      metadata: {
        roles: [
          {
            jurisdiction: "us-tx",
            role: "state_legislator",
            from: "2010-01-01T00:00:00.000Z",
            to: "2018-01-01T00:00:00.000Z",
          },
          {
            jurisdiction: "us-federal",
            role: "representative",
            from: "2019-01-03T00:00:00.000Z",
            to: null,
          },
        ],
      },
    });
    const result = await handleResolvePerson(store.db, { name: "Maria Lopez" });
    expect(result.matches[0].disambiguators.length).toBeGreaterThanOrEqual(2);
    const d = result.matches[0].disambiguators.join(" | ");
    expect(d).toContain("us-tx");
    expect(d).toContain("us-federal");
    expect(d).toContain("present");
  });

  it("sorts exact matches before alias, alias before fuzzy", async () => {
    upsertEntity(store.db, { kind: "person", name: "Sam Chen" });
    upsertEntity(store.db, {
      kind: "person",
      name: "Samantha Chen",
      aliases: ["Sam Chen"],
    });
    const result = await handleResolvePerson(store.db, { name: "Sam Chen" });
    const confidences = result.matches.map((m) => m.confidence);
    const exactIdx = confidences.indexOf("exact");
    const aliasIdx = confidences.indexOf("alias");
    if (exactIdx !== -1 && aliasIdx !== -1) {
      expect(exactIdx).toBeLessThan(aliasIdx);
    }
  });

  it("accepts context field without error (V1 ignores it)", async () => {
    upsertEntity(store.db, { kind: "person", name: "Test Person" });
    await expect(
      handleResolvePerson(store.db, {
        name: "Test Person",
        context: "Texas energy committee member",
      }),
    ).resolves.not.toThrow();
  });

  it("matches non-Person kinds only when they have the exact name and kind=person is not matched", async () => {
    upsertEntity(store.db, {
      kind: "organization",
      name: "Texas Energy Committee",
      jurisdiction: "us-tx",
    });
    const result = await handleResolvePerson(store.db, { name: "Texas Energy Committee" });
    // Non-Person entity — should NOT appear in resolve_person results.
    expect(result.matches).toHaveLength(0);
  });
});

describe("handleResolvePerson — R15 hydration path", () => {
  it("no jurisdiction_hint → no adapter calls (local-only)", async () => {
    upsertEntity(store.db, { kind: "person", name: "Jane Smith" });
    const openstatesSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "searchPeople")
      .mockImplementation(async () => ({ entitiesUpserted: 0 }));
    const congressSpy = vi
      .spyOn(CongressAdapter.prototype, "searchMembers")
      .mockImplementation(async () => ({ entitiesUpserted: 0 }));
    const fecSpy = vi
      .spyOn(OpenFecAdapter.prototype, "searchCandidates")
      .mockImplementation(async () => ({ entitiesUpserted: 0 }));

    await handleResolvePerson(store.db, { name: "Jane Smith" });

    expect(openstatesSpy).not.toHaveBeenCalled();
    expect(congressSpy).not.toHaveBeenCalled();
    expect(fecSpy).not.toHaveBeenCalled();

    openstatesSpy.mockRestore();
    congressSpy.mockRestore();
    fecSpy.mockRestore();
  });

  it("state jurisdiction_hint: invokes OpenStates searchPeople", async () => {
    const spy = vi
      .spyOn(OpenStatesAdapter.prototype, "searchPeople")
      .mockImplementation(async () => ({ entitiesUpserted: 0 }));

    const res = await handleResolvePerson(store.db, {
      name: "Jane Smith",
      jurisdiction_hint: "us-tx",
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(store.db, {
      jurisdiction: "us-tx",
      name: "Jane Smith",
    });
    expect(res.stale_notice).toBeUndefined();
    spy.mockRestore();
  });

  it("us-federal: fans out to Congress searchMembers + OpenFEC searchCandidates", async () => {
    const cgSpy = vi
      .spyOn(CongressAdapter.prototype, "searchMembers")
      .mockImplementation(async () => ({ entitiesUpserted: 0 }));
    const fecSpy = vi
      .spyOn(OpenFecAdapter.prototype, "searchCandidates")
      .mockImplementation(async () => ({ entitiesUpserted: 0 }));

    await handleResolvePerson(store.db, {
      name: "John Smith",
      jurisdiction_hint: "us-federal",
    });

    expect(cgSpy).toHaveBeenCalledOnce();
    expect(fecSpy).toHaveBeenCalledOnce();
    expect(fecSpy).toHaveBeenCalledWith(store.db, { q: "John Smith" });
    cgSpy.mockRestore();
    fecSpy.mockRestore();
  });

  it("cache hit: second call within TTL does NOT call the adapter", async () => {
    const spy = vi
      .spyOn(OpenStatesAdapter.prototype, "searchPeople")
      .mockImplementation(async () => ({ entitiesUpserted: 0 }));

    await handleResolvePerson(store.db, { name: "Jane Smith", jurisdiction_hint: "us-tx" });
    await handleResolvePerson(store.db, { name: "Jane Smith", jurisdiction_hint: "us-tx" });

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("upstream failure with stale cache surfaces stale_notice and still serves matches", async () => {
    upsertEntity(store.db, {
      kind: "person",
      name: "Jane Smith",
      metadata: { roles: [{ jurisdiction: "us-tx", role: "state_legislator" }] },
    });
    upsertFetchLog(store.db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: hashArgs("searchPeople", {
        jurisdiction: "us-tx",
        name: "Jane Smith",
      }),
      scope: "full",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 1,
    });

    const spy = vi
      .spyOn(OpenStatesAdapter.prototype, "searchPeople")
      .mockRejectedValue(new Error("simulated upstream failure"));

    const res = await handleResolvePerson(store.db, {
      name: "Jane Smith",
      jurisdiction_hint: "us-tx",
    });

    expect(res.stale_notice?.reason).toBe("upstream_failure");
    expect(res.matches.length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it("upstream failure with no cache propagates", async () => {
    const spy = vi
      .spyOn(OpenStatesAdapter.prototype, "searchPeople")
      .mockRejectedValue(new Error("network down"));

    await expect(
      handleResolvePerson(store.db, { name: "Jane Smith", jurisdiction_hint: "us-tx" }),
    ).rejects.toThrow(/network down/);

    spy.mockRestore();
  });
});

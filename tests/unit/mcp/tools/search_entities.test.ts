import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { bootstrap } from "../../../../src/cli/bootstrap.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertFetchLog } from "../../../../src/core/fetch_log.js";
import { hashArgs } from "../../../../src/core/args_hash.js";
import { _resetToolCacheForTesting } from "../../../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../../../src/core/limiters.js";
import { CongressAdapter } from "../../../../src/adapters/congress.js";
import { OpenFecAdapter } from "../../../../src/adapters/openfec.js";
import { OpenStatesAdapter } from "../../../../src/adapters/openstates.js";
import { handleSearchEntities } from "../../../../src/mcp/tools/search_entities.js";

const TEST_DB = "./data/test-tool-search-entities.db";
let store: Store;

beforeEach(() => {
  _resetToolCacheForTesting();
  _resetLimitersForTesting();
  process.env.OPENSTATES_API_KEY = "test-key";
  process.env.API_DATA_GOV_KEY = "test-key";

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
afterEach(() => {
  store.close();
  delete process.env.OPENSTATES_API_KEY;
  delete process.env.API_DATA_GOV_KEY;
});

describe("search_entities tool — projection", () => {
  it("matches by substring (no jurisdiction → local-only)", async () => {
    const res = await handleSearchEntities(store.db, { q: "doe" });
    expect(res.results).toHaveLength(2);
  });

  it("filters by kind", async () => {
    const res = await handleSearchEntities(store.db, { q: "doe", kind: "person" });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].name).toBe("Jane Doe");
  });
});

describe("search_entities tool — R15 hydration path", () => {
  it("no jurisdiction → no adapter calls", async () => {
    const openstatesSpy = vi
      .spyOn(OpenStatesAdapter.prototype, "searchPeople")
      .mockImplementation(async () => ({ entitiesUpserted: 0 }));
    const congressSpy = vi
      .spyOn(CongressAdapter.prototype, "searchMembers")
      .mockImplementation(async () => ({ entitiesUpserted: 0 }));
    const fecSpy = vi
      .spyOn(OpenFecAdapter.prototype, "searchCandidates")
      .mockImplementation(async () => ({ entitiesUpserted: 0 }));

    await handleSearchEntities(store.db, { q: "doe" });

    expect(openstatesSpy).not.toHaveBeenCalled();
    expect(congressSpy).not.toHaveBeenCalled();
    expect(fecSpy).not.toHaveBeenCalled();

    openstatesSpy.mockRestore();
    congressSpy.mockRestore();
    fecSpy.mockRestore();
  });

  it("state jurisdiction: invokes OpenStates searchPeople", async () => {
    const spy = vi
      .spyOn(OpenStatesAdapter.prototype, "searchPeople")
      .mockImplementation(async () => ({ entitiesUpserted: 0 }));

    const res = await handleSearchEntities(store.db, { q: "doe", jurisdiction: "us-tx" });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(store.db, {
      jurisdiction: "us-tx",
      name: "doe",
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

    await handleSearchEntities(store.db, { q: "smith", jurisdiction: "us-federal" });

    expect(cgSpy).toHaveBeenCalledOnce();
    expect(fecSpy).toHaveBeenCalledOnce();
    expect(fecSpy).toHaveBeenCalledWith(store.db, { q: "smith" });
    cgSpy.mockRestore();
    fecSpy.mockRestore();
  });

  it("cache hit: second call within TTL does NOT call the adapter", async () => {
    const spy = vi
      .spyOn(OpenStatesAdapter.prototype, "searchPeople")
      .mockImplementation(async () => ({ entitiesUpserted: 0 }));

    await handleSearchEntities(store.db, { q: "doe", jurisdiction: "us-tx" });
    await handleSearchEntities(store.db, { q: "doe", jurisdiction: "us-tx" });

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("upstream failure with stale cache surfaces stale_notice and still serves local data", async () => {
    upsertFetchLog(store.db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: hashArgs("searchPeople", {
        jurisdiction: "us-tx",
        name: "doe",
      }),
      scope: "full",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 1,
    });

    const spy = vi
      .spyOn(OpenStatesAdapter.prototype, "searchPeople")
      .mockRejectedValue(new Error("simulated upstream failure"));

    const res = await handleSearchEntities(store.db, { q: "doe", jurisdiction: "us-tx" });

    expect(res.stale_notice?.reason).toBe("upstream_failure");
    expect(res.results.length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it("upstream failure with no cache propagates", async () => {
    const spy = vi
      .spyOn(OpenStatesAdapter.prototype, "searchPeople")
      .mockRejectedValue(new Error("network down"));

    await expect(
      handleSearchEntities(store.db, { q: "doe", jurisdiction: "us-tx" }),
    ).rejects.toThrow(/network down/);

    spy.mockRestore();
  });
});

describe("handleSearchEntities had_role / had_jurisdiction", () => {
  it("had_role matches a historical role even when current jurisdiction is different", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/se-had-role-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities
       (id, kind, name, name_normalized, jurisdiction, external_ids, aliases, metadata, first_seen_at, last_seen_at)
       VALUES ('p1', 'person', 'Jane Doe', 'jane doe', 'us-federal',
         '{"bioguide":"D000001"}', '[]', ?, ?, ?)`,
    ).run(
      JSON.stringify({
        roles: [
          { jurisdiction: "us-tx", role: "state_legislator" },
          { jurisdiction: "us-federal", role: "senator" },
        ],
      }),
      now,
      now,
    );

    const result = await handleSearchEntities(db, {
      q: "jane",
      had_role: "state_legislator",
    });

    expect(result.results.map((r) => r.id)).toContain("p1");
  });

  it("had_jurisdiction matches a historical jurisdiction", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/se-had-juris-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities
       (id, kind, name, name_normalized, jurisdiction, external_ids, aliases, metadata, first_seen_at, last_seen_at)
       VALUES ('p1', 'person', 'Jane Doe', 'jane doe', 'us-federal',
         '{"bioguide":"D000001"}', '[]', ?, ?, ?)`,
    ).run(
      JSON.stringify({
        roles: [
          { jurisdiction: "us-tx", role: "state_legislator" },
          { jurisdiction: "us-federal", role: "senator" },
        ],
      }),
      now,
      now,
    );

    const result = await handleSearchEntities(db, {
      q: "jane",
      had_jurisdiction: "us-tx",
    });

    expect(result.results.map((r) => r.id)).toContain("p1");
  });

  it("had_role + had_jurisdiction require the SAME role entry to match both", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/se-had-and-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities
       (id, kind, name, name_normalized, jurisdiction, external_ids, aliases, metadata, first_seen_at, last_seen_at)
       VALUES ('p1', 'person', 'Jane Doe', 'jane doe', 'us-federal',
         '{"bioguide":"D000001"}', '[]', ?, ?, ?)`,
    ).run(
      JSON.stringify({
        roles: [
          { jurisdiction: "us-tx", role: "state_legislator" },
          { jurisdiction: "us-federal", role: "senator" },
        ],
      }),
      now,
      now,
    );

    const noMatch = await handleSearchEntities(db, {
      q: "jane",
      had_role: "senator",
      had_jurisdiction: "us-tx",
    });
    expect(noMatch.results.map((r) => r.id)).not.toContain("p1");

    const match = await handleSearchEntities(db, {
      q: "jane",
      had_role: "state_legislator",
      had_jurisdiction: "us-tx",
    });
    expect(match.results.map((r) => r.id)).toContain("p1");
  });

  it("had_role drops entities whose metadata has no roles[]", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/se-had-none-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities
       (id, kind, name, name_normalized, jurisdiction, external_ids, aliases, metadata, first_seen_at, last_seen_at)
       VALUES ('p2', 'person', 'Jim Smith', 'jim smith', 'us-federal',
         '{}', '[]', '{}', ?, ?)`,
    ).run(now, now);

    const result = await handleSearchEntities(db, {
      q: "jim",
      had_role: "senator",
    });
    expect(result.results.map((r) => r.id)).not.toContain("p2");
  });
});

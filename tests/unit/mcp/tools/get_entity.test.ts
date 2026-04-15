import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/federal/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { upsertFetchLog } from "../../../../src/core/fetch_log.js";
import { hashArgs } from "../../../../src/core/args_hash.js";
import { _resetToolCacheForTesting } from "../../../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../../../src/federal/limiters.js";
import { CongressAdapter } from "../../../../src/federal/adapters/congress.js";
import { OpenFecAdapter } from "../../../../src/federal/adapters/openfec.js";
import { OpenStatesAdapter } from "../../../../src/state/adapters/openstates.js";
import { handleGetEntity } from "../../../../src/federal/tools/get_entity.js";

const TEST_DB = "./data/test-tool-get-entity.db";
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
  vi.restoreAllMocks();
  delete process.env.OPENSTATES_API_KEY;
  delete process.env.API_DATA_GOV_KEY;
});

describe("get_entity — projection", () => {
  it("returns entity with recent documents", async () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person", name: "Jane Doe", jurisdiction: undefined,
      metadata: {
        roles: [{ jurisdiction: "us-tx", role: "state_legislator",
                  from: new Date().toISOString(), to: null }],
      },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB1",
      occurred_at: new Date().toISOString(),
      source: { name: "openstates", id: "1", url: "https://openstates.org/tx/bills/HB1" },
      references: [{ entity_id: entity.id, role: "sponsor" }],
    });
    const res = await handleGetEntity(store.db, { id: entity.id });
    expect(res.entity.name).toBe("Jane Doe");
    expect(res.recent_documents).toHaveLength(1);
  });
  it("throws for unknown id", async () => {
    await expect(handleGetEntity(store.db, { id: "missing" })).rejects.toThrow();
  });
  it("surfaces federal role URL in sources when entity has a bioguide ID", async () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Schumer, Charles E.",
      jurisdiction: undefined,
      external_ids: { bioguide: "S000148" },
      metadata: {
        roles: [
          { jurisdiction: "us-ny",      role: "state_legislator", from: "1981-01-01T00:00:00.000Z", to: "1999-01-03T00:00:00.000Z" },
          { jurisdiction: "us-federal", role: "senator",          from: "1999-01-03T00:00:00.000Z", to: null },
        ],
      },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "HR1 — A federal bill",
      occurred_at: new Date().toISOString(),
      source: {
        name: "congress",
        id: "119-hr-1",
        url: "https://www.congress.gov/bill/119th-congress/house-bill/1",
      },
      references: [{ entity_id: entity.id, role: "sponsor" }],
    });

    // Stub the fetchMember call triggered by the bioguide external ID.
    vi.spyOn(CongressAdapter.prototype, "fetchMember")
      .mockResolvedValue({ entitiesUpserted: 0 });

    const res = await handleGetEntity(store.db, { id: entity.id });
    const roles = (res.entity.metadata.roles ?? []) as Array<{ jurisdiction: string }>;
    const jurisdictions = roles.map((r) => r.jurisdiction);
    expect(jurisdictions).toContain("us-ny");
    expect(jurisdictions).toContain("us-federal");

    const congressSource = res.sources.find((s) => s.name === "congress");
    expect(congressSource?.url).toMatch(/congress\.gov/);
  });

  it("emits fec.gov source URL when entity has a fec_candidate external_id", async () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Smith, John R.",
      jurisdiction: undefined,
      external_ids: { fec_candidate: "H0AZ01234", bioguide: "S001234" },
      metadata: {
        roles: [{ jurisdiction: "us-federal", role: "federal_candidate_representative" }],
      },
    });

    // Stub fanout — we only care about projection here.
    vi.spyOn(CongressAdapter.prototype, "fetchMember")
      .mockResolvedValue({ entitiesUpserted: 0 });
    vi.spyOn(OpenFecAdapter.prototype, "fetchCandidate")
      .mockResolvedValue({ entitiesUpserted: 0 });

    const res = await handleGetEntity(store.db, { id: entity.id });
    const fecSource = res.sources.find((s) => s.url.includes("fec.gov/data/candidate"));
    expect(fecSource).toBeDefined();
    expect(fecSource!.url).toBe("https://www.fec.gov/data/candidate/H0AZ01234/");
  });

  it("recent_documents exposes action_date on each item and sorts by it", async () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person", name: "Sen. B",
      external_ids: { openstates_person: "ocd-person/b" },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "SB 1 — Older action",
      occurred_at: "2025-06-01T00:00:00Z",
      source: { name: "openstates", id: "1", url: "https://example.com/1" },
      references: [{ entity_id: entity.id, role: "sponsor" }],
      raw: { actions: [{ date: "2025-06-01", description: "intro" }] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "SB 2 — Newer action",
      occurred_at: "2025-09-18T00:00:00Z",
      source: { name: "openstates", id: "2", url: "https://example.com/2" },
      references: [{ entity_id: entity.id, role: "sponsor" }],
      raw: { actions: [{ date: "2025-09-18", description: "enacted" }] },
    });

    // The openstates_person external ID triggers a fetchPerson call —
    // stub it so the test is projection-only.
    vi.spyOn(OpenStatesAdapter.prototype, "fetchPerson")
      .mockResolvedValue({ entitiesUpserted: 0 });

    const res = await handleGetEntity(store.db, { id: entity.id });
    expect(res.recent_documents.map((d) => d.title)).toEqual([
      "SB 2 — Newer action",
      "SB 1 — Older action",
    ]);
    expect(res.recent_documents[0].action_date).toBe("2025-09-18");
    expect(res.recent_documents[0].occurred_at).toMatch(/^2025-09-18T/);
  });

  it("emits fec.gov source URL when entity has a fec_committee external_id", async () => {
    const { entity } = upsertEntity(store.db, {
      kind: "pac",
      name: "Smith for Congress",
      jurisdiction: "us-federal",
      external_ids: { fec_committee: "C00123456" },
    });

    const res = await handleGetEntity(store.db, { id: entity.id });
    const fecSource = res.sources.find((s) => s.url.includes("fec.gov/data/committee"));
    expect(fecSource).toBeDefined();
    expect(fecSource!.url).toBe("https://www.fec.gov/data/committee/C00123456/");
  });
});

describe("get_entity — R15 fanout", () => {
  it("entity with no external IDs → zero adapter calls", async () => {
    const openstatesSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchPerson")
      .mockResolvedValue({ entitiesUpserted: 0 });
    const congressSpy = vi.spyOn(CongressAdapter.prototype, "fetchMember")
      .mockResolvedValue({ entitiesUpserted: 0 });
    const fecSpy = vi.spyOn(OpenFecAdapter.prototype, "fetchCandidate")
      .mockResolvedValue({ entitiesUpserted: 0 });

    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Bare Person",
      metadata: {
        roles: [{ jurisdiction: "us-tx", role: "state_legislator" }],
      },
    });
    await handleGetEntity(store.db, { id: entity.id });

    expect(openstatesSpy).not.toHaveBeenCalled();
    expect(congressSpy).not.toHaveBeenCalled();
    expect(fecSpy).not.toHaveBeenCalled();

    openstatesSpy.mockRestore();
    congressSpy.mockRestore();
    fecSpy.mockRestore();
  });

  it("bioguide only → only CongressAdapter.fetchMember is invoked", async () => {
    const openstatesSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchPerson")
      .mockResolvedValue({ entitiesUpserted: 0 });
    const congressSpy = vi.spyOn(CongressAdapter.prototype, "fetchMember")
      .mockResolvedValue({ entitiesUpserted: 0 });
    const fecSpy = vi.spyOn(OpenFecAdapter.prototype, "fetchCandidate")
      .mockResolvedValue({ entitiesUpserted: 0 });

    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Schumer, Charles E.",
      external_ids: { bioguide: "S000148" },
    });
    await handleGetEntity(store.db, { id: entity.id });

    expect(congressSpy).toHaveBeenCalledOnce();
    expect(congressSpy).toHaveBeenCalledWith(store.db, "S000148");
    expect(openstatesSpy).not.toHaveBeenCalled();
    expect(fecSpy).not.toHaveBeenCalled();

    openstatesSpy.mockRestore();
    congressSpy.mockRestore();
    fecSpy.mockRestore();
  });

  it("openstates_person only → only OpenStatesAdapter.fetchPerson is invoked", async () => {
    const openstatesSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchPerson")
      .mockResolvedValue({ entitiesUpserted: 0 });
    const congressSpy = vi.spyOn(CongressAdapter.prototype, "fetchMember")
      .mockResolvedValue({ entitiesUpserted: 0 });
    const fecSpy = vi.spyOn(OpenFecAdapter.prototype, "fetchCandidate")
      .mockResolvedValue({ entitiesUpserted: 0 });

    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Jane Doe",
      external_ids: { openstates_person: "ocd-person/tx-1" },
    });
    await handleGetEntity(store.db, { id: entity.id });

    expect(openstatesSpy).toHaveBeenCalledOnce();
    expect(openstatesSpy).toHaveBeenCalledWith(store.db, "ocd-person/tx-1");
    expect(congressSpy).not.toHaveBeenCalled();
    expect(fecSpy).not.toHaveBeenCalled();

    openstatesSpy.mockRestore();
    congressSpy.mockRestore();
    fecSpy.mockRestore();
  });

  it("fec_candidate only → only OpenFecAdapter.fetchCandidate is invoked", async () => {
    const openstatesSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchPerson")
      .mockResolvedValue({ entitiesUpserted: 0 });
    const congressSpy = vi.spyOn(CongressAdapter.prototype, "fetchMember")
      .mockResolvedValue({ entitiesUpserted: 0 });
    const fecSpy = vi.spyOn(OpenFecAdapter.prototype, "fetchCandidate")
      .mockResolvedValue({ entitiesUpserted: 0 });

    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Smith, John R.",
      external_ids: { fec_candidate: "H0AZ01234" },
    });
    await handleGetEntity(store.db, { id: entity.id });

    expect(fecSpy).toHaveBeenCalledOnce();
    expect(fecSpy).toHaveBeenCalledWith(store.db, "H0AZ01234");
    expect(openstatesSpy).not.toHaveBeenCalled();
    expect(congressSpy).not.toHaveBeenCalled();

    openstatesSpy.mockRestore();
    congressSpy.mockRestore();
    fecSpy.mockRestore();
  });

  it("all three external IDs → all three adapters are invoked exactly once", async () => {
    const openstatesSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchPerson")
      .mockResolvedValue({ entitiesUpserted: 0 });
    const congressSpy = vi.spyOn(CongressAdapter.prototype, "fetchMember")
      .mockResolvedValue({ entitiesUpserted: 0 });
    const fecSpy = vi.spyOn(OpenFecAdapter.prototype, "fetchCandidate")
      .mockResolvedValue({ entitiesUpserted: 0 });

    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Multi-ID Person",
      external_ids: {
        bioguide: "S000148",
        openstates_person: "ocd-person/ny-schumer",
        fec_candidate: "S2NY00123",
      },
    });
    await handleGetEntity(store.db, { id: entity.id });

    expect(openstatesSpy).toHaveBeenCalledOnce();
    expect(congressSpy).toHaveBeenCalledOnce();
    expect(fecSpy).toHaveBeenCalledOnce();

    openstatesSpy.mockRestore();
    congressSpy.mockRestore();
    fecSpy.mockRestore();
  });

  it("cache hit: second call within TTL skips the adapter", async () => {
    const congressSpy = vi.spyOn(CongressAdapter.prototype, "fetchMember")
      .mockResolvedValue({ entitiesUpserted: 0 });

    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Cached Person",
      external_ids: { bioguide: "S000148" },
    });
    await handleGetEntity(store.db, { id: entity.id });
    await handleGetEntity(store.db, { id: entity.id });

    expect(congressSpy).toHaveBeenCalledOnce();
    congressSpy.mockRestore();
  });

  it("upstream failure with stale cache → stale_notice, entity still returned", async () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Stale Person",
      external_ids: { bioguide: "S000148" },
    });
    // Seed a stale fetch_log row so the failure falls back to cached.
    upsertFetchLog(store.db, {
      source: "congress",
      endpoint_path: "/member/S000148",
      args_hash: hashArgs("fetchMember", { bioguide: "S000148" }),
      scope: "detail",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 1,
    });
    const congressSpy = vi.spyOn(CongressAdapter.prototype, "fetchMember")
      .mockRejectedValue(new Error("simulated upstream failure"));

    const res = await handleGetEntity(store.db, { id: entity.id });
    expect(res.stale_notice?.reason).toBe("upstream_failure");
    expect(res.entity.name).toBe("Stale Person");
    congressSpy.mockRestore();
  });

  it("upstream failure with no cache → error propagates", async () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person",
      name: "Cold-Fail Person",
      external_ids: { bioguide: "S000148" },
    });
    const congressSpy = vi.spyOn(CongressAdapter.prototype, "fetchMember")
      .mockRejectedValue(new Error("network down"));

    await expect(handleGetEntity(store.db, { id: entity.id })).rejects.toThrow(/network down/);
    congressSpy.mockRestore();
  });

  it("endpoint_path includes the ID → different entities get different cache rows", async () => {
    const congressSpy = vi.spyOn(CongressAdapter.prototype, "fetchMember")
      .mockResolvedValue({ entitiesUpserted: 0 });

    const { entity: e1 } = upsertEntity(store.db, {
      kind: "person",
      name: "Person One",
      external_ids: { bioguide: "AAA111" },
    });
    const { entity: e2 } = upsertEntity(store.db, {
      kind: "person",
      name: "Person Two",
      external_ids: { bioguide: "BBB222" },
    });

    await handleGetEntity(store.db, { id: e1.id });
    await handleGetEntity(store.db, { id: e2.id });
    // Both should fire — separate cache keys via the ID in endpoint_path.
    expect(congressSpy).toHaveBeenCalledTimes(2);
    // And repeating the first is a cache hit.
    await handleGetEntity(store.db, { id: e1.id });
    expect(congressSpy).toHaveBeenCalledTimes(2);
    congressSpy.mockRestore();
  });
});

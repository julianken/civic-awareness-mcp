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
import { handleEntityConnections } from "../../../../src/federal/tools/entity_connections.js";

const TEST_DB = "./data/test-entity-connections-tool.db";
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
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

function makeEntity(name: string, external_ids?: Record<string, string>, jurisdiction?: string) {
  return upsertEntity(store.db, { kind: "person", name, external_ids, jurisdiction }).entity;
}

/**
 * Builds a projection-test root entity that carries a bioguide. Used by
 * the `— projection` describe-block below so the R15 short-circuit
 * doesn't fire before `findConnections` runs. Seeds a `fetch_log` row
 * too so `withShapedFetch` serves the TTL fast path instead of
 * attempting the adapter call (which would 404 without live creds).
 */
function makeProjectionRoot(name: string): ReturnType<typeof makeEntity> {
  const bioguide = `P${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
  const e = makeEntity(name, { bioguide });
  const now = new Date().toISOString();
  for (const endpoint of [
    `/member/${bioguide}/sponsored-legislation`,
    `/member/${bioguide}/cosponsored-legislation`,
  ]) {
    const tool = endpoint.endsWith("sponsored-legislation") && !endpoint.includes("cosponsored")
      ? "fetchMemberSponsored"
      : "fetchMemberCosponsored";
    upsertFetchLog(store.db, {
      source: "congress",
      endpoint_path: endpoint,
      args_hash: hashArgs(tool, { bioguide }),
      scope: "full",
      fetched_at: now,
      last_rowcount: 0,
    });
  }
  return e;
}

function makeDoc(sourceId: string, kind: "bill" | "vote", refs: string[]) {
  return upsertDocument(store.db, {
    kind,
    jurisdiction: "us-federal",
    title: `Doc ${sourceId}`,
    occurred_at: "2024-03-01T00:00:00.000Z",
    source: { name: "congress", id: sourceId, url: `https://congress.gov/${sourceId}` },
    references: refs.map((entity_id) => ({ entity_id, role: "voter" as const })),
  }).document;
}

describe("handleEntityConnections — projection", () => {
  it("throws when entity is not found", async () => {
    await expect(
      handleEntityConnections(store.db, {
        id: "00000000-0000-0000-0000-000000000000",
        depth: 1,
        min_co_occurrences: 1,
      }),
    ).rejects.toThrow("Entity not found");
  });

  it("returns root with empty edges when entity has no documents", async () => {
    const a = makeProjectionRoot("Alice Empty");
    const result = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 1,
      min_co_occurrences: 1,
    });
    expect(result.root.id).toBe(a.id);
    expect(result.edges).toHaveLength(0);
    expect(result.nodes).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it("returns one edge with sample_documents and populated nodes", async () => {
    const a = makeProjectionRoot("Alice Conn");
    const b = makeEntity("Bob Conn");
    const doc = makeDoc("conn-doc-1", "bill", [a.id, b.id]);
    const result = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 1,
      min_co_occurrences: 1,
    });
    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0];
    expect(edge.from).toBe(a.id);
    expect(edge.to).toBe(b.id);
    expect(edge.via_kinds).toContain("bill");
    expect(edge.sample_documents).toHaveLength(1);
    expect(edge.sample_documents[0].id).toBe(doc.id);
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).toContain(b.id);
    expect(nodeIds).not.toContain(a.id);
  });

  it("respects min_co_occurrences", async () => {
    const a = makeProjectionRoot("Alice Min");
    const b = makeEntity("Bob Min");
    const c = makeEntity("Carol Min");
    makeDoc("min-ab-1", "bill", [a.id, b.id]);
    makeDoc("min-ab-2", "bill", [a.id, b.id]);
    makeDoc("min-ac-1", "bill", [a.id, c.id]);
    const result = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 1,
      min_co_occurrences: 2,
    });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].to).toBe(b.id);
  });

  it("includes sources from sample documents", async () => {
    const a = makeProjectionRoot("Alice Src");
    const b = makeEntity("Bob Src");
    makeDoc("src-doc-1", "bill", [a.id, b.id]);
    const result = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 1,
      min_co_occurrences: 1,
    });
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0].name).toBe("congress");
  });

  it("validates input via zod — rejects invalid depth", async () => {
    const a = makeProjectionRoot("Alice ValidZ");
    await expect(
      handleEntityConnections(store.db, { id: a.id, depth: 3, min_co_occurrences: 1 }),
    ).rejects.toThrow();
  });

  it("depth=2 surfaces second-hop neighbors in nodes", async () => {
    const a = makeProjectionRoot("Alice D2 Tool");
    const b = makeEntity("Bob D2 Tool");
    const c = makeEntity("Carol D2 Tool");
    makeDoc("d2t-ab-1", "bill", [a.id, b.id]);
    makeDoc("d2t-ab-2", "bill", [a.id, b.id]);
    makeDoc("d2t-bc-1", "vote", [b.id, c.id]);
    makeDoc("d2t-bc-2", "vote", [b.id, c.id]);
    const result = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 2,
      min_co_occurrences: 1,
    });
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).toContain(c.id);
  });

  it("returns truncated=true and exactly 100 edges at the hard cap", async () => {
    const root = makeProjectionRoot("Alice Cap Tool");
    for (let i = 0; i < 102; i++) {
      const peer = makeEntity(`Peer Cap Tool ${i}`);
      makeDoc(`cap-tool-${i}-a`, "bill", [root.id, peer.id]);
      makeDoc(`cap-tool-${i}-b`, "bill", [root.id, peer.id]);
    }
    const result = await handleEntityConnections(store.db, {
      id: root.id,
      depth: 1,
      min_co_occurrences: 2,
    });
    expect(result.edges.length).toBe(100);
    expect(result.truncated).toBe(true);
  });

  it("emits per-jurisdiction OpenStates URLs for state-specific documents", async () => {
    const a = makeProjectionRoot("Alice Multi");
    const bTx = makeEntity("Bob TX");
    const cCa = makeEntity("Carol CA");
    upsertDocument(store.db, {
      kind: "bill",
      jurisdiction: "us-tx",
      title: "IL HB 1",
      occurred_at: "2024-03-01T00:00:00.000Z",
      source: { name: "openstates", id: "tx-hb-1", url: "https://openstates.org/tx/bills/hb1" },
      references: [
        { entity_id: a.id, role: "sponsor" },
        { entity_id: bTx.id, role: "cosponsor" },
      ],
    });
    upsertDocument(store.db, {
      kind: "bill",
      jurisdiction: "us-ca",
      title: "CA AB 1",
      occurred_at: "2024-03-01T00:00:00.000Z",
      source: { name: "openstates", id: "ca-ab-1", url: "https://openstates.org/ca/bills/ab1" },
      references: [
        { entity_id: a.id, role: "sponsor" },
        { entity_id: cCa.id, role: "cosponsor" },
      ],
    });
    const result = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 1,
      min_co_occurrences: 1,
    });
    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain("https://openstates.org/tx/");
    expect(urls).toContain("https://openstates.org/ca/");
    expect(urls).not.toContain("https://openstates.org/us-federal/");
  });
});

describe("handleEntityConnections — R15 fanout", () => {
  it("entity with no external IDs → short-circuits with empty_reason=no_external_ids", async () => {
    const sponsoredSpy = vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    const cosponsoredSpy = vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    const openstatesSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchBillsBySponsor")
      .mockResolvedValue({ documentsUpserted: 0 });
    const fecSpy = vi.spyOn(OpenFecAdapter.prototype, "fetchContributionsToCandidate")
      .mockResolvedValue({ documentsUpserted: 0 });

    const a = makeEntity("Bare Entity");
    // Even give them a co-occurring document — the short-circuit must
    // skip both the fanout AND the findConnections projection.
    const b = makeEntity("Co-occurrence B");
    makeDoc("bare-doc-1", "bill", [a.id, b.id]);

    const res = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 1,
      min_co_occurrences: 1,
    });

    expect(res.empty_reason).toBe("no_external_ids");
    expect(res.edges).toHaveLength(0);
    expect(res.nodes).toHaveLength(0);
    expect(res.sources).toHaveLength(0);
    expect(res.truncated).toBe(false);
    expect(res.root.id).toBe(a.id);
    expect(sponsoredSpy).not.toHaveBeenCalled();
    expect(cosponsoredSpy).not.toHaveBeenCalled();
    expect(openstatesSpy).not.toHaveBeenCalled();
    expect(fecSpy).not.toHaveBeenCalled();
  });

  it("bioguide only → sponsored + cosponsored Congress.gov methods invoked", async () => {
    const sponsoredSpy = vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    const cosponsoredSpy = vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    const openstatesSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchBillsBySponsor")
      .mockResolvedValue({ documentsUpserted: 0 });
    const fecSpy = vi.spyOn(OpenFecAdapter.prototype, "fetchContributionsToCandidate")
      .mockResolvedValue({ documentsUpserted: 0 });

    const e = makeEntity("Sen. Bioguide", { bioguide: "S000148" });
    await handleEntityConnections(store.db, { id: e.id, depth: 1, min_co_occurrences: 1 });

    expect(sponsoredSpy).toHaveBeenCalledOnce();
    expect(sponsoredSpy).toHaveBeenCalledWith(store.db, "S000148");
    expect(cosponsoredSpy).toHaveBeenCalledOnce();
    expect(cosponsoredSpy).toHaveBeenCalledWith(store.db, "S000148");
    expect(openstatesSpy).not.toHaveBeenCalled();
    expect(fecSpy).not.toHaveBeenCalled();
  });

  it("openstates_person only → fetchBillsBySponsor invoked", async () => {
    const sponsoredSpy = vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    const cosponsoredSpy = vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    const openstatesSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchBillsBySponsor")
      .mockResolvedValue({ documentsUpserted: 0 });
    const fecSpy = vi.spyOn(OpenFecAdapter.prototype, "fetchContributionsToCandidate")
      .mockResolvedValue({ documentsUpserted: 0 });

    const e = makeEntity("State Legislator", { openstates_person: "ocd-person/tx-1" }, "us-tx");
    await handleEntityConnections(store.db, { id: e.id, depth: 1, min_co_occurrences: 1 });

    expect(openstatesSpy).toHaveBeenCalledOnce();
    expect(openstatesSpy).toHaveBeenCalledWith(store.db, {
      sponsor: "ocd-person/tx-1",
      jurisdiction: "tx",
      limit: 50,
    });
    expect(sponsoredSpy).not.toHaveBeenCalled();
    expect(cosponsoredSpy).not.toHaveBeenCalled();
    expect(fecSpy).not.toHaveBeenCalled();
  });

  it("fec_candidate only → fetchContributionsToCandidate invoked", async () => {
    const sponsoredSpy = vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    const cosponsoredSpy = vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    const openstatesSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchBillsBySponsor")
      .mockResolvedValue({ documentsUpserted: 0 });
    const fecSpy = vi.spyOn(OpenFecAdapter.prototype, "fetchContributionsToCandidate")
      .mockResolvedValue({ documentsUpserted: 0 });

    const e = makeEntity("FEC Candidate", { fec_candidate: "H0AZ01234" });
    await handleEntityConnections(store.db, { id: e.id, depth: 1, min_co_occurrences: 1 });

    expect(fecSpy).toHaveBeenCalledOnce();
    expect(fecSpy).toHaveBeenCalledWith(store.db, { candidateId: "H0AZ01234" });
    expect(sponsoredSpy).not.toHaveBeenCalled();
    expect(cosponsoredSpy).not.toHaveBeenCalled();
    expect(openstatesSpy).not.toHaveBeenCalled();
  });

  it("passes a non-default fanout limit to fetchBillsBySponsor (>20)", async () => {
    const openstatesSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchBillsBySponsor")
      .mockResolvedValue({ documentsUpserted: 0 });

    const e = makeEntity("Sponsor Person", { openstates_person: "ocd-person/tx-2" }, "us-tx");
    await handleEntityConnections(store.db, { id: e.id, depth: 1, min_co_occurrences: 1 });

    expect(openstatesSpy).toHaveBeenCalledOnce();
    const call = openstatesSpy.mock.calls[0][1] as { sponsor: string; jurisdiction: string; limit?: number };
    expect(call.limit).toBeGreaterThan(20);
  });

  it("all three external IDs → 4 adapter methods invoked exactly once each", async () => {
    const sponsoredSpy = vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    const cosponsoredSpy = vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    const openstatesSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchBillsBySponsor")
      .mockResolvedValue({ documentsUpserted: 0 });
    const fecSpy = vi.spyOn(OpenFecAdapter.prototype, "fetchContributionsToCandidate")
      .mockResolvedValue({ documentsUpserted: 0 });

    const e = makeEntity("Multi-ID Person", {
      bioguide: "S000148",
      openstates_person: "ocd-person/ny-schumer",
      fec_candidate: "S2NY00123",
    }, "us-ny");
    await handleEntityConnections(store.db, { id: e.id, depth: 1, min_co_occurrences: 1 });

    expect(sponsoredSpy).toHaveBeenCalledOnce();
    expect(cosponsoredSpy).toHaveBeenCalledOnce();
    expect(openstatesSpy).toHaveBeenCalledOnce();
    expect(fecSpy).toHaveBeenCalledOnce();
  });

  it("cache hit: second call within TTL skips the adapter calls", async () => {
    const sponsoredSpy = vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    const cosponsoredSpy = vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });

    const e = makeEntity("Cached Person", { bioguide: "S000148" });
    await handleEntityConnections(store.db, { id: e.id, depth: 1, min_co_occurrences: 1 });
    await handleEntityConnections(store.db, { id: e.id, depth: 1, min_co_occurrences: 1 });

    expect(sponsoredSpy).toHaveBeenCalledOnce();
    expect(cosponsoredSpy).toHaveBeenCalledOnce();
  });

  it("upstream failure with stale cache → stale_notice attached, connections still computed", async () => {
    const e = makeEntity("Stale Person", { bioguide: "S000148" });
    // Seed a co-occurrence so the projection has something to return.
    const colleague = makeEntity("Colleague");
    makeDoc("stale-1", "bill", [e.id, colleague.id]);

    // Seed stale fetch_log rows for both sponsored + cosponsored so the
    // fallback path runs after the thrown fetch.
    const ageMs = 48 * 60 * 60 * 1000;
    for (const endpoint of [
      "/member/S000148/sponsored-legislation",
      "/member/S000148/cosponsored-legislation",
    ]) {
      const tool = endpoint.endsWith("sponsored-legislation") && !endpoint.includes("cosponsored")
        ? "fetchMemberSponsored"
        : "fetchMemberCosponsored";
      upsertFetchLog(store.db, {
        source: "congress",
        endpoint_path: endpoint,
        args_hash: hashArgs(tool, { bioguide: "S000148" }),
        scope: "full",
        fetched_at: new Date(Date.now() - ageMs).toISOString(),
        last_rowcount: 0,
      });
    }

    vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockRejectedValue(new Error("simulated upstream failure"));
    vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockRejectedValue(new Error("simulated upstream failure"));

    const res = await handleEntityConnections(store.db, {
      id: e.id,
      depth: 1,
      min_co_occurrences: 1,
    });
    expect(res.stale_notice?.reason).toBe("upstream_failure");
    expect(res.root.id).toBe(e.id);
    // Projection still computes over the local store.
    const nodeIds = res.nodes.map((n) => n.id);
    expect(nodeIds).toContain(colleague.id);
  });

  it("multiple upstream failures → stale_notice mentions every failing source", async () => {
    const e = makeEntity("Multi-Fail Person", {
      bioguide: "S000148",
      openstates_person: "ocd-person/ny-1",
    });

    // Seed stale fetch_log rows for every endpoint so each call has a
    // cached fallback and produces a stale_notice instead of throwing.
    const ageMs = 48 * 60 * 60 * 1000;
    const stale = new Date(Date.now() - ageMs).toISOString();
    for (const [endpoint, tool, args] of [
      ["/member/S000148/sponsored-legislation", "fetchMemberSponsored", { bioguide: "S000148" }],
      ["/member/S000148/cosponsored-legislation", "fetchMemberCosponsored", { bioguide: "S000148" }],
    ] as const) {
      upsertFetchLog(store.db, {
        source: "congress",
        endpoint_path: endpoint,
        args_hash: hashArgs(tool, args),
        scope: "full",
        fetched_at: stale,
        last_rowcount: 0,
      });
    }
    upsertFetchLog(store.db, {
      source: "openstates",
      endpoint_path: "/bills/by-sponsor",
      args_hash: hashArgs("fetchBillsBySponsor", { sponsor: "ocd-person/ny-1" }),
      scope: "full",
      fetched_at: stale,
      last_rowcount: 0,
    });

    vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockRejectedValue(new Error("congress sponsored exploded"));
    vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockRejectedValue(new Error("congress cosponsored exploded"));
    vi.spyOn(OpenStatesAdapter.prototype, "fetchBillsBySponsor")
      .mockRejectedValue(new Error("openstates exploded"));

    const res = await handleEntityConnections(store.db, {
      id: e.id,
      depth: 1,
      min_co_occurrences: 1,
    });

    expect(res.stale_notice).toBeDefined();
    expect(res.stale_notice!.reason).toBe("upstream_failure");
    // Aggregated message lists labels for each failing source.
    expect(res.stale_notice!.message).toMatch(/congress sponsored/);
    expect(res.stale_notice!.message).toMatch(/congress cosponsored/);
    expect(res.stale_notice!.message).toMatch(/openstates/);
  });

  it("upstream failure with no cache → error propagates", async () => {
    const e = makeEntity("Cold-Fail Person", { bioguide: "S000148" });
    vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockRejectedValue(new Error("network down"));
    vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockRejectedValue(new Error("network down"));

    await expect(
      handleEntityConnections(store.db, { id: e.id, depth: 1, min_co_occurrences: 1 }),
    ).rejects.toThrow(/network down/);
  });

  it("endpoint_path includes the ID → different entities get different cache rows", async () => {
    const sponsoredSpy = vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });

    const e1 = makeEntity("Person One", { bioguide: "AAA111" });
    const e2 = makeEntity("Person Two", { bioguide: "BBB222" });

    await handleEntityConnections(store.db, { id: e1.id, depth: 1, min_co_occurrences: 1 });
    await handleEntityConnections(store.db, { id: e2.id, depth: 1, min_co_occurrences: 1 });
    expect(sponsoredSpy).toHaveBeenCalledTimes(2);
    await handleEntityConnections(store.db, { id: e1.id, depth: 1, min_co_occurrences: 1 });
    expect(sponsoredSpy).toHaveBeenCalledTimes(2);
  });
});

describe("handleEntityConnections via_roles", () => {
  it("distinguishes sponsor vs cosponsor on separate bills between the same two people", async () => {
    vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });

    const a = makeProjectionRoot("Alice VR");
    const b = makeEntity("Bob VR");

    // Bill 1: A sponsors, B cosponsors.
    upsertDocument(store.db, {
      kind: "bill",
      jurisdiction: "us-federal",
      title: "VR Bill 1",
      occurred_at: "2024-03-01T00:00:00.000Z",
      source: { name: "congress", id: "vr-bill-1", url: "https://congress.gov/vr-bill-1" },
      references: [
        { entity_id: a.id, role: "sponsor" },
        { entity_id: b.id, role: "cosponsor" },
      ],
    });

    // Bill 2: A cosponsors, B sponsors.
    upsertDocument(store.db, {
      kind: "bill",
      jurisdiction: "us-federal",
      title: "VR Bill 2",
      occurred_at: "2024-03-02T00:00:00.000Z",
      source: { name: "congress", id: "vr-bill-2", url: "https://congress.gov/vr-bill-2" },
      references: [
        { entity_id: a.id, role: "cosponsor" },
        { entity_id: b.id, role: "sponsor" },
      ],
    });

    const result = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 1,
      min_co_occurrences: 1,
    });

    const edgeToB = result.edges.find((e) => e.to === b.id);
    expect(edgeToB).toBeDefined();
    expect(edgeToB!.via_kinds).toEqual(["bill"]);
    expect(new Set(edgeToB!.via_roles)).toEqual(new Set(["sponsor", "cosponsor"]));
  });

  it("depth=2 second-hop edge carries the to-node's role on the shared document", async () => {
    vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });

    const a = makeProjectionRoot("Alice D2VR");
    const b = makeEntity("Bob D2VR");
    const c = makeEntity("Carol D2VR");

    // Bill 1: A sponsors, B cosponsors → A→B edge via_roles=[cosponsor].
    upsertDocument(store.db, {
      kind: "bill",
      jurisdiction: "us-federal",
      title: "D2VR Bill 1",
      occurred_at: "2024-03-01T00:00:00.000Z",
      source: { name: "congress", id: "d2vr-bill-1", url: "https://congress.gov/d2vr-bill-1" },
      references: [
        { entity_id: a.id, role: "sponsor" },
        { entity_id: b.id, role: "cosponsor" },
      ],
    });

    // Bill 2: B sponsors, C cosponsors → B→C edge via_roles=[cosponsor].
    upsertDocument(store.db, {
      kind: "bill",
      jurisdiction: "us-federal",
      title: "D2VR Bill 2",
      occurred_at: "2024-03-02T00:00:00.000Z",
      source: { name: "congress", id: "d2vr-bill-2", url: "https://congress.gov/d2vr-bill-2" },
      references: [
        { entity_id: b.id, role: "sponsor" },
        { entity_id: c.id, role: "cosponsor" },
      ],
    });

    const result = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 2,
      min_co_occurrences: 1,
    });

    const edgeAB = result.edges.find((e) => e.from === a.id && e.to === b.id);
    expect(edgeAB).toBeDefined();
    expect(edgeAB!.via_roles).toEqual(["cosponsor"]);

    const edgeBC = result.edges.find((e) => e.from === b.id && e.to === c.id);
    expect(edgeBC).toBeDefined();
    expect(edgeBC!.via_roles).toContain("cosponsor");
  });

  it("exposes voter role on vote documents", async () => {
    vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });

    const x = makeProjectionRoot("Person VR X");
    const y = makeEntity("Person VR Y");

    upsertDocument(store.db, {
      kind: "vote",
      jurisdiction: "us-federal",
      title: "VR Vote 1",
      occurred_at: "2024-03-03T00:00:00.000Z",
      source: { name: "congress", id: "vr-vote-1", url: "https://congress.gov/vr-vote-1" },
      references: [
        { entity_id: x.id, role: "voter" },
        { entity_id: y.id, role: "voter" },
      ],
    });

    const result = await handleEntityConnections(store.db, {
      id: x.id,
      depth: 1,
      min_co_occurrences: 1,
    });

    const edge = result.edges.find((e) => e.to === y.id);
    expect(edge).toBeDefined();
    expect(edge!.via_roles).toEqual(["voter"]);
  });
});

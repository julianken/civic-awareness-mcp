import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleEntityConnections } from "../../../../src/mcp/tools/entity_connections.js";

const TEST_DB = "./data/test-entity-connections-tool.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});

afterEach(() => {
  store.close();
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

function makeEntity(name: string) {
  return upsertEntity(store.db, { kind: "person", name }).entity;
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

describe("handleEntityConnections", () => {
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
    const a = makeEntity("Alice Empty");
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
    const a = makeEntity("Alice Conn");
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
    // b should appear in nodes
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).toContain(b.id);
    // root should NOT appear in nodes
    expect(nodeIds).not.toContain(a.id);
  });

  it("respects min_co_occurrences", async () => {
    const a = makeEntity("Alice Min");
    const b = makeEntity("Bob Min");
    const c = makeEntity("Carol Min");
    // a↔b: 2 shared docs, a↔c: 1 shared doc
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
    const a = makeEntity("Alice Src");
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
    const a = makeEntity("Alice ValidZ");
    await expect(
      handleEntityConnections(store.db, { id: a.id, depth: 3, min_co_occurrences: 1 }),
    ).rejects.toThrow();
  });

  it("depth=2 surfaces second-hop neighbors in nodes", async () => {
    const a = makeEntity("Alice D2 Tool");
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
    // Seed 102 peers, each sharing 2 documents with root (to exceed
    // min_co_occurrences=2) — verifies cap and truncated flag.
    const root = makeEntity("Alice Cap Tool");
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
    // When a Person's edges span multiple states, the sources array must
    // include one entry per (source_name, jurisdiction) pair with the
    // correct state-specific URL — not a single collapsed entry that
    // falsely claims us-federal.
    const a = makeEntity("Alice Multi");
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
    // Both a Texas and a California openstates URL must appear.
    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain("https://openstates.org/tx/");
    expect(urls).toContain("https://openstates.org/ca/");
    // And NO hardcoded "us-federal" fallback for state documents.
    expect(urls).not.toContain("https://openstates.org/us-federal/");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { upsertEntity } from "../../../src/core/entities.js";
import { upsertDocument } from "../../../src/core/documents.js";
import { findConnections } from "../../../src/core/connections.js";

const TEST_DB = "./data/test-connections.db";
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

function makeEntity(db: Store["db"], name: string) {
  return upsertEntity(db, { kind: "person", name }).entity;
}

function makeDoc(
  db: Store["db"],
  sourceId: string,
  kind: "bill" | "vote" | "contribution",
  refs: string[],
) {
  return upsertDocument(db, {
    kind,
    jurisdiction: "us-federal",
    title: `Doc ${sourceId}`,
    occurred_at: "2024-01-01T00:00:00.000Z",
    source: { name: "congress", id: sourceId, url: `https://congress.gov/${sourceId}` },
    references: refs.map((entity_id) => ({ entity_id, role: "sponsor" as const })),
  }).document;
}

describe("findConnections", () => {
  it("returns empty result when entity has no documents", () => {
    const a = makeEntity(store.db, "Alice Alone");
    const result = findConnections(store.db, a.id, 1, 1);
    expect(result.edges).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it("returns empty result when entity has no co-occurrences", () => {
    const a = makeEntity(store.db, "Alice Solo");
    const b = makeEntity(store.db, "Bob Solo");
    makeDoc(store.db, "doc-a", "bill", [a.id]);
    makeDoc(store.db, "doc-b", "bill", [b.id]);
    const result = findConnections(store.db, a.id, 1, 1);
    expect(result.edges).toHaveLength(0);
  });

  it("returns an edge when two entities co-occur on a single document (minCoOccurrences=1)", () => {
    const a = makeEntity(store.db, "Alice Shared");
    const b = makeEntity(store.db, "Bob Shared");
    makeDoc(store.db, "doc-ab", "bill", [a.id, b.id]);
    const result = findConnections(store.db, a.id, 1, 1);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].from_id).toBe(a.id);
    expect(result.edges[0].to_id).toBe(b.id);
    expect(result.edges[0].co_occurrence_count).toBe(1);
    expect(result.edges[0].via_kinds).toContain("bill");
    expect(result.edges[0].sample_document_ids).toHaveLength(1);
  });

  it("enforces minCoOccurrences=2 and excludes single-document pairs", () => {
    const a = makeEntity(store.db, "Alice Two");
    const b = makeEntity(store.db, "Bob Two");
    const c = makeEntity(store.db, "Carol Two");
    // a↔b: 2 shared docs; a↔c: 1 shared doc
    makeDoc(store.db, "doc-ab1", "bill", [a.id, b.id]);
    makeDoc(store.db, "doc-ab2", "vote", [a.id, b.id]);
    makeDoc(store.db, "doc-ac1", "bill", [a.id, c.id]);
    const result = findConnections(store.db, a.id, 1, 2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].to_id).toBe(b.id);
    expect(result.edges[0].co_occurrence_count).toBe(2);
  });

  it("populates via_kinds with all distinct document kinds", () => {
    const a = makeEntity(store.db, "Alice Kinds");
    const b = makeEntity(store.db, "Bob Kinds");
    makeDoc(store.db, "doc-ab-bill", "bill", [a.id, b.id]);
    makeDoc(store.db, "doc-ab-vote", "vote", [a.id, b.id]);
    const result = findConnections(store.db, a.id, 1, 1);
    expect(result.edges[0].via_kinds).toHaveLength(2);
    expect(result.edges[0].via_kinds).toContain("bill");
    expect(result.edges[0].via_kinds).toContain("vote");
  });

  it("caps sample_document_ids at 3", () => {
    const a = makeEntity(store.db, "Alice Docs");
    const b = makeEntity(store.db, "Bob Docs");
    for (let i = 0; i < 5; i++) {
      makeDoc(store.db, `doc-many-${i}`, "bill", [a.id, b.id]);
    }
    const result = findConnections(store.db, a.id, 1, 1);
    expect(result.edges[0].sample_document_ids.length).toBeLessThanOrEqual(3);
  });

  it("returns depth=2 edges through an intermediate neighbor", () => {
    const a = makeEntity(store.db, "Alice Depth");
    const b = makeEntity(store.db, "Bob Depth");
    const c = makeEntity(store.db, "Carol Depth");
    // a↔b: directly connected
    makeDoc(store.db, "doc-ab", "bill", [a.id, b.id]);
    makeDoc(store.db, "doc-ab2", "bill", [a.id, b.id]);
    // b↔c: reachable at depth=2
    makeDoc(store.db, "doc-bc", "vote", [b.id, c.id]);
    makeDoc(store.db, "doc-bc2", "vote", [b.id, c.id]);
    const result = findConnections(store.db, a.id, 2, 1);
    const toIds = result.edges.map((e) => e.to_id);
    expect(toIds).toContain(b.id);
    expect(toIds).toContain(c.id);
  });

  it("does not duplicate edges when depth=2 produces a pair already in depth=1", () => {
    const a = makeEntity(store.db, "Alice Dedup");
    const b = makeEntity(store.db, "Bob Dedup");
    const c = makeEntity(store.db, "Carol Dedup");
    // a↔b and a↔c at depth=1; b↔c also seen as b→c at depth=2
    makeDoc(store.db, "doc-ab", "bill", [a.id, b.id]);
    makeDoc(store.db, "doc-ab2", "bill", [a.id, b.id]);
    makeDoc(store.db, "doc-ac", "bill", [a.id, c.id]);
    makeDoc(store.db, "doc-ac2", "bill", [a.id, c.id]);
    makeDoc(store.db, "doc-bc", "vote", [b.id, c.id]);
    makeDoc(store.db, "doc-bc2", "vote", [b.id, c.id]);
    const result = findConnections(store.db, a.id, 2, 1);
    const pairs = result.edges.map((e) => `${e.from_id}→${e.to_id}`);
    // Unique pairs only
    const unique = new Set(pairs);
    expect(pairs.length).toBe(unique.size);
  });

  it("sorts edges by co_occurrence_count descending", () => {
    const a = makeEntity(store.db, "Alice Sorted");
    const b = makeEntity(store.db, "Bob Sorted");
    const c = makeEntity(store.db, "Carol Sorted");
    // a↔c has more shared docs than a↔b
    makeDoc(store.db, "doc-ab-s", "bill", [a.id, b.id]);
    for (let i = 0; i < 4; i++) {
      makeDoc(store.db, `doc-ac-s-${i}`, "bill", [a.id, c.id]);
    }
    const result = findConnections(store.db, a.id, 1, 1);
    expect(result.edges[0].to_id).toBe(c.id);
    expect(result.edges[0].co_occurrence_count).toBeGreaterThan(
      result.edges[1].co_occurrence_count,
    );
  });

  it("sets truncated=true when edge count hits the 100-edge cap", () => {
    // Seed 105 peer entities, each sharing a document with root
    const root = makeEntity(store.db, "Alice Cap");
    for (let i = 0; i < 105; i++) {
      const peer = makeEntity(store.db, `Peer Cap ${i}`);
      makeDoc(store.db, `doc-cap-${i}`, "bill", [root.id, peer.id]);
    }
    const result = findConnections(store.db, root.id, 1, 1);
    expect(result.edges.length).toBe(100);
    expect(result.truncated).toBe(true);
  });
});

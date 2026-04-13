import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { upsertEntity } from "../../../src/core/entities.js";
import {
  upsertDocument, queryDocuments, findDocumentsByEntity,
} from "../../../src/core/documents.js";

const TEST_DB = "./data/test-documents.db";
let store: Store;
beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});
afterEach(() => store.close());

describe("upsertDocument", () => {
  it("inserts new", () => {
    const r = upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "HR1234",
      occurred_at: "2026-03-01T00:00:00.000Z",
      source: { name: "congress", id: "hr-1234-119", url: "https://x/1" },
    });
    expect(r.created).toBe(true);
  });
  it("updates on source conflict", () => {
    const input = {
      kind: "bill" as const, jurisdiction: "us-federal", title: "v1",
      occurred_at: "2026-03-01T00:00:00.000Z",
      source: { name: "congress", id: "hr-1234-119", url: "https://x/1" },
    };
    upsertDocument(store.db, input);
    const second = upsertDocument(store.db, { ...input, title: "v2" });
    expect(second.created).toBe(false);
    expect(second.document.title).toBe("v2");
  });
  it("writes references", () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person", name: "Jane",
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "HR1",
      occurred_at: "2026-03-01T00:00:00.000Z",
      source: { name: "congress", id: "1", url: "https://x/1" },
      references: [{ entity_id: entity.id, role: "sponsor" }],
    });
    expect(findDocumentsByEntity(store.db, entity.id)).toHaveLength(1);
  });

  // Regression: duplicate (entity_id, role) pairs from upstream — e.g.
  // an OpenStates bill that lists the same person twice as primary
  // sponsor, or entity resolution collapsing two sponsor entries into
  // one entity — must not trip the PRIMARY KEY
  // (document_id, entity_id, role). We tolerate the dup silently.
  it("tolerates duplicate (entity_id, role) references", () => {
    const { entity } = upsertEntity(store.db, { kind: "person", name: "Duped" });
    expect(() =>
      upsertDocument(store.db, {
        kind: "bill", jurisdiction: "us-tx", title: "HB1",
        occurred_at: "2026-03-01T00:00:00.000Z",
        source: { name: "openstates", id: "ocd-bill/dup", url: "https://x" },
        references: [
          { entity_id: entity.id, role: "sponsor" },
          { entity_id: entity.id, role: "sponsor" },
        ],
      }),
    ).not.toThrow();
    // Only one row stored, not two.
    expect(findDocumentsByEntity(store.db, entity.id)).toHaveLength(1);
  });
});

describe("queryDocuments", () => {
  beforeEach(() => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "HR1",
      occurred_at: "2026-03-01T00:00:00.000Z",
      source: { name: "congress", id: "1", url: "https://x/1" },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "HR2",
      occurred_at: "2026-04-01T00:00:00.000Z",
      source: { name: "congress", id: "2", url: "https://x/2" },
    });
  });
  it("filters by kind", () => {
    expect(queryDocuments(store.db, { kind: "bill", jurisdiction: "us-federal", limit: 10 })).toHaveLength(2);
  });
  it("filters by window", () => {
    const docs = queryDocuments(store.db, {
      kind: "bill", jurisdiction: "us-federal", from: "2026-03-15T00:00:00.000Z", limit: 10,
    });
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("HR2");
  });
  it("orders DESC by occurred_at", () => {
    const docs = queryDocuments(store.db, { kind: "bill", jurisdiction: "us-federal", limit: 10 });
    expect(docs[0].title).toBe("HR2");
  });
});

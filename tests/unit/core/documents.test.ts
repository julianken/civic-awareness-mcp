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

  // Regression: OpenStates returns timestamps as
  // `2026-04-04T06:20:24.862671+00:00` (microsecond precision +
  // numeric offset). Stored as-is, these failed the strict
  // `Document` Zod schema on read, breaking `recent_bills`. Storage
  // must canonicalize to `...sssZ` regardless of source format.
  it("normalizes occurred_at to canonical millisecond Z form on insert", () => {
    const r = upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB1",
      occurred_at: "2026-04-04T06:20:24.862671+00:00",
      source: { name: "openstates", id: "ocd-bill/normalize-test", url: "https://x" },
    });
    expect(r.document.occurred_at).toBe("2026-04-04T06:20:24.862Z");
    const stored = store.db
      .prepare("SELECT occurred_at FROM documents WHERE source_id = 'ocd-bill/normalize-test'")
      .get() as { occurred_at: string };
    expect(stored.occurred_at).toBe("2026-04-04T06:20:24.862Z");
  });

  it("normalizes occurred_at on update too", () => {
    const input = {
      kind: "bill" as const, jurisdiction: "us-tx", title: "HB1",
      occurred_at: "2026-04-04T00:00:00.000Z",
      source: { name: "openstates", id: "ocd-bill/normalize-update", url: "https://x" },
    };
    upsertDocument(store.db, input);
    upsertDocument(store.db, {
      ...input,
      occurred_at: "2026-04-05T06:20:24.862671+00:00",
    });
    const stored = store.db
      .prepare("SELECT occurred_at FROM documents WHERE source_id = 'ocd-bill/normalize-update'")
      .get() as { occurred_at: string };
    expect(stored.occurred_at).toBe("2026-04-05T06:20:24.862Z");
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

describe("findDocumentsByEntity", () => {
  it("findDocumentsByEntity returns action_date alongside occurred_at", () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person", name: "Test Senator",
      external_ids: { openstates_person: "ocd-person/t" },
    });
    upsertDocument(store.db, {
      kind: "bill",
      jurisdiction: "us-tx",
      title: "SB 99 — Test",
      occurred_at: "2025-09-18T00:00:00Z",
      source: { name: "openstates", id: "ocd-bill/99", url: "https://example.com/99" },
      references: [{ entity_id: entity.id, role: "sponsor" }],
      raw: { actions: [
        { date: "2025-09-01", description: "Introduced" },
        { date: "2025-09-18", description: "Became law" },
      ]},
    });

    const docs = findDocumentsByEntity(store.db, entity.id, 10);
    expect(docs[0].occurred_at).toMatch(/^2025-09-18T/);
    expect(docs[0].action_date).toBe("2025-09-18");
  });

  it("findDocumentsByEntity sorts by action_date DESC when available", () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person", name: "Sen A",
      external_ids: { openstates_person: "ocd-person/a" },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "OLDER",
      occurred_at: "2025-06-01T00:00:00Z",
      source: { name: "openstates", id: "o1", url: "https://example.com/o1" },
      references: [{ entity_id: entity.id, role: "sponsor" }],
      raw: { actions: [{ date: "2025-06-01", description: "intro" }] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "NEWER",
      occurred_at: "2025-09-18T00:00:00Z",
      source: { name: "openstates", id: "o2", url: "https://example.com/o2" },
      references: [{ entity_id: entity.id, role: "sponsor" }],
      raw: { actions: [{ date: "2025-09-18", description: "enacted" }] },
    });
    const docs = findDocumentsByEntity(store.db, entity.id, 10);
    expect(docs.map((d) => d.title)).toEqual(["NEWER", "OLDER"]);
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

  it("queryDocuments returns cross-jurisdiction results when jurisdiction is '*'", () => {
    upsertDocument(store.db, {
      kind: "vote", jurisdiction: "us-tx", title: "Vote TX — A",
      occurred_at: "2025-09-18T00:00:00Z",
      source: { name: "openstates", id: "tx-a", url: "https://ex" },
    });
    upsertDocument(store.db, {
      kind: "vote", jurisdiction: "us-ca", title: "Vote CA — B",
      occurred_at: "2025-09-17T00:00:00Z",
      source: { name: "openstates", id: "ca-b", url: "https://ex" },
    });
    const all = queryDocuments(store.db, {
      kind: "vote",
      jurisdiction: "*",
      limit: 10,
    });
    expect(all.map((d) => d.jurisdiction).sort()).toEqual(["us-ca", "us-tx"]);
  });
});

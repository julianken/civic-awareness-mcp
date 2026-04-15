import { describe, it, expect, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore } from "../../../src/core/store.js";

const TEST_DB = "./data/test-store.db";
afterEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  if (existsSync(TEST_DB + "-wal")) rmSync(TEST_DB + "-wal");
  if (existsSync(TEST_DB + "-shm")) rmSync(TEST_DB + "-shm");
});

describe("openStore", () => {
  it("creates the DB file", () => {
    const s = openStore(TEST_DB);
    expect(existsSync(TEST_DB)).toBe(true);
    s.close();
  });

  it("applies migrations on first open", () => {
    const s = openStore(TEST_DB);
    const tables = s.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("entities");
    expect(tables).toContain("documents");
    expect(tables).toContain("document_references");
    expect(tables).toContain("jurisdictions");
    expect(tables).toContain("schema_migrations");
    s.close();
  });

  it("is idempotent", () => {
    openStore(TEST_DB).close();
    const s = openStore(TEST_DB);
    const count = s.db
      .prepare("SELECT COUNT(*) as c FROM schema_migrations")
      .get() as { c: number };
    expect(count.c).toBe(9);
    s.close();
  });

  // Regression: pre-Phase-5 OpenStates ingests stored timestamps as
  // `2026-04-04T06:20:24.862671+00:00` (microsecond precision +
  // numeric offset). Migration 002 normalizes legacy rows so
  // `recent_bills` doesn't blow up against pre-existing DBs.
  it("migration 002 normalizes legacy occurred_at to canonical Z form on reopen", () => {
    const s1 = openStore(TEST_DB);
    s1.db.prepare("INSERT INTO jurisdictions (id, level, name) VALUES ('us-tx', 'state', 'Texas')").run();
    s1.db
      .prepare(
        `INSERT INTO documents (id, kind, jurisdiction, title, occurred_at, fetched_at, source_name, source_id, source_url, raw)
         VALUES ('legacy-1', 'bill', 'us-tx', 'HB1', ?, ?, 'openstates', 'ocd-bill/legacy', 'https://x', '{}')`,
      )
      .run("2026-04-04T06:20:24.862671+00:00", "2026-04-04T06:20:24.862Z");
    s1.db.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    s1.close();

    const s2 = openStore(TEST_DB);
    const fixed = s2.db
      .prepare("SELECT occurred_at FROM documents WHERE id = 'legacy-1'")
      .get() as { occurred_at: string };
    s2.close();
    expect(fixed.occurred_at).toMatch(/^2026-04-04T06:20:24\.\d{3}Z$/);
  });
});

import { seedJurisdictions } from "../../../src/core/seeds.js";

describe("seedJurisdictions", () => {
  it("inserts us-federal and all 50 states", () => {
    const s = openStore(TEST_DB);
    seedJurisdictions(s.db);
    const federal = s.db
      .prepare("SELECT id, level, name FROM jurisdictions WHERE id = ?")
      .get("us-federal");
    expect(federal).toEqual({ id: "us-federal", level: "federal", name: "United States" });
    const stateCount = s.db
      .prepare("SELECT COUNT(*) as c FROM jurisdictions WHERE level = 'state'")
      .get() as { c: number };
    expect(stateCount.c).toBe(50);
    // Spot-check a few specific states across the alphabet.
    expect(
      s.db.prepare("SELECT name FROM jurisdictions WHERE id = ?").get("us-tx"),
    ).toEqual({ name: "Texas" });
    expect(
      s.db.prepare("SELECT name FROM jurisdictions WHERE id = ?").get("us-wy"),
    ).toEqual({ name: "Wyoming" });
    s.close();
  });

  it("is idempotent", () => {
    const s = openStore(TEST_DB);
    seedJurisdictions(s.db);
    seedJurisdictions(s.db);
    const c = s.db.prepare("SELECT COUNT(*) as c FROM jurisdictions").get() as { c: number };
    // us-federal + 50 states. Keep in sync with JURISDICTIONS in src/core/seeds.ts.
    expect(c.c).toBe(51);
    s.close();
  });
});

// Regression for drift audit C1: migration 007's expression index
// `idx_entities_bioguide` is keyed on `json_extract(external_ids, '$."bioguide"')`
// — with inner double-quotes around the key. SQLite's planner matches the
// indexed expression by exact text, so a future call site that drops the
// inner quotes (`'$.bioguide'`) silently regresses to a full table scan.
// These tests pin both the positive and negative cases against EXPLAIN
// QUERY PLAN so the index stays load-bearing for get_vote and the
// congress sponsor-upsert path.
describe("migration 007: bioguide expression index", () => {
  function seedEntity(s: ReturnType<typeof openStore>, id: string, bioguide: string): void {
    s.db
      .prepare(
        `INSERT INTO entities (id, kind, name, name_normalized, external_ids, first_seen_at, last_seen_at)
         VALUES (?, 'person', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `Member ${bioguide}`,
        `member ${bioguide}`,
        JSON.stringify({ bioguide }),
        "2026-04-14T00:00:00.000Z",
        "2026-04-14T00:00:00.000Z",
      );
  }

  it("query plan with quoted '$.\"bioguide\"' path uses idx_entities_bioguide", () => {
    const s = openStore(TEST_DB);
    seedJurisdictions(s.db);
    seedEntity(s, "p1", "A000001");
    seedEntity(s, "p2", "B000002");
    seedEntity(s, "p3", "C000003");

    const plan = s.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM entities
         WHERE json_extract(external_ids, '$."bioguide"') = ?`,
      )
      .all("A000001") as Array<{ detail: string }>;
    s.close();

    const detail = plan.map((r) => r.detail).join(" | ");
    expect(detail).toContain("USING INDEX idx_entities_bioguide");
  });

  it("query plan with unquoted '$.bioguide' path does NOT use idx_entities_bioguide", () => {
    const s = openStore(TEST_DB);
    seedJurisdictions(s.db);
    seedEntity(s, "p1", "A000001");

    const plan = s.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM entities
         WHERE json_extract(external_ids, '$.bioguide') = ?`,
      )
      .all("A000001") as Array<{ detail: string }>;
    s.close();

    const detail = plan.map((r) => r.detail).join(" | ");
    expect(detail).not.toContain("USING INDEX idx_entities_bioguide");
  });
});

// Phase 9.1 D1/D2: same drift-guard pattern as 007 above for the
// openstates_person and fec_committee expression indexes. The path
// literals here MUST stay in sync with EXTERNAL_ID_PATHS in entities.ts
// and the migration files.
describe("migration 008/009: openstates_person + fec_committee expression indexes", () => {
  function seedEntity(
    s: ReturnType<typeof openStore>,
    id: string,
    source: string,
    extId: string,
  ): void {
    s.db
      .prepare(
        `INSERT INTO entities (id, kind, name, name_normalized, external_ids, first_seen_at, last_seen_at)
         VALUES (?, 'person', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `Entity ${extId}`,
        `entity ${extId}`,
        JSON.stringify({ [source]: extId }),
        "2026-04-14T00:00:00.000Z",
        "2026-04-14T00:00:00.000Z",
      );
  }

  it("query plan with quoted '$.\"openstates_person\"' path uses idx_entities_openstates_person", () => {
    const s = openStore(TEST_DB);
    seedJurisdictions(s.db);
    seedEntity(s, "o1", "openstates_person", "ocd-person/aaa");
    seedEntity(s, "o2", "openstates_person", "ocd-person/bbb");
    seedEntity(s, "o3", "openstates_person", "ocd-person/ccc");

    const plan = s.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM entities
         WHERE json_extract(external_ids, '$."openstates_person"') = ?`,
      )
      .all("ocd-person/aaa") as Array<{ detail: string }>;
    s.close();

    const detail = plan.map((r) => r.detail).join(" | ");
    expect(detail).toContain("USING INDEX idx_entities_openstates_person");
  });

  it("query plan with quoted '$.\"fec_committee\"' path uses idx_entities_fec_committee", () => {
    const s = openStore(TEST_DB);
    seedJurisdictions(s.db);
    seedEntity(s, "c1", "fec_committee", "C00111111");
    seedEntity(s, "c2", "fec_committee", "C00222222");
    seedEntity(s, "c3", "fec_committee", "C00333333");

    const plan = s.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM entities
         WHERE json_extract(external_ids, '$."fec_committee"') = ?`,
      )
      .all("C00111111") as Array<{ detail: string }>;
    s.close();

    const detail = plan.map((r) => r.detail).join(" | ");
    expect(detail).toContain("USING INDEX idx_entities_fec_committee");
  });
});

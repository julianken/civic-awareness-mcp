import { describe, it, expect, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openStore } from "../../../src/core/store.js";

const coreSqlPath = fileURLToPath(new URL("../../../src/core/schema.sql", import.meta.url));

const TEST_DB = "./data/test-store.db";
afterEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  if (existsSync(TEST_DB + "-wal")) rmSync(TEST_DB + "-wal");
  if (existsSync(TEST_DB + "-shm")) rmSync(TEST_DB + "-shm");
});

describe("openStore", () => {
  it("creates the DB file", () => {
    const s = openStore(TEST_DB, coreSqlPath);
    expect(existsSync(TEST_DB)).toBe(true);
    s.close();
  });

  it("applies schema on first open", () => {
    const s = openStore(TEST_DB, coreSqlPath);
    const tables = s.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("entities");
    expect(tables).toContain("documents");
    expect(tables).toContain("document_references");
    expect(tables).toContain("jurisdictions");
    expect(tables).toContain("fetch_log");
    s.close();
  });

  it("is idempotent (IF NOT EXISTS)", () => {
    openStore(TEST_DB, coreSqlPath).close();
    const s = openStore(TEST_DB, coreSqlPath);
    const tables = s.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("entities");
    s.close();
  });

  it("uses core schema when no schemaPaths given", () => {
    // Default path resolution: store resolves schema.sql relative to itself.
    // This only works when running from the repo root with the source layout.
    const s = openStore(TEST_DB);
    const tables = s.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("entities");
    s.close();
  });
});

import { seedJurisdictions } from "../../../src/federal/seeds.js";

describe("seedJurisdictions", () => {
  it("inserts us-federal and all 50 states", () => {
    const s = openStore(TEST_DB, coreSqlPath);
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
    const s = openStore(TEST_DB, coreSqlPath);
    seedJurisdictions(s.db);
    seedJurisdictions(s.db);
    const c = s.db.prepare("SELECT COUNT(*) as c FROM jurisdictions").get() as { c: number };
    // us-federal + 50 states. Keep in sync with JURISDICTIONS in src/core/seeds.ts.
    expect(c.c).toBe(51);
    s.close();
  });
});

// Drift-guard: bioguide expression index path must exactly match what
// is in schema.sql so SQLite's planner can use the index.
describe("schema.sql: bioguide expression index", () => {
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

  it("query plan with quoted '$.\"bioguide\"' path uses idx_entities_bioguide (after federal schema)", async () => {
    const federalSqlPath = fileURLToPath(new URL("../../../src/federal/schema.sql", import.meta.url));
    const s = openStore(TEST_DB, coreSqlPath, federalSqlPath);
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

  it("query plan with unquoted '$.bioguide' path does NOT use idx_entities_bioguide", async () => {
    const federalSqlPath = fileURLToPath(new URL("../../../src/federal/schema.sql", import.meta.url));
    const s = openStore(TEST_DB, coreSqlPath, federalSqlPath);
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

// Phase 9.1 D1/D2: same drift-guard pattern for fec_committee.
describe("schema.sql: fec_committee expression index", () => {
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

  it("query plan with quoted '$.\"fec_committee\"' path uses idx_entities_fec_committee", async () => {
    const federalSqlPath = fileURLToPath(new URL("../../../src/federal/schema.sql", import.meta.url));
    const s = openStore(TEST_DB, coreSqlPath, federalSqlPath);
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

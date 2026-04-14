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
    expect(count.c).toBe(5);
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

import { describe, it, expect, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore } from "../../../src/core/store.js";

const TEST_DB = "./data/test-store.db";
afterEach(() => { if (existsSync(TEST_DB)) rmSync(TEST_DB); });

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
    expect(count.c).toBe(1);
    s.close();
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

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

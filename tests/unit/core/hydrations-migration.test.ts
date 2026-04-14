import { describe, it, expect } from "vitest";
import { openStore } from "../../../src/core/store.js";

describe("migration 004 — hydrations table", () => {
  it("creates hydrations table with expected columns and constraints", () => {
    const store = openStore(":memory:");
    const info = store.db
      .prepare("PRAGMA table_info(hydrations)")
      .all() as Array<{ name: string; type: string; pk: number; notnull: number }>;
    const byName = Object.fromEntries(info.map((c) => [c.name, c]));
    expect(byName.source).toMatchObject({ type: "TEXT", notnull: 1, pk: 1 });
    expect(byName.jurisdiction).toMatchObject({ type: "TEXT", notnull: 1, pk: 2 });
    expect(byName.scope).toMatchObject({ type: "TEXT", notnull: 1, pk: 3 });
    expect(byName.last_fetched_at).toMatchObject({ type: "TEXT", notnull: 1 });
    expect(byName.status).toMatchObject({ type: "TEXT", notnull: 1 });
    store.close();
  });

  it("accepts valid insert; rejects invalid scope", () => {
    const store = openStore(":memory:");
    // valid
    store.db
      .prepare(
        "INSERT INTO hydrations (source, jurisdiction, scope, last_fetched_at, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run("openstates", "us-tx", "recent", new Date().toISOString(), "complete");
    const count = store.db.prepare("SELECT COUNT(*) AS c FROM hydrations").get() as { c: number };
    expect(count.c).toBe(1);

    // invalid scope rejected by CHECK constraint
    expect(() =>
      store.db
        .prepare(
          "INSERT INTO hydrations (source, jurisdiction, scope, last_fetched_at, status) VALUES (?, ?, ?, ?, ?)",
        )
        .run("openstates", "us-tx", "bogus", new Date().toISOString(), "complete"),
    ).toThrow(/CHECK constraint/);

    store.close();
  });

  it("upsert via (source, jurisdiction, scope) primary key works", () => {
    const store = openStore(":memory:");
    const stmt = store.db.prepare(
      `INSERT INTO hydrations (source, jurisdiction, scope, last_fetched_at, status)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source, jurisdiction, scope) DO UPDATE SET
           last_fetched_at = excluded.last_fetched_at,
           status = excluded.status`,
    );
    stmt.run("openstates", "us-tx", "recent", "2026-04-13T00:00:00Z", "partial");
    stmt.run("openstates", "us-tx", "recent", "2026-04-13T01:00:00Z", "complete");
    const row = store.db
      .prepare("SELECT status, last_fetched_at FROM hydrations")
      .get() as { status: string; last_fetched_at: string };
    expect(row.status).toBe("complete");
    expect(row.last_fetched_at).toBe("2026-04-13T01:00:00Z");
    store.close();
  });
});

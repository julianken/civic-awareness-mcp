import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";

const TEST_DB = "./data/test-migration-003.db";
let store: Store;
beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
});
afterEach(() => store.close());

describe("migration 003 — occurred_at from actions", () => {
  it("heals pre-T2 bug-shaped bill rows (occurred_at = updated_at)", () => {
    // Seed a jurisdiction so the FK passes.
    store.db.prepare(
      "INSERT INTO jurisdictions (id, level, name) VALUES ('us-tx', 'state', 'Texas')",
    ).run();
    // Insert a row that looks like what pre-T2 OpenStates ingest would
    // have written: occurred_at = crawl timestamp, raw.actions has the
    // real action date.
    store.db.prepare(
      `INSERT INTO documents
       (id, kind, jurisdiction, title, occurred_at, fetched_at,
        source_name, source_id, source_url, raw)
       VALUES (?, 'bill', 'us-tx', 'SB 5 — Test', ?, ?, 'openstates', 'ocd-bill/x', 'https://ex', ?)`,
    ).run(
      "00000000-0000-0000-0000-000000000001",
      "2026-04-10T10:00:00.000Z",  // bug: crawl time
      "2026-04-10T10:00:00.000Z",
      JSON.stringify({ actions: [
        { date: "2025-09-17", description: "introduced" },
        { date: "2025-09-18", description: "became law" },
      ]}),
    );
    // Re-run migration 003 against this existing DB by loading the SQL directly.
    const sql = readFileSync(
      "./src/core/migrations/003-occurred-at-from-actions.sql",
      "utf8",
    );
    store.db.exec(sql);
    const row = store.db.prepare(
      "SELECT occurred_at FROM documents WHERE source_id = 'ocd-bill/x'",
    ).get() as { occurred_at: string };
    expect(row.occurred_at).toBe("2025-09-18");  // date-only per SQLite json_extract
  });

  it("is idempotent — re-running on healed rows is a no-op", () => {
    store.db.prepare(
      "INSERT INTO jurisdictions (id, level, name) VALUES ('us-tx', 'state', 'Texas')",
    ).run();
    store.db.prepare(
      `INSERT INTO documents
       (id, kind, jurisdiction, title, occurred_at, fetched_at,
        source_name, source_id, source_url, raw)
       VALUES (?, 'bill', 'us-tx', 'SB 5 — Test', ?, ?, 'openstates', 'ocd-bill/x', 'https://ex', ?)`,
    ).run(
      "00000000-0000-0000-0000-000000000002",
      "2025-09-18",  // already-healed value
      "2026-04-10T10:00:00.000Z",
      JSON.stringify({ actions: [{ date: "2025-09-18", description: "became law" }] }),
    );
    const sql = readFileSync(
      "./src/core/migrations/003-occurred-at-from-actions.sql",
      "utf8",
    );
    store.db.exec(sql);
    store.db.exec(sql);  // applying twice must not mutate the row
    const row = store.db.prepare(
      "SELECT occurred_at FROM documents WHERE source_id = 'ocd-bill/x'",
    ).get() as { occurred_at: string };
    expect(row.occurred_at).toBe("2025-09-18");
  });

  it("skips bills with empty actions[]", () => {
    store.db.prepare(
      "INSERT INTO jurisdictions (id, level, name) VALUES ('us-tx', 'state', 'Texas')",
    ).run();
    store.db.prepare(
      `INSERT INTO documents
       (id, kind, jurisdiction, title, occurred_at, fetched_at,
        source_name, source_id, source_url, raw)
       VALUES (?, 'bill', 'us-tx', 'SB 5 — Test', ?, ?, 'openstates', 'ocd-bill/x', 'https://ex', ?)`,
    ).run(
      "00000000-0000-0000-0000-000000000003",
      "2026-04-10T10:00:00.000Z",
      "2026-04-10T10:00:00.000Z",
      JSON.stringify({ actions: [] }),
    );
    const sql = readFileSync(
      "./src/core/migrations/003-occurred-at-from-actions.sql",
      "utf8",
    );
    store.db.exec(sql);
    const row = store.db.prepare(
      "SELECT occurred_at FROM documents WHERE source_id = 'ocd-bill/x'",
    ).get() as { occurred_at: string };
    expect(row.occurred_at).toBe("2026-04-10T10:00:00.000Z");  // unchanged
  });
});

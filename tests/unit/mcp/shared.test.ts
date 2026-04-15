import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/federal/seeds.js";
import { upsertDocument } from "../../../src/core/documents.js";
import { emptyFeedDiagnostic } from "../../../src/core/shared.js";

const TEST_DB = "./data/test-shared.db";
let store: Store;
beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});
afterEach(() => store.close());

describe("emptyFeedDiagnostic", () => {
  it("returns no_events_in_window when the jurisdiction has no documents at all", () => {
    const d = emptyFeedDiagnostic(store.db, { jurisdiction: "us-tx", kind: "bill" });
    expect(d.empty_reason).toBe("no_events_in_window");
    expect(d.data_freshness.last_refreshed_at).toBeNull();
    expect(d.data_freshness.source).toBeNull();
    expect(d.hint).toMatch(/stale_notice/);
  });

  it("returns no_events_in_window when rows exist but outside the window", () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "Old — B",
      occurred_at: "2024-01-01T00:00:00Z",
      source: { name: "openstates", id: "old", url: "https://ex" },
    });
    const d = emptyFeedDiagnostic(store.db, { jurisdiction: "us-tx", kind: "bill" });
    expect(d.empty_reason).toBe("no_events_in_window");
    // fetched_at is set by upsertDocument at write time → "today", not 2024.
    expect(d.data_freshness.last_refreshed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(d.data_freshness.source).toBe("openstates");
    expect(d.hint).toMatch(/refresh|session|window/);
  });

  it("returns unknown_jurisdiction when the jurisdiction is not seeded", () => {
    const d = emptyFeedDiagnostic(store.db, { jurisdiction: "us-zz", kind: "bill" });
    expect(d.empty_reason).toBe("unknown_jurisdiction");
  });

  it("returns no_events_in_window for jurisdiction '*' when any jurisdiction has data", () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "SB 1 — A",
      occurred_at: "2025-09-18T00:00:00Z",
      source: { name: "openstates", id: "tx-1", url: "https://ex" },
    });
    const d = emptyFeedDiagnostic(store.db, { jurisdiction: "*", kind: "bill" });
    expect(d.empty_reason).toBe("no_events_in_window");
    expect(d.data_freshness.source).toBe("openstates");
  });

  it("returns no_events_in_window for jurisdiction '*' when store is empty", () => {
    const d = emptyFeedDiagnostic(store.db, { jurisdiction: "*", kind: "bill" });
    expect(d.empty_reason).toBe("no_events_in_window");
    expect(d.data_freshness.last_refreshed_at).toBeNull();
    expect(d.hint).toMatch(/stale_notice/);
  });
});

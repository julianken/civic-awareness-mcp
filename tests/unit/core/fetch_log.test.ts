import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { bootstrap } from "../../../src/cli/bootstrap.js";
import { openStore } from "../../../src/core/store.js";
import { getFetchLog, upsertFetchLog, isFetchLogFresh } from "../../../src/core/fetch_log.js";

let db: Database.Database;

beforeEach(async () => {
  const dbPath = `/tmp/fetch-log-test-${Date.now()}-${Math.random()}.db`;
  await bootstrap({ dbPath });
  db = openStore(dbPath).db;
});

describe("fetch_log", () => {
  it("returns null for an unknown key", () => {
    const row = getFetchLog(db, "openstates", "/people", "abc123");
    expect(row).toBeNull();
  });

  it("upsert then get round-trips", () => {
    const now = new Date().toISOString();
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: "abc123",
      scope: "full",
      fetched_at: now,
      last_rowcount: 42,
    });
    const row = getFetchLog(db, "openstates", "/people", "abc123");
    expect(row).toEqual({
      source: "openstates",
      endpoint_path: "/people",
      args_hash: "abc123",
      scope: "full",
      fetched_at: now,
      last_rowcount: 42,
    });
  });

  it("upsert overwrites existing row", () => {
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: "abc123",
      scope: "recent",
      fetched_at: "2026-04-01T00:00:00.000Z",
      last_rowcount: 0,
    });
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: "abc123",
      scope: "full",
      fetched_at: "2026-04-14T00:00:00.000Z",
      last_rowcount: 100,
    });
    const row = getFetchLog(db, "openstates", "/people", "abc123");
    expect(row?.scope).toBe("full");
    expect(row?.last_rowcount).toBe(100);
  });

  it("isFetchLogFresh returns true when within TTL", () => {
    const now = Date.now();
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: "abc123",
      scope: "full",
      fetched_at: new Date(now - 30 * 60 * 1000).toISOString(), // 30 min ago
      last_rowcount: 1,
    });
    expect(isFetchLogFresh(db, "openstates", "/people", "abc123", 60 * 60 * 1000))
      .toBe(true);
  });

  it("isFetchLogFresh returns false when past TTL", () => {
    const now = Date.now();
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: "abc123",
      scope: "full",
      fetched_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
      last_rowcount: 1,
    });
    expect(isFetchLogFresh(db, "openstates", "/people", "abc123", 60 * 60 * 1000))
      .toBe(false);
  });

  it("isFetchLogFresh returns false when row is absent", () => {
    expect(isFetchLogFresh(db, "openstates", "/people", "unknown", 60 * 60 * 1000))
      .toBe(false);
  });
});

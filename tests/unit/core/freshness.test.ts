import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openStore } from "../../../src/core/store.js";
import {
  getFreshness,
  markFresh,
  isFresh,
  TTL_RECENT_MS,
  TTL_FULL_MS,
} from "../../../src/core/freshness.js";

let db: Database.Database;

beforeEach(() => {
  const store = openStore(":memory:");
  db = store.db;
});

describe("freshness", () => {
  it("returns null for unseen key", () => {
    const r = getFreshness(db, "openstates", "us-tx", "recent");
    expect(r).toBeNull();
  });

  it("markFresh → getFreshness round trip, status complete", () => {
    markFresh(db, "openstates", "us-tx", "recent", "complete");
    const r = getFreshness(db, "openstates", "us-tx", "recent");
    expect(r).toMatchObject({ status: "complete" });
    expect(r!.last_fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("isFresh true within TTL", () => {
    markFresh(db, "openstates", "us-tx", "recent", "complete");
    expect(isFresh(db, "openstates", "us-tx", "recent")).toBe(true);
  });

  it("isFresh false past TTL (recent=1h)", () => {
    const past = new Date(Date.now() - TTL_RECENT_MS - 1000).toISOString();
    db.prepare(
      "INSERT INTO hydrations (source, jurisdiction, scope, last_fetched_at, status) VALUES (?,?,?,?,?)",
    ).run("openstates", "us-tx", "recent", past, "complete");
    expect(isFresh(db, "openstates", "us-tx", "recent")).toBe(false);
  });

  it("isFresh false past TTL (full=24h)", () => {
    const past = new Date(Date.now() - TTL_FULL_MS - 1000).toISOString();
    db.prepare(
      "INSERT INTO hydrations (source, jurisdiction, scope, last_fetched_at, status) VALUES (?,?,?,?,?)",
    ).run("openstates", "us-tx", "full", past, "complete");
    expect(isFresh(db, "openstates", "us-tx", "full")).toBe(false);
  });

  it("markFresh overwrites prior row (upsert)", () => {
    markFresh(db, "openstates", "us-tx", "full", "partial");
    markFresh(db, "openstates", "us-tx", "full", "complete");
    const r = getFreshness(db, "openstates", "us-tx", "full");
    expect(r!.status).toBe("complete");
  });

  it("TTL constants are 1h recent / 24h full", () => {
    expect(TTL_RECENT_MS).toBe(60 * 60 * 1000);
    expect(TTL_FULL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

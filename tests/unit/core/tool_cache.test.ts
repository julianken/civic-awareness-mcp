import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { bootstrap } from "../../../src/cli/bootstrap.js";
import { openStore } from "../../../src/core/store.js";
import { hashArgs } from "../../../src/core/args_hash.js";
import { upsertFetchLog, getFetchLog } from "../../../src/core/fetch_log.js";
import {
  withShapedFetch,
  _resetToolCacheForTesting,
} from "../../../src/core/tool_cache.js";

let db: Database.Database;

beforeEach(async () => {
  _resetToolCacheForTesting();
  const dbPath = `/tmp/tool-cache-test-${Date.now()}-${Math.random()}.db`;
  await bootstrap({ dbPath });
  db = openStore(dbPath).db;
});

describe("withShapedFetch — TTL hit", () => {
  it("skips upstream when fetch_log row is fresh", async () => {
    const args = { name: "test" };
    const hash = hashArgs("__test__", args);
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: hash,
      scope: "full",
      fetched_at: new Date().toISOString(),
      last_rowcount: 5,
    });

    const fetchAndWrite = vi.fn(async () => ({ primary_rows_written: 0 }));
    const readLocal = vi.fn(() => ["cached-result"]);

    const result = await withShapedFetch(
      db,
      { source: "openstates", endpoint_path: "/people", args, tool: "__test__" },
      { scope: "full", ms: 24 * 60 * 60 * 1000 },
      fetchAndWrite,
      readLocal,
      () => 0,
    );

    expect(fetchAndWrite).not.toHaveBeenCalled();
    expect(readLocal).toHaveBeenCalledOnce();
    expect(result.value).toEqual(["cached-result"]);
    expect(result.stale_notice).toBeUndefined();
  });
});

describe("withShapedFetch — TTL miss", () => {
  it("calls fetchAndWrite on cache miss, updates fetch_log, returns readLocal", async () => {
    const fetchAndWrite = vi.fn(async () => ({ primary_rows_written: 7 }));
    const readLocal = vi.fn(() => ["fresh-result"]);

    const result = await withShapedFetch(
      db,
      { source: "openstates", endpoint_path: "/people", args: { name: "test" }, tool: "__test__" },
      { scope: "full", ms: 24 * 60 * 60 * 1000 },
      fetchAndWrite,
      readLocal,
      () => 0,
    );

    expect(fetchAndWrite).toHaveBeenCalledOnce();
    expect(readLocal).toHaveBeenCalledOnce();
    expect(result.value).toEqual(["fresh-result"]);
    expect(result.stale_notice).toBeUndefined();

    const logged = getFetchLog(
      db, "openstates", "/people",
      hashArgs("__test__", { name: "test" }),
    );
    expect(logged).not.toBeNull();
    expect(logged?.last_rowcount).toBe(7);
    expect(logged?.scope).toBe("full");
  });

  it("rolls back fetch_log if fetchAndWrite throws", async () => {
    const fetchAndWrite = vi.fn(async () => {
      throw new Error("upstream down");
    });
    const readLocal = vi.fn(() => [] as string[]);

    await expect(
      withShapedFetch(
        db,
        { source: "openstates", endpoint_path: "/people", args: { name: "test" }, tool: "__test__" },
        { scope: "full", ms: 24 * 60 * 60 * 1000 },
        fetchAndWrite,
        readLocal,
        () => 0,
      ),
    ).rejects.toThrow(/upstream down/);

    const logged = getFetchLog(
      db, "openstates", "/people",
      hashArgs("__test__", { name: "test" }),
    );
    expect(logged).toBeNull();
  });
});

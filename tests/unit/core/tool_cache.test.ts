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

describe("withShapedFetch — singleflight", () => {
  it("coalesces concurrent identical calls into one upstream fetch", async () => {
    let fetchCount = 0;
    let resolveFetch: (() => void) | null = null;
    const fetchAndWrite = async () => {
      fetchCount += 1;
      await new Promise<void>((resolve) => { resolveFetch = resolve; });
      return { primary_rows_written: 1 };
    };
    const readLocal = () => ["result"];

    const key = {
      source: "openstates" as const,
      endpoint_path: "/people",
      args: { name: "coalesce" },
      tool: "__test__",
    };
    const ttl = { scope: "full" as const, ms: 24 * 60 * 60 * 1000 };

    const p1 = withShapedFetch(db, key, ttl, fetchAndWrite, readLocal, () => 0);
    const p2 = withShapedFetch(db, key, ttl, fetchAndWrite, readLocal, () => 0);
    const p3 = withShapedFetch(db, key, ttl, fetchAndWrite, readLocal, () => 0);

    await new Promise((r) => setTimeout(r, 10));
    expect(fetchCount).toBe(1);

    resolveFetch!();
    const results = await Promise.all([p1, p2, p3]);

    expect(fetchCount).toBe(1);
    expect(results.map((r: { value: string[] }) => r.value)).toEqual([["result"], ["result"], ["result"]]);
  });

  it("different args do NOT coalesce", async () => {
    let fetchCount = 0;
    const fetchAndWrite = async () => {
      fetchCount += 1;
      return { primary_rows_written: 1 };
    };
    const readLocal = () => ["result"];
    const ttl = { scope: "full" as const, ms: 24 * 60 * 60 * 1000 };

    await Promise.all([
      withShapedFetch(
        db,
        { source: "openstates", endpoint_path: "/people", args: { name: "a" }, tool: "__test__" },
        ttl, fetchAndWrite, readLocal, () => 0,
      ),
      withShapedFetch(
        db,
        { source: "openstates", endpoint_path: "/people", args: { name: "b" }, tool: "__test__" },
        ttl, fetchAndWrite, readLocal, () => 0,
      ),
    ]);

    expect(fetchCount).toBe(2);
  });
});

describe("withShapedFetch — daily budget", () => {
  it("propagates budget-exhausted when no cached data exists", async () => {
    process.env.CIVIC_AWARENESS_DAILY_BUDGET = "openstates=0";
    _resetToolCacheForTesting();

    const fetchAndWrite = vi.fn(async () => ({ primary_rows_written: 1 }));
    const readLocal = vi.fn(() => [] as string[]);

    await expect(
      withShapedFetch(
        db,
        { source: "openstates", endpoint_path: "/people", args: { name: "x" }, tool: "__test__" },
        { scope: "full", ms: 24 * 60 * 60 * 1000 },
        fetchAndWrite,
        readLocal,
        () => 0,
      ),
    ).rejects.toThrow(/daily budget/i);

    expect(fetchAndWrite).not.toHaveBeenCalled();

    delete process.env.CIVIC_AWARENESS_DAILY_BUDGET;
    _resetToolCacheForTesting();
  });
});

describe("withShapedFetch — stale fallback", () => {
  it("returns stale cached value + stale_notice when upstream fails", async () => {
    const args = { name: "expired" };
    const hash = hashArgs("__test__", args);
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: hash,
      scope: "full",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 3,
    });

    const fetchAndWrite = vi.fn(async () => {
      throw new Error("network down");
    });
    const readLocal = vi.fn(() => ["stale-but-useful"]);

    const result = await withShapedFetch(
      db,
      { source: "openstates", endpoint_path: "/people", args, tool: "__test__" },
      { scope: "full", ms: 24 * 60 * 60 * 1000 },
      fetchAndWrite,
      readLocal,
      () => 0,
    );

    expect(fetchAndWrite).toHaveBeenCalledOnce();
    expect(readLocal).toHaveBeenCalledOnce();
    expect(result.value).toEqual(["stale-but-useful"]);
    expect(result.stale_notice).toBeDefined();
    expect(result.stale_notice?.reason).toBe("upstream_failure");
    expect(result.stale_notice?.message).toMatch(/network down/);
  });

  it("propagates upstream error when no cached data exists", async () => {
    const fetchAndWrite = vi.fn(async () => {
      throw new Error("network down");
    });
    const readLocal = vi.fn(() => [] as string[]);

    await expect(
      withShapedFetch(
        db,
        { source: "openstates", endpoint_path: "/people", args: { name: "cold" }, tool: "__test__" },
        { scope: "full", ms: 24 * 60 * 60 * 1000 },
        fetchAndWrite,
        readLocal,
        () => 0,
      ),
    ).rejects.toThrow(/network down/);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { bootstrap } from "../../../src/cli/bootstrap.js";
import { openStore } from "../../../src/core/store.js";
import { hashArgs } from "../../../src/core/args_hash.js";
import { upsertFetchLog } from "../../../src/core/fetch_log.js";
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

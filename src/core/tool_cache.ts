import type Database from "better-sqlite3";
import { hashArgs } from "./args_hash.js";
import { isFetchLogFresh } from "./fetch_log.js";
import type { FetchLogScope } from "./fetch_log.js";
import type { HydrationSource } from "./freshness.js";
import type { StaleNotice } from "../mcp/shared.js";

export interface ShapedFetchKey {
  source: HydrationSource;
  endpoint_path: string;
  args: unknown;
  tool: string;
}

export interface ShapedFetchTTL {
  scope: FetchLogScope;
  ms: number;
}

export interface ShapedFetchResult<T> {
  value: T;
  stale_notice?: StaleNotice;
}

export function _resetToolCacheForTesting(): void {
  // Subsequent tasks add singleflight + budget singletons; reset them here.
}

export async function withShapedFetch<T>(
  db: Database.Database,
  key: ShapedFetchKey,
  ttl: ShapedFetchTTL,
  _fetchAndWrite: () => Promise<{ primary_rows_written: number }>,
  readLocal: () => T,
  _peekWaitMs: () => number,
): Promise<ShapedFetchResult<T>> {
  const args_hash = hashArgs(key.tool, key.args);

  if (isFetchLogFresh(db, key.source, key.endpoint_path, args_hash, ttl.ms)) {
    return { value: readLocal() };
  }

  // Subsequent tasks implement the miss path + singleflight + budget +
  // transactional write-through + stale fallback. Throw until they land.
  throw new Error("withShapedFetch TTL-miss path not yet implemented");
}

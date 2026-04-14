import type Database from "better-sqlite3";
import { hashArgs } from "./args_hash.js";
import { DailyBudget } from "./budget.js";
import { getFetchLog, isFetchLogFresh, upsertFetchLog } from "./fetch_log.js";
import type { FetchLogScope } from "./fetch_log.js";
import type { HydrationSource } from "./freshness.js";
import { Singleflight } from "./singleflight.js";
import type { StaleNotice } from "../mcp/shared.js";
import { RATE_LIMIT_WAIT_THRESHOLD_MS } from "../util/http.js";

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

let sf = new Singleflight<ShapedFetchResult<unknown>>();
let txMutex: Promise<void> = Promise.resolve();
let budget = new DailyBudget(process.env.CIVIC_AWARENESS_DAILY_BUDGET);

export function _resetToolCacheForTesting(): void {
  sf = new Singleflight<ShapedFetchResult<unknown>>();
  txMutex = Promise.resolve();
  budget = new DailyBudget(process.env.CIVIC_AWARENESS_DAILY_BUDGET);
}

async function runInTransaction<R>(
  db: Database.Database,
  fn: () => Promise<R>,
): Promise<R> {
  const prev = txMutex;
  let release!: () => void;
  txMutex = new Promise<void>((r) => { release = r; });
  await prev;
  try {
    db.prepare("BEGIN IMMEDIATE").run();
    try {
      const result = await fn();
      db.prepare("COMMIT").run();
      return result;
    } catch (err) {
      db.prepare("ROLLBACK").run();
      throw err;
    }
  } finally {
    release();
  }
}

export async function withShapedFetch<T>(
  db: Database.Database,
  key: ShapedFetchKey,
  ttl: ShapedFetchTTL,
  fetchAndWrite: () => Promise<{ primary_rows_written: number }>,
  readLocal: () => T,
  peekWaitMs: () => number,
): Promise<ShapedFetchResult<T>> {
  const args_hash = hashArgs(key.tool, key.args);

  if (isFetchLogFresh(db, key.source, key.endpoint_path, args_hash, ttl.ms)) {
    return { value: readLocal() };
  }

  const singleflightKey = `${key.source}:${key.endpoint_path}:${args_hash}`;
  return (await sf.do(singleflightKey, async () => {
    if (isFetchLogFresh(db, key.source, key.endpoint_path, args_hash, ttl.ms)) {
      return { value: readLocal() } as ShapedFetchResult<unknown>;
    }
    try {
      const b = budget.check(key.source);
      if (!b.allowed) {
        throw new Error(`Daily budget for ${key.source} exhausted`);
      }
      const waitMs = peekWaitMs();
      if (waitMs > RATE_LIMIT_WAIT_THRESHOLD_MS) {
        throw new Error(
          `Rate limit for ${key.source} requires ${Math.ceil(waitMs / 1000)}s wait`,
        );
      }
      await runInTransaction(db, async () => {
        const result = await fetchAndWrite();
        upsertFetchLog(db, {
          source: key.source,
          endpoint_path: key.endpoint_path,
          args_hash,
          scope: ttl.scope,
          fetched_at: new Date().toISOString(),
          last_rowcount: result.primary_rows_written,
        });
        return result;
      });
      budget.record(key.source);
      return { value: readLocal() } as ShapedFetchResult<unknown>;
    } catch (err) {
      const prior = getFetchLog(db, key.source, key.endpoint_path, args_hash);
      if (prior) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          value: readLocal(),
          stale_notice: {
            as_of: prior.fetched_at,
            reason: "upstream_failure",
            message: `Upstream ${key.source} fetch failed; serving stale cached data. ${msg}`,
          },
        } as ShapedFetchResult<unknown>;
      }
      throw err;
    }
  })) as ShapedFetchResult<T>;
}

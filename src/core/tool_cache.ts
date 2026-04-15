import type Database from "better-sqlite3";
import { hashArgs } from "./args_hash.js";
import { DailyBudget } from "./budget.js";
import { getFetchLog, isFetchLogFresh, upsertFetchLog } from "./fetch_log.js";
import type { FetchLogScope } from "./fetch_log.js";
import type { HydrationSource } from "./sources.js";
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
let budget = new DailyBudget(process.env.CIVIC_AWARENESS_DAILY_BUDGET);

export function _resetToolCacheForTesting(): void {
  sf = new Singleflight<ShapedFetchResult<unknown>>();
  budget = new DailyBudget(process.env.CIVIC_AWARENESS_DAILY_BUDGET);
}

/**
 * R15 cache-gated upstream fetch. See
 * `docs/superpowers/specs/2026-04-14-shaped-query-hydration-design.md`.
 *
 * Flow: TTL fast-path → singleflight-gated miss path (double-check
 * TTL, daily budget, rate-limit peek, atomic write-through inside
 * a transaction, budget record). Upstream failures with a prior
 * `fetch_log` row fall back to stale cached data plus a
 * `stale_notice`; cold failures propagate the error.
 *
 * @param fetchAndWrite Async thunk that (1) issues the narrow
 *   upstream request and (2) upserts results into `documents` /
 *   `entities`. Each adapter write uses its own sync transaction
 *   internally. Returns `{ primary_rows_written }` telemetry
 *   stored in `fetch_log.last_rowcount`.
 * @param readLocal Sync thunk that SELECTs the tool's projection
 *   from the local store. Invoked after a successful fetch AND in
 *   the stale-fallback path — must tolerate empty-store state
 *   (return `[]` or similar) without throwing.
 * @param peekWaitMs Returns the source's current rate-limiter
 *   queue depth in ms (e.g. `getLimiter("openstates").peekWaitMs()`).
 *   If > `RATE_LIMIT_WAIT_THRESHOLD_MS` (2.5s), the fetch is
 *   skipped and the stale-fallback path runs.
 */
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
      const result = await fetchAndWrite();
      // upsertFetchLog is the only write that needs to be atomic with
      // itself (ON CONFLICT upsert); individual document/entity writes
      // inside fetchAndWrite each use their own sync db.transaction().
      db.transaction(() => {
        upsertFetchLog(db, {
          source: key.source,
          endpoint_path: key.endpoint_path,
          args_hash,
          scope: ttl.scope,
          fetched_at: new Date().toISOString(),
          last_rowcount: result.primary_rows_written,
        });
      })();
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

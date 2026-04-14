import type Database from "better-sqlite3";
import type { HydrationSource } from "./freshness.js";

export type FetchLogScope = "recent" | "full" | "detail";

export interface FetchLogRow {
  source: HydrationSource;
  endpoint_path: string;
  args_hash: string;
  scope: FetchLogScope;
  fetched_at: string;
  last_rowcount: number;
}

export function getFetchLog(
  db: Database.Database,
  source: HydrationSource,
  endpoint_path: string,
  args_hash: string,
): FetchLogRow | null {
  const row = db
    .prepare(
      `SELECT source, endpoint_path, args_hash, scope, fetched_at, last_rowcount
         FROM fetch_log
         WHERE source = ? AND endpoint_path = ? AND args_hash = ?`,
    )
    .get(source, endpoint_path, args_hash) as FetchLogRow | undefined;
  return row ?? null;
}

export function upsertFetchLog(db: Database.Database, row: FetchLogRow): void {
  db.prepare(
    `INSERT INTO fetch_log
       (source, endpoint_path, args_hash, scope, fetched_at, last_rowcount)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, endpoint_path, args_hash) DO UPDATE SET
       scope = excluded.scope,
       fetched_at = excluded.fetched_at,
       last_rowcount = excluded.last_rowcount`,
  ).run(
    row.source,
    row.endpoint_path,
    row.args_hash,
    row.scope,
    row.fetched_at,
    row.last_rowcount,
  );
}

export function isFetchLogFresh(
  db: Database.Database,
  source: HydrationSource,
  endpoint_path: string,
  args_hash: string,
  ttlMs: number,
): boolean {
  const row = getFetchLog(db, source, endpoint_path, args_hash);
  if (!row) return false;
  const ageMs = Date.now() - Date.parse(row.fetched_at);
  return ageMs < ttlMs;
}

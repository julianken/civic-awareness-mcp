import type Database from "better-sqlite3";

export type HydrationScope = "recent" | "full";
export type HydrationStatus = "complete" | "partial";
export type HydrationSource = "openstates" | "congress" | "openfec";

export const TTL_RECENT_MS = 60 * 60 * 1000;
export const TTL_FULL_MS = 24 * 60 * 60 * 1000;

export interface FreshnessRecord {
  source: HydrationSource;
  jurisdiction: string;
  scope: HydrationScope;
  last_fetched_at: string;
  status: HydrationStatus;
}

export function getFreshness(
  db: Database.Database,
  source: HydrationSource,
  jurisdiction: string,
  scope: HydrationScope,
): FreshnessRecord | null {
  const row = db
    .prepare(
      `SELECT source, jurisdiction, scope, last_fetched_at, status
         FROM hydrations
         WHERE source = ? AND jurisdiction = ? AND scope = ?`,
    )
    .get(source, jurisdiction, scope) as FreshnessRecord | undefined;
  return row ?? null;
}

export function markFresh(
  db: Database.Database,
  source: HydrationSource,
  jurisdiction: string,
  scope: HydrationScope,
  status: HydrationStatus,
): void {
  db.prepare(
    `INSERT INTO hydrations (source, jurisdiction, scope, last_fetched_at, status)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source, jurisdiction, scope) DO UPDATE SET
         last_fetched_at = excluded.last_fetched_at,
         status = excluded.status`,
  ).run(source, jurisdiction, scope, new Date().toISOString(), status);
}

export function isFresh(
  db: Database.Database,
  source: HydrationSource,
  jurisdiction: string,
  scope: HydrationScope,
): boolean {
  const rec = getFreshness(db, source, jurisdiction, scope);
  if (!rec) return false;
  const ageMs = Date.now() - new Date(rec.last_fetched_at).getTime();
  const ttl = scope === "recent" ? TTL_RECENT_MS : TTL_FULL_MS;
  return ageMs < ttl;
}

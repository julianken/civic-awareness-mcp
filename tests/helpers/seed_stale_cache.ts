import type Database from "better-sqlite3";
import { upsertDocument } from "../../src/core/documents.js";
import { upsertFetchLog } from "../../src/core/fetch_log.js";
import { hashArgs } from "../../src/core/args_hash.js";
import type { FetchLogScope } from "../../src/core/fetch_log.js";
import type { HydrationSource } from "../../src/core/freshness.js";

export interface SeedStaleCacheInput {
  db: Database.Database;
  source: HydrationSource;
  endpoint_path: string;
  scope: FetchLogScope;
  tool: string;
  args: unknown;
  stale_age_ms?: number; // default 48h
  documents?: Parameters<typeof upsertDocument>[1][];
}

export function seedStaleCache(input: SeedStaleCacheInput): void {
  const ageMs = input.stale_age_ms ?? 48 * 60 * 60 * 1000;
  upsertFetchLog(input.db, {
    source: input.source,
    endpoint_path: input.endpoint_path,
    args_hash: hashArgs(input.tool, input.args),
    scope: input.scope,
    fetched_at: new Date(Date.now() - ageMs).toISOString(),
    last_rowcount: input.documents?.length ?? 0,
  });
  for (const d of input.documents ?? []) upsertDocument(input.db, d);
}

import type Database from "better-sqlite3";
import { OpenStatesAdapter } from "./adapters/openstates.js";
import { requireEnv } from "../util/env.js";
import { logger } from "../util/logger.js";
import { getLimiter } from "./limiters.js";

export type RefreshSource = "openstates";

export interface RefreshSourceOptions {
  source: RefreshSource;
  maxPages?: number;
  jurisdictions?: string[];
  deadline?: number;
}

export interface RefreshSourceResult {
  source: RefreshSource;
  entitiesUpserted: number;
  documentsUpserted: number;
  errors: string[];
  jurisdictionsProcessed?: string[];
}

export async function refreshSource(
  db: Database.Database,
  opts: RefreshSourceOptions,
): Promise<RefreshSourceResult> {
  if (opts.source === "openstates") {
    const adapter = new OpenStatesAdapter({ apiKey: requireEnv("OPENSTATES_API_KEY"), rateLimiter: getLimiter("openstates") });
    const targets = opts.jurisdictions ?? listStateJurisdictions(db);
    let entities = 0;
    let documents = 0;
    const errors: string[] = [];
    for (const state of targets) {
      logger.info("refreshing state", { state });
      const r = await adapter.refresh({ db, maxPages: opts.maxPages, deadline: opts.deadline, jurisdiction: state });
      entities += r.entitiesUpserted;
      documents += r.documentsUpserted;
      for (const err of r.errors) errors.push(`${state}: ${err}`);
    }
    return {
      source: "openstates",
      entitiesUpserted: entities,
      documentsUpserted: documents,
      errors,
      jurisdictionsProcessed: targets,
    };
  }
  throw new Error(
    `unknown source: ${String(opts.source)}; valid values: openstates`,
  );
}

function listStateJurisdictions(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT id FROM jurisdictions WHERE level = 'state' ORDER BY id")
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id.replace(/^us-/, ""));
}

import type Database from "better-sqlite3";
import { refreshSource } from "../../core/refresh.js";
import { RefreshSourceInput } from "../schemas.js";

export interface RefreshSourceResponse {
  source: string;
  entities_upserted: number;
  documents_upserted: number;
  errors: string[];
  jurisdictions_processed?: string[];
}

export async function handleRefreshSource(
  db: Database.Database,
  rawInput: unknown,
): Promise<RefreshSourceResponse> {
  const input = RefreshSourceInput.parse(rawInput);
  const result = await refreshSource(db, {
    source: input.source,
    jurisdictions: input.jurisdictions,
    maxPages: input.max_pages,
  });
  return {
    source: result.source,
    entities_upserted: result.entitiesUpserted,
    documents_upserted: result.documentsUpserted,
    errors: result.errors,
    jurisdictions_processed: result.jurisdictionsProcessed,
  };
}

import type Database from "better-sqlite3";

export interface RefreshResult {
  source: string;
  entitiesUpserted: number;
  documentsUpserted: number;
  errors: string[];
}

export interface AdapterOptions {
  db: Database.Database;
  /** Limit on results fetched — useful for dev/testing. */
  maxPages?: number;
  /**
   * Jurisdiction to refresh. Required by per-jurisdiction adapters
   * (e.g., OpenStates iterates one state per call); optional for
   * single-jurisdiction adapters (Congress.gov is always
   * `us-federal`; OpenFEC is always federal campaign finance).
   */
  jurisdiction?: string;
}

export interface Adapter {
  readonly name: string;
  refresh(opts: AdapterOptions): Promise<RefreshResult>;
}

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
  /**
   * Wall-clock deadline in epoch ms. When Date.now() >= deadline, the
   * adapter stops paginating before the next fetch and returns what
   * it has accumulated so far. Used by hydrateFull to cap per-entity
   * hydration time.
   */
  deadline?: number;
}

export interface Adapter {
  readonly name: string;
  refresh(opts: AdapterOptions): Promise<RefreshResult>;
}

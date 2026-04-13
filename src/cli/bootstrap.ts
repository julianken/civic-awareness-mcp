import { openStore } from "../core/store.js";
import { seedJurisdictions } from "../core/seeds.js";
import { logger } from "../util/logger.js";

export interface BootstrapOptions { dbPath: string }

export async function bootstrap(opts: BootstrapOptions): Promise<void> {
  logger.info("bootstrapping store", { dbPath: opts.dbPath });
  const store = openStore(opts.dbPath);
  seedJurisdictions(store.db);
  store.close();
  logger.info("bootstrap complete");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.CIVIC_AWARENESS_DB_PATH ?? "./data/civic-awareness.db";
  bootstrap({ dbPath }).catch((err) => {
    logger.error("bootstrap failed", { error: String(err) });
    process.exit(1);
  });
}

import { fileURLToPath } from "node:url";
import { openStore } from "../../core/store.js";
import { seedJurisdictions } from "../seeds.js";
import { logger } from "../../util/logger.js";

const coreSqlPath = fileURLToPath(new URL("../../core/schema.sql", import.meta.url));
const stateSqlPath = fileURLToPath(new URL("../schema.sql", import.meta.url));

export interface BootstrapOptions { dbPath: string }

export async function bootstrap(opts: BootstrapOptions): Promise<void> {
  logger.info("bootstrapping state store", { dbPath: opts.dbPath });
  const store = openStore(opts.dbPath, coreSqlPath, stateSqlPath);
  seedJurisdictions(store.db);
  store.close();
  logger.info("bootstrap complete");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.CIVIC_STATE_DB_PATH ?? "./data/state.db";
  bootstrap({ dbPath }).catch((err) => {
    logger.error("bootstrap failed", { error: String(err) });
    process.exit(1);
  });
}

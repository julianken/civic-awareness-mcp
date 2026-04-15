#!/usr/bin/env node
import { openStore } from "../core/store.js";
import { evictStaleFetchLogRows } from "../core/fetch_log.js";
import { loadProjectEnvDefaults } from "../util/env-file.js";
import { optionalEnv } from "../util/env.js";
import { logger } from "../util/logger.js";

interface Args {
  olderThanDays: number;
}

function parseArgs(argv: string[]): Args {
  let olderThanDays = 30;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = inlineValue ?? argv[i + 1];

    if (flag === "--older-than-days") {
      olderThanDays = parseInt(value, 10);
      if (inlineValue === undefined) i++;
    } else if (flag.startsWith("--")) {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (Number.isNaN(olderThanDays) || olderThanDays < 1) {
    throw new Error("--older-than-days must be a positive integer");
  }
  return { olderThanDays };
}

function main(): void {
  const { olderThanDays } = parseArgs(process.argv.slice(2));
  const dbPath = optionalEnv("CIVIC_AWARENESS_DB_PATH", "./data/civic-awareness.db");
  const store = openStore(dbPath);
  try {
    const { evictedCount } = evictStaleFetchLogRows(store.db, { olderThanDays });
    logger.info("fetch_log eviction complete", { olderThanDays, evictedCount });
    process.stdout.write(
      `Evicted ${evictedCount} fetch_log row(s) older than ${olderThanDays}d.\n`,
    );
  } finally {
    store.close();
  }
}

loadProjectEnvDefaults(import.meta.url);
try {
  main();
} catch (err) {
  logger.error("evict-fetch-log failed", { error: String(err) });
  process.exit(1);
}

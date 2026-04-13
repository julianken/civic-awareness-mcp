import { openStore } from "../core/store.js";
import { seedJurisdictions } from "../core/seeds.js";
import { refreshSource, type RefreshSource } from "../core/refresh.js";
import { optionalEnv } from "../util/env.js";
import { logger } from "../util/logger.js";

interface Args {
  source: string;
  maxPages?: number;
  jurisdictions?: string[];
}

function parseArgs(argv: string[]): Args {
  let source = "openstates";
  let maxPages: number | undefined;
  let jurisdictions: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) source = argv[++i];
    else if (argv[i].startsWith("--source=")) source = argv[i].slice("--source=".length);
    else if (argv[i] === "--max-pages" && argv[i + 1]) maxPages = parseInt(argv[++i], 10);
    else if (argv[i].startsWith("--max-pages=")) maxPages = parseInt(argv[i].slice("--max-pages=".length), 10);
    else if (argv[i] === "--jurisdictions" && argv[i + 1]) {
      jurisdictions = argv[++i].split(",").map((s) => s.trim().toLowerCase());
    } else if (argv[i].startsWith("--jurisdictions=")) {
      jurisdictions = argv[i]
        .slice("--jurisdictions=".length)
        .split(",")
        .map((s) => s.trim().toLowerCase());
    }
  }
  return { source, maxPages, jurisdictions };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = optionalEnv("CIVIC_AWARENESS_DB_PATH", "./data/civic-awareness.db");
  const store = openStore(dbPath);
  seedJurisdictions(store.db);

  if (args.source !== "openstates" && args.source !== "congress" && args.source !== "openfec") {
    logger.error("unknown source; valid values: openstates, congress, openfec", {
      source: args.source,
    });
    process.exit(1);
  }

  const result = await refreshSource(store.db, {
    source: args.source as RefreshSource,
    maxPages: args.maxPages,
    jurisdictions: args.jurisdictions,
  });

  logger.info("refresh complete", {
    source: result.source,
    entitiesUpserted: result.entitiesUpserted,
    documentsUpserted: result.documentsUpserted,
    errorCount: result.errors.length,
    jurisdictionsProcessed: result.jurisdictionsProcessed,
  });
  if (result.errors.length > 0) {
    logger.error("refresh had errors", { errors: result.errors });
  }

  store.close();
}

main().catch((err) => {
  logger.error("refresh failed", { error: String(err) });
  process.exit(1);
});

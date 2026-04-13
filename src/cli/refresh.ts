import { openStore } from "../core/store.js";
import { seedJurisdictions } from "../core/seeds.js";
import { OpenStatesAdapter } from "../adapters/openstates.js";
import { CongressAdapter } from "../adapters/congress.js";
import { OpenFecAdapter } from "../adapters/openfec.js";
import { requireEnv, optionalEnv } from "../util/env.js";
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

function listStateJurisdictions(db: import("better-sqlite3").Database): string[] {
  const rows = db
    .prepare("SELECT id FROM jurisdictions WHERE level = 'state' ORDER BY id")
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id.replace(/^us-/, ""));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = optionalEnv("CIVIC_AWARENESS_DB_PATH", "./data/civic-awareness.db");
  const store = openStore(dbPath);
  seedJurisdictions(store.db);

  if (args.source === "openfec") {
    const adapter = new OpenFecAdapter({
      apiKey: requireEnv("API_DATA_GOV_KEY"),
    });
    logger.info("refreshing source", { source: "openfec" });
    const result = await adapter.refresh({ db: store.db, maxPages: args.maxPages });
    logger.info("refresh complete", {
      source: result.source,
      entitiesUpserted: result.entitiesUpserted,
      documentsUpserted: result.documentsUpserted,
      errorCount: result.errors.length,
    });
    if (result.errors.length > 0) {
      logger.error("openfec refresh had errors", { errors: result.errors });
    }
  } else if (args.source === "congress") {
    const adapter = new CongressAdapter({
      apiKey: requireEnv("API_DATA_GOV_KEY"),
    });
    logger.info("refreshing source", { source: "congress" });
    const result = await adapter.refresh({ db: store.db, maxPages: args.maxPages });
    logger.info("refresh complete", {
      source: result.source,
      entitiesUpserted: result.entitiesUpserted,
      documentsUpserted: result.documentsUpserted,
      errorCount: result.errors.length,
    });
    if (result.errors.length > 0) {
      logger.error("congress refresh had errors", { errors: result.errors });
    }
  } else if (args.source === "openstates") {
    const adapter = new OpenStatesAdapter({ apiKey: requireEnv("OPENSTATES_API_KEY") });
    const targets = args.jurisdictions ?? listStateJurisdictions(store.db);
    for (const state of targets) {
      logger.info("refreshing state", { state });
      const result = await adapter.refresh({
        db: store.db,
        maxPages: args.maxPages,
        jurisdiction: state,
      });
      logger.info("state refresh complete", {
        source: result.source,
        entitiesUpserted: result.entitiesUpserted,
        documentsUpserted: result.documentsUpserted,
        errorCount: result.errors.length,
      });
      if (result.errors.length > 0) {
        logger.error("state had errors", { state, errors: result.errors });
      }
    }
  } else {
    logger.error("unknown source; valid values: openstates, congress, openfec", {
      source: args.source,
    });
    process.exit(1);
  }

  store.close();
}

main().catch((err) => {
  logger.error("refresh failed", { error: String(err) });
  process.exit(1);
});

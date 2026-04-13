import { openStore } from "../core/store.js";
import { seedJurisdictions } from "../core/seeds.js";
import { OpenStatesAdapter } from "../adapters/openstates.js";
import { requireEnv, optionalEnv } from "../util/env.js";
import { logger } from "../util/logger.js";

interface Args {
  source: string;
  maxPages?: number;
  /** Comma-separated state codes (e.g. "tx,ca"). If omitted, iterate
   *  all state jurisdictions from the jurisdictions table. */
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
    else if (argv[i] === "--jurisdictions" && argv[i + 1]) {
      jurisdictions = argv[++i].split(",").map((s) => s.trim().toLowerCase());
    } else if (argv[i].startsWith("--jurisdictions=")) {
      jurisdictions = argv[i].slice("--jurisdictions=".length)
        .split(",").map((s) => s.trim().toLowerCase());
    }
  }
  return { source, maxPages, jurisdictions };
}

function listStateJurisdictions(db: import("better-sqlite3").Database): string[] {
  // "us-tx" → "tx", filter to state-level only.
  const rows = db.prepare(
    "SELECT id FROM jurisdictions WHERE level = 'state' ORDER BY id",
  ).all() as Array<{ id: string }>;
  return rows.map((r) => r.id.replace(/^us-/, ""));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = optionalEnv("CIVIC_AWARENESS_DB_PATH", "./data/civic-awareness.db");
  const store = openStore(dbPath);
  seedJurisdictions(store.db);

  if (args.source !== "openstates") {
    logger.error("unknown source", { source: args.source });
    process.exit(1);
  }

  const adapter = new OpenStatesAdapter({ apiKey: requireEnv("OPENSTATES_API_KEY") });
  const targets = args.jurisdictions ?? listStateJurisdictions(store.db);
  // NOTE: OpenStates free tier is 500 requests/day. A full 50-state
  // cold refresh exceeds that. For free-tier users this loop must be
  // invoked with a subset (`--jurisdictions=tx,ca,...`) or repeated
  // across days; a future enhancement should persist progress in the
  // DB so subsequent runs skip states that already completed today.
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
  store.close();
}

main().catch((err) => {
  logger.error("refresh failed", { error: String(err) });
  process.exit(1);
});

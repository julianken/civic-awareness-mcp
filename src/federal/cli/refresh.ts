import { fileURLToPath } from "node:url";
import { openStore } from "../../core/store.js";
import { seedJurisdictions } from "../seeds.js";
import { refreshSource, type RefreshSource } from "../refresh.js";
import { loadProjectEnvDefaults } from "../../util/env-file.js";
import { optionalEnv } from "../../util/env.js";
import { logger } from "../../util/logger.js";

const coreSqlPath = fileURLToPath(new URL("../../core/schema.sql", import.meta.url));
const federalSqlPath = fileURLToPath(new URL("../schema.sql", import.meta.url));

interface Args {
  source: string;
  maxPages?: number;
  jurisdictions?: string[];
}

function normalizeJurisdictions(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^us-/, ""))
    .filter((s) => s.length > 0);
}

function parseArgs(argv: string[]): Args {
  let source = "congress";
  let maxPages: number | undefined;
  let jurisdictions: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = inlineValue ?? argv[i + 1];

    if (flag === "--source") {
      source = value;
      if (inlineValue === undefined) i++;
    } else if (flag === "--max-pages") {
      maxPages = parseInt(value, 10);
      if (inlineValue === undefined) i++;
    } else if (flag === "--jurisdictions" || flag === "--jurisdiction") {
      jurisdictions = normalizeJurisdictions(value);
      if (inlineValue === undefined) i++;
    } else if (flag.startsWith("--")) {
      rejectUnknownFlag(flag);
    }
  }
  return { source, maxPages, jurisdictions };
}

function rejectUnknownFlag(flag: string): never {
  throw new Error(`unknown flag: ${flag}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = optionalEnv("CIVIC_FEDERAL_DB_PATH", "./data/federal.db");
  const store = openStore(dbPath, coreSqlPath, federalSqlPath);
  seedJurisdictions(store.db);

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

loadProjectEnvDefaults(import.meta.url);
main().catch((err) => {
  logger.error("refresh failed", { error: String(err) });
  process.exit(1);
});

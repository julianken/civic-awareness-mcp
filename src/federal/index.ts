#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./cli/bootstrap.js";
import { openStore } from "../core/store.js";
import { loadProjectEnvDefaults } from "../util/env-file.js";
import { logger } from "../util/logger.js";

const coreSqlPath = fileURLToPath(new URL("../core/schema.sql", import.meta.url));
const federalSqlPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

const DB_PATH = process.env.CIVIC_FEDERAL_DB_PATH ?? "./data/federal.db";

// Runs on every server start before the stdio transport connects.
// Must remain fast (schema + jurisdiction seed only, no network) so
// Claude Desktop's MCP handshake does not time out.
export async function autoBootstrapIfNeeded(dbPath: string): Promise<void> {
  if (!existsSync(dbPath)) {
    logger.info("database file missing — auto-bootstrapping", { dbPath });
    await bootstrap({ dbPath });
    return;
  }
  const store = openStore(dbPath, coreSqlPath, federalSqlPath);
  const row = store.db
    .prepare("SELECT COUNT(*) AS n FROM jurisdictions")
    .get() as { n: number };
  store.close();
  if (row.n === 0) {
    logger.info("jurisdictions table empty — auto-bootstrapping", { dbPath });
    await bootstrap({ dbPath });
  }
}

async function main(): Promise<void> {
  logger.info("starting civic-federal-mcp", { dbPath: DB_PATH });
  await autoBootstrapIfNeeded(DB_PATH);
  const { mcp } = buildServer({ dbPath: DB_PATH });
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info("ready");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadProjectEnvDefaults(import.meta.url);
  main().catch((err) => {
    logger.error("fatal", { error: String(err) });
    process.exit(1);
  });
}

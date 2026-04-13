#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./mcp/server.js";
import { logger } from "./util/logger.js";

const DB_PATH = process.env.CIVIC_AWARENESS_DB_PATH ?? "./data/civic-awareness.db";

async function main(): Promise<void> {
  logger.info("starting civic-awareness-mcp", { dbPath: DB_PATH });
  const { mcp } = buildServer({ dbPath: DB_PATH });
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info("ready");
}

main().catch((err) => {
  logger.error("fatal", { error: String(err) });
  process.exit(1);
});

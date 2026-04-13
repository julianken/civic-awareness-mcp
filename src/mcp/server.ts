import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openStore, type Store } from "../core/store.js";

export interface BuildServerOptions { dbPath: string }
export interface CivicAwarenessServer { mcp: McpServer; store: Store }

export function buildServer(opts: BuildServerOptions): CivicAwarenessServer {
  const store = openStore(opts.dbPath);
  const mcp = new McpServer(
    { name: "civic-awareness-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  // Phase 2 registers tools here.
  return { mcp, store };
}

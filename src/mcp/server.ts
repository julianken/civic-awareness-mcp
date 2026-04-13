import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openStore, type Store } from "../core/store.js";
import { handleRecentBills } from "./tools/recent_bills.js";
import { handleSearchEntities } from "./tools/search_entities.js";
import { handleGetEntity } from "./tools/get_entity.js";
import { RecentBillsInput, SearchEntitiesInput, GetEntityInput } from "./schemas.js";

export interface BuildServerOptions { dbPath: string }
export interface CivicAwarenessServer { mcp: McpServer; store: Store }

export function buildServer(opts: BuildServerOptions): CivicAwarenessServer {
  const store = openStore(opts.dbPath);
  const mcp = new McpServer(
    { name: "civic-awareness-mcp", version: "0.0.2" },
    { capabilities: { tools: {} } },
  );

  mcp.registerTool(
    "recent_bills",
    {
      description:
        "List recently-updated U.S. state legislative bills for a given state, with sponsors. " +
        'Jurisdiction is required — pass e.g. "us-tx" or "us-ca".',
      inputSchema: RecentBillsInput.shape,
    },
    async (input) => {
      const data = await handleRecentBills(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "search_entities",
    {
      description:
        "Search for people or organizations by name across all U.S. state legislatures.",
      inputSchema: SearchEntitiesInput.shape,
    },
    async (input) => {
      const data = await handleSearchEntities(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "get_entity",
    {
      description:
        "Fetch a single entity by ID with recent related documents. " +
        "For Persons, returns the cross-jurisdiction roles[] history.",
      inputSchema: GetEntityInput.shape,
    },
    async (input) => {
      const data = await handleGetEntity(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  return { mcp, store };
}

import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openStore, type Store } from "../core/store.js";
import { handleRecentBills } from "./tools/recent_bills.js";
import { handleGetBill } from "./tools/get_bill.js";
import { handleListBills } from "./tools/list_bills.js";
import { handleSearchDocuments } from "./tools/search_civic_documents.js";
import { handleSearchEntities } from "./tools/search_entities.js";
import { handleResolvePerson } from "./tools/resolve_person.js";
import { handleGetEntity } from "./tools/get_entity.js";
import { handleEntityConnections } from "./tools/entity_connections.js";
import { handleRecentVotes } from "./tools/recent_votes.js";
import {
  RecentBillsInput,
  GetBillInput,
  ListBillsInput,
  SearchDocumentsInput,
  SearchEntitiesInput,
  ResolvePersonInput,
  GetEntityInput,
  EntityConnectionsInput,
  RecentVotesInput,
} from "./schemas.js";

const coreSqlPath = fileURLToPath(new URL("../core/schema.sql", import.meta.url));
const stateSqlPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

export interface BuildServerOptions { dbPath: string }
export interface CivicStateServer { mcp: McpServer; store: Store }

export function buildServer(opts: BuildServerOptions): CivicStateServer {
  const store = openStore(opts.dbPath, coreSqlPath, stateSqlPath);
  const mcp = new McpServer(
    { name: "civic-state-mcp", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  mcp.registerTool(
    "recent_bills",
    {
      description:
        "List recently-updated U.S. state legislative bills from OpenStates. " +
        "Pass a jurisdiction like 'us-tx' or 'us-ca'. Use '*' to query all cached jurisdictions locally.",
      inputSchema: RecentBillsInput.shape,
    },
    async (input) => {
      const data = await handleRecentBills(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "get_bill",
    {
      description:
        "Fetch full detail for a single state bill including actions, versions, " +
        "sponsors, and subjects. Requires jurisdiction, session, and identifier.",
      inputSchema: GetBillInput.shape,
    },
    async (input) => {
      const data = await handleGetBill(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "list_bills",
    {
      description:
        "List state bills with structured filters: session, chamber, sponsor, " +
        "classification, subject, date ranges. Backed by OpenStates.",
      inputSchema: ListBillsInput.shape,
    },
    async (input) => {
      const data = await handleListBills(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "search_civic_documents",
    {
      description:
        "Search state civic documents (bills) by title. " +
        "Optionally filter by jurisdiction, kind, source, or date range.",
      inputSchema: SearchDocumentsInput.shape,
    },
    async (input) => {
      const data = await handleSearchDocuments(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "search_entities",
    {
      description:
        "Search for people or organizations by name across state legislatures (OpenStates). " +
        "Pass a jurisdiction to trigger upstream hydration.",
      inputSchema: SearchEntitiesInput.shape,
    },
    async (input) => {
      const data = await handleSearchEntities(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "resolve_person",
    {
      description:
        "Disambiguate a person by name across state legislators. Returns all matching " +
        "Person entities with confidence tiers. Supply jurisdiction_hint to trigger " +
        "upstream OpenStates hydration.",
      inputSchema: ResolvePersonInput.shape,
    },
    async (input) => {
      const data = await handleResolvePerson(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "get_entity",
    {
      description:
        "Fetch a single entity by ID with recent related documents. " +
        "For state Persons, returns the cross-jurisdiction roles[] history.",
      inputSchema: GetEntityInput.shape,
    },
    async (input) => {
      const data = await handleGetEntity(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "entity_connections",
    {
      description:
        "Given an entity ID, return co-occurrence edges to other entities via " +
        "shared state bills. Supports depth=1 (direct) or depth=2 (through one hop). " +
        "Edges are capped at 100 and sorted by co_occurrence_count descending.",
      inputSchema: EntityConnectionsInput.shape,
    },
    async (input) => {
      const data = await handleEntityConnections(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "recent_votes",
    {
      description:
        "List recent roll-call votes from state legislatures via OpenStates. " +
        "Pass a jurisdiction like 'us-tx' or 'us-ca'. Votes are sourced from " +
        "recently-updated bills with embedded vote data. Use '*' to query all cached jurisdictions locally.",
      inputSchema: RecentVotesInput.shape,
    },
    async (input) => {
      const data = await handleRecentVotes(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  return { mcp, store };
}

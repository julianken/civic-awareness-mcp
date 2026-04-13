import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openStore, type Store } from "../core/store.js";
import { handleRecentBills } from "./tools/recent_bills.js";
import { handleRecentVotes } from "./tools/recent_votes.js";
import { handleRecentContributions } from "./tools/recent_contributions.js";
import { handleSearchEntities } from "./tools/search_entities.js";
import { handleGetEntity } from "./tools/get_entity.js";
import { handleSearchDocuments } from "./tools/search_civic_documents.js";
import { handleEntityConnections } from "./tools/entity_connections.js";
import { handleResolvePerson } from "./tools/resolve_person.js";
import { handleRefreshSource } from "./tools/refresh_source.js";
import {
  RecentBillsInput,
  RecentVotesInput,
  RecentContributionsInput,
  SearchEntitiesInput,
  GetEntityInput,
  SearchDocumentsInput,
  EntityConnectionsInput,
  ResolvePersonInput,
  RefreshSourceInput,
} from "./schemas.js";

export interface BuildServerOptions { dbPath: string }
export interface CivicAwarenessServer { mcp: McpServer; store: Store }

export function buildServer(opts: BuildServerOptions): CivicAwarenessServer {
  const store = openStore(opts.dbPath);
  const mcp = new McpServer(
    { name: "civic-awareness-mcp", version: "0.0.6" },
    { capabilities: { tools: {} } },
  );

  mcp.registerTool(
    "recent_bills",
    {
      description:
        "List recently-updated legislative bills. Jurisdiction is required — " +
        'pass "us-federal" for Congress.gov bills, or "us-<state>" (e.g. "us-tx") ' +
        "for OpenStates state bills.",
      inputSchema: RecentBillsInput.shape,
    },
    async (input) => {
      const data = await handleRecentBills(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "recent_votes",
    {
      description:
        "List recent roll-call votes for a jurisdiction. Jurisdiction is required — " +
        'pass "us-federal" for congressional votes. ' +
        "Optionally filter by chamber (upper=Senate, lower=House) or bill identifier.",
      inputSchema: RecentVotesInput.shape,
    },
    async (input) => {
      const data = await handleRecentVotes(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "recent_contributions",
    {
      description:
        "List itemized federal campaign contributions from OpenFEC. " +
        "A date window (from/to ISO datetimes) is required. " +
        "Optionally filter by candidate or committee name and minimum amount. " +
        "Contributor addresses and employer information are never exposed.",
      inputSchema: RecentContributionsInput.shape,
    },
    async (input) => {
      const data = await handleRecentContributions(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "search_entities",
    {
      description:
        "Search for people or organizations by name across all ingested jurisdictions " +
        "(U.S. state legislatures, federal Congress, and federal campaign committees).",
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
        "For Persons, returns the cross-jurisdiction roles[] history spanning " +
        "state and federal offices and campaign candidacies.",
      inputSchema: GetEntityInput.shape,
    },
    async (input) => {
      const data = await handleGetEntity(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "search_civic_documents",
    {
      description:
        "Search civic documents (U.S. state and federal bills, votes, and " +
        "federal campaign contributions) by title across all ingested jurisdictions.",
      inputSchema: SearchDocumentsInput.shape,
    },
    async (input) => {
      const data = await handleSearchDocuments(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "entity_connections",
    {
      description:
        "Given an entity ID, return co-occurrence edges to other entities via " +
        "shared documents (bills, votes, contributions). Supports depth=1 (direct) " +
        "or depth=2 (through one hop). Edges are capped at 100 and sorted by " +
        "co_occurrence_count descending; truncated flag signals whether the cap " +
        "was hit. Useful for 'who works with this legislator most' queries.",
      inputSchema: EntityConnectionsInput.shape,
    },
    async (input) => {
      const data = await handleEntityConnections(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "resolve_person",
    {
      description:
        "Disambiguate a person by name. Returns all matching Person entities " +
        "with confidence tiers (exact > alias > fuzzy) and disambiguators " +
        "(role + jurisdiction + time span per role). Optional jurisdiction_hint " +
        "and role_hint activate fuzzy matching — without a hint, fuzzy matches " +
        "are suppressed to avoid false positives.",
      inputSchema: ResolvePersonInput.shape,
    },
    async (input) => {
      const data = await handleResolvePerson(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  mcp.registerTool(
    "refresh_source",
    {
      description:
        "Refresh the local SQLite store from an upstream civic-data API. " +
        "Source must be one of 'openstates', 'congress', 'openfec'. For " +
        "openstates, pass `jurisdictions: ['tx']` (or similar) to scope the " +
        "refresh — omitting it iterates all seeded states, which consumes " +
        "the 500/day OpenStates free-tier budget quickly. `max_pages` caps " +
        "pagination per endpoint (not total HTTP calls); actual upstream " +
        "requests ≈ pages × endpoints × jurisdictions, so openstates with " +
        "50 states and 3 endpoints at max_pages=2 is 300 requests. Default " +
        "max_pages is 2 (conservative first-touch). This tool writes to " +
        "the DB and requires user consent per MCP semantics; one consent " +
        "grant covers the whole batch.",
      inputSchema: RefreshSourceInput.shape,
    },
    async (input) => {
      const data = await handleRefreshSource(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  return { mcp, store };
}

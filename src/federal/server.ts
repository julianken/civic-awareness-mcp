import { fileURLToPath } from "node:url";
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
import { handleGetVote } from "./tools/get_vote.js";
import {
  RecentBillsInput,
  RecentVotesInput,
  RecentContributionsInput,
  SearchEntitiesInput,
  GetEntityInput,
  SearchDocumentsInput,
  EntityConnectionsInput,
  ResolvePersonInput,
  GetVoteInput,
} from "./schemas.js";

const coreSqlPath = fileURLToPath(new URL("../core/schema.sql", import.meta.url));
const federalSqlPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

export interface BuildServerOptions {
  dbPath: string;
}
export interface CivicAwarenessServer {
  mcp: McpServer;
  store: Store;
}

export function buildServer(opts: BuildServerOptions): CivicAwarenessServer {
  const store = openStore(opts.dbPath, coreSqlPath, federalSqlPath);
  const mcp = new McpServer(
    { name: "civic-federal-mcp", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  mcp.registerTool(
    "recent_bills",
    {
      description: "List recently-updated U.S. federal legislative bills from Congress.gov.",
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
        "List recent roll-call votes for a U.S. federal jurisdiction (Congress.gov). " +
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
        "Search for people or organizations by name across federal Congress and campaign committees.",
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
        "federal offices and campaign candidacies.",
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
        "Search civic documents (U.S. federal bills, votes, and campaign contributions) by title.",
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
    "get_vote",
    {
      description:
        "Fetch full detail for a single roll-call vote, including " +
        "per-legislator positions (entity_id, name, party, state, " +
        "yea/nay/present/not_voting). Pass either `vote_id` " +
        "(the documents.id returned by recent_votes) OR the federal " +
        "composite `{ congress, chamber, session, roll_number }`. " +
        "Federal (Congress.gov) only.",
      inputSchema: GetVoteInput.shape,
    },
    async (input) => {
      const data = await handleGetVote(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  return { mcp, store };
}

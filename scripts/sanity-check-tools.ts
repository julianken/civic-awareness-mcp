#!/usr/bin/env tsx
/**
 * Manual smoke gate — exercises all 18 MCP tool handlers end-to-end
 * against real upstream APIs (OpenStates, Congress.gov, OpenFEC).
 *
 * Run:
 *   tsx --env-file=.env.local scripts/sanity-check-tools.ts
 *
 * Output: a Markdown table with one row per tool. Status values:
 *   ok               — handler returned a result (may be empty, no diagnostic)
 *   empty_diagnostic — handler returned empty_reason or stale_notice (expected
 *                      for unfiltered queries or unknown entities)
 *   error            — handler threw; full stack printed in ERRORS section
 *
 * This script is NOT part of `npm test`. It is a manual pre-merge smoke gate
 * that catches bugs the MSW-mocked unit tests cannot: wrong URL params, missing
 * required filters, auth failures, upstream schema changes, etc. Run it before
 * opening a PR that touches adapters or tool handlers.
 *
 * Expected non-errors: federal get_entity and entity_connections with fake IDs
 * will produce errors — that is intentional to verify the error path works.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { openStore } from "../src/core/store.js";
import { seedJurisdictions as seedFederal } from "../src/federal/seeds.js";
import { seedJurisdictions as seedState } from "../src/state/seeds.js";

// Federal handlers
import { handleRecentBills as fedRecentBills } from "../src/federal/tools/recent_bills.js";
import { handleRecentVotes as fedRecentVotes } from "../src/federal/tools/recent_votes.js";
import { handleRecentContributions as fedRecentContributions } from "../src/federal/tools/recent_contributions.js";
import { handleGetVote as fedGetVote } from "../src/federal/tools/get_vote.js";
import { handleSearchDocuments as fedSearchDocs } from "../src/federal/tools/search_civic_documents.js";
import { handleSearchEntities as fedSearchEntities } from "../src/federal/tools/search_entities.js";
import { handleResolvePerson as fedResolvePerson } from "../src/federal/tools/resolve_person.js";
import { handleGetEntity as fedGetEntity } from "../src/federal/tools/get_entity.js";
import { handleEntityConnections as fedEntityConnections } from "../src/federal/tools/entity_connections.js";

// State handlers
import { handleRecentBills as stateRecentBills } from "../src/state/tools/recent_bills.js";
import { handleGetBill as stateGetBill } from "../src/state/tools/get_bill.js";
import { handleListBills as stateListBills } from "../src/state/tools/list_bills.js";
import { handleSearchDocuments as stateSearchDocs } from "../src/state/tools/search_civic_documents.js";
import { handleSearchEntities as stateSearchEntities } from "../src/state/tools/search_entities.js";
import { handleResolvePerson as stateResolvePerson } from "../src/state/tools/resolve_person.js";
import { handleGetEntity as stateGetEntity } from "../src/state/tools/get_entity.js";
import { handleEntityConnections as stateEntityConnections } from "../src/state/tools/entity_connections.js";
import { handleRecentVotes as stateRecentVotes } from "../src/state/tools/recent_votes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const coreSqlPath = path.join(root, "src/core/schema.sql");
const federalSqlPath = path.join(root, "src/federal/schema.sql");
const stateSqlPath = path.join(root, "src/state/schema.sql");
const FEDERAL_DB = path.join(root, "data/federal.db");
const STATE_DB = path.join(root, "data/state.db");

interface Row {
  server: string;
  tool: string;
  status: "ok" | "empty_diagnostic" | "error" | "skipped";
  notes: string;
  errorDetail?: string;
}

const rows: Row[] = [];
const errors: Array<{ server: string; tool: string; message: string; stack?: string }> = [];

function classify(result: unknown): { status: Row["status"]; notes: string } {
  if (result === null || result === undefined) {
    return { status: "ok", notes: "returned null/undefined" };
  }
  const r = result as Record<string, unknown>;
  const hasEmptyReason = "empty_reason" in r && r.empty_reason !== undefined;
  const hasStaleNotice = "stale_notice" in r && r.stale_notice !== undefined;
  const hasResults = "results" in r && Array.isArray(r.results);
  const hasError = "error" in r && r.error !== undefined;

  let notes = "";
  if (hasEmptyReason) notes += `empty_reason=${JSON.stringify(r.empty_reason)} `;
  if (hasStaleNotice) notes += `stale_notice=${JSON.stringify(r.stale_notice)} `;
  if (hasResults) notes += `results.length=${(r.results as unknown[]).length} `;
  if (hasError) notes += `error=${JSON.stringify(r.error)} `;
  if (!notes) notes = JSON.stringify(result).slice(0, 120);

  const status = hasEmptyReason || hasStaleNotice ? "empty_diagnostic" : "ok";
  return { status, notes: notes.trim() };
}

async function run(server: string, tool: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    const { status, notes } = classify(result);
    rows.push({ server, tool, status, notes });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? "") : "";
    rows.push({ server, tool, status: "error", notes: msg.slice(0, 120) });
    errors.push({ server, tool, message: msg, stack });
  }
}

async function main() {
  const fedStore = openStore(FEDERAL_DB, coreSqlPath, federalSqlPath);
  seedFederal(fedStore.db);
  const stateStore = openStore(STATE_DB, coreSqlPath, stateSqlPath);
  seedState(stateStore.db);

  // Federal: search for a real entity id to chain get_entity / entity_connections
  let fedEntityId: string | undefined;
  let stateEntityId: string | undefined;

  // --- FEDERAL TOOLS ---
  await run("federal", "recent_bills", () => fedRecentBills(fedStore.db, { days: 3, limit: 5 }));
  await run("federal", "recent_votes", () =>
    fedRecentVotes(fedStore.db, { jurisdiction: "us-federal", days: 3 }),
  );

  // RecentContributionsInput requires { window: { from, to } }
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  await run("federal", "recent_contributions", () =>
    fedRecentContributions(fedStore.db, {
      window: { from: weekAgo.toISOString(), to: now.toISOString() },
    }),
  );

  // get_vote: provide composite key
  await run("federal", "get_vote", () =>
    fedGetVote(fedStore.db, {
      congress: 118,
      chamber: "upper",
      session: 1,
      roll_number: 1,
    }),
  );

  await run("federal", "search_civic_documents", () => fedSearchDocs(fedStore.db, { q: "health" }));

  // search_entities — capture first result id for chaining
  await run("federal", "search_entities", async () => {
    const result = await fedSearchEntities(fedStore.db, { q: "Warren", limit: 5 });
    const r = result as unknown as Record<string, unknown>;
    if (Array.isArray(r.results) && r.results.length > 0) {
      fedEntityId = (r.results[0] as Record<string, unknown>).id as string;
    }
    return result;
  });

  await run("federal", "resolve_person", () =>
    fedResolvePerson(fedStore.db, { name: "Elizabeth Warren" }),
  );

  await run("federal", "get_entity", () =>
    fedGetEntity(fedStore.db, { id: fedEntityId ?? "fake-id-does-not-exist" }),
  );

  await run("federal", "entity_connections", () =>
    fedEntityConnections(fedStore.db, {
      id: fedEntityId ?? "fake-id-does-not-exist",
      depth: 1,
    }),
  );

  // --- STATE TOOLS ---
  await run("state", "recent_bills", () =>
    stateRecentBills(stateStore.db, { jurisdiction: "us-tx", days: 7, limit: 5 }),
  );

  await run("state", "get_bill", () =>
    stateGetBill(stateStore.db, { jurisdiction: "us-tx", session: "89R", identifier: "SB 11" }),
  );

  await run("state", "list_bills", () =>
    stateListBills(stateStore.db, { jurisdiction: "us-tx", limit: 5 }),
  );

  await run("state", "search_civic_documents", () =>
    stateSearchDocs(stateStore.db, { q: "education" }),
  );

  // state search_entities — capture id for chaining
  await run("state", "search_entities", async () => {
    const result = await stateSearchEntities(stateStore.db, { q: "Abbott", limit: 5 });
    const r = result as unknown as Record<string, unknown>;
    if (Array.isArray(r.results) && r.results.length > 0) {
      stateEntityId = (r.results[0] as Record<string, unknown>).id as string;
    }
    return result;
  });

  await run("state", "resolve_person", () =>
    stateResolvePerson(stateStore.db, { name: "Greg Abbott", jurisdiction_hint: "us-tx" }),
  );

  // State uses entity_id field (not id) per GetEntityInput schema
  await run("state", "get_entity", () =>
    stateGetEntity(stateStore.db, { entity_id: stateEntityId ?? "fake-id-does-not-exist" }),
  );

  await run("state", "entity_connections", () =>
    stateEntityConnections(stateStore.db, {
      id: stateEntityId ?? "fake-id-does-not-exist",
      depth: 1,
    }),
  );

  await run("state", "recent_votes", () =>
    stateRecentVotes(stateStore.db, { jurisdiction: "us-tx", days: 14, limit: 5 }),
  );

  fedStore.close();
  stateStore.close();

  // Print table
  const colWidths = { server: 8, tool: 28, status: 18, notes: 80 };
  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);
  const sep = `| ${pad("-".repeat(colWidths.server), colWidths.server)} | ${pad("-".repeat(colWidths.tool), colWidths.tool)} | ${pad("-".repeat(colWidths.status), colWidths.status)} | ${"-".repeat(colWidths.notes)} |`;
  const header = `| ${pad("Server", colWidths.server)} | ${pad("Tool", colWidths.tool)} | ${pad("Status", colWidths.status)} | ${"Notes".padEnd(colWidths.notes)} |`;

  console.log("\n" + header);
  console.log(sep);
  for (const row of rows) {
    const statusStr = row.status === "error" ? "ERROR **" : row.status;
    console.log(
      `| ${pad(row.server, colWidths.server)} | ${pad(row.tool, colWidths.tool)} | ${pad(statusStr, colWidths.status)} | ${pad(row.notes, colWidths.notes)} |`,
    );
  }

  if (errors.length > 0) {
    console.log("\n--- ERRORS ---\n");
    for (const e of errors) {
      console.log(`[${e.server}/${e.tool}] ${e.message}`);
      if (e.stack) {
        const frames = e.stack.split("\n").slice(1, 6).join("\n");
        console.log(frames);
      }
      console.log();
    }
  }

  const errorCount = rows.filter((r) => r.status === "error").length;
  const emptyCount = rows.filter((r) => r.status === "empty_diagnostic").length;
  const okCount = rows.filter((r) => r.status === "ok").length;
  console.log(
    `\nSummary: ${rows.length} tools | ${okCount} ok | ${emptyCount} empty_diagnostic | ${errorCount} errors\n`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

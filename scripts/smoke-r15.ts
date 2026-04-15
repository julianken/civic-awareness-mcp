/**
 * R15 end-to-end smoke script.
 *
 * Exercises the full R15 pipeline (tool handler → withShapedFetch →
 * fetch_log → narrow adapter → real upstream → SQLite write-through →
 * local projection) against real APIs, without going through the MCP
 * protocol layer. Diagnostic tool only — not part of the test suite.
 *
 * Run with: `pnpm tsx scripts/smoke-r15.ts`
 */

import { existsSync, unlinkSync } from "node:fs";
import { bootstrap } from "../src/cli/bootstrap.js";
import { openStore } from "../src/core/store.js";
import { handleRecentBills } from "../src/mcp/tools/recent_bills.js";
import { handleResolvePerson } from "../src/mcp/tools/resolve_person.js";
import { handleSearchDocuments } from "../src/mcp/tools/search_civic_documents.js";
import { loadProjectEnvDefaults } from "../src/util/env-file.js";
import { redactSecrets } from "../src/util/redact.js";

const DB_PATH = "/tmp/civic-r15-smoke.db";

type Scenario = () => Promise<void>;

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return redactSecrets(`${err.name}: ${err.message}${err.stack ? "\n" + err.stack.split("\n").slice(1, 4).join("\n") : ""}`);
  }
  return redactSecrets(String(err));
}

async function runScenario(label: string, fn: Scenario): Promise<void> {
  console.log(`\n=== ${label} ===`);
  try {
    await fn();
  } catch (err) {
    console.log(`  [FAIL] ${formatError(err)}`);
  }
}

async function main(): Promise<void> {
  loadProjectEnvDefaults(import.meta.url);

  if (!process.env.OPENSTATES_API_KEY) {
    console.log("[warn] OPENSTATES_API_KEY not set — OpenStates scenarios will fail");
  }
  if (!process.env.API_DATA_GOV_KEY) {
    console.log("[warn] API_DATA_GOV_KEY not set — Congress.gov / OpenFEC scenarios will fail");
  }

  if (existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`[setup] Removed existing ${DB_PATH}`);
  }

  console.log("[setup] Bootstrapping fresh DB at " + DB_PATH);
  await bootstrap({ dbPath: DB_PATH });

  const store = openStore(DB_PATH);
  console.log("[setup] Store opened\n");

  // ── Scenario 1 ─────────────────────────────────────────────────────
  await runScenario(
    "Scenario 1: search_civic_documents cold (expect empty, store_not_warmed)",
    async () => {
      const t0 = Date.now();
      const r = await handleSearchDocuments(store.db, { q: "budget" });
      const dt = Date.now() - t0;
      console.log(`  elapsed: ${dt}ms`);
      console.log(`  total: ${r.total}`);
      console.log(`  empty_reason: ${r.empty_reason ?? "(none)"}`);
      if (r.hint) console.log(`  hint: ${r.hint}`);
    },
  );

  // ── Scenario 2 ─────────────────────────────────────────────────────
  await runScenario(
    "Scenario 2: recent_bills cold us-tx days=365 (expect upstream OpenStates)",
    async () => {
      const t0 = Date.now();
      const r = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 365 });
      const dt = Date.now() - t0;
      console.log(`  elapsed: ${dt}ms`);
      console.log(`  total: ${r.total}`);
      if (r.data_freshness) {
        console.log(`  data_freshness.last_refreshed_at: ${r.data_freshness.last_refreshed_at}`);
        console.log(`  data_freshness.source: ${r.data_freshness.source}`);
      }
      console.log(`  stale_notice: ${r.stale_notice ? JSON.stringify(r.stale_notice) : "(none)"}`);
      if (r.results.length > 0) {
        const first = r.results[0];
        console.log(`  first: ${first.identifier} — ${first.title.slice(0, 70)}`);
      } else {
        console.log(`  empty_reason: ${r.empty_reason ?? "(none)"}`);
        if (r.hint) console.log(`  hint: ${r.hint}`);
      }
    },
  );

  // ── Scenario 3 ─────────────────────────────────────────────────────
  await runScenario(
    "Scenario 3: recent_bills warm us-tx days=365 (expect cache hit <100ms)",
    async () => {
      const t0 = Date.now();
      const r = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 365 });
      const dt = Date.now() - t0;
      console.log(`  elapsed: ${dt}ms`);
      console.log(`  total: ${r.total}`);
      console.log(`  stale_notice: ${r.stale_notice ? JSON.stringify(r.stale_notice) : "(none)"}`);
    },
  );

  // ── Scenario 4 ─────────────────────────────────────────────────────
  await runScenario(
    "Scenario 4: recent_bills cold us-federal days=30 (Congress.gov; validates fromDateTime fix)",
    async () => {
      const t0 = Date.now();
      const r = await handleRecentBills(store.db, { jurisdiction: "us-federal", days: 30 });
      const dt = Date.now() - t0;
      console.log(`  elapsed: ${dt}ms`);
      console.log(`  total: ${r.total}`);
      if (r.data_freshness) {
        console.log(`  data_freshness.last_refreshed_at: ${r.data_freshness.last_refreshed_at}`);
        console.log(`  data_freshness.source: ${r.data_freshness.source}`);
      }
      console.log(`  stale_notice: ${r.stale_notice ? JSON.stringify(r.stale_notice) : "(none)"}`);
      if (r.results.length > 0) {
        const first = r.results[0];
        console.log(`  first: ${first.identifier} — ${first.title.slice(0, 70)}`);
      } else {
        console.log(`  empty_reason: ${r.empty_reason ?? "(none)"}`);
        if (r.hint) console.log(`  hint: ${r.hint}`);
      }
    },
  );

  // ── Scenario 5 ─────────────────────────────────────────────────────
  await runScenario(
    "Scenario 5: resolve_person 'Angus King' us-federal (Congress.gov + OpenFEC fanout)",
    async () => {
      const t0 = Date.now();
      const r = await handleResolvePerson(store.db, {
        name: "Angus King",
        role_hint: "senator",
        jurisdiction_hint: "us-federal",
      });
      const dt = Date.now() - t0;
      console.log(`  elapsed: ${dt}ms`);
      console.log(`  matches.length: ${r.matches.length}`);
      console.log(`  stale_notice: ${r.stale_notice ? JSON.stringify(r.stale_notice) : "(none)"}`);
      if (r.matches.length > 0) {
        const first = r.matches[0];
        console.log(`  first.name: ${first.name}`);
        console.log(`  first.confidence: ${first.confidence}`);
        console.log(`  first.disambiguators: ${JSON.stringify(first.disambiguators)}`);
      }
    },
  );

  // ── Scenario 6 ─────────────────────────────────────────────────────
  await runScenario(
    "Scenario 6: search_civic_documents warmed (expect non-empty or no store_not_warmed)",
    async () => {
      const t0 = Date.now();
      const r = await handleSearchDocuments(store.db, { q: "budget" });
      const dt = Date.now() - t0;
      console.log(`  elapsed: ${dt}ms`);
      console.log(`  total: ${r.total}`);
      console.log(`  empty_reason: ${r.empty_reason ?? "(none)"}`);
      if (r.results.length > 0) {
        const first = r.results[0];
        console.log(`  first: ${first.id} — ${first.title.slice(0, 70)}`);
      }
    },
  );

  // ── Final tallies ──────────────────────────────────────────────────
  console.log("\n=== Final store tallies ===");
  const fetchLogCount = (store.db.prepare("SELECT COUNT(*) AS n FROM fetch_log").get() as { n: number }).n;
  const docsCount = (store.db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
  const entitiesCount = (store.db.prepare("SELECT COUNT(*) AS n FROM entities").get() as { n: number }).n;
  console.log(`  fetch_log rows: ${fetchLogCount}`);
  console.log(`  documents rows: ${docsCount}`);
  console.log(`  entities rows:  ${entitiesCount}`);

  const fetchLogDetail = store.db
    .prepare(
      `SELECT source, endpoint_path, scope, last_rowcount, fetched_at
         FROM fetch_log ORDER BY fetched_at`,
    )
    .all() as Array<{ source: string; endpoint_path: string; scope: string; last_rowcount: number; fetched_at: string }>;
  console.log("  fetch_log detail:");
  for (const row of fetchLogDetail) {
    console.log(
      `    - ${row.source} ${row.endpoint_path} scope=${row.scope} rowcount=${row.last_rowcount} at=${row.fetched_at}`,
    );
  }

  store.close();
  console.log("\n[done] Smoke script complete.");
}

main().catch((err) => {
  console.error("[FATAL]", formatError(err));
  process.exit(1);
});

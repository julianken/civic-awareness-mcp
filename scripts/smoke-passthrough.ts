import { loadProjectEnvDefaults } from "../src/util/env-file.js";
import { openStore } from "../src/core/store.js";
import { handleRecentBills } from "../src/mcp/tools/recent_bills.js";
import { bootstrap } from "../src/cli/bootstrap.js";
import { existsSync, unlinkSync } from "node:fs";
import { getFreshness } from "../src/core/freshness.js";

const DB_PATH = "/tmp/civic-smoke.db";

async function main() {
  loadProjectEnvDefaults(import.meta.url);

  if (existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`[setup] Removed existing ${DB_PATH}`);
  }

  console.log("[setup] Bootstrapping fresh DB…");
  await bootstrap({ dbPath: DB_PATH });

  const store = openStore(DB_PATH);
  console.log("[setup] Store opened\n");

  console.log("=== Call 1: cold recent_bills({jurisdiction:'us-tx', days:365}) ===");
  const t0 = Date.now();
  const result1 = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 365 });
  const dt1 = Date.now() - t0;
  console.log(`  Elapsed: ${dt1}ms`);
  console.log(`  total: ${result1.total}`);
  console.log(`  sources: ${JSON.stringify(result1.sources)}`);
  console.log(`  stale_notice: ${result1.stale_notice ? JSON.stringify(result1.stale_notice) : "(none)"}`);
  if (result1.results.length > 0) {
    console.log("  First 3 bills:");
    for (const b of result1.results.slice(0, 3)) {
      console.log(`    - ${b.identifier}: ${b.title.slice(0, 80)}`);
    }
  } else {
    console.log("  (empty results)");
    if (result1.empty_reason) console.log(`  empty_reason: ${result1.empty_reason}`);
    if (result1.hint) console.log(`  hint: ${result1.hint}`);
  }

  const hydr1 = getFreshness(store.db, "openstates", "us-tx", "recent");
  console.log(`  hydrations row: ${hydr1 ? `status=${hydr1.status} at ${hydr1.last_fetched_at}` : "(none)"}`);
  console.log();

  console.log("=== Call 2: warm cache, should NOT hit upstream ===");
  const t2 = Date.now();
  const result2 = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 365 });
  const dt2 = Date.now() - t2;
  console.log(`  Elapsed: ${dt2}ms (should be <100ms if cache hit)`);
  console.log(`  total: ${result2.total}`);
  console.log(`  stale_notice: ${result2.stale_notice ? JSON.stringify(result2.stale_notice) : "(none)"}`);
  console.log();

  store.close();
  console.log("[done] Smoke test complete.");
}

main().catch((err) => {
  console.error("[FAIL]", err);
  process.exit(1);
});

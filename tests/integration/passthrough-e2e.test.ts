/**
 * Pass-through cache integration test (R13 path).
 *
 * Exercises the real hydrate → singleflight → TTL → stale_notice
 * pipeline for tools still on R13 (resolve_person and other
 * non-migrated tools). The `recent_bills` tool has been migrated
 * to the R15 `withShapedFetch` path — its integration scenarios
 * live in `passthrough-e2e.shaped.test.ts`. The two `recent_bills`
 * scenarios preserved here (warm hit, singleflight) pass under
 * R15 incidentally and act as regression tests for the shared
 * cache-write contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/core/seeds.js";
import { handleRecentBills } from "../../src/mcp/tools/recent_bills.js";
import { handleResolvePerson } from "../../src/mcp/tools/resolve_person.js";
import { _resetLimitersForTesting } from "../../src/core/limiters.js";
import { _resetForTesting as resetHydrateBudget } from "../../src/core/hydrate.js";
import { _resetToolCacheForTesting } from "../../src/core/tool_cache.js";

vi.stubEnv("OPENSTATES_API_KEY", "test-key");

const billsFixture = readFileSync("tests/integration/fixtures/openstates-bills-page1.json", "utf-8");
const peopleFixture = readFileSync("tests/integration/fixtures/openstates-people-page1.json", "utf-8");

let store: Store;

// Per-test fetch mode for the global spy.
type FetchMode = "ok" | "500";
let fetchMode: FetchMode = "ok";
let fetchHits = 0;

function installFetchMock(delayMs = 0): void {
  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = String(typeof input === "string" ? input : (input as URL | Request).toString());
    if (!url.includes("openstates.org")) return new Response("", { status: 404 });
    fetchHits += 1;
    if (delayMs > 0) await new Promise<void>((r) => setTimeout(r, delayMs));
    if (fetchMode === "500") {
      return new Response(JSON.stringify({ detail: "server error" }), { status: 500 });
    }
    if (url.includes("/people")) return new Response(peopleFixture, { status: 200 });
    if (url.includes("/bills")) return new Response(billsFixture, { status: 200 });
    return new Response("", { status: 404 });
  });
}

beforeEach(() => {
  fetchHits = 0;
  fetchMode = "ok";
  _resetLimitersForTesting();
  resetHydrateBudget();
  _resetToolCacheForTesting();
  store = openStore(":memory:");
  seedJurisdictions(store.db);
  installFetchMock();
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("pass-through cache — full orchestrator (no ensureFresh mock)", () => {
  // ── Scenario: Warm hit (within TTL) ───────────────────────────────────
  it("warm hit: second call within TTL skips upstream", async () => {
    // Cold fill.
    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 });
    const hitsAfterFirst = fetchHits;

    // Switch to 500 — any upstream call would fail, proving cache is used.
    fetchMode = "500";

    const result = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.stale_notice).toBeUndefined();
    // fetch was not called again.
    expect(fetchHits).toBe(hitsAfterFirst);
  });

  // ── Scenario: Entity full hydrate — success path ──────────────────────
  it("full hydrate: resolve_person with jurisdiction_hint populates hydrations scope=full", async () => {
    const result = await handleResolvePerson(store.db, {
      name: "Alice Johnson",
      jurisdiction_hint: "us-tx",
    });

    // Full-scope hydration row must exist after the call.
    const row = store.db
      .prepare(
        "SELECT status FROM hydrations WHERE source='openstates' AND jurisdiction='us-tx' AND scope='full'",
      )
      .get() as { status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("complete");

    // Alice Johnson is in the fixture and should be found.
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].name).toBe("Alice Johnson");
    expect(result.stale_notice).toBeUndefined();
  });

  // ── Scenario: Singleflight coalesce ───────────────────────────────────
  it("singleflight: 3 concurrent calls produce exactly 1 upstream /bills request", async () => {
    let billsHits = 0;

    // Override the fetch mock with one that counts /bills hits and adds a
    // 30ms delay so all three concurrent callers have time to latch onto
    // the in-flight singleflight promise before it resolves.
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "string" ? input : (input as URL | Request).toString());
      if (!url.includes("openstates.org")) return new Response("", { status: 404 });
      if (url.includes("/bills")) {
        billsHits += 1;
        await new Promise<void>((r) => setTimeout(r, 30));
        return new Response(billsFixture, { status: 200 });
      }
      if (url.includes("/people")) {
        return new Response(peopleFixture, { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const [r1, r2, r3] = await Promise.all([
      handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 }),
      handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 }),
      handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 }),
    ]);

    expect(r1.results.length).toBeGreaterThan(0);
    expect(r2.results.length).toBeGreaterThan(0);
    expect(r3.results.length).toBeGreaterThan(0);

    // Singleflight coalesces: only 1 upstream /bills request.
    expect(billsHits).toBe(1);
  });
});

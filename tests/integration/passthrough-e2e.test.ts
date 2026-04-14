/**
 * Pass-through cache integration test.
 *
 * Unlike the other e2e tests, this file does NOT mock ensureFresh.
 * It exercises the real hydrate → singleflight → TTL → stale_notice
 * pipeline against a vi.spyOn(fetch) mock and, for the upstream-failure
 * scenario, a vi.spyOn on refreshSource (to reach the catch branch that
 * the adapter's internal error-swallowing otherwise prevents).
 *
 * Scenarios:
 *  1. Cold fill — store empty, fetch succeeds, hydrations row written.
 *  2. Warm hit — second call within TTL does NOT re-hit upstream.
 *  3. TTL expiry — manually expire row, third call re-fetches.
 *  4. Upstream failure → stale_notice reason=upstream_failure.
 *  5. Rate limited → stale_notice reason=rate_limited.
 *  6. Entity full hydrate — resolve_person with jurisdiction_hint triggers full scope.
 *  7. Singleflight coalesce — 3 concurrent calls produce exactly 1 upstream hit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/core/seeds.js";
import { handleRecentBills } from "../../src/mcp/tools/recent_bills.js";
import { handleResolvePerson } from "../../src/mcp/tools/resolve_person.js";
import { RateLimiter } from "../../src/util/http.js";
import { _setLimiterForTesting, _resetLimitersForTesting } from "../../src/core/limiters.js";
import { _resetForTesting as resetHydrateBudget } from "../../src/core/hydrate.js";
import { TTL_RECENT_MS } from "../../src/core/freshness.js";
import * as refreshModule from "../../src/core/refresh.js";

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
  store = openStore(":memory:");
  seedJurisdictions(store.db);
  installFetchMock();
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Helper: expire a hydrations row so the next call will attempt a re-fetch.
function expireFreshness(
  db: Store["db"],
  source: string,
  jurisdiction: string,
  scope: string,
): void {
  const twoHoursAgo = new Date(Date.now() - (TTL_RECENT_MS + 2 * 60 * 1000)).toISOString();
  db.prepare(
    "UPDATE hydrations SET last_fetched_at=? WHERE source=? AND jurisdiction=? AND scope=?",
  ).run(twoHoursAgo, source, jurisdiction, scope);
}

describe("pass-through cache — full orchestrator (no ensureFresh mock)", () => {
  // ── Scenario 1: Cold fill ──────────────────────────────────────────────
  it("cold fill: fetches upstream and writes hydrations row with status=complete", async () => {
    const result = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.stale_notice).toBeUndefined();
    expect(fetchHits).toBeGreaterThan(0);

    const row = store.db
      .prepare(
        "SELECT status FROM hydrations WHERE source='openstates' AND jurisdiction='us-tx' AND scope='recent'",
      )
      .get() as { status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("complete");
  });

  // ── Scenario 2: Warm hit (within TTL) ─────────────────────────────────
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

  // ── Scenario 3: TTL expiry ─────────────────────────────────────────────
  it("TTL expiry: stale hydrations row triggers re-fetch", async () => {
    // Cold fill.
    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 });
    const hitsAfterFirst = fetchHits;

    // Manually expire the freshness record.
    expireFreshness(store.db, "openstates", "us-tx", "recent");

    fetchMode = "ok";
    const result = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 });

    expect(result.results.length).toBeGreaterThan(0);
    // At least one new fetch occurred after expiry.
    expect(fetchHits).toBeGreaterThan(hitsAfterFirst);
  });

  // ── Scenario 4: Upstream failure → stale_notice ───────────────────────
  //
  // The OpenStates adapter swallows HTTP errors internally (it catches them
  // and appends to result.errors). To reach the catch branch inside
  // ensureFresh that produces stale_notice.reason=upstream_failure, we need
  // refreshSource itself to throw. We accomplish this by spying on
  // refreshModule.refreshSource to throw after the cold fill. The real
  // ensureFresh + singleflight + TTL flow still runs — only the leaf
  // "fetch from upstream" step is replaced.
  it("upstream failure: returns stale_notice.reason=upstream_failure with cached data", async () => {
    // Seed store via a successful cold fill.
    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 });

    // Expire freshness so the next call attempts upstream.
    expireFreshness(store.db, "openstates", "us-tx", "recent");

    // Make refreshSource throw a non-ConfigurationError.
    vi.spyOn(refreshModule, "refreshSource").mockRejectedValue(
      new Error("simulated upstream failure"),
    );

    const result = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 });

    // Stale cached data still served.
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.stale_notice).toBeDefined();
    expect(result.stale_notice!.reason).toBe("upstream_failure");
  });

  // ── Scenario 5: Rate limited → stale_notice ───────────────────────────
  it("rate limited: returns stale_notice.reason=rate_limited with cached data", async () => {
    // Seed store via a successful cold fill.
    await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 });

    // Expire freshness.
    expireFreshness(store.db, "openstates", "us-tx", "recent");

    // Inject a drained limiter: 1 token / 60s → after acquire() the bucket
    // is empty and peekWaitMs() returns ~60000, well above RATE_LIMIT_WAIT_THRESHOLD_MS (2500).
    const drainedLimiter = new RateLimiter({ tokensPerInterval: 1, intervalMs: 60_000 });
    await drainedLimiter.acquire(); // consume the single token
    _setLimiterForTesting("openstates", drainedLimiter);

    const result = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 90 });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.stale_notice).toBeDefined();
    expect(result.stale_notice!.reason).toBe("rate_limited");
  });

  // ── Scenario 6: Entity full hydrate — success path ────────────────────
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

  // ── Scenario 7: Singleflight coalesce ─────────────────────────────────
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

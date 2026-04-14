import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { openStore, type Store } from "../../../src/core/store.js";
import { markFresh } from "../../../src/core/freshness.js";
import {
  ensureFresh,
  sourcesFor,
  sourcesForFullHydrate,
  _resetForTesting,
} from "../../../src/core/hydrate.js";
import { ConfigurationError } from "../../../src/util/env.js";

// Mock refreshSource so tests never hit the network.
vi.mock("../../../src/core/refresh.js", () => ({
  refreshSource: vi.fn(),
}));

import { refreshSource } from "../../../src/core/refresh.js";

const mockRefreshSource = vi.mocked(refreshSource);

let store: Store;

beforeEach(() => {
  store = openStore(":memory:");
  mockRefreshSource.mockReset();
  _resetForTesting();
});

afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
});

// ── 1. Already fresh → no upstream call ──────────────────────────────

describe("ensureFresh — already fresh", () => {
  it("returns { ok: true } without calling refreshSource", async () => {
    markFresh(store.db, "openstates", "us-tx", "recent", "complete");
    const result = await ensureFresh(store.db, "openstates", "us-tx", "recent", () => 0);
    expect(result).toEqual({ ok: true });
    expect(mockRefreshSource).not.toHaveBeenCalled();
  });
});

// ── 2. Stale → refresh succeeds → marks fresh ────────────────────────

describe("ensureFresh — stale then success", () => {
  it("calls refreshSource and marks status=complete", async () => {
    mockRefreshSource.mockResolvedValue({
      source: "openstates",
      entitiesUpserted: 1,
      documentsUpserted: 1,
      errors: [],
    });
    const result = await ensureFresh(store.db, "openstates", "us-tx", "recent", () => 0);
    expect(result).toEqual({ ok: true });
    expect(mockRefreshSource).toHaveBeenCalledOnce();

    // hydrations row should now exist with status complete
    const row = store.db
      .prepare("SELECT status FROM hydrations WHERE source=? AND jurisdiction=? AND scope=?")
      .get("openstates", "us-tx", "recent") as { status: string } | undefined;
    expect(row?.status).toBe("complete");
  });
});

// ── 3. Rate-limit peek > 2.5s → stale_notice.reason = rate_limited ──

describe("ensureFresh — rate limited", () => {
  it("returns rate_limited stale notice with retry_after_s", async () => {
    const result = await ensureFresh(store.db, "openstates", "us-tx", "recent", () => 3000);
    expect(result.ok).toBe(false);
    expect(result.stale_notice?.reason).toBe("rate_limited");
    expect(result.stale_notice?.retry_after_s).toBe(3);
    expect(mockRefreshSource).not.toHaveBeenCalled();
  });
});

// ── 4. Daily budget exhausted → stale_notice.reason = daily_budget_exhausted

describe("ensureFresh — budget exhausted", () => {
  it("returns daily_budget_exhausted when budget is 0", async () => {
    // Stub env before _resetForTesting so the new DailyBudget picks it up.
    vi.stubEnv("CIVIC_AWARENESS_DAILY_BUDGET", "openstates=0");
    _resetForTesting();

    const result = await ensureFresh(store.db, "openstates", "us-tx", "recent", () => 0);
    expect(result.ok).toBe(false);
    expect(result.stale_notice?.reason).toBe("daily_budget_exhausted");
    expect(mockRefreshSource).not.toHaveBeenCalled();
  });
});

// ── 5. refreshSource throws generic Error → upstream_failure ─────────

describe("ensureFresh — upstream failure", () => {
  it("returns upstream_failure on generic Error from refreshSource", async () => {
    mockRefreshSource.mockRejectedValue(new Error("Network timeout"));
    const result = await ensureFresh(store.db, "openstates", "us-tx", "recent", () => 0);
    expect(result.ok).toBe(false);
    expect(result.stale_notice?.reason).toBe("upstream_failure");
    expect(result.stale_notice?.message).toContain("Network timeout");
  });
});

// ── 6. refreshSource throws ConfigurationError → re-throw ────────────

describe("ensureFresh — ConfigurationError re-throw", () => {
  it("propagates ConfigurationError rather than converting to stale_notice", async () => {
    mockRefreshSource.mockRejectedValue(
      new ConfigurationError("Required environment variable OPENSTATES_API_KEY is not set."),
    );
    await expect(
      ensureFresh(store.db, "openstates", "us-tx", "recent", () => 0),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

// ── 7. scope=full with deadline exceeded → partial ───────────────────

describe("ensureFresh — scope full, deadline exceeded", () => {
  it("marks partial and returns stale_notice.reason=partial_hydrate", async () => {
    // Slow mock: resolves after yielding, but we cheat by making Date.now()
    // return a value past the deadline after the first call that sets it.
    let callCount = 0;
    const realDateNow = Date.now;
    // Mock refreshSource to be slow enough that the deadline expires by the
    // time we check it. We simulate this by advancing Date.now during the call.
    mockRefreshSource.mockImplementation(async () => {
      // Simulate time passing past the 20s deadline during the fetch.
      vi.spyOn(Date, "now").mockReturnValue(realDateNow() + 25_000);
      callCount++;
      return { source: "openstates", entitiesUpserted: 0, documentsUpserted: 0, errors: [] };
    });

    const result = await ensureFresh(store.db, "openstates", "us-tx", "full", () => 0);

    expect(callCount).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.stale_notice?.reason).toBe("partial_hydrate");
    expect(result.stale_notice?.completeness).toBe("active_session_only");

    const row = store.db
      .prepare("SELECT status FROM hydrations WHERE source=? AND jurisdiction=? AND scope=?")
      .get("openstates", "us-tx", "full") as { status: string } | undefined;
    expect(row?.status).toBe("partial");

    vi.restoreAllMocks();
  });
});

// ── 8. Singleflight coalescing ────────────────────────────────────────

describe("ensureFresh — singleflight", () => {
  it("coalesces concurrent calls on same key to one refreshSource invocation", async () => {
    mockRefreshSource.mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(
            () =>
              r({ source: "openstates", entitiesUpserted: 0, documentsUpserted: 0, errors: [] }),
            50,
          ),
        ),
    );

    const [a, b, c] = await Promise.all([
      ensureFresh(store.db, "openstates", "us-tx", "recent", () => 0),
      ensureFresh(store.db, "openstates", "us-tx", "recent", () => 0),
      ensureFresh(store.db, "openstates", "us-tx", "recent", () => 0),
    ]);

    expect(mockRefreshSource).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(c).toEqual({ ok: true });
  });

  it("does NOT coalesce calls on different keys", async () => {
    mockRefreshSource.mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(
            () =>
              r({ source: "openstates", entitiesUpserted: 0, documentsUpserted: 0, errors: [] }),
            50,
          ),
        ),
    );

    await Promise.all([
      ensureFresh(store.db, "openstates", "us-tx", "recent", () => 0),
      ensureFresh(store.db, "openstates", "us-ca", "recent", () => 0),
    ]);

    expect(mockRefreshSource).toHaveBeenCalledTimes(2);
  });
});

// ── 9. sourcesFor routing ─────────────────────────────────────────────

describe("sourcesFor", () => {
  it("bill + us-federal → congress", () => {
    expect(sourcesFor("bill", "us-federal")).toEqual(["congress"]);
  });
  it("bill + us-tx → openstates", () => {
    expect(sourcesFor("bill", "us-tx")).toEqual(["openstates"]);
  });
  it("vote + us-federal → congress", () => {
    expect(sourcesFor("vote", "us-federal")).toEqual(["congress"]);
  });
  it("contribution + us-federal → openfec", () => {
    expect(sourcesFor("contribution", "us-federal")).toEqual(["openfec"]);
  });
  it("bill + * → []", () => {
    expect(sourcesFor("bill", "*")).toEqual([]);
  });
  it("contribution + * → []", () => {
    expect(sourcesFor("contribution", "*")).toEqual([]);
  });
});

// ── 10. sourcesForFullHydrate routing ────────────────────────────────

describe("sourcesForFullHydrate", () => {
  it("us-federal → congress + openfec", () => {
    expect(sourcesForFullHydrate("us-federal")).toEqual(["congress", "openfec"]);
  });
  it("us-tx → openstates", () => {
    expect(sourcesForFullHydrate("us-tx")).toEqual(["openstates"]);
  });
  it("* → []", () => {
    expect(sourcesForFullHydrate("*")).toEqual([]);
  });
});

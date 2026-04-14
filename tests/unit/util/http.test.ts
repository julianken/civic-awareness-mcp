import { describe, it, expect } from "vitest";
import { RateLimiter, RATE_LIMIT_WAIT_THRESHOLD_MS } from "../../../src/util/http.js";

describe("RateLimiter", () => {
  it("allows immediate call under limit", async () => {
    const rl = new RateLimiter({ tokensPerInterval: 5, intervalMs: 1000 });
    const start = Date.now();
    await rl.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("blocks when tokens exhausted", async () => {
    const rl = new RateLimiter({ tokensPerInterval: 2, intervalMs: 200 });
    await rl.acquire();
    await rl.acquire();
    const start = Date.now();
    await rl.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });
});

describe("RateLimiter.peekWaitMs", () => {
  it("returns 0 when tokens available", () => {
    const r = new RateLimiter({ tokensPerInterval: 2, intervalMs: 1000 });
    expect(r.peekWaitMs()).toBe(0);
  });

  it("returns positive wait when depleted", async () => {
    const r = new RateLimiter({ tokensPerInterval: 1, intervalMs: 1000 });
    await r.acquire();
    const w = r.peekWaitMs();
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThanOrEqual(1000);
  });

  it("peek does not consume tokens", async () => {
    const r = new RateLimiter({ tokensPerInterval: 2, intervalMs: 1000 });
    r.peekWaitMs();
    r.peekWaitMs();
    const start = Date.now();
    await r.acquire();
    await r.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe("rate-limit threshold constant", () => {
  it("is 2500ms", () => {
    expect(RATE_LIMIT_WAIT_THRESHOLD_MS).toBe(2500);
  });
});

import { describe, it, expect } from "vitest";
import { RateLimiter } from "../../../src/util/http.js";

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

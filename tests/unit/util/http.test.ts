import { describe, it, expect, vi, afterEach } from "vitest";
import { RateLimiter, RATE_LIMIT_WAIT_THRESHOLD_MS, rateLimitedFetch } from "../../../src/util/http.js";
import { logger } from "../../../src/util/logger.js";

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

describe("rateLimitedFetch latency logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs info with all required fields on success", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});

    await rateLimitedFetch("https://v3.openstates.org/bills?jurisdiction=tx", {
      userAgent: "test/1.0",
    });

    expect(infoSpy).toHaveBeenCalledOnce();
    const [msg, fields] = infoSpy.mock.calls[0];
    expect(msg).toBe("upstream fetch ok");
    expect(fields).toMatchObject({
      url: "https://v3.openstates.org/bills?jurisdiction=tx",
      method: "GET",
      status: 200,
      attempt: 1,
      host: "v3.openstates.org",
    });
    expect(typeof fields?.duration_ms).toBe("number");
  });

  it("logs warn on 429 with attempt counter incrementing per retry", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});

    await rateLimitedFetch("https://v3.openstates.org/bills", {
      userAgent: "test/1.0",
      retries: 3,
    });

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][1]).toMatchObject({ status: 429, attempt: 1 });
    expect(warnSpy.mock.calls[1][1]).toMatchObject({ status: 429, attempt: 2 });
    expect(infoSpy).toHaveBeenCalledOnce();
    expect(infoSpy.mock.calls[0][1]).toMatchObject({ status: 200, attempt: 3 });
  });

  it("logs warn for every attempt on terminal failure (retries exhausted)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("", { status: 500, headers: { "Retry-After": "0" } }),
    );
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});

    const res = await rateLimitedFetch("https://v3.openstates.org/bills", {
      userAgent: "test/1.0",
      retries: 2,
    });

    expect(res.status).toBe(500);
    // retries=2 means attempts 1, 2, 3 (attempt >= retries returns on the 3rd try)
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[0][1]).toMatchObject({ attempt: 1, host: "v3.openstates.org" });
    expect(warnSpy.mock.calls[2][1]).toMatchObject({ attempt: 3, host: "v3.openstates.org" });
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("logs warn with status network_error and rethrows on fetch exception", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await expect(
      rateLimitedFetch("https://v3.openstates.org/bills", { userAgent: "test/1.0" }),
    ).rejects.toThrow("Failed to fetch");

    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg, fields] = warnSpy.mock.calls[0];
    expect(msg).toBe("upstream fetch network error");
    expect(fields).toMatchObject({
      status: "network_error",
      attempt: 1,
      host: "v3.openstates.org",
    });
    expect(typeof fields?.duration_ms).toBe("number");
  });

  it("does not include auth headers in logged fields", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});

    await rateLimitedFetch("https://v3.openstates.org/bills", {
      userAgent: "test/1.0",
      headers: { "X-API-KEY": "secret-key-value" },
    });

    const [, fields] = infoSpy.mock.calls[0];
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("secret-key-value");
    expect(serialized).not.toContain("X-API-KEY");
  });
});

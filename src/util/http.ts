export const RATE_LIMIT_WAIT_THRESHOLD_MS = 2500;

export interface RateLimiterOptions {
  tokensPerInterval: number;
  intervalMs: number;
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  constructor(private opts: RateLimiterOptions) {
    this.tokens = opts.tokensPerInterval;
    this.lastRefill = Date.now();
  }
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = this.opts.intervalMs / this.opts.tokensPerInterval;
    await sleep(waitMs);
    return this.acquire();
  }
  peekWaitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const msPerToken = this.opts.intervalMs / this.opts.tokensPerInterval;
    const elapsed = Date.now() - this.lastRefill;
    return Math.ceil(msPerToken - (elapsed % msPerToken));
  }
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = (elapsed / this.opts.intervalMs) * this.opts.tokensPerInterval;
    if (newTokens >= 1) {
      this.tokens = Math.min(
        this.opts.tokensPerInterval,
        this.tokens + Math.floor(newTokens),
      );
      this.lastRefill = now;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchOptions extends RequestInit {
  userAgent: string;
  rateLimiter?: RateLimiter;
  retries?: number;
}

export async function rateLimitedFetch(url: string, opts: FetchOptions): Promise<Response> {
  const { userAgent, rateLimiter, retries = 3, ...init } = opts;
  const headers = new Headers(init.headers ?? {});
  headers.set("User-Agent", userAgent);

  let attempt = 0;
  while (true) {
    if (rateLimiter) await rateLimiter.acquire();
    // redirect: "error" is a defense-in-depth measure: the three upstream
    // civic APIs (OpenStates, Congress.gov, OpenFEC) don't issue 30x
    // responses on their documented endpoints, so an unexpected redirect
    // is a signal something is wrong (DNS redirection, captive portal,
    // provider outage redirecting to a status page). Surfacing it loudly
    // is safer than silently following a redirect that could leak the
    // request's timing or the User-Agent to an unintended destination.
    const res = await fetch(url, { ...init, headers, redirect: "error" });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) return res;
      const retryAfter = Number(res.headers.get("Retry-After") ?? 0) * 1000;
      const backoff = retryAfter || Math.min(30000, 1000 * Math.pow(2, attempt));
      await sleep(backoff);
      attempt += 1;
      continue;
    }
    return res;
  }
}

import { RateLimiter } from "../util/http.js";
import type { HydrationSource } from "./freshness.js";

const limiters: Partial<Record<HydrationSource, RateLimiter>> = {};

function limiterConfigFor(source: HydrationSource): { tokensPerInterval: number; intervalMs: number } {
  switch (source) {
    // OpenStates free tier is 10/min; 8 is conservative.
    case "openstates": return { tokensPerInterval: 8,  intervalMs: 60_000 };
    // Congress.gov is ~5000/hr = ~83/min; 80 is conservative.
    case "congress":   return { tokensPerInterval: 80, intervalMs: 60_000 };
    // OpenFEC is 1000/hr = ~16/min; 15 is conservative.
    case "openfec":    return { tokensPerInterval: 15, intervalMs: 60_000 };
  }
}

/**
 * Returns the process-wide singleton RateLimiter for the given source.
 * Adapters are constructed with this limiter so that the hydrator's
 * peekWaitMs() check reads from the same token bucket that the adapter
 * actually drains during fetch calls.
 */
export function getLimiter(source: HydrationSource): RateLimiter {
  if (!limiters[source]) {
    limiters[source] = new RateLimiter(limiterConfigFor(source));
  }
  return limiters[source]!;
}

/**
 * Replaces the singleton limiter for the given source with the provided
 * instance. Test-only — allows scenario-specific token bucket states.
 */
export function _setLimiterForTesting(source: HydrationSource, limiter: RateLimiter): void {
  limiters[source] = limiter;
}

/**
 * Resets all singleton limiters so each test starts with a fresh bucket.
 * Test-only.
 */
export function _resetLimitersForTesting(): void {
  for (const key of Object.keys(limiters) as HydrationSource[]) {
    delete limiters[key];
  }
}

import type Database from "better-sqlite3";
import type { DocumentKind } from "./types.js";
import {
  getFreshness,
  isFresh,
  markFresh,
  type HydrationScope,
  type HydrationSource,
} from "./freshness.js";
import { Singleflight } from "./singleflight.js";
import { DailyBudget } from "./budget.js";
import { RATE_LIMIT_WAIT_THRESHOLD_MS } from "../util/http.js";
import { refreshSource } from "./refresh.js";
import type { StaleNotice } from "../mcp/shared.js";
import { logger } from "../util/logger.js";
import { ConfigurationError } from "../util/env.js";

const FULL_HYDRATE_MAX_PAGES = 5;
const FULL_HYDRATE_DEADLINE_MS = 20_000;
const RECENT_HYDRATE_MAX_PAGES = 2;

const sf = new Singleflight<EnsureFreshResult>();
const budget = new DailyBudget(process.env.CIVIC_AWARENESS_DAILY_BUDGET);

/** Exposed for tests that need to reset module-level singleton state. */
export function _resetForTesting(): void {
  // Re-read the env var so tests can stub it before importing.
  // We construct a fresh DailyBudget from the (possibly stubbed) env value.
  Object.assign(budget, new DailyBudget(process.env.CIVIC_AWARENESS_DAILY_BUDGET));
}

export interface EnsureFreshResult {
  ok: boolean;
  stale_notice?: StaleNotice;
}

export function sourcesFor(
  kind: DocumentKind,
  jurisdiction: string,
): HydrationSource[] {
  if (jurisdiction === "*") return [];
  if (kind === "contribution") return ["openfec"];
  if (jurisdiction === "us-federal") return ["congress"];
  return ["openstates"];
}

export function sourcesForFullHydrate(jurisdiction: string): HydrationSource[] {
  if (jurisdiction === "*") return [];
  if (jurisdiction === "us-federal") return ["congress", "openfec"];
  return ["openstates"];
}

export async function ensureFresh(
  db: Database.Database,
  source: HydrationSource,
  jurisdiction: string,
  scope: HydrationScope,
  rateLimiterWaitMs: () => number,
): Promise<EnsureFreshResult> {
  if (isFresh(db, source, jurisdiction, scope)) return { ok: true };

  const key = `${source}:${jurisdiction}:${scope}`;
  return sf.do(key, async () => {
    if (isFresh(db, source, jurisdiction, scope)) return { ok: true };

    const b = budget.check(source);
    if (!b.allowed) {
      return staleResult(db, source, jurisdiction, scope, {
        reason: "daily_budget_exhausted",
        message: `Daily request budget for ${source} exhausted; serving stale local data.`,
      });
    }

    const wait = rateLimiterWaitMs();
    if (wait > RATE_LIMIT_WAIT_THRESHOLD_MS) {
      return staleResult(db, source, jurisdiction, scope, {
        reason: "rate_limited",
        message: `Rate limit for ${source} requires ${Math.ceil(wait / 1000)}s wait; serving stale local data.`,
        retry_after_s: Math.ceil(wait / 1000),
      });
    }

    try {
      const deadline = scope === "full"
        ? Date.now() + FULL_HYDRATE_DEADLINE_MS
        : undefined;
      const maxPages = scope === "full"
        ? FULL_HYDRATE_MAX_PAGES
        : RECENT_HYDRATE_MAX_PAGES;

      await refreshSource(db, {
        source,
        jurisdictions: jurisdictionArg(source, jurisdiction),
        maxPages,
        deadline,
      });
      budget.record(source);

      const partial = scope === "full" && deadline !== undefined && Date.now() >= deadline;
      markFresh(db, source, jurisdiction, scope, partial ? "partial" : "complete");

      if (partial) {
        return {
          ok: true,
          stale_notice: {
            as_of: new Date().toISOString(),
            reason: "partial_hydrate",
            message: `Hydration for ${jurisdiction} exceeded the ${FULL_HYDRATE_DEADLINE_MS / 1000}s budget; partial data returned.`,
            completeness: "active_session_only",
          },
        };
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof ConfigurationError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("hydrate failed", { source, jurisdiction, scope, error: msg });
      return staleResult(db, source, jurisdiction, scope, {
        reason: "upstream_failure",
        message: `Upstream ${source} fetch failed; serving stale local data. ${msg}`,
      });
    }
  });
}

function jurisdictionArg(source: HydrationSource, jurisdiction: string): string[] | undefined {
  if (source !== "openstates") return undefined;
  return [jurisdiction.replace(/^us-/, "")];
}

function staleResult(
  db: Database.Database,
  source: HydrationSource,
  jurisdiction: string,
  scope: HydrationScope,
  noticeBase: Omit<StaleNotice, "as_of">,
): EnsureFreshResult {
  const existing = getFreshness(db, source, jurisdiction, scope);
  const as_of = existing?.last_fetched_at ?? new Date(0).toISOString();
  return {
    ok: false,
    stale_notice: { as_of, ...noticeBase },
  };
}

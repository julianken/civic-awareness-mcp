import type Database from "better-sqlite3";
import type { StaleNotice } from "../mcp/shared.js";
import { OpenStatesAdapter, BillNotFoundError } from "../adapters/openstates.js";
import { logger } from "../util/logger.js";
import { requireEnv } from "../util/env.js";
import { getLimiter } from "./limiters.js";

const FRESH_TTL_MS = 60 * 60 * 1000;

export interface EnsureBillInput {
  jurisdiction: string;
  session: string;
  identifier: string;
}

export interface EnsureBillResult {
  ok: boolean;
  stale_notice?: StaleNotice;
}

interface Row { fetched_at: string }

/** Per-document freshness check (R14 / D11). */
export async function ensureBillFresh(
  db: Database.Database,
  input: EnsureBillInput,
): Promise<EnsureBillResult> {
  if (input.jurisdiction === "us-federal") {
    return {
      ok: false,
      stale_notice: {
        as_of: new Date().toISOString(),
        reason: "not_yet_supported",
        message: "Federal bill detail not yet implemented; use recent_bills for listings.",
      },
    };
  }

  const existing = db
    .prepare(
      `SELECT fetched_at FROM documents
        WHERE source_name = 'openstates' AND kind = 'bill'
          AND jurisdiction = ?
          AND title LIKE ? || ' — %'
          AND json_extract(raw, '$.session') = ?`,
    )
    .get(input.jurisdiction, input.identifier, input.session) as Row | undefined;

  if (existing) {
    const ageMs = Date.now() - Date.parse(existing.fetched_at);
    if (ageMs < FRESH_TTL_MS) return { ok: true };
  }

  try {
    const adapter = new OpenStatesAdapter({
      apiKey: requireEnv("OPENSTATES_API_KEY"),
      rateLimiter: getLimiter("openstates"),
    });
    await adapter.fetchBill(db, input);
    return { ok: true };
  } catch (err) {
    if (err instanceof BillNotFoundError) {
      return {
        ok: false,
        stale_notice: {
          as_of: new Date().toISOString(),
          reason: "not_found",
          message: err.message,
        },
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("ensureBillFresh failed", {
      jurisdiction: input.jurisdiction, session: input.session,
      identifier: input.identifier, error: msg,
    });
    const as_of = existing?.fetched_at ?? new Date(0).toISOString();
    return {
      ok: existing !== undefined,
      stale_notice: {
        as_of,
        reason: "upstream_failure",
        message: `Upstream openstates fetch failed; ${existing ? "serving stale local data" : "no local data available"}. ${msg}`,
      },
    };
  }
}

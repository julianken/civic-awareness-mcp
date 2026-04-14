import type Database from "better-sqlite3";
import type { StaleNotice } from "../mcp/shared.js";
import { CongressAdapter, VoteNotFoundError } from "../adapters/congress.js";
import { getLimiter } from "./limiters.js";
import { requireEnv } from "../util/env.js";
import { logger } from "../util/logger.js";

const FRESH_TTL_MS = 60 * 60 * 1000;

export interface FederalVoteComposite {
  congress: number;
  chamber: "upper" | "lower";
  session: 1 | 2;
  roll_number: number;
}

export interface EnsureVoteInput {
  vote_id?: string;
  composite?: FederalVoteComposite;
}

export interface EnsureVoteResult {
  ok: boolean;
  documentId?: string;
  stale_notice?: StaleNotice;
}

interface Row {
  id: string;
  fetched_at: string;
}

/** Resolve a `documents` row for the requested vote, either directly
 *  by `vote_id` or by upserting via the federal composite. Same
 *  per-document TTL rules as `ensureBillFresh` (R14 / D11). */
export async function ensureVoteFresh(
  db: Database.Database,
  input: EnsureVoteInput,
): Promise<EnsureVoteResult> {
  let existing: Row | undefined;

  if (input.vote_id) {
    existing = db
      .prepare(
        "SELECT id, fetched_at FROM documents WHERE id = ? AND kind = 'vote'",
      )
      .get(input.vote_id) as Row | undefined;

    if (!existing && !input.composite) {
      return {
        ok: false,
        stale_notice: {
          as_of: new Date().toISOString(),
          reason: "not_found",
          message: `Vote ${input.vote_id} not found in local store and no composite provided for upstream fetch.`,
        },
      };
    }
  }

  if (!existing && input.composite) {
    const chamberLower = input.composite.chamber === "upper" ? "senate" : "house";
    const sourceId = `vote-${input.composite.congress}-${chamberLower}-${input.composite.roll_number}`;
    existing = db
      .prepare(
        "SELECT id, fetched_at FROM documents WHERE source_name = 'congress' AND source_id = ?",
      )
      .get(sourceId) as Row | undefined;
  }

  if (existing) {
    const ageMs = Date.now() - Date.parse(existing.fetched_at);
    if (ageMs < FRESH_TTL_MS) {
      return { ok: true, documentId: existing.id };
    }
  }

  if (!input.composite) {
    return existing
      ? { ok: true, documentId: existing.id }
      : {
          ok: false,
          stale_notice: {
            as_of: new Date().toISOString(),
            reason: "not_found",
            message: "Vote not in local store and no composite provided for upstream fetch.",
          },
        };
  }

  try {
    const adapter = new CongressAdapter({
      apiKey: requireEnv("API_DATA_GOV_KEY"),
      rateLimiter: getLimiter("congress"),
    });
    const { documentId } = await adapter.fetchVote(db, input.composite);
    return { ok: true, documentId };
  } catch (err) {
    if (err instanceof VoteNotFoundError) {
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
    logger.warn("ensureVoteFresh upstream failed", {
      composite: input.composite,
      error: msg,
    });
    const as_of = existing?.fetched_at ?? new Date(0).toISOString();
    return {
      ok: existing !== undefined,
      documentId: existing?.id,
      stale_notice: {
        as_of,
        reason: "upstream_failure",
        message: `Upstream congress fetch failed; ${existing ? "serving stale local data" : "no local data available"}. ${msg}`,
      },
    };
  }
}

import type Database from "better-sqlite3";
import { ensureVoteFresh, type EnsureVoteInput } from "../hydrate_vote.js";
import { GetVoteInput } from "../schemas.js";
import type { StaleNotice } from "../../core/shared.js";
import { logger } from "../../util/logger.js";
import { EXTERNAL_ID_PATHS } from "../../core/entities.js";

/**
 * Tally counts mirror Congress.gov's totals block. `not_voting` is the
 * upstream's `notVoting` field, which conflates pairs, announced
 * positions, and physical absences — semantically broader than "absent."
 */
export interface VoteTally {
  yea: number;
  nay: number;
  present: number;
  not_voting: number;
}

export interface VotePosition {
  entity_id: string | null;
  name: string;
  party: string | null;
  state?: string;
  vote: "yea" | "nay" | "present" | "not_voting";
}

export interface VoteDetail {
  id: string;
  bill_identifier: string | null;
  jurisdiction: string;
  session: string;
  chamber: "upper" | "lower";
  date: string;
  result: string;
  tally: VoteTally;
  positions: VotePosition[];
  source_url: string;
  fetched_at: string;
}

export interface GetVoteResponse {
  vote: VoteDetail | null;
  sources: Array<{ name: string; url: string }>;
  stale_notice?: StaleNotice;
}

interface Row {
  id: string;
  jurisdiction: string;
  occurred_at: string;
  fetched_at: string;
  source_name: string;
  source_url: string;
  raw: string;
}

interface RawPosition {
  bioguideId: string;
  name: string;
  party: string | null;
  state: string | null;
  position: string;
}

interface RawShape {
  congress?: number;
  chamber?: string;
  rollNumber?: number;
  question?: string;
  result?: string;
  bill?: { type?: string; number?: string } | null;
  totals?: { yea?: number; nay?: number; present?: number; notVoting?: number };
  positions?: RawPosition[];
}

function normaliseChamber(raw: string | undefined): "upper" | "lower" {
  return (raw ?? "").toLowerCase().includes("senate") ? "upper" : "lower";
}

// Defensive guard: the Congress adapter (`normalizeVotePosition`)
// already lowercases and snake-cases positions before write. This guard
// catches anything that bypasses the adapter (raw fixture imports,
// future adapters) so the projection's union type stays honest.
function normalisePosition(p: string): VotePosition["vote"] {
  if (p === "yea" || p === "nay" || p === "present") return p;
  return "not_voting";
}

export async function handleGetVote(
  db: Database.Database,
  rawInput: unknown,
): Promise<GetVoteResponse> {
  const input = GetVoteInput.parse(rawInput);

  const ensureInput: EnsureVoteInput = {
    vote_id: input.vote_id,
    composite:
      input.congress !== undefined &&
      input.chamber !== undefined &&
      input.session !== undefined &&
      input.roll_number !== undefined
        ? {
            congress: input.congress,
            chamber: input.chamber,
            session: input.session,
            roll_number: input.roll_number,
          }
        : undefined,
  };

  const freshness = await ensureVoteFresh(db, ensureInput);

  const sources = [{ name: "congress", url: "https://www.congress.gov/" }];

  if (!freshness.documentId) {
    return {
      vote: null,
      sources,
      ...(freshness.stale_notice ? { stale_notice: freshness.stale_notice } : {}),
    };
  }

  const row = db
    .prepare(
      `SELECT id, jurisdiction, occurred_at, fetched_at, source_name, source_url, raw
         FROM documents
        WHERE id = ? AND kind = 'vote'`,
    )
    .get(freshness.documentId) as Row | undefined;

  if (!row) {
    const raceNotice: StaleNotice = freshness.stale_notice ?? {
      as_of: new Date().toISOString(),
      reason: "not_found",
      message: `Vote ${freshness.documentId} resolved via ensureVoteFresh but row missing in local store (race).`,
    };
    return {
      vote: null,
      sources,
      stale_notice: raceNotice,
    };
  }

  const raw = JSON.parse(row.raw) as RawShape;
  const totals = raw.totals ?? {};
  const tally: VoteTally = {
    yea: totals.yea ?? 0,
    nay: totals.nay ?? 0,
    present: totals.present ?? 0,
    not_voting: totals.notVoting ?? 0,
  };
  const billIdentifier =
    raw.bill && raw.bill.type && raw.bill.number
      ? `${raw.bill.type.toUpperCase()}${raw.bill.number}`
      : null;

  const entityByBioguide = db.prepare(
    `SELECT id FROM entities
      WHERE json_extract(external_ids, '${EXTERNAL_ID_PATHS.bioguide}') = ?`,
  );
  const positions: VotePosition[] = (raw.positions ?? []).map((p) => {
    const ent = entityByBioguide.get(p.bioguideId) as { id: string } | undefined;
    const position: VotePosition = {
      entity_id: ent?.id ?? null,
      name: p.name,
      party: p.party,
      vote: normalisePosition(p.position),
    };
    if (p.state) position.state = p.state;
    return position;
  });

  const projectedTally: VoteTally = {
    yea: 0,
    nay: 0,
    present: 0,
    not_voting: 0,
  };
  for (const p of positions) projectedTally[p.vote] += 1;
  if (
    projectedTally.yea !== tally.yea ||
    projectedTally.nay !== tally.nay ||
    projectedTally.present !== tally.present ||
    projectedTally.not_voting !== tally.not_voting
  ) {
    logger.warn("get_vote tally drift: projected positions do not match upstream totals", {
      vote_id: row.id,
      upstream: tally,
      projected: projectedTally,
    });
  }

  const session = raw.congress !== undefined ? String(raw.congress) : "";

  const vote: VoteDetail = {
    id: row.id,
    bill_identifier: billIdentifier,
    jurisdiction: row.jurisdiction,
    session,
    chamber: normaliseChamber(raw.chamber),
    date: row.occurred_at,
    result: raw.result ?? "result_missing",
    tally,
    positions,
    source_url: row.source_url,
    fetched_at: row.fetched_at,
  };

  return {
    vote,
    sources,
    ...(freshness.stale_notice ? { stale_notice: freshness.stale_notice } : {}),
  };
}

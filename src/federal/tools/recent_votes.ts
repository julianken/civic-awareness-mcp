import type Database from "better-sqlite3";
import { CongressAdapter } from "../adapters/congress.js";
import { queryDocuments } from "../../core/documents.js";
import { getLimiter } from "../limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import { requireEnv } from "../../util/env.js";
import { RecentVotesInput } from "../schemas.js";
import { emptyFeedDiagnostic, type EmptyFeedDiagnostic, type StaleNotice } from "../../core/shared.js";

export interface VoteTally {
  yea: number;
  nay: number;
  present: number;
  absent: number;
}

export interface VoteSummary {
  id: string;
  bill_identifier: string;
  chamber: string;
  date: string;
  result: string;
  tally: VoteTally;
  source_url: string;
}

export interface RecentVotesResponse {
  results: VoteSummary[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  window: { from: string; to: string };
  empty_reason?: EmptyFeedDiagnostic["empty_reason"];
  data_freshness?: EmptyFeedDiagnostic["data_freshness"];
  hint?: string;
  stale_notice?: StaleNotice;
}

const CHAMBER_MAP: Record<string, string> = {
  upper: "senate",
  lower: "house",
};

/**
 * Returns recent roll-call votes for the given jurisdiction.
 *
 * R15 vertical: thin orchestrator around `withShapedFetch`. Only
 * `us-federal` hydrates — votes are fetched via
 * `CongressAdapter.fetchRecentVotes`. State jurisdictions short-circuit
 * to local-only because OpenStates doesn't expose a `/votes` feed
 * endpoint and state vote ingestion remains deferred.
 */
export async function handleRecentVotes(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentVotesResponse> {
  const input = RecentVotesInput.parse(rawInput);
  const to = new Date();
  const from = new Date(to.getTime() - input.days * 86400 * 1000);

  const projectLocal = (): RecentVotesResponse => {
    const docs = input.session
      ? queryDocuments(db, {
          kind: "vote",
          jurisdiction: input.jurisdiction,
          limit: 200,
        })
      : queryDocuments(db, {
          kind: "vote",
          jurisdiction: input.jurisdiction,
          from: from.toISOString(),
          to: to.toISOString(),
          limit: 200,
        });

    const sessionFiltered = input.session
      ? docs.filter((d) => (d.raw as { session?: string }).session === input.session)
      : docs;

    const chamberFilter = input.chamber ? CHAMBER_MAP[input.chamber] : undefined;

    const filtered = sessionFiltered.filter((d) => {
      const raw = d.raw as {
        chamber?: string;
        bill?: { type?: string; number?: string };
      };
      if (chamberFilter) {
        const docChamber = (raw.chamber ?? "").toLowerCase();
        if (!docChamber.includes(chamberFilter)) return false;
      }
      if (input.bill_identifier) {
        const bill = raw.bill;
        if (!bill) return false;
        const docBillId = `${bill.type ?? ""}${bill.number ?? ""}`.toUpperCase();
        if (docBillId !== input.bill_identifier.toUpperCase()) return false;
      }
      return true;
    });

    const results: VoteSummary[] = filtered.map((d) => {
      const raw = d.raw as {
        chamber?: string;
        result?: string;
        bill?: { type?: string; number?: string };
        totals?: { yea?: number; nay?: number; present?: number; notVoting?: number };
      };
      const totals = raw.totals ?? {};
      const tally: VoteTally = {
        yea: totals.yea ?? 0,
        nay: totals.nay ?? 0,
        present: totals.present ?? 0,
        absent: totals.notVoting ?? 0,
      };
      const bill = raw.bill;
      const billIdentifier = bill ? `${bill.type ?? ""}${bill.number ?? ""}`.toUpperCase() : "unknown";
      return {
        id: d.id,
        bill_identifier: billIdentifier,
        chamber: raw.chamber ?? "unknown",
        date: d.occurred_at,
        result: raw.result ?? "unknown",
        tally,
        source_url: d.source.url,
      };
    });

    // Build source URLs from each document's actual source_name —
    // congress for federal votes, openstates when state vote ingestion lands.
    // Matches the pattern in get_entity.ts.
    const sourceByName = new Map<string, string>();
    for (const d of filtered) {
      if (sourceByName.has(d.source.name)) continue;
      if (d.source.name === "congress") {
        sourceByName.set(d.source.name, "https://www.congress.gov/");
      } else if (d.source.name === "openstates") {
        const stateAbbr = d.jurisdiction.replace(/^us-/, "");
        const url = d.jurisdiction === "*"
          ? "https://openstates.org/"
          : `https://openstates.org/${stateAbbr}/`;
        sourceByName.set(d.source.name, url);
      } else {
        sourceByName.set(d.source.name, "");
      }
    }

    const base: RecentVotesResponse = {
      results,
      total: results.length,
      sources: Array.from(sourceByName, ([name, url]) => ({ name, url })),
      window: { from: from.toISOString(), to: to.toISOString() },
    };
    if (results.length === 0) {
      const diag = emptyFeedDiagnostic(db, { jurisdiction: input.jurisdiction, kind: "vote" });
      return { ...base, ...diag };
    }
    return base;
  };

  // Votes only have a federal source today; state jurisdictions go local-only.
  if (input.jurisdiction !== "us-federal") {
    return projectLocal();
  }

  const fetchAndWrite = async (): Promise<{ primary_rows_written: number }> => {
    const adapter = new CongressAdapter({
      apiKey: requireEnv("API_DATA_GOV_KEY"),
      rateLimiter: getLimiter("congress"),
    });
    const result = await adapter.fetchRecentVotes(db, { chamber: input.chamber });
    return { primary_rows_written: result.documentsUpserted };
  };

  const result = await withShapedFetch(
    db,
    {
      source: "congress",
      endpoint_path: "/vote",
      args: {
        jurisdiction: input.jurisdiction,
        days: input.days,
        chamber: input.chamber,
        session: input.session,
        bill_identifier: input.bill_identifier,
      },
      tool: "recent_votes",
    },
    { scope: "recent", ms: 60 * 60 * 1000 },
    fetchAndWrite,
    projectLocal,
    () => getLimiter("congress").peekWaitMs(),
  );

  return result.stale_notice
    ? { ...result.value, stale_notice: result.stale_notice }
    : result.value;
}

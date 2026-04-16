import type Database from "better-sqlite3";
import { OpenStatesAdapter } from "../adapters/openstates.js";
import { queryDocuments } from "../../core/documents.js";
import { getLimiter } from "../limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import { requireEnv } from "../../util/env.js";
import { RecentVotesInput } from "../schemas.js";
import { emptyFeedDiagnostic, type EmptyFeedDiagnostic, type StaleNotice } from "../../core/shared.js";

export interface VoteTally {
  yes: number;
  no: number;
  not_voting: number;
}

export interface VoteSummary {
  id: string;
  bill_identifier: string;
  chamber: string;
  date: string;
  result: string;
  motion_text: string;
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

export async function handleRecentVotes(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentVotesResponse> {
  const input = RecentVotesInput.parse(rawInput);
  const to = new Date();
  const from = new Date(to.getTime() - input.days * 86400 * 1000);

  const projectLocal = (): RecentVotesResponse => {
    const isWildcard = input.jurisdiction === "*";

    const docs = queryDocuments(db, {
      kind: "vote",
      ...(isWildcard ? {} : { jurisdiction: input.jurisdiction }),
      from: from.toISOString(),
      to: to.toISOString(),
      limit: Math.max(input.limit ?? 200, 200),
    });

    const chamberFiltered = input.chamber
      ? docs.filter((d) => {
          const raw = d.raw as { chamber?: string };
          return raw.chamber === input.chamber;
        })
      : docs;

    const sessionFiltered = input.session
      ? chamberFiltered.filter((d) => {
          const raw = d.raw as { bill?: { session?: string } };
          return raw.bill?.session === input.session;
        })
      : chamberFiltered;

    const capped = input.limit !== undefined
      ? sessionFiltered.slice(0, input.limit)
      : sessionFiltered;

    const results: VoteSummary[] = capped.map((d) => {
      const raw = d.raw as {
        chamber?: string;
        result?: string;
        motion_text?: string;
        counts?: Array<{ option: string; value: number }>;
        bill?: { identifier?: string };
      };
      const counts = raw.counts ?? [];
      const tally: VoteTally = {
        yes: counts.find((c) => c.option === "yes")?.value ?? 0,
        no: counts.find((c) => c.option === "no")?.value ?? 0,
        not_voting: counts.find((c) => c.option === "not voting")?.value ?? 0,
      };
      return {
        id: d.id,
        bill_identifier: raw.bill?.identifier ?? "unknown",
        chamber: raw.chamber ?? "unknown",
        date: d.occurred_at,
        result: raw.result ?? "unknown",
        motion_text: raw.motion_text ?? "",
        tally,
        source_url: d.source.url,
      };
    });

    const abbr = isWildcard ? "" : input.jurisdiction.replace(/^us-/, "");
    const sourceUrl = isWildcard
      ? "https://openstates.org/"
      : `https://openstates.org/${abbr}/`;

    const base: RecentVotesResponse = {
      results,
      total: results.length,
      sources: [{ name: "openstates", url: sourceUrl }],
      window: { from: from.toISOString(), to: to.toISOString() },
    };

    if (results.length === 0) {
      const diag = emptyFeedDiagnostic(db, {
        kind: "vote",
        jurisdiction: input.jurisdiction,
      });
      return { ...base, ...diag };
    }
    return base;
  };

  if (input.jurisdiction === "*") {
    return projectLocal();
  }

  const fetchAndWrite = async (): Promise<{ primary_rows_written: number }> => {
    const adapter = new OpenStatesAdapter({
      apiKey: requireEnv("OPENSTATES_API_KEY"),
      rateLimiter: getLimiter("openstates"),
    });
    const stateAbbr = input.jurisdiction.replace(/^us-/, "");
    const updatedSince = from.toISOString().slice(0, 19);
    const { documentsUpserted } = await adapter.fetchRecentVotes(db, {
      jurisdiction: stateAbbr,
      updated_since: updatedSince,
      limit: input.limit,
    });
    return { primary_rows_written: documentsUpserted };
  };

  const result = await withShapedFetch(
    db,
    {
      source: "openstates",
      endpoint_path: "/bills?include=votes",
      args: {
        jurisdiction: input.jurisdiction,
        days: input.days,
        chamber: input.chamber,
        session: input.session,
        limit: input.limit,
      },
      tool: "recent_votes",
    },
    { scope: "recent", ms: 60 * 60 * 1000 },
    fetchAndWrite,
    projectLocal,
    () => getLimiter("openstates").peekWaitMs(),
  );

  return result.stale_notice
    ? { ...result.value, stale_notice: result.stale_notice }
    : result.value;
}

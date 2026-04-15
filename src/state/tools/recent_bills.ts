import type Database from "better-sqlite3";
import { OpenStatesAdapter } from "../adapters/openstates.js";
import { queryDocuments } from "../../core/documents.js";
import { getLimiter } from "../limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import type { EntityReference } from "../../core/types.js";
import { requireEnv } from "../../util/env.js";
import { logger } from "../../util/logger.js";
import { RecentBillsInput } from "../schemas.js";
import { emptyFeedDiagnostic, type EmptyFeedDiagnostic, type StaleNotice } from "../../core/shared.js";

const MAX_WARN_PER_CALL = 3;

export interface SponsorSummary {
  count: number;
  by_party: Record<string, number>;
  top: Array<{
    entity_id: string;
    name: string;
    party?: string;
    role: "sponsor" | "cosponsor";
  }>;
}

export interface BillSummary {
  id: string;
  identifier: string;
  title: string;
  latest_action: { date: string; description: string } | null;
  sponsor_summary: SponsorSummary;
  source_url: string;
}

export interface RecentBillsResponse {
  results: BillSummary[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  window: { from: string; to: string };
  empty_reason?: EmptyFeedDiagnostic["empty_reason"];
  data_freshness?: EmptyFeedDiagnostic["data_freshness"];
  hint?: string;
  filters_applied?: EmptyFeedDiagnostic["filters_applied"];
  stale_notice?: StaleNotice;
}

export function projectLatestAction(
  raw: Record<string, unknown>,
): { date: string; description: string } | null {
  const actions = raw.actions as Array<Record<string, unknown>> | undefined;
  if (!actions?.length) return null;
  const last = actions[actions.length - 1];
  const date = typeof last.date === "string" ? last.date : null;
  const description = typeof last.description === "string" ? last.description : null;
  if (date === null || description === null) return null;
  return { date, description };
}

export function buildSponsorSummary(
  db: Database.Database,
  refs: EntityReference[],
): SponsorSummary {
  const filtered = refs.filter((r) => r.role === "sponsor" || r.role === "cosponsor");
  if (filtered.length === 0) {
    return { count: 0, by_party: {}, top: [] };
  }
  const allPlaceholders = filtered.map(() => "?").join(",");
  const allRows = db
    .prepare(`SELECT id, name, metadata FROM entities WHERE id IN (${allPlaceholders})`)
    .all(...filtered.map((r) => r.entity_id)) as Array<{ id: string; name: string; metadata: string }>;
  const byId = new Map(
    allRows.map((r) => [
      r.id,
      { name: r.name, meta: JSON.parse(r.metadata) as { party?: string } },
    ]),
  );

  const by_party: Record<string, number> = {};
  for (const r of filtered) {
    const e = byId.get(r.entity_id);
    const party = e?.meta.party ?? "unknown";
    by_party[party] = (by_party[party] ?? 0) + 1;
  }

  const TOP_N = 5;
  const primaries = filtered.filter((r) => r.role === "sponsor");
  const cosponsors = filtered.filter((r) => r.role === "cosponsor");
  const topRefs = [...primaries, ...cosponsors].slice(0, TOP_N);

  const top = topRefs.map((r) => {
    const e = byId.get(r.entity_id);
    return {
      entity_id: r.entity_id,
      name: e?.name ?? "Unknown",
      party: e?.meta.party,
      role: r.role as "sponsor" | "cosponsor",
    };
  });

  return { count: filtered.length, by_party, top };
}

export async function handleRecentBills(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentBillsResponse> {
  const input = RecentBillsInput.parse(rawInput);

  const to = new Date();
  const from = new Date(to.getTime() - input.days * 86400 * 1000);

  const projectLocal = (jurisdiction: string): RecentBillsResponse => {
    const isWildcard = jurisdiction === "*";
    const ceiling = Math.max(50, (input.limit ?? 0) * 3);

    const docs = input.session
      ? queryDocuments(db, {
          kind: "bill",
          ...(isWildcard ? {} : { jurisdiction }),
          limit: Math.max(100, ceiling),
        })
      : input.limit !== undefined
        ? queryDocuments(db, {
            kind: "bill",
            ...(isWildcard ? {} : { jurisdiction }),
            limit: ceiling,
          })
        : queryDocuments(db, {
            kind: "bill",
            ...(isWildcard ? {} : { jurisdiction }),
            from: from.toISOString(),
            to: to.toISOString(),
            limit: 50,
          });

    const sessionFiltered = input.session
      ? docs.filter((d) => (d.raw as { session?: string }).session === input.session)
      : docs;

    const filtered = input.chamber
      ? sessionFiltered.filter((d) => {
          const raw = d.raw as { from_organization?: { classification?: string } };
          return raw.from_organization?.classification === input.chamber;
        })
      : sessionFiltered;

    let titleSplitWarns = 0;
    const results: BillSummary[] = filtered.map((d) => {
      const [identifier, ...titleParts] = d.title.split(" — ");
      if (titleParts.length === 0 && titleSplitWarns < MAX_WARN_PER_CALL) {
        logger.warn("recent_bills: title missing ' — ' separator; identifier and title duplicated", {
          document_id: d.id,
          title: d.title,
        });
        titleSplitWarns++;
      }
      return {
        id: d.id,
        identifier: identifier?.trim() ?? d.title,
        title: titleParts.join(" — ").trim() || d.title,
        latest_action: projectLatestAction(d.raw),
        sponsor_summary: buildSponsorSummary(db, d.references),
        source_url: d.source.url,
      };
    });

    const capped = input.limit !== undefined
      ? results.slice(0, input.limit)
      : results;

    const abbr = isWildcard ? "" : jurisdiction.replace(/^us-/, "");
    const sourceUrl = isWildcard ? "https://openstates.org/" : `https://openstates.org/${abbr}/`;

    const base: RecentBillsResponse = {
      results: capped,
      total: capped.length,
      sources: [{ name: "openstates", url: sourceUrl }],
      window: { from: from.toISOString(), to: to.toISOString() },
    };
    if (capped.length === 0 && !isWildcard) {
      const filtersApplied: string[] = [];
      if (input.session) filtersApplied.push("session");
      if (input.chamber) filtersApplied.push("chamber");
      const diag = emptyFeedDiagnostic(db, {
        kind: "bill",
        jurisdiction,
        preFilterCount: docs.length,
        filtersApplied,
      });
      return { ...base, ...diag };
    }
    return base;
  };

  // Wildcard short-circuits to local-only.
  if (input.jurisdiction === "*") {
    return projectLocal("*");
  }

  const jurisdiction = input.jurisdiction;

  const fetchAndWrite = async (): Promise<{ primary_rows_written: number }> => {
    const adapter = new OpenStatesAdapter({
      apiKey: requireEnv("OPENSTATES_API_KEY"),
      rateLimiter: getLimiter("openstates"),
    });
    const stateAbbr = jurisdiction.replace(/^us-/, "");
    const fromDateTime = input.limit !== undefined
      ? new Date(to.getTime() - 365 * 86400 * 1000).toISOString().slice(0, 19)
      : from.toISOString().slice(0, 19);
    const { documentsUpserted } = await adapter.fetchRecentBills(db, {
      jurisdiction: stateAbbr,
      updated_since: fromDateTime,
      chamber: input.chamber,
      limit: input.limit,
    });
    return { primary_rows_written: documentsUpserted };
  };

  const result = await withShapedFetch(
    db,
    {
      source: "openstates",
      endpoint_path: "/bills",
      args: {
        jurisdiction,
        days: input.days,
        chamber: input.chamber,
        session: input.session,
        limit: input.limit,
      },
      tool: "recent_bills",
    },
    { scope: "recent", ms: 60 * 60 * 1000 },
    fetchAndWrite,
    () => projectLocal(jurisdiction),
    () => getLimiter("openstates").peekWaitMs(),
  );

  if (result.stale_notice) {
    return { ...result.value, stale_notice: result.stale_notice };
  }
  return result.value;
}

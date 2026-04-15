import type Database from "better-sqlite3";
import { CongressAdapter } from "../adapters/congress.js";
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
  // Single batched SELECT for all sponsor metadata (by_party aggregate).
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

  // Top-N selection: primaries first (capped at 5), then cosponsors fill the rest.
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

/**
 * Returns recently-updated bills for the given jurisdiction.
 *
 * Sort order is **last-updated desc**, not introduced-date — upstream
 * APIs (OpenStates `sort=updated_desc`, Congress.gov
 * `sort=updateDate+desc`) place re-touched older bills above freshly
 * introduced ones when the older bill has the more recent activity.
 *
 * Semantics when both `days` and `limit` are set: BOTH apply as
 * upper bounds. The window filters; `limit` caps. When only `limit`
 * is set (callers omit `days`), the default `days=7` still applies
 * in the local projection, but the upstream `updated_since` filter
 * is dropped so biennial / off-session jurisdictions can surface
 * older entries. To ask for "last N ever," pass `days=365, limit=N`.
 *
 * R15 vertical: the handler is a thin orchestrator around
 * `withShapedFetch`. It branches on jurisdiction — `us-federal` uses
 * the Congress.gov adapter's `fetchRecentBills`, state jurisdictions
 * use the OpenStates adapter's `fetchRecentBills`. Wildcard `"*"`
 * short-circuits to local-only (no upstream fetch).
 *
 * Title format is always "IDENTIFIER — TITLE" — the handler splits on
 * " — " to separate `identifier` from `title` in the response.
 */
export async function handleRecentBills(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentBillsResponse> {
  const input = RecentBillsInput.parse(rawInput);

  // Federal package: jurisdiction is always "us-federal".
  const JURISDICTION = "us-federal" as const;
  const to = new Date();
  const from = new Date(to.getTime() - input.days * 86400 * 1000);

  const projectLocal = (): RecentBillsResponse => {
    // Headroom for chamber/session filters before the final cap.
    const ceiling = Math.max(50, (input.limit ?? 0) * 3);
    const docs = input.session
      ? queryDocuments(db, {
          kind: "bill",
          jurisdiction: JURISDICTION,
          limit: Math.max(100, ceiling),
        })
      : input.limit !== undefined
        ? queryDocuments(db, {
            kind: "bill",
            jurisdiction: JURISDICTION,
            limit: ceiling,
          })
        : queryDocuments(db, {
            kind: "bill",
            jurisdiction: JURISDICTION,
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

    const base: RecentBillsResponse = {
      results: capped,
      total: capped.length,
      sources: [{ name: "congress", url: "https://www.congress.gov/" }],
      window: { from: from.toISOString(), to: to.toISOString() },
    };
    if (capped.length === 0) {
      const filtersApplied: string[] = [];
      if (input.session) filtersApplied.push("session");
      if (input.chamber) filtersApplied.push("chamber");
      const diag = emptyFeedDiagnostic(db, {
        jurisdiction: JURISDICTION,
        kind: "bill",
        preFilterCount: docs.length,
        filtersApplied,
      });
      return { ...base, ...diag };
    }
    return base;
  };

  const fetchAndWrite = async (): Promise<{ primary_rows_written: number }> => {
    const adapter = new CongressAdapter({
      apiKey: requireEnv("API_DATA_GOV_KEY"),
      rateLimiter: getLimiter("congress"),
    });
    // Congress.gov requires fromDateTime for sort=updateDate+desc
    // to be meaningful; when `limit` is set we widen the window
    // to 365d so older re-touched bills can surface and the
    // native sort + limit do the real work.
    const fromDateTime = input.limit !== undefined
      ? new Date(to.getTime() - 365 * 86400 * 1000).toISOString()
      : from.toISOString();
    const { documentsUpserted } = await adapter.fetchRecentBills(db, {
      fromDateTime,
      chamber: input.chamber,
      limit: input.limit,
    });
    return { primary_rows_written: documentsUpserted };
  };

  const result = await withShapedFetch(
    db,
    {
      source: "congress",
      endpoint_path: "/bill",
      args: {
        jurisdiction: JURISDICTION,
        days: input.days,
        chamber: input.chamber,
        session: input.session,
        limit: input.limit,
      },
      tool: "recent_bills",
    },
    { scope: "recent", ms: 60 * 60 * 1000 },
    fetchAndWrite,
    projectLocal,
    () => getLimiter("congress").peekWaitMs(),
  );

  if (result.stale_notice) {
    return { ...result.value, stale_notice: result.stale_notice };
  }
  return result.value;
}

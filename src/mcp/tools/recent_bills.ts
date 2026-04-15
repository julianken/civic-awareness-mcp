import type Database from "better-sqlite3";
import { OpenStatesAdapter } from "../../adapters/openstates.js";
import { CongressAdapter } from "../../adapters/congress.js";
import { queryDocuments } from "../../core/documents.js";
import { findEntityById } from "../../core/entities.js";
import { getLimiter } from "../../core/limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import type { EntityReference } from "../../core/types.js";
import { requireEnv } from "../../util/env.js";
import { logger } from "../../util/logger.js";
import { RecentBillsInput } from "../schemas.js";
import { emptyFeedDiagnostic, type EmptyFeedDiagnostic, type StaleNotice } from "../shared.js";

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
  stale_notice?: StaleNotice;
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

  const to = new Date();
  const from = new Date(to.getTime() - input.days * 86400 * 1000);

  const projectLocal = (): RecentBillsResponse => {
    // Headroom for chamber/session filters before the final cap.
    const ceiling = Math.max(50, (input.limit ?? 0) * 3);
    const docs = input.session
      ? queryDocuments(db, {
          kind: "bill",
          jurisdiction: input.jurisdiction,
          limit: Math.max(100, ceiling),
        })
      : input.limit !== undefined
        ? queryDocuments(db, {
            kind: "bill",
            jurisdiction: input.jurisdiction,
            limit: ceiling,
          })
        : queryDocuments(db, {
            kind: "bill",
            jurisdiction: input.jurisdiction,
            from: from.toISOString(),
            to: to.toISOString(),
            limit: 50,
          });

    const sessionFiltered = input.session
      ? docs.filter((d) => (d.raw as { session?: string }).session === input.session)
      : docs;

    const filtered = input.chamber
      ? sessionFiltered.filter((d) => {
          const sponsor = d.references.find((r) => r.role === "sponsor");
          if (!sponsor) return false;
          const ent = findEntityById(db, sponsor.entity_id);
          return ent?.metadata.chamber === input.chamber;
        })
      : sessionFiltered;

    let titleSplitWarns = 0;
    const results: BillSummary[] = filtered.map((d) => {
      const [identifier, ...titleParts] = d.title.split(" — ");
      const actions = (d.raw.actions as Array<{ date: string; description: string }> | undefined) ?? [];
      const latest = actions.length ? actions[actions.length - 1] : null;
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
        latest_action: latest,
        sponsor_summary: buildSponsorSummary(db, d.references),
        source_url: d.source.url,
      };
    });

    const capped = input.limit !== undefined
      ? results.slice(0, input.limit)
      : results;

    // Build source URLs from each document's actual source_name —
    // openstates for state bills, congress for federal, etc. Matches
    // the pattern in get_entity.ts.
    const sourceByName = new Map<string, string>();
    let unknownSourceWarns = 0;
    for (const d of filtered) {
      if (sourceByName.has(d.source.name)) continue;
      if (d.source.name === "openstates") {
        const stateAbbr = d.jurisdiction.replace(/^us-/, "");
        const url = d.jurisdiction === "*"
          ? "https://openstates.org/"
          : `https://openstates.org/${stateAbbr}/`;
        sourceByName.set(d.source.name, url);
      } else if (d.source.name === "congress") {
        sourceByName.set(d.source.name, "https://www.congress.gov/");
      } else {
        if (unknownSourceWarns < MAX_WARN_PER_CALL) {
          logger.warn("recent_bills: unknown source name", { source: d.source.name });
          unknownSourceWarns++;
        }
        sourceByName.set(d.source.name, "");
      }
    }

    const base: RecentBillsResponse = {
      results: capped,
      total: capped.length,
      sources: Array.from(sourceByName, ([name, url]) => ({ name, url })),
      window: { from: from.toISOString(), to: to.toISOString() },
    };
    if (capped.length === 0) {
      const diag = emptyFeedDiagnostic(db, { jurisdiction: input.jurisdiction, kind: "bill" });
      return { ...base, ...diag };
    }
    return base;
  };

  // Wildcard: local-only. No hydration, no upstream fetch — matches
  // search-style behaviour.
  if (input.jurisdiction === "*") {
    return projectLocal();
  }

  const isFederal = input.jurisdiction === "us-federal";
  const source = isFederal ? "congress" as const : "openstates" as const;
  const endpoint_path = isFederal ? "/bill" : "/bills";

  const fetchAndWrite = async (): Promise<{ primary_rows_written: number }> => {
    if (isFederal) {
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
    }
    const adapter = new OpenStatesAdapter({
      apiKey: requireEnv("OPENSTATES_API_KEY"),
      rateLimiter: getLimiter("openstates"),
    });
    // When `limit` is set we drop updated_since so biennial / off-
    // session jurisdictions can return their last-N-updated bills
    // regardless of recency. See D12 / R16.
    const { documentsUpserted } = await adapter.fetchRecentBills(db, {
      jurisdiction: input.jurisdiction,
      updated_since: input.limit !== undefined
        ? undefined
        : from.toISOString().slice(0, 10),
      chamber: input.chamber,
      limit: input.limit,
    });
    return { primary_rows_written: documentsUpserted };
  };

  const result = await withShapedFetch(
    db,
    {
      source,
      endpoint_path,
      args: {
        jurisdiction: input.jurisdiction,
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
    () => getLimiter(source).peekWaitMs(),
  );

  if (result.stale_notice) {
    return { ...result.value, stale_notice: result.stale_notice };
  }
  return result.value;
}

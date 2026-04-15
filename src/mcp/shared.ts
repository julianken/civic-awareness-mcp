import type Database from "better-sqlite3";
import type { DocumentKind } from "../core/types.js";

export type EmptyReason = "no_events_in_window" | "unknown_jurisdiction" | "filter_eliminated_all";

export interface DataFreshness {
  last_refreshed_at: string | null;
  source: string | null;
}

export interface EmptyFeedDiagnostic {
  empty_reason: EmptyReason;
  data_freshness: DataFreshness;
  hint: string;
  filters_applied?: string[];
}

export interface EmptyFeedContext {
  jurisdiction: string;
  kind: DocumentKind;
  preFilterCount?: number;
  filtersApplied?: string[];
}

// Narrowed under R15 (docs/00-rationale.md:455). Retired members:
// `rate_limited`, `partial_hydrate`, `daily_budget_exhausted` —
// shaped-query hydration collapsed these into `upstream_failure`
// (with cached fallback) or surfaces them as transport-layer errors
// rather than partial responses.
export type StaleReason =
  | "upstream_failure"
  | "not_found"
  | "not_yet_supported";

export interface StaleNotice {
  as_of: string;
  reason: StaleReason;
  message: string;
  retry_after_s?: number;
  completeness?: string;
}

export function emptyFeedDiagnostic(
  db: Database.Database,
  ctx: EmptyFeedContext,
): EmptyFeedDiagnostic {
  if (ctx.preFilterCount !== undefined && ctx.preFilterCount > 0) {
    const filters = ctx.filtersApplied ?? [];
    return {
      empty_reason: "filter_eliminated_all",
      data_freshness: { last_refreshed_at: null, source: null },
      hint: `${ctx.preFilterCount} ${ctx.kind}(s) matched the window but were removed by filter(s): ${filters.join(", ")}.`,
      filters_applied: filters,
    };
  }

  // Unknown jurisdiction check first — "*" is a valid wildcard per D3b.
  if (ctx.jurisdiction !== "*") {
    const juris = db
      .prepare("SELECT 1 FROM jurisdictions WHERE id = ?")
      .get(ctx.jurisdiction) as unknown;
    if (!juris) {
      return {
        empty_reason: "unknown_jurisdiction",
        data_freshness: { last_refreshed_at: null, source: null },
        hint: `Jurisdiction "${ctx.jurisdiction}" is not seeded. Use "us-federal" or "us-<state-abbr>".`,
      };
    }
  }

  // Any documents of this kind in this jurisdiction at all?
  const latest = db
    .prepare(
      `SELECT fetched_at, source_name
         FROM documents
         WHERE kind = ? AND (jurisdiction = ? OR ? = '*')
         ORDER BY fetched_at DESC
         LIMIT 1`,
    )
    .get(ctx.kind, ctx.jurisdiction, ctx.jurisdiction) as
      | { fetched_at: string; source_name: string }
      | undefined;

  if (!latest) {
    return {
      empty_reason: "no_events_in_window",
      data_freshness: { last_refreshed_at: null, source: null },
      hint:
        `No ${ctx.kind}s for ${ctx.jurisdiction} returned by upstream. ` +
        "If this is unexpected, check stale_notice for hydrate failures.",
    };
  }

  return {
    empty_reason: "no_events_in_window",
    data_freshness: {
      last_refreshed_at: latest.fetched_at,
      source: latest.source_name,
    },
    hint: `Last ${ctx.kind} refresh landed ${latest.fetched_at.slice(0, 10)}. Try a wider window (days=365) or pass session=<id> to bypass the window.`,
  };
}

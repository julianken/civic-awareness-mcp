import type Database from "better-sqlite3";
import type { DocumentKind } from "../core/types.js";

export type EmptyReason = "no_refresh" | "no_events_in_window" | "unknown_jurisdiction";

export interface DataFreshness {
  last_refreshed_at: string | null;
  source: string | null;
}

export interface EmptyFeedDiagnostic {
  empty_reason: EmptyReason;
  data_freshness: DataFreshness;
  hint: string;
}

export interface EmptyFeedContext {
  jurisdiction: string;
  kind: DocumentKind;
}

export function emptyFeedDiagnostic(
  db: Database.Database,
  ctx: EmptyFeedContext,
): EmptyFeedDiagnostic {
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
    const hint = ctx.jurisdiction === "*"
      ? `No ${ctx.kind}s ingested yet. Run: pnpm refresh --source=openstates --jurisdictions=<state>`
      : `No ${ctx.kind}s ingested yet for ${ctx.jurisdiction}. Run: pnpm refresh --source=openstates --jurisdictions=${ctx.jurisdiction.replace(/^us-/, "")}`;
    return {
      empty_reason: "no_refresh",
      data_freshness: { last_refreshed_at: null, source: null },
      hint,
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

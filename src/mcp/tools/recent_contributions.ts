import type Database from "better-sqlite3";
import { OpenFecAdapter } from "../../adapters/openfec.js";
import { queryDocuments } from "../../core/documents.js";
import { getLimiter } from "../../core/limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import { requireEnv } from "../../util/env.js";
import { escapeLike } from "../../util/sql.js";
import { RecentContributionsInput } from "../schemas.js";
import { emptyFeedDiagnostic, type EmptyFeedDiagnostic, type StaleNotice } from "../shared.js";

export interface ContributorRef {
  name: string;
  entity_id?: string;
}

export interface RecipientRef {
  name: string;
  entity_id: string;
}

export interface ContributionSummary {
  id: string;
  amount: number;
  date: string;
  contributor: ContributorRef;
  recipient: RecipientRef;
  source_url: string;
}

export interface RecentContributionsResponse {
  results: ContributionSummary[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  window: { from: string; to: string };
  empty_reason?: EmptyFeedDiagnostic["empty_reason"];
  data_freshness?: EmptyFeedDiagnostic["data_freshness"];
  hint?: string;
  stale_notice?: StaleNotice;
}

/**
 * Returns recent federal campaign contributions within a time window.
 *
 * R15 vertical: thin orchestrator around `withShapedFetch`. OpenFEC is
 * federal-only (D2), so hydration is unconditional — no jurisdiction
 * branching. The narrow `fetchRecentContributions` call uses OpenFEC's
 * native `min_date`/`max_date` filters (MM/DD/YYYY). Candidate/committee
 * filtering remains client-side via a normalized-name LIKE search over
 * local `entities`.
 */
export async function handleRecentContributions(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentContributionsResponse> {
  const input = RecentContributionsInput.parse(rawInput);

  const toMMDDYYYY = (iso: string): string => {
    const d = new Date(iso);
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
  };

  const projectLocal = (): RecentContributionsResponse => {
    // If candidate_or_committee is given, resolve it to an entity UUID.
    // We match against normalized name (lowercased, punct-stripped) using
    // a LIKE search consistent with search_entities — but limit to
    // kinds that appear as recipients on contribution documents.
    let recipientEntityId: string | undefined;
    if (input.candidate_or_committee) {
      const q = input.candidate_or_committee
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const match = db
        .prepare(
          `SELECT id FROM entities
           WHERE kind IN ('pac', 'organization', 'committee', 'person')
             AND name_normalized LIKE ? ESCAPE '\\'
           LIMIT 1`,
        )
        .get(`%${escapeLike(q)}%`) as { id: string } | undefined;
      recipientEntityId = match?.id;
    }

    const docs = queryDocuments(db, {
      kind: "contribution",
      jurisdiction: "us-federal",
      from: input.window.from,
      to: input.window.to,
      limit: 200,
    });

    const results: ContributionSummary[] = [];

    for (const doc of docs) {
      const raw = doc.raw as {
        amount?: number;
        date?: string;
        contributor_name?: string;
      };

      const amount = raw.amount ?? 0;

      // min_amount filter.
      if (input.min_amount !== undefined && amount < input.min_amount) continue;

      // candidate_or_committee filter — check that the resolved entity is
      // the recipient on this document.
      if (recipientEntityId) {
        const isRecipient = doc.references.some(
          (r) => r.entity_id === recipientEntityId && r.role === "recipient",
        );
        if (!isRecipient) continue;
      }

      // Resolve contributor and recipient from document_references.
      const contribRef = doc.references.find((r) => r.role === "contributor");
      const recipientRef = doc.references.find((r) => r.role === "recipient");

      if (!recipientRef) continue;  // malformed document — skip

      // Look up entity names.
      const recipientRow = db
        .prepare("SELECT name FROM entities WHERE id = ?")
        .get(recipientRef.entity_id) as { name: string } | undefined;

      let contributorName = raw.contributor_name ?? "Unknown";
      let contributorEntityId: string | undefined;

      if (contribRef) {
        const contribRow = db
          .prepare("SELECT name FROM entities WHERE id = ?")
          .get(contribRef.entity_id) as { name: string } | undefined;
        if (contribRow) {
          contributorName = contribRow.name;
          contributorEntityId = contribRef.entity_id;
        }
      }

      results.push({
        id: doc.id,
        amount,
        date: raw.date ?? doc.occurred_at.slice(0, 10),
        // Address and employer deliberately omitted per docs/05-tool-surface.md.
        contributor: {
          name: contributorName,
          entity_id: contributorEntityId,
        },
        recipient: {
          name: recipientRow?.name ?? "Unknown",
          entity_id: recipientRef.entity_id,
        },
        source_url: doc.source.url,
      });
    }

    const base: RecentContributionsResponse = {
      results,
      total: results.length,
      sources: results.length > 0
        ? [{ name: "openfec", url: "https://www.fec.gov/" }]
        : [],
      window: input.window,
    };
    if (results.length === 0) {
      const diag = emptyFeedDiagnostic(db, { jurisdiction: "us-federal", kind: "contribution" });
      return { ...base, ...diag };
    }
    return base;
  };

  const fetchAndWrite = async (): Promise<{ primary_rows_written: number }> => {
    const adapter = new OpenFecAdapter({
      apiKey: requireEnv("API_DATA_GOV_KEY"),
      rateLimiter: getLimiter("openfec"),
    });
    const result = await adapter.fetchRecentContributions(db, {
      min_date: toMMDDYYYY(input.window.from),
      max_date: toMMDDYYYY(input.window.to),
    });
    return { primary_rows_written: result.documentsUpserted };
  };

  const result = await withShapedFetch(
    db,
    {
      source: "openfec",
      endpoint_path: "/schedules/schedule_a",
      args: {
        window: input.window,
        candidate_or_committee: input.candidate_or_committee,
        min_amount: input.min_amount,
      },
      tool: "recent_contributions",
    },
    { scope: "recent", ms: 60 * 60 * 1000 },
    fetchAndWrite,
    projectLocal,
    () => getLimiter("openfec").peekWaitMs(),
  );

  return result.stale_notice
    ? { ...result.value, stale_notice: result.stale_notice }
    : result.value;
}

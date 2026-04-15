import type Database from "better-sqlite3";
import { OpenFecAdapter } from "../adapters/openfec.js";
import { queryDocuments } from "../../core/documents.js";
import { findEntityById } from "../../core/entities.js";
import { getLimiter } from "../limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import { requireEnv } from "../../util/env.js";
import { logger } from "../../util/logger.js";
import { escapeLike } from "../../util/sql.js";
import { RecentContributionsInput } from "../schemas.js";
import { emptyFeedDiagnostic, type EmptyFeedDiagnostic, type StaleNotice } from "../../core/shared.js";

const MAX_WARN_PER_CALL = 3;

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

  // Default side semantics: when candidate_or_committee is set and side is
  // omitted, default to "recipient" for back-compat. When side is set, it
  // wins. contributor_entity_id is independent of `side` and always filters
  // the contributor side locally.
  const effectiveSide: "contributor" | "recipient" | "either" =
    input.side ?? (input.candidate_or_committee ? "recipient" : "either");

  // Resolve contributor entity once, up front — used by both projectLocal
  // (local entity_id filter) and fetchAndWrite (upstream contributor_name).
  let contributorEntity: { id: string; name: string } | undefined;
  if (input.contributor_entity_id) {
    const row = findEntityById(db, input.contributor_entity_id);
    if (!row) {
      logger.warn("recent_contributions: contributor entity not found", {
        id: input.contributor_entity_id,
      });
      throw new Error(`Entity not found: ${input.contributor_entity_id}`);
    }
    contributorEntity = { id: row.id, name: row.name };
  }

  // OpenFEC /schedules/schedule_a rejects requests that have only date-range
  // filters — it requires at least one of: committee_id, contributor_id,
  // contributor_name, contributor_city, contributor_zip, etc. Guard here so we
  // never hit that 400 path; return an empty diagnostic instead.
  const hasNarrowingFilter =
    input.contributor_entity_id !== undefined ||
    input.candidate_or_committee !== undefined;
  if (!hasNarrowingFilter) {
    return {
      results: [],
      total: 0,
      sources: [],
      window: input.window,
      empty_reason: "filter_eliminated_all",
      hint: "OpenFEC requires at least one narrowing filter. Pass contributor_entity_id or candidate_or_committee.",
    };
  }

  const toMMDDYYYY = (iso: string): string => {
    const d = new Date(iso);
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
  };

  const projectLocal = (): RecentContributionsResponse => {
    // candidate_or_committee resolves to a single best-match entity id.
    // Under `effectiveSide`, that match is applied to the contributor
    // side, recipient side, or either.
    let candOrCmteEntityId: string | undefined;
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
      candOrCmteEntityId = match?.id;
    }

    const docs = queryDocuments(db, {
      kind: "contribution",
      jurisdiction: "us-federal",
      from: input.window.from,
      to: input.window.to,
      limit: 200,
    });

    const results: ContributionSummary[] = [];
    let missingAmountWarns = 0;
    let malformedDocWarns = 0;
    let danglingFkWarns = 0;

    for (const doc of docs) {
      const raw = doc.raw as {
        amount?: number;
        date?: string;
        contributor_name?: string;
      };

      if (raw.amount == null) {
        if (missingAmountWarns < MAX_WARN_PER_CALL) {
          logger.warn("recent_contributions: contribution missing amount, skipping", {
            document_id: doc.id,
          });
          missingAmountWarns++;
        }
        continue;
      }
      const amount = raw.amount;

      // min_amount filter.
      if (input.min_amount !== undefined && amount < input.min_amount) continue;

      const contribRef = doc.references.find((r) => r.role === "contributor");
      const recipientRef = doc.references.find((r) => r.role === "recipient");

      if (!recipientRef) {
        if (malformedDocWarns < MAX_WARN_PER_CALL) {
          logger.warn("recent_contributions: contribution document missing recipient ref", {
            document_id: doc.id,
          });
          malformedDocWarns++;
        }
        continue;
      }

      // contributor_entity_id filter — always contributor side.
      if (contributorEntity && contribRef?.entity_id !== contributorEntity.id) {
        continue;
      }

      // candidate_or_committee filter with side semantics.
      if (candOrCmteEntityId) {
        const matchesContributor = contribRef?.entity_id === candOrCmteEntityId;
        const matchesRecipient = recipientRef.entity_id === candOrCmteEntityId;
        const ok =
          effectiveSide === "contributor"
            ? matchesContributor
            : effectiveSide === "recipient"
              ? matchesRecipient
              : matchesContributor || matchesRecipient;
        if (!ok) continue;
      }

      // Look up entity names.
      const recipientRow = db
        .prepare("SELECT name FROM entities WHERE id = ?")
        .get(recipientRef.entity_id) as { name: string } | undefined;

      if (!recipientRow && danglingFkWarns < MAX_WARN_PER_CALL) {
        logger.warn("recent_contributions: dangling recipient FK, rendering as Unknown", {
          document_id: doc.id,
          recipient_entity_id: recipientRef.entity_id,
        });
        danglingFkWarns++;
      }

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
        // Address and employer deliberately omitted — contributor home
        // addresses and employers are stored for deduplication but must
        // not be surfaced through tool output to avoid exposing PII.
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
      contributor_name: contributorEntity?.name,
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
        contributor_entity_id: input.contributor_entity_id,
        side: effectiveSide,
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

import type Database from "better-sqlite3";
import { queryDocuments } from "../../core/documents.js";
import { RecentContributionsInput } from "../schemas.js";
import { escapeLike } from "../../util/sql.js";

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
}

export async function handleRecentContributions(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentContributionsResponse> {
  const input = RecentContributionsInput.parse(rawInput);

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

  return {
    results,
    total: results.length,
    sources: results.length > 0
      ? [{ name: "openfec", url: "https://www.fec.gov/" }]
      : [],
    window: input.window,
  };
}

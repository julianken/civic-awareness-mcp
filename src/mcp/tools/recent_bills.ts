import type Database from "better-sqlite3";
import { queryDocuments } from "../../core/documents.js";
import { findEntityById } from "../../core/entities.js";
import { RecentBillsInput } from "../schemas.js";

export interface BillSummary {
  id: string;
  identifier: string;
  title: string;
  latest_action: { date: string; description: string } | null;
  sponsors: Array<{ name: string; party?: string; district?: string; chamber?: string }>;
  source_url: string;
}

export interface RecentBillsResponse {
  results: BillSummary[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  window: { from: string; to: string };
}

export async function handleRecentBills(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentBillsResponse> {
  const input = RecentBillsInput.parse(rawInput);
  const to = new Date();
  const from = new Date(to.getTime() - input.days * 86400 * 1000);

  const docs = queryDocuments(db, {
    kind: "bill",
    jurisdiction: input.jurisdiction,
    from: from.toISOString(),
    to: to.toISOString(),
    limit: 50,
  });

  const filtered = input.chamber
    ? docs.filter((d) => {
        const sponsor = d.references.find((r) => r.role === "sponsor");
        if (!sponsor) return false;
        const ent = findEntityById(db, sponsor.entity_id);
        return ent?.metadata.chamber === input.chamber;
      })
    : docs;

  const results: BillSummary[] = filtered.map((d) => {
    const [identifier, ...titleParts] = d.title.split(" — ");
    const actions = (d.raw.actions as Array<{ date: string; description: string }> | undefined) ?? [];
    const latest = actions.length ? actions[actions.length - 1] : null;
    const sponsors = d.references
      .filter((r) => r.role === "sponsor" || r.role === "cosponsor")
      .map((r) => {
        const e = findEntityById(db, r.entity_id);
        return {
          name: e?.name ?? "Unknown",
          party: e?.metadata.party as string | undefined,
          district: e?.metadata.district as string | undefined,
          chamber: e?.metadata.chamber as string | undefined,
        };
      });
    return {
      id: d.id,
      identifier: identifier?.trim() ?? d.title,
      title: titleParts.join(" — ").trim() || d.title,
      latest_action: latest,
      sponsors,
      source_url: d.source.url,
    };
  });

  // Build a jurisdiction-aware source URL: "us-tx" → "/tx/".
  // For "*" (cross-state), link to the OpenStates root.
  const stateAbbr = input.jurisdiction.replace(/^us-/, "");
  const openstatesUrl = input.jurisdiction === "*"
    ? "https://openstates.org/"
    : `https://openstates.org/${stateAbbr}/`;
  const sourceUrls = new Map<string, string>();
  for (const d of filtered) sourceUrls.set(d.source.name, openstatesUrl);

  return {
    results,
    total: results.length,
    sources: Array.from(sourceUrls, ([name, url]) => ({ name, url })),
    window: { from: from.toISOString(), to: to.toISOString() },
  };
}

import type Database from "better-sqlite3";
import { SearchDocumentsInput } from "../schemas.js";
import { escapeLike } from "../../util/sql.js";
import type { StaleNotice } from "../shared.js";

export interface DocumentMatch {
  id: string;
  kind: string;
  title: string;
  summary?: string;
  occurred_at: string;
  source_url: string;
}

export interface SearchDocumentsResponse {
  results: DocumentMatch[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  empty_reason?: "store_not_warmed";
  hint?: string;
  stale_notice?: StaleNotice;
}

interface Row {
  id: string; kind: string; title: string; summary: string | null;
  occurred_at: string; source_url: string; source_name: string;
  jurisdiction: string;
}

export async function handleSearchDocuments(
  db: Database.Database,
  rawInput: unknown,
): Promise<SearchDocumentsResponse> {
  const input = SearchDocumentsInput.parse(rawInput);

  const clauses = ["title LIKE ? ESCAPE '\\'"];
  const params: unknown[] = [`%${escapeLike(input.q)}%`];
  if (input.jurisdiction) {
    clauses.push("jurisdiction = ?");
    params.push(input.jurisdiction);
  }
  if (input.kinds?.length) {
    const qs = input.kinds.map(() => "?").join(",");
    clauses.push(`kind IN (${qs})`);
    params.push(...input.kinds);
  }
  if (input.sources?.length) {
    const qs = input.sources.map(() => "?").join(",");
    clauses.push(`source_name IN (${qs})`);
    params.push(...input.sources);
  }
  if (input.from) { clauses.push("occurred_at >= ?"); params.push(input.from); }
  if (input.to)   { clauses.push("occurred_at <= ?"); params.push(input.to); }
  params.push(input.limit);

  const rows = db.prepare(
    `SELECT id, kind, title, summary, occurred_at, source_url, source_name, jurisdiction
     FROM documents WHERE ${clauses.join(" AND ")}
     ORDER BY occurred_at DESC LIMIT ?`,
  ).all(...params) as Row[];

  const sourceKeys = new Map<string, { name: string; jurisdiction: string }>();
  const results: DocumentMatch[] = rows.map((r) => {
    sourceKeys.set(`${r.source_name}|${r.jurisdiction}`, {
      name: r.source_name, jurisdiction: r.jurisdiction,
    });
    return {
      id: r.id, kind: r.kind, title: r.title,
      summary: r.summary ?? undefined,
      occurred_at: r.occurred_at, source_url: r.source_url,
    };
  });

  const sources = Array.from(sourceKeys.values()).map(({ name, jurisdiction }) => {
    if (name === "openstates") {
      const stateAbbr = jurisdiction.replace(/^us-/, "");
      return { name, url: `https://openstates.org/${stateAbbr}/` };
    }
    return { name, url: "" };
  });

  const response: SearchDocumentsResponse = { results, total: results.length, sources };

  if (results.length === 0) {
    const anyRow = db.prepare(
      `SELECT 1 FROM documents ${input.jurisdiction ? "WHERE jurisdiction = ?" : ""} LIMIT 1`,
    ).get(...(input.jurisdiction ? [input.jurisdiction] : [])) as unknown;
    if (!anyRow) {
      response.empty_reason = "store_not_warmed";
      response.hint = input.jurisdiction
        ? `No documents for ${input.jurisdiction}. Try calling recent_bills/recent_votes/recent_contributions first to warm the cache.`
        : "Local store is empty. Try calling a feed tool (recent_bills, recent_votes, recent_contributions) first to warm the cache.";
    }
  }

  return response;
}

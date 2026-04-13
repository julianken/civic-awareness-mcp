import type Database from "better-sqlite3";
import { SearchDocumentsInput } from "../schemas.js";

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
  const clauses = ["title LIKE ?"];
  const params: unknown[] = [`%${input.q}%`];
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

  return { results, total: results.length, sources };
}

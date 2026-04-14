import type Database from "better-sqlite3";
import { ensureFresh, sourcesFor } from "../../core/hydrate.js";
import { getLimiter } from "../../core/limiters.js";
import type { DocumentKind } from "../../core/types.js";
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

  let stale_notice: StaleNotice | undefined;
  if (input.jurisdiction) {
    const kinds = (input.kinds ?? ["bill", "vote", "contribution"]) as DocumentKind[];
    const seenSources = new Set<string>();
    outer: for (const kind of kinds) {
      for (const src of sourcesFor(kind, input.jurisdiction)) {
        if (seenSources.has(src)) continue;
        seenSources.add(src);
        const r = await ensureFresh(
          db,
          src,
          input.jurisdiction,
          "recent",
          () => getLimiter(src).peekWaitMs(),
        );
        if (r.stale_notice) {
          stale_notice = r.stale_notice;
          break outer;
        }
      }
    }
  }

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
  if (stale_notice) response.stale_notice = stale_notice;
  return response;
}

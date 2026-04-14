import type Database from "better-sqlite3";
import { SearchEntitiesInput } from "../schemas.js";
import { normalizeName } from "../../resolution/fuzzy.js";
import { escapeLike } from "../../util/sql.js";
import type { StaleNotice } from "../shared.js";
import { ensureFresh, sourcesForFullHydrate } from "../../core/hydrate.js";
import { getLimiter } from "../../core/limiters.js";

export interface EntityMatch {
  id: string;
  kind: string;
  name: string;
  jurisdiction?: string;
  roles_seen: string[];
  last_seen_at: string;
}

export interface SearchEntitiesResponse {
  results: EntityMatch[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  stale_notice?: StaleNotice;
}

interface Row {
  id: string;
  kind: string;
  name: string;
  jurisdiction: string | null;
  last_seen_at: string;
  roles: string | null;
}

export async function handleSearchEntities(
  db: Database.Database,
  rawInput: unknown,
): Promise<SearchEntitiesResponse> {
  const input = SearchEntitiesInput.parse(rawInput);

  let stale_notice: StaleNotice | undefined;
  if (input.jurisdiction) {
    outer: for (const src of sourcesForFullHydrate(input.jurisdiction)) {
      const r = await ensureFresh(db, src, input.jurisdiction, "full", () => getLimiter(src).peekWaitMs());
      if (r.stale_notice) { stale_notice = r.stale_notice; break outer; }
    }
  }

  const needle = `%${escapeLike(normalizeName(input.q))}%`;

  const clauses = ["e.name_normalized LIKE ? ESCAPE '\\'"];
  const params: unknown[] = [needle];
  if (input.kind) {
    clauses.push("e.kind = ?");
    params.push(input.kind);
  }
  if (input.jurisdiction) {
    clauses.push("e.jurisdiction = ?");
    params.push(input.jurisdiction);
  }
  params.push(input.limit);

  const rows = db
    .prepare(
      `SELECT e.id, e.kind, e.name, e.jurisdiction, e.last_seen_at,
            GROUP_CONCAT(DISTINCT r.role) AS roles
     FROM entities e
     LEFT JOIN document_references r ON r.entity_id = e.id
     WHERE ${clauses.join(" AND ")}
     GROUP BY e.id
     ORDER BY e.last_seen_at DESC
     LIMIT ?`,
    )
    .all(...params) as Row[];

  const results: EntityMatch[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    jurisdiction: r.jurisdiction ?? undefined,
    roles_seen: r.roles ? r.roles.split(",") : [],
    last_seen_at: r.last_seen_at,
  }));

  const response: SearchEntitiesResponse = { results, total: results.length, sources: [] };
  if (stale_notice) response.stale_notice = stale_notice;
  return response;
}

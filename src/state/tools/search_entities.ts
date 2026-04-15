import type Database from "better-sqlite3";
import { OpenStatesAdapter } from "../adapters/openstates.js";
import { getLimiter } from "../limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import { normalizeName } from "../../resolution/fuzzy.js";
import { requireEnv } from "../../util/env.js";
import { escapeLike } from "../../util/sql.js";
import { SearchEntitiesInput } from "../schemas.js";
import type { StaleNotice } from "../../core/shared.js";

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

  const projectLocal = (): SearchEntitiesResponse => {
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
    if (input.had_role || input.had_jurisdiction) {
      const roleChecks: string[] = [];
      const roleParams: unknown[] = [];
      if (input.had_role) {
        roleChecks.push("json_extract(je.value, '$.role') = ?");
        roleParams.push(input.had_role);
      }
      if (input.had_jurisdiction) {
        roleChecks.push("json_extract(je.value, '$.jurisdiction') = ?");
        roleParams.push(input.had_jurisdiction);
      }
      clauses.push(
        `EXISTS (
          SELECT 1 FROM json_each(e.metadata, '$.roles') je
          WHERE ${roleChecks.join(" AND ")}
        )`,
      );
      params.push(...roleParams);
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

    return { results, total: results.length, sources: [] };
  };

  // No jurisdiction → local-only.
  if (!input.jurisdiction) {
    return projectLocal();
  }

  const ttl = { scope: "full" as const, ms: 24 * 60 * 60 * 1000 };
  const noop = (): void => {};
  const juris = input.jurisdiction;

  let stale_notice: StaleNotice | undefined;
  const result = await withShapedFetch(
    db,
    {
      source: "openstates",
      endpoint_path: "/people",
      args: { jurisdiction: juris, name: input.q },
      tool: "searchPeople",
    },
    ttl,
    async () => {
      const adapter = new OpenStatesAdapter({
        apiKey: requireEnv("OPENSTATES_API_KEY"),
        rateLimiter: getLimiter("openstates"),
      });
      const r = await adapter.searchPeople(db, {
        jurisdiction: juris,
        name: input.q,
        limit: input.limit,
      });
      return { primary_rows_written: r.entitiesUpserted };
    },
    noop,
    () => getLimiter("openstates").peekWaitMs(),
  );

  if (result.stale_notice) stale_notice = result.stale_notice;

  return {
    ...projectLocal(),
    ...(stale_notice ? { stale_notice } : {}),
  };
}

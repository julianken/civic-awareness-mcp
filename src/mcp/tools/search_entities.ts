import type Database from "better-sqlite3";
import { CongressAdapter } from "../../adapters/congress.js";
import { OpenFecAdapter } from "../../adapters/openfec.js";
import { OpenStatesAdapter } from "../../adapters/openstates.js";
import { getLimiter } from "../../core/limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import { normalizeName } from "../../resolution/fuzzy.js";
import { requireEnv } from "../../util/env.js";
import { escapeLike } from "../../util/sql.js";
import { SearchEntitiesInput } from "../schemas.js";
import type { StaleNotice } from "../shared.js";

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

  // No jurisdiction → local-only (matches the pre-R15 behaviour; the
  // caller has explicitly declined to pick a source to hit).
  if (!input.jurisdiction) {
    return projectLocal();
  }

  const ttl = { scope: "full" as const, ms: 24 * 60 * 60 * 1000 };
  const noop = (): void => {};
  const calls: Promise<{ stale_notice?: StaleNotice }>[] = [];

  if (input.jurisdiction === "us-federal") {
    calls.push(
      withShapedFetch(
        db,
        {
          source: "congress",
          endpoint_path: "/member",
          args: {},
          tool: "searchMembers",
        },
        ttl,
        async () => {
          const adapter = new CongressAdapter({
            apiKey: requireEnv("API_DATA_GOV_KEY"),
            rateLimiter: getLimiter("congress"),
          });
          const r = await adapter.searchMembers(db);
          return { primary_rows_written: r.entitiesUpserted };
        },
        noop,
        () => getLimiter("congress").peekWaitMs(),
      ),
      withShapedFetch(
        db,
        {
          source: "openfec",
          endpoint_path: "/candidates/search",
          args: { q: input.q },
          tool: "searchCandidates",
        },
        ttl,
        async () => {
          const adapter = new OpenFecAdapter({
            apiKey: requireEnv("API_DATA_GOV_KEY"),
            rateLimiter: getLimiter("openfec"),
          });
          const r = await adapter.searchCandidates(db, { q: input.q });
          return { primary_rows_written: r.entitiesUpserted };
        },
        noop,
        () => getLimiter("openfec").peekWaitMs(),
      ),
    );
  } else {
    const juris = input.jurisdiction;
    calls.push(
      withShapedFetch(
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
          });
          return { primary_rows_written: r.entitiesUpserted };
        },
        noop,
        () => getLimiter("openstates").peekWaitMs(),
      ),
    );
  }

  let stale_notice: StaleNotice | undefined;
  for (const r of await Promise.all(calls)) {
    if (r.stale_notice && !stale_notice) stale_notice = r.stale_notice;
  }

  const response = projectLocal();
  if (stale_notice) response.stale_notice = stale_notice;
  return response;
}

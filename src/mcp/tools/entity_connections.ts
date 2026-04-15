import type Database from "better-sqlite3";
import { CongressAdapter } from "../../adapters/congress.js";
import { OpenFecAdapter } from "../../adapters/openfec.js";
import { OpenStatesAdapter } from "../../adapters/openstates.js";
import { findConnections } from "../../core/connections.js";
import { findEntityById } from "../../core/entities.js";
import { getLimiter } from "../../core/limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import { requireEnv } from "../../util/env.js";
import { logger } from "../../util/logger.js";
import { EntityConnectionsInput } from "../schemas.js";
import type { StaleNotice, StaleReason } from "../shared.js";

interface EntityMatch {
  id: string;
  kind: string;
  name: string;
  roles_seen: string[];
  last_seen_at: string;
}

interface DocumentMatch {
  id: string;
  kind: string;
  title: string;
  occurred_at: string;
  source_url: string;
}

interface ConnectionEdge {
  from: string;
  to: string;
  via_kinds: string[];
  via_roles: string[];
  co_occurrence_count: number;
  sample_documents: DocumentMatch[];
}

export interface EntityConnectionsResponse {
  root: EntityMatch;
  edges: ConnectionEdge[];
  nodes: EntityMatch[];
  sources: Array<{ name: string; url: string }>;
  truncated: boolean;
  empty_reason?: "no_external_ids";
  stale_notice?: StaleNotice;
}

interface EntityRow {
  id: string;
  kind: string;
  name: string;
  last_seen_at: string;
}

interface DocRow {
  id: string;
  kind: string;
  title: string;
  occurred_at: string;
  source_url: string;
  source_name: string;
  jurisdiction: string;
}

interface RoleRow {
  entity_id: string;
  role: string;
}

function batchFetchEntities(db: Database.Database, ids: string[]): Map<string, EntityRow> {
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(`SELECT id, kind, name, last_seen_at FROM entities WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as EntityRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

function batchFetchDocs(db: Database.Database, ids: string[]): Map<string, DocRow> {
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT id, kind, title, occurred_at, source_url, source_name, jurisdiction
       FROM documents WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as DocRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

function batchFetchRoles(db: Database.Database, ids: string[]): Map<string, string[]> {
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT DISTINCT entity_id, role FROM document_references
       WHERE entity_id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as RoleRow[];
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const existing = map.get(r.entity_id) ?? [];
    existing.push(r.role);
    map.set(r.entity_id, existing);
  }
  return map;
}

function sourceUrl(sourceName: string, jurisdiction: string): string {
  if (sourceName === "openstates") {
    const state = jurisdiction.replace(/^us-/, "");
    return `https://openstates.org/${state}/`;
  }
  if (sourceName === "congress") return "https://www.congress.gov/";
  if (sourceName === "openfec") return "https://www.fec.gov/";
  return "";
}

// Severity ordering used when merging stale_notices from multiple
// parallel adapter calls. `upstream_failure` outranks `not_found`
// (which outranks `not_yet_supported`) because an unreachable
// upstream is the most actionable signal for an LLM consumer —
// a "not found" or "not yet supported" might be expected.
const STALE_REASON_RANK: Record<StaleReason, number> = {
  upstream_failure: 3,
  not_found: 2,
  not_yet_supported: 1,
};

/**
 * Combine stale_notices from N parallel adapter calls into a single
 * notice. Picks the most-severe `reason` (per `STALE_REASON_RANK`) and
 * concatenates the source labels of every failing call into the
 * `message`, so an LLM consumer sees that (e.g.) both Congress.gov and
 * OpenFEC failed rather than only the first one. `as_of` is the
 * earliest of the contributing notices (oldest cached fallback wins,
 * since it bounds freshness across all sources).
 */
function aggregateStaleNotices(
  results: Array<{ label: string; stale_notice?: StaleNotice }>,
): StaleNotice | undefined {
  const failing = results.filter(
    (r): r is { label: string; stale_notice: StaleNotice } => r.stale_notice !== undefined,
  );
  if (failing.length === 0) return undefined;
  if (failing.length === 1) return failing[0].stale_notice;

  const sorted = [...failing].sort(
    (a, b) => STALE_REASON_RANK[b.stale_notice.reason] - STALE_REASON_RANK[a.stale_notice.reason],
  );
  const reason = sorted[0].stale_notice.reason;
  const as_of = sorted
    .map((r) => r.stale_notice.as_of)
    .reduce((min, v) => (v < min ? v : min));
  const parts = sorted.map((r) => `${r.label}: ${r.stale_notice.message}`);
  return {
    as_of,
    reason,
    message: `Multiple sources reported issues — ${parts.join(" | ")}`,
  };
}

export async function handleEntityConnections(
  db: Database.Database,
  rawInput: unknown,
): Promise<EntityConnectionsResponse> {
  const input = EntityConnectionsInput.parse(rawInput);

  const rootEntity = findEntityById(db, input.id);
  if (!rootEntity) {
    logger.warn("entity_connections: entity not found", { id: input.id });
    throw new Error(`Entity not found: ${input.id}`);
  }

  const rootRoleMap = batchFetchRoles(db, [rootEntity.id]);
  const root: EntityMatch = {
    id: rootEntity.id,
    kind: rootEntity.kind,
    name: rootEntity.name,
    roles_seen: rootRoleMap.get(rootEntity.id) ?? [],
    last_seen_at: rootEntity.last_seen_at,
  };

  // Cold-path short-circuit per phase-8a Decision 9: an entity with no
  // external IDs cannot be fanned out to any upstream, so entity_connections
  // returns an empty graph with a diagnostic reason rather than silently
  // computing a projection over whatever stale documents happen to be
  // local.
  if (Object.keys(rootEntity.external_ids).length === 0) {
    return {
      root,
      edges: [],
      nodes: [],
      sources: [],
      truncated: false,
      empty_reason: "no_external_ids",
    };
  }

  const ttl = { scope: "full" as const, ms: 24 * 60 * 60 * 1000 };
  const noop = (): void => {};
  const calls: Array<{
    label: string;
    promise: Promise<{ stale_notice?: StaleNotice }>;
  }> = [];

  if (rootEntity.external_ids.bioguide) {
    const bioguide = rootEntity.external_ids.bioguide;
    calls.push({
      label: "congress sponsored",
      promise: withShapedFetch(
        db,
        {
          source: "congress",
          endpoint_path: `/member/${bioguide}/sponsored-legislation`,
          args: { bioguide },
          tool: "fetchMemberSponsored",
        },
        ttl,
        async () => {
          const adapter = new CongressAdapter({
            apiKey: requireEnv("API_DATA_GOV_KEY"),
            rateLimiter: getLimiter("congress"),
          });
          const r = await adapter.fetchMemberSponsoredBills(db, bioguide);
          return { primary_rows_written: r.documentsUpserted };
        },
        noop,
        () => getLimiter("congress").peekWaitMs(),
      ),
    });
    calls.push({
      label: "congress cosponsored",
      promise: withShapedFetch(
        db,
        {
          source: "congress",
          endpoint_path: `/member/${bioguide}/cosponsored-legislation`,
          args: { bioguide },
          tool: "fetchMemberCosponsored",
        },
        ttl,
        async () => {
          const adapter = new CongressAdapter({
            apiKey: requireEnv("API_DATA_GOV_KEY"),
            rateLimiter: getLimiter("congress"),
          });
          const r = await adapter.fetchMemberCosponsoredBills(db, bioguide);
          return { primary_rows_written: r.documentsUpserted };
        },
        noop,
        () => getLimiter("congress").peekWaitMs(),
      ),
    });
  }

  if (rootEntity.external_ids.openstates_person) {
    const ocdId = rootEntity.external_ids.openstates_person;
    calls.push({
      label: "openstates bills-by-sponsor",
      promise: withShapedFetch(
        db,
        {
          source: "openstates",
          endpoint_path: "/bills/by-sponsor",
          args: { sponsor: ocdId },
          tool: "fetchBillsBySponsor",
        },
        ttl,
        async () => {
          const adapter = new OpenStatesAdapter({
            apiKey: requireEnv("OPENSTATES_API_KEY"),
            rateLimiter: getLimiter("openstates"),
          });
          const r = await adapter.fetchBillsBySponsor(db, { sponsor: ocdId });
          return { primary_rows_written: r.documentsUpserted };
        },
        noop,
        () => getLimiter("openstates").peekWaitMs(),
      ),
    });
  }

  if (rootEntity.external_ids.fec_candidate) {
    const candidateId = rootEntity.external_ids.fec_candidate;
    calls.push({
      label: "openfec contributions-to-candidate",
      promise: withShapedFetch(
        db,
        {
          source: "openfec",
          endpoint_path: `/candidate/${candidateId}/schedule_a`,
          args: { candidateId },
          tool: "fetchContributionsToCandidate",
        },
        ttl,
        async () => {
          const adapter = new OpenFecAdapter({
            apiKey: requireEnv("API_DATA_GOV_KEY"),
            rateLimiter: getLimiter("openfec"),
          });
          const r = await adapter.fetchContributionsToCandidate(db, { candidateId });
          return { primary_rows_written: r.documentsUpserted };
        },
        noop,
        () => getLimiter("openfec").peekWaitMs(),
      ),
    });
  }

  const callResults = await Promise.all(
    calls.map(async (c) => ({ label: c.label, ...(await c.promise) })),
  );
  const stale_notice = aggregateStaleNotices(callResults);

  const { edges: rawEdges, truncated } = findConnections(
    db,
    rootEntity.id,
    input.depth,
    input.min_co_occurrences,
  );

  const entityIdSet = new Set<string>();
  const docIdSet = new Set<string>();
  for (const e of rawEdges) {
    entityIdSet.add(e.from_id);
    entityIdSet.add(e.to_id);
    for (const did of e.sample_document_ids) docIdSet.add(did);
  }
  entityIdSet.delete(rootEntity.id);

  const entityMap = batchFetchEntities(db, Array.from(entityIdSet));
  const docMap = batchFetchDocs(db, Array.from(docIdSet));
  const roleMap = batchFetchRoles(db, Array.from(entityIdSet));

  const toEntityMatch = (id: string): EntityMatch | null => {
    const row = entityMap.get(id);
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      roles_seen: roleMap.get(row.id) ?? [],
      last_seen_at: row.last_seen_at,
    };
  };

  const toDocMatch = (id: string): DocumentMatch | null => {
    const row = docMap.get(id);
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      occurred_at: row.occurred_at,
      source_url: row.source_url,
    };
  };

  const edges: ConnectionEdge[] = rawEdges.map((e) => ({
    from: e.from_id,
    to: e.to_id,
    via_kinds: e.via_kinds,
    via_roles: e.via_roles,
    co_occurrence_count: e.co_occurrence_count,
    sample_documents: e.sample_document_ids.map(toDocMatch).filter((d): d is DocumentMatch => d !== null),
  }));

  const nodes: EntityMatch[] = Array.from(entityIdSet)
    .map(toEntityMatch)
    .filter((n): n is EntityMatch => n !== null);

  // Build sources from unique (source_name, jurisdiction) pairs across
  // sample documents. Each pair resolves to a jurisdiction-aware URL so
  // a graph that spans Texas + California + federal surfaces three
  // distinct OpenStates / Congress.gov entries rather than collapsing
  // them into one with a wrong jurisdiction.
  const sourcesSeen = new Map<string, { name: string; url: string }>();
  for (const row of docMap.values()) {
    const key = `${row.source_name}|${row.jurisdiction}`;
    if (!sourcesSeen.has(key)) {
      sourcesSeen.set(key, {
        name: row.source_name,
        url: sourceUrl(row.source_name, row.jurisdiction),
      });
    }
  }
  const sources = Array.from(sourcesSeen.values());

  const response: EntityConnectionsResponse = { root, edges, nodes, sources, truncated };
  if (stale_notice) response.stale_notice = stale_notice;
  return response;
}

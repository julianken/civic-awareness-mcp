import type Database from "better-sqlite3";
import { EntityConnectionsInput } from "../schemas.js";
import { findConnections } from "../../core/connections.js";
import { findEntityById } from "../../core/entities.js";

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
  co_occurrence_count: number;
  sample_documents: DocumentMatch[];
}

export interface EntityConnectionsResponse {
  root: EntityMatch;
  edges: ConnectionEdge[];
  nodes: EntityMatch[];
  sources: Array<{ name: string; url: string }>;
  truncated: boolean;
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

export async function handleEntityConnections(
  db: Database.Database,
  rawInput: unknown,
): Promise<EntityConnectionsResponse> {
  const input = EntityConnectionsInput.parse(rawInput);

  const rootEntity = findEntityById(db, input.id);
  if (!rootEntity) throw new Error(`Entity not found: ${input.id}`);

  const { edges: rawEdges, truncated } = findConnections(
    db,
    rootEntity.id,
    input.depth,
    input.min_co_occurrences,
  );

  // Collect all entity IDs (excluding root) and document IDs to hydrate.
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
  // Also fetch root roles
  const rootRoleMap = batchFetchRoles(db, [rootEntity.id]);

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

  const root: EntityMatch = {
    id: rootEntity.id,
    kind: rootEntity.kind,
    name: rootEntity.name,
    roles_seen: rootRoleMap.get(rootEntity.id) ?? [],
    last_seen_at: rootEntity.last_seen_at,
  };

  const edges: ConnectionEdge[] = rawEdges.map((e) => ({
    from: e.from_id,
    to: e.to_id,
    via_kinds: e.via_kinds,
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

  return { root, edges, nodes, sources, truncated };
}

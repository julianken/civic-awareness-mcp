import type Database from "better-sqlite3";

export interface RawEdge {
  from_id: string;
  to_id: string;
  via_kinds: string[];
  via_roles: string[];
  co_occurrence_count: number;
  sample_document_ids: string[];
}

export interface ConnectionsResult {
  edges: RawEdge[];
  truncated: boolean;
}

const MAX_EDGES = 100;
const MAX_DEPTH2_NEIGHBORS = 20;
const MAX_SAMPLE_DOCS = 3;

// Returns (from_id, to_id, via_kind, per-kind-count) rows for all
// pairs co-occurring on shared documents where from_id = rootId.
// Filtering by minCoOccurrences happens after aggregating by pair.
const EDGE_KIND_SQL = `
  SELECT
    r1.entity_id    AS from_id,
    r2.entity_id    AS to_id,
    d.kind          AS via_kind,
    r2.role         AS via_role,
    COUNT(DISTINCT d.id) AS co_count
  FROM document_references r1
  JOIN document_references r2
    ON r1.document_id = r2.document_id
    AND r1.entity_id != r2.entity_id
  JOIN documents d ON r1.document_id = d.id
  WHERE r1.entity_id = ?
  GROUP BY r1.entity_id, r2.entity_id, d.kind, r2.role
  ORDER BY co_count DESC
`;

// True total distinct shared document count between two entities.
const TOTAL_COUNT_SQL = `
  SELECT COUNT(DISTINCT r2.document_id) AS total_count
  FROM document_references r1
  JOIN document_references r2
    ON r1.document_id = r2.document_id
    AND r2.entity_id = ?
  WHERE r1.entity_id = ?
`;

// Most-recent shared document IDs for a given pair.
const SAMPLE_DOCS_SQL = `
  SELECT d.id
  FROM documents d
  JOIN document_references r1 ON d.id = r1.document_id
  JOIN document_references r2 ON d.id = r2.document_id
  WHERE r1.entity_id = ? AND r2.entity_id = ?
  ORDER BY d.occurred_at DESC
  LIMIT ${MAX_SAMPLE_DOCS}
`;

interface KindRow {
  from_id: string;
  to_id: string;
  via_kind: string;
  via_role: string;
  co_count: number;
}

interface TotalRow {
  total_count: number;
}

interface SampleRow {
  id: string;
}

// Runs depth-1 edge discovery from a single root entity and returns
// deduplicated RawEdge array capped at maxEdges. Returns both the
// edges array and the set of neighbor IDs found (used for depth=2).
function expandOne(
  db: Database.Database,
  rootId: string,
  minCoOccurrences: number,
  existingPairs: Set<string>,
  maxEdges: number,
): { edges: RawEdge[]; neighborIds: string[] } {
  const kindStmt = db.prepare<[string], KindRow>(EDGE_KIND_SQL);
  const totalStmt = db.prepare<[string, string], TotalRow>(TOTAL_COUNT_SQL);
  const sampleStmt = db.prepare<[string, string], SampleRow>(SAMPLE_DOCS_SQL);

  const kindRows = kindStmt.all(rootId);

  // Group rows by (from_id, to_id) pair.
  const pairMap = new Map<string, {
    from_id: string;
    to_id: string;
    kinds: Set<string>;
    roles: Set<string>;
  }>();
  for (const row of kindRows) {
    const key = `${row.from_id}|${row.to_id}`;
    if (!pairMap.has(key)) {
      pairMap.set(key, {
        from_id: row.from_id,
        to_id: row.to_id,
        kinds: new Set(),
        roles: new Set(),
      });
    }
    pairMap.get(key)!.kinds.add(row.via_kind);
    pairMap.get(key)!.roles.add(row.via_role);
  }

  const edges: RawEdge[] = [];
  const neighborIds: string[] = [];

  for (const [key, pair] of pairMap) {
    if (existingPairs.has(key) || edges.length >= maxEdges) continue;

    const totalRow = totalStmt.get(pair.to_id, pair.from_id);
    const totalCount = totalRow?.total_count ?? 0;
    if (totalCount < minCoOccurrences) continue;

    const sampleRows = sampleStmt.all(pair.from_id, pair.to_id);

    existingPairs.add(key);
    neighborIds.push(pair.to_id);
    edges.push({
      from_id: pair.from_id,
      to_id: pair.to_id,
      via_kinds: Array.from(pair.kinds),
      via_roles: Array.from(pair.roles),
      co_occurrence_count: totalCount,
      sample_document_ids: sampleRows.map((r) => r.id),
    });
  }

  return { edges, neighborIds };
}

export function findConnections(
  db: Database.Database,
  rootId: string,
  depth: 1 | 2,
  minCoOccurrences: number,
): ConnectionsResult {
  const existingPairs = new Set<string>();
  const allEdges: RawEdge[] = [];

  // Depth-1 expansion.
  const { edges: d1Edges, neighborIds } = expandOne(
    db, rootId, minCoOccurrences, existingPairs, MAX_EDGES,
  );
  allEdges.push(...d1Edges);

  if (depth === 2 && allEdges.length < MAX_EDGES) {
    // Sort neighbors by their edge's co_occurrence_count descending so
    // the strongest connections are expanded first — highest value when
    // the cap triggers mid-expansion.
    const sortedNeighbors = neighborIds
      .map((nid) => ({
        nid,
        count: allEdges.find((e) => e.to_id === nid)?.co_occurrence_count ?? 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_DEPTH2_NEIGHBORS)
      .map((x) => x.nid);

    for (const neighborId of sortedNeighbors) {
      if (allEdges.length >= MAX_EDGES) break;
      const remaining = MAX_EDGES - allEdges.length;
      const { edges: d2Edges } = expandOne(
        db, neighborId, minCoOccurrences, existingPairs, remaining,
      );
      allEdges.push(...d2Edges);
    }
  }

  // Sort final edge list by co_occurrence_count descending.
  allEdges.sort((a, b) => b.co_occurrence_count - a.co_occurrence_count);

  const truncated = allEdges.length >= MAX_EDGES;
  return { edges: allEdges, truncated };
}

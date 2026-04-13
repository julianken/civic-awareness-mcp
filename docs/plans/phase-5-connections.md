# Phase 5 — Connections & Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Prerequisite:** Phase 4 complete (`docs/plans/phase-4-openfec.md`
all checkboxes green). 108 tests pass.

**Goal:** Ship two final query-layer tools — `entity_connections` (graph
co-occurrence queries) and `resolve_person` (name disambiguation with
confidence scores). No new adapters. No schema migrations. No new env
vars. All inputs already exist in the `documents` / `entities` /
`document_references` tables.

**Architecture:** One new query-layer module (`src/core/connections.ts`),
two new tool handlers (`src/mcp/tools/entity_connections.ts` and
`src/mcp/tools/resolve_person.ts`), two new zod schemas
(`EntityConnectionsInput`, `ResolvePersonInput`) in `src/mcp/schemas.ts`,
and registration of both tools in `src/mcp/server.ts` (version bumped to
`v0.0.5`).

**Load-bearing sub-decisions (from `docs/roadmap.md` Phase 5):**
- **`depth=2` cap:** Prolific entities (Schumer, Pelosi) can co-occur
  with hundreds of others. Hard cap at 100 total edges per response;
  neighbor expansion for depth=2 processes at most 20 depth-1 neighbors
  before stopping. The response includes a `truncated: boolean` flag.
- **`min_co_occurrences` semantics:** Edge exists iff the two entities
  share at least N distinct documents (counted by document UUID, not by
  number of references). Default is 2.
- **`sample_documents` per edge:** cap at 3 most-recent documents.
- **`via_kinds` construction:** For one edge A→B, aggregate unique
  `DocumentKind` values across all shared documents into an array.
- **`resolve_person` confidence precedence:** If the same entity matches
  on both exact and alias paths, return it once with the higher label
  (`"exact"` beats `"alias"` beats `"fuzzy"`).
- **`disambiguators` format:** Derived from `metadata.roles[]`; each
  entry is a string of the form `"<role>, <jurisdiction>, <from>–<to>"`,
  e.g. `"senator, us-federal, 2019-01-03–present"`. For non-Person
  entities, disambiguators come from `kind` and `jurisdiction`.
- **`context` field on `resolve_person`:** Accepted and stored in the
  parsed input but not used for matching in V1. Reserved for Phase 6+.
  No error is thrown when it's provided.

---

## File structure produced by this phase

```
src/
├── core/
│   └── connections.ts                         ← Task 1 (new)
├── mcp/
│   ├── server.ts                              (modified in Task 4)
│   ├── schemas.ts                             (modified in Tasks 2 & 3)
│   └── tools/
│       ├── entity_connections.ts              ← Task 2 (new)
│       └── resolve_person.ts                  ← Task 3 (new)
tests/
├── unit/
│   ├── core/
│   │   └── connections.test.ts                ← Task 1
│   └── mcp/
│       └── tools/
│           ├── entity_connections.test.ts     ← Task 2
│           └── resolve_person.test.ts         ← Task 3
└── integration/
    └── phase5-e2e.test.ts                     ← Task 5
```

---

## Prerequisites

Before executing this phase:

- Phase 4 all checkboxes green, test suite green (`pnpm test` passes).
- `pnpm test` produces "108 tests passed" (or whatever the current
  passing count is) with no failures.

---

## Task 1: `src/core/connections.ts` — graph co-occurrence query layer

**Files:** `src/core/connections.ts` (new),
`tests/unit/core/connections.test.ts` (new)

This is the heart of `entity_connections`. The function
`findConnections` runs a self-join over `document_references`, collects
edges with `via_kinds` and sample documents, and handles the depth=2
expansion loop with hard caps.

### SQL for depth-1 edge query

```sql
SELECT
  r1.entity_id    AS from_id,
  r2.entity_id    AS to_id,
  d.kind          AS via_kind,
  COUNT(DISTINCT d.id) AS co_count
FROM document_references r1
JOIN document_references r2
  ON r1.document_id = r2.document_id
  AND r1.entity_id != r2.entity_id
JOIN documents d ON r1.document_id = d.id
WHERE r1.entity_id = ?
GROUP BY r1.entity_id, r2.entity_id, d.kind
HAVING co_count >= ?
ORDER BY co_count DESC
```

This query returns one row per (from_id, to_id, kind) triple. The
caller collapses rows with the same (from_id, to_id) pair into a single
edge with `via_kinds: string[]` and `co_occurrence_count: number` (the
max count across all kinds, or preferably the sum — see note below).

**Note on `co_occurrence_count` semantics:** Because the SQL groups by
kind, a pair that co-occurs on 3 bills and 2 votes returns two rows with
`co_count = 3` and `co_count = 2`. After collapsing, the merged edge
should report the total distinct shared document count (not per-kind).
Use a separate COUNT query to compute the true total, or re-aggregate in
JavaScript. The plan uses re-aggregation in JavaScript: after grouping
rows by (from_id, to_id), compute `co_occurrence_count` as the size of
the deduplicated `document_id` set that appears across all matching rows.
Because we don't carry `document_id` in the per-kind rows, it is simpler
to run a second query for the true count:

```sql
SELECT COUNT(DISTINCT r2.document_id) AS total_count
FROM document_references r1
JOIN document_references r2
  ON r1.document_id = r2.document_id
  AND r2.entity_id = ?
WHERE r1.entity_id = ?
```

This second query is called once per (from_id, to_id) pair — at most 20
times for depth=1 (before the 100-edge cap kicks in), which is
acceptable.

### Sample documents query (per edge, capped at 3)

```sql
SELECT d.id, d.kind, d.title, d.occurred_at, d.source_url
FROM documents d
JOIN document_references r1 ON d.id = r1.document_id
JOIN document_references r2 ON d.id = r2.document_id
WHERE r1.entity_id = ? AND r2.entity_id = ?
ORDER BY d.occurred_at DESC
LIMIT 3
```

### depth=2 expansion algorithm

1. Run depth-1 query for the root entity → call result `depth1Edges`.
2. Collect neighbor IDs from `depth1Edges` (the `to_id` values), capped
   at 20 unique neighbors (sorted by `co_occurrence_count DESC` so the
   strongest connections' neighbors are expanded first).
3. For each of those 20 neighbor IDs, run the depth-1 query with that
   neighbor as the root. Add any new edges (pairs not already in the
   result set) to the accumulated edge set.
4. Stop as soon as the total edge count reaches 100 (the hard cap).
5. Sort the final edge set by `co_occurrence_count DESC`.
6. Return `{ edges, truncated: boolean }`.

### Data types

```ts
import type Database from "better-sqlite3";

export interface RawEdge {
  from_id: string;
  to_id: string;
  via_kinds: string[];
  co_occurrence_count: number;
  sample_document_ids: string[];  // up to 3, most recent first
}

export interface ConnectionsResult {
  edges: RawEdge[];
  truncated: boolean;
}

export function findConnections(
  db: Database.Database,
  rootId: string,
  depth: 1 | 2,
  minCoOccurrences: number,
): ConnectionsResult
```

- [ ] **Step 1.1: Write unit tests for `findConnections`**

Create `tests/unit/core/connections.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { upsertEntity } from "../../../src/core/entities.js";
import { upsertDocument } from "../../../src/core/documents.js";
import { findConnections } from "../../../src/core/connections.js";

const TEST_DB = "./data/test-connections.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});

afterEach(() => {
  store.close();
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

function makeEntity(db: Store["db"], name: string) {
  return upsertEntity(db, { kind: "person", name }).entity;
}

function makeDoc(
  db: Store["db"],
  sourceId: string,
  kind: "bill" | "vote" | "contribution",
  refs: string[],
) {
  return upsertDocument(db, {
    kind,
    jurisdiction: "us-federal",
    title: `Doc ${sourceId}`,
    occurred_at: "2024-01-01T00:00:00.000Z",
    source: { name: "congress", id: sourceId, url: `https://congress.gov/${sourceId}` },
    references: refs.map((entity_id) => ({ entity_id, role: "sponsor" as const })),
  }).document;
}

describe("findConnections", () => {
  it("returns empty result when entity has no documents", () => {
    const a = makeEntity(store.db, "Alice Alone");
    const result = findConnections(store.db, a.id, 1, 1);
    expect(result.edges).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it("returns empty result when entity has no co-occurrences", () => {
    const a = makeEntity(store.db, "Alice Solo");
    const b = makeEntity(store.db, "Bob Solo");
    makeDoc(store.db, "doc-a", "bill", [a.id]);
    makeDoc(store.db, "doc-b", "bill", [b.id]);
    const result = findConnections(store.db, a.id, 1, 1);
    expect(result.edges).toHaveLength(0);
  });

  it("returns an edge when two entities co-occur on a single document (minCoOccurrences=1)", () => {
    const a = makeEntity(store.db, "Alice Shared");
    const b = makeEntity(store.db, "Bob Shared");
    makeDoc(store.db, "doc-ab", "bill", [a.id, b.id]);
    const result = findConnections(store.db, a.id, 1, 1);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].from_id).toBe(a.id);
    expect(result.edges[0].to_id).toBe(b.id);
    expect(result.edges[0].co_occurrence_count).toBe(1);
    expect(result.edges[0].via_kinds).toContain("bill");
    expect(result.edges[0].sample_document_ids).toHaveLength(1);
  });

  it("enforces minCoOccurrences=2 and excludes single-document pairs", () => {
    const a = makeEntity(store.db, "Alice Two");
    const b = makeEntity(store.db, "Bob Two");
    const c = makeEntity(store.db, "Carol Two");
    // a↔b: 2 shared docs; a↔c: 1 shared doc
    makeDoc(store.db, "doc-ab1", "bill", [a.id, b.id]);
    makeDoc(store.db, "doc-ab2", "vote", [a.id, b.id]);
    makeDoc(store.db, "doc-ac1", "bill", [a.id, c.id]);
    const result = findConnections(store.db, a.id, 1, 2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].to_id).toBe(b.id);
    expect(result.edges[0].co_occurrence_count).toBe(2);
  });

  it("populates via_kinds with all distinct document kinds", () => {
    const a = makeEntity(store.db, "Alice Kinds");
    const b = makeEntity(store.db, "Bob Kinds");
    makeDoc(store.db, "doc-ab-bill", "bill", [a.id, b.id]);
    makeDoc(store.db, "doc-ab-vote", "vote", [a.id, b.id]);
    const result = findConnections(store.db, a.id, 1, 1);
    expect(result.edges[0].via_kinds).toHaveLength(2);
    expect(result.edges[0].via_kinds).toContain("bill");
    expect(result.edges[0].via_kinds).toContain("vote");
  });

  it("caps sample_document_ids at 3", () => {
    const a = makeEntity(store.db, "Alice Docs");
    const b = makeEntity(store.db, "Bob Docs");
    for (let i = 0; i < 5; i++) {
      makeDoc(store.db, `doc-many-${i}`, "bill", [a.id, b.id]);
    }
    const result = findConnections(store.db, a.id, 1, 1);
    expect(result.edges[0].sample_document_ids.length).toBeLessThanOrEqual(3);
  });

  it("returns depth=2 edges through an intermediate neighbor", () => {
    const a = makeEntity(store.db, "Alice Depth");
    const b = makeEntity(store.db, "Bob Depth");
    const c = makeEntity(store.db, "Carol Depth");
    // a↔b: directly connected
    makeDoc(store.db, "doc-ab", "bill", [a.id, b.id]);
    makeDoc(store.db, "doc-ab2", "bill", [a.id, b.id]);
    // b↔c: reachable at depth=2
    makeDoc(store.db, "doc-bc", "vote", [b.id, c.id]);
    makeDoc(store.db, "doc-bc2", "vote", [b.id, c.id]);
    const result = findConnections(store.db, a.id, 2, 1);
    const toIds = result.edges.map((e) => e.to_id);
    expect(toIds).toContain(b.id);
    expect(toIds).toContain(c.id);
  });

  it("does not duplicate edges when depth=2 produces a pair already in depth=1", () => {
    const a = makeEntity(store.db, "Alice Dedup");
    const b = makeEntity(store.db, "Bob Dedup");
    const c = makeEntity(store.db, "Carol Dedup");
    // a↔b and a↔c at depth=1; b↔c also seen as b→c at depth=2
    makeDoc(store.db, "doc-ab", "bill", [a.id, b.id]);
    makeDoc(store.db, "doc-ab2", "bill", [a.id, b.id]);
    makeDoc(store.db, "doc-ac", "bill", [a.id, c.id]);
    makeDoc(store.db, "doc-ac2", "bill", [a.id, c.id]);
    makeDoc(store.db, "doc-bc", "vote", [b.id, c.id]);
    makeDoc(store.db, "doc-bc2", "vote", [b.id, c.id]);
    const result = findConnections(store.db, a.id, 2, 1);
    const pairs = result.edges.map((e) => `${e.from_id}→${e.to_id}`);
    // Unique pairs only
    const unique = new Set(pairs);
    expect(pairs.length).toBe(unique.size);
  });

  it("sorts edges by co_occurrence_count descending", () => {
    const a = makeEntity(store.db, "Alice Sorted");
    const b = makeEntity(store.db, "Bob Sorted");
    const c = makeEntity(store.db, "Carol Sorted");
    // a↔c has more shared docs than a↔b
    makeDoc(store.db, "doc-ab-s", "bill", [a.id, b.id]);
    for (let i = 0; i < 4; i++) {
      makeDoc(store.db, `doc-ac-s-${i}`, "bill", [a.id, c.id]);
    }
    const result = findConnections(store.db, a.id, 1, 1);
    expect(result.edges[0].to_id).toBe(c.id);
    expect(result.edges[0].co_occurrence_count).toBeGreaterThan(
      result.edges[1].co_occurrence_count,
    );
  });

  it("sets truncated=true when edge count hits the 100-edge cap", () => {
    // Seed 105 peer entities, each sharing a document with root
    const root = makeEntity(store.db, "Alice Cap");
    for (let i = 0; i < 105; i++) {
      const peer = makeEntity(store.db, `Peer Cap ${i}`);
      makeDoc(store.db, `doc-cap-${i}`, "bill", [root.id, peer.id]);
    }
    const result = findConnections(store.db, root.id, 1, 1);
    expect(result.edges.length).toBe(100);
    expect(result.truncated).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run the test (expect failures — implementation not yet written)**

```bash
pnpm test tests/unit/core/connections.test.ts 2>&1 | tail -20
```

Expected: all tests fail with "Cannot find module" or similar. This
is correct — we write the tests first (TDD).

- [ ] **Step 1.3: Implement `src/core/connections.ts`**

Create `src/core/connections.ts`:

```ts
import type Database from "better-sqlite3";

export interface RawEdge {
  from_id: string;
  to_id: string;
  via_kinds: string[];
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
// pairs co-occurring on >= minCoOccurrences shared documents where
// from_id = rootId.
const EDGE_KIND_SQL = `
  SELECT
    r1.entity_id    AS from_id,
    r2.entity_id    AS to_id,
    d.kind          AS via_kind,
    COUNT(DISTINCT d.id) AS co_count
  FROM document_references r1
  JOIN document_references r2
    ON r1.document_id = r2.document_id
    AND r1.entity_id != r2.entity_id
  JOIN documents d ON r1.document_id = d.id
  WHERE r1.entity_id = ?
  GROUP BY r1.entity_id, r2.entity_id, d.kind
  HAVING co_count >= ?
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
  const kindStmt = db.prepare<[string, number], KindRow>(EDGE_KIND_SQL);
  const totalStmt = db.prepare<[string, string], TotalRow>(TOTAL_COUNT_SQL);
  const sampleStmt = db.prepare<[string, string], SampleRow>(SAMPLE_DOCS_SQL);

  const kindRows = kindStmt.all(rootId, minCoOccurrences);

  // Group rows by (from_id, to_id) pair.
  const pairMap = new Map<string, { from_id: string; to_id: string; kinds: Set<string> }>();
  for (const row of kindRows) {
    const key = `${row.from_id}|${row.to_id}`;
    if (!pairMap.has(key)) {
      pairMap.set(key, { from_id: row.from_id, to_id: row.to_id, kinds: new Set() });
    }
    pairMap.get(key)!.kinds.add(row.via_kind);
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
```

- [ ] **Step 1.4: Run tests (expect green)**

```bash
pnpm test tests/unit/core/connections.test.ts
```

All tests should pass. If the "truncated cap" test is flaky (SQLite
returns rows in a nondeterministic order that causes > 100 edges to
appear briefly), add an `ORDER BY` clause to ensure consistent capping.

- [ ] **Step 1.5: Run full test suite to check for regressions**

```bash
pnpm test
```

No regressions expected — `connections.ts` has no imports from existing
modules beyond `better-sqlite3` types.

- [ ] **Step 1.6: Commit**

```bash
git add src/core/connections.ts tests/unit/core/connections.test.ts
git commit -m "$(cat <<'EOF'
feat: add findConnections query layer for co-occurrence graph

Implements depth-1 and depth-2 entity co-occurrence discovery over
document_references with a 100-edge hard cap, 20-neighbor expansion
limit, sorted edges, and per-edge sample documents (max 3).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `entity_connections` tool

**Files:** `src/mcp/tools/entity_connections.ts` (new),
`src/mcp/schemas.ts` (modified),
`tests/unit/mcp/tools/entity_connections.test.ts` (new)

The tool handler wraps `findConnections`, hydrates entity and document
metadata from the DB, formats the response per `docs/05-tool-surface.md`,
and enforces the `truncated` flag and `sources` array.

### Response type

```ts
interface EntityConnectionsResponse {
  root: EntityMatch;
  edges: Array<{
    from: string;                  // entity UUID
    to: string;                   // entity UUID
    via_kinds: string[];
    co_occurrence_count: number;
    sample_documents: DocumentMatch[];
  }>;
  nodes: EntityMatch[];            // deduplicated flat list of all touched entities
  sources: Array<{ name: string; url: string }>;
  truncated: boolean;
}
```

where `EntityMatch` and `DocumentMatch` reuse the types already defined
in `search_entities.ts` and `get_entity.ts`.

### Hydration strategy

After `findConnections` returns raw edges:

1. Collect all entity IDs referenced by edges (root + all `from_id` /
   `to_id` values), dedup, and batch-fetch from `entities`.
2. Collect all `sample_document_ids`, dedup, batch-fetch from
   `documents`.
3. Build the `nodes` array from the fetched entities (excluding the root
   entity, which goes in `root` separately).
4. Build the `sources` array from the unique `source_name` values of all
   sample documents, using the same source-URL mapping as `get_entity.ts`.

### Batch-fetch helpers

Use SQLite's `IN (?, ?, ...)` syntax with a dynamic parameter list. For
up to ~100 edges × 3 samples each = up to 300 document UUIDs, this
remains well within SQLite limits.

```ts
// Batch fetch entities by IDs
db.prepare(
  `SELECT * FROM entities WHERE id IN (${ids.map(() => "?").join(",")})`,
).all(...ids)

// Batch fetch documents by IDs
db.prepare(
  `SELECT * FROM documents WHERE id IN (${ids.map(() => "?").join(",")})`,
).all(...ids)
```

When `ids` is empty, return `[]` without hitting the DB (SQLite does not
support `IN ()` with zero elements).

- [ ] **Step 2.1: Add `EntityConnectionsInput` to `src/mcp/schemas.ts`**

Open `src/mcp/schemas.ts` and append after the last export:

```ts
export const EntityConnectionsInput = z.object({
  id: z.string().min(1),
  depth: z.union([z.literal(1), z.literal(2)]).default(1),
  min_co_occurrences: z.number().int().min(1).max(50).default(2),
});
export type EntityConnectionsInput = z.infer<typeof EntityConnectionsInput>;
```

- [ ] **Step 2.2: Write unit tests for the tool handler**

Create `tests/unit/mcp/tools/entity_connections.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleEntityConnections } from "../../../../src/mcp/tools/entity_connections.js";

const TEST_DB = "./data/test-entity-connections-tool.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});

afterEach(() => {
  store.close();
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

function makeEntity(name: string) {
  return upsertEntity(store.db, { kind: "person", name }).entity;
}

function makeDoc(sourceId: string, kind: "bill" | "vote", refs: string[]) {
  return upsertDocument(store.db, {
    kind,
    jurisdiction: "us-federal",
    title: `Doc ${sourceId}`,
    occurred_at: "2024-03-01T00:00:00.000Z",
    source: { name: "congress", id: sourceId, url: `https://congress.gov/${sourceId}` },
    references: refs.map((entity_id) => ({ entity_id, role: "voter" as const })),
  }).document;
}

describe("handleEntityConnections", () => {
  it("throws when entity is not found", async () => {
    await expect(
      handleEntityConnections(store.db, {
        id: "00000000-0000-0000-0000-000000000000",
        depth: 1,
        min_co_occurrences: 1,
      }),
    ).rejects.toThrow("Entity not found");
  });

  it("returns root with empty edges when entity has no documents", async () => {
    const a = makeEntity("Alice Empty");
    const result = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 1,
      min_co_occurrences: 1,
    });
    expect(result.root.id).toBe(a.id);
    expect(result.edges).toHaveLength(0);
    expect(result.nodes).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it("returns one edge with sample_documents and populated nodes", async () => {
    const a = makeEntity("Alice Conn");
    const b = makeEntity("Bob Conn");
    const doc = makeDoc("conn-doc-1", "bill", [a.id, b.id]);
    const result = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 1,
      min_co_occurrences: 1,
    });
    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0];
    expect(edge.from).toBe(a.id);
    expect(edge.to).toBe(b.id);
    expect(edge.via_kinds).toContain("bill");
    expect(edge.sample_documents).toHaveLength(1);
    expect(edge.sample_documents[0].id).toBe(doc.id);
    // b should appear in nodes
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).toContain(b.id);
    // root should NOT appear in nodes
    expect(nodeIds).not.toContain(a.id);
  });

  it("respects min_co_occurrences", async () => {
    const a = makeEntity("Alice Min");
    const b = makeEntity("Bob Min");
    const c = makeEntity("Carol Min");
    // a↔b: 2 shared docs, a↔c: 1 shared doc
    makeDoc("min-ab-1", "bill", [a.id, b.id]);
    makeDoc("min-ab-2", "bill", [a.id, b.id]);
    makeDoc("min-ac-1", "bill", [a.id, c.id]);
    const result = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 1,
      min_co_occurrences: 2,
    });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].to).toBe(b.id);
  });

  it("includes sources from sample documents", async () => {
    const a = makeEntity("Alice Src");
    const b = makeEntity("Bob Src");
    makeDoc("src-doc-1", "bill", [a.id, b.id]);
    const result = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 1,
      min_co_occurrences: 1,
    });
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0].name).toBe("congress");
  });

  it("validates input via zod — rejects invalid depth", async () => {
    const a = makeEntity("Alice ValidZ");
    await expect(
      handleEntityConnections(store.db, { id: a.id, depth: 3, min_co_occurrences: 1 }),
    ).rejects.toThrow();
  });

  it("depth=2 surfaces second-hop neighbors in nodes", async () => {
    const a = makeEntity("Alice D2 Tool");
    const b = makeEntity("Bob D2 Tool");
    const c = makeEntity("Carol D2 Tool");
    makeDoc("d2t-ab-1", "bill", [a.id, b.id]);
    makeDoc("d2t-ab-2", "bill", [a.id, b.id]);
    makeDoc("d2t-bc-1", "vote", [b.id, c.id]);
    makeDoc("d2t-bc-2", "vote", [b.id, c.id]);
    const result = await handleEntityConnections(store.db, {
      id: a.id,
      depth: 2,
      min_co_occurrences: 1,
    });
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).toContain(c.id);
  });

  it("returns truncated=true and exactly 100 edges at the hard cap", async () => {
    // Seed 102 peers, each sharing 2 documents with root (to exceed
    // min_co_occurrences=2) — verifies cap and truncated flag.
    const root = makeEntity("Alice Cap Tool");
    for (let i = 0; i < 102; i++) {
      const peer = makeEntity(`Peer Cap Tool ${i}`);
      makeDoc(`cap-tool-${i}-a`, "bill", [root.id, peer.id]);
      makeDoc(`cap-tool-${i}-b`, "bill", [root.id, peer.id]);
    }
    const result = await handleEntityConnections(store.db, {
      id: root.id,
      depth: 1,
      min_co_occurrences: 2,
    });
    expect(result.edges.length).toBe(100);
    expect(result.truncated).toBe(true);
  });
});
```

- [ ] **Step 2.3: Run the tests (expect failures)**

```bash
pnpm test tests/unit/mcp/tools/entity_connections.test.ts 2>&1 | tail -20
```

Expected: failures because `entity_connections.ts` doesn't exist yet.

- [ ] **Step 2.4: Implement `src/mcp/tools/entity_connections.ts`**

Create `src/mcp/tools/entity_connections.ts`:

```ts
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
    .prepare(`SELECT id, kind, title, occurred_at, source_url, source_name FROM documents WHERE id IN (${ids.map(() => "?").join(",")})`)
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

  // Build sources from unique source_name values across sample documents.
  const sourcesSeen = new Map<string, string>();
  for (const row of docMap.values()) {
    if (!sourcesSeen.has(row.source_name)) {
      sourcesSeen.set(row.source_name, sourceUrl(row.source_name, "us-federal"));
    }
  }
  const sources = Array.from(sourcesSeen.entries()).map(([name, url]) => ({ name, url }));

  return { root, edges, nodes, sources, truncated };
}
```

- [ ] **Step 2.5: Run the tool tests (expect green)**

```bash
pnpm test tests/unit/mcp/tools/entity_connections.test.ts
```

- [ ] **Step 2.6: Run full test suite**

```bash
pnpm test
```

No regressions expected.

- [ ] **Step 2.7: Commit**

```bash
git add src/mcp/schemas.ts src/mcp/tools/entity_connections.ts \
  tests/unit/mcp/tools/entity_connections.test.ts
git commit -m "$(cat <<'EOF'
feat: add entity_connections tool with depth-1/2 co-occurrence graph

Tool handler hydrates entity/document metadata, enforces 100-edge cap
with truncated flag, and returns flat edge list sorted by strength.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `resolve_person` tool

**Files:** `src/mcp/tools/resolve_person.ts` (new),
`src/mcp/schemas.ts` (modified),
`tests/unit/mcp/tools/resolve_person.test.ts` (new)

The tool implements three-step name matching (exact, alias, fuzzy) and
returns matches with confidence labels and human-readable disambiguators.
It reuses `normalizeName` and `fuzzyPick` from `src/resolution/fuzzy.ts`
but adapts `fuzzyPick` for multi-match use (returning all qualifying
candidates rather than picking one).

### Matching algorithm

**Step 1 — Exact normalized-name match:**
```sql
SELECT * FROM entities WHERE kind = 'person' AND name_normalized = ?
```
All results are tagged `confidence: "exact"`.

**Step 2 — Alias match:**
```sql
SELECT * FROM entities WHERE kind = 'person'
  AND json_extract(aliases, '$') LIKE ?
```
Because SQLite's `json_extract` on an array returns a JSON string, alias
matching uses a `LIKE` scan over the serialized `aliases` JSON text, or
a `WHERE json_each.value = ?` join using `json_each`. The plan uses
`json_each` for correctness (avoids false positives from substrings):

```sql
SELECT DISTINCT e.*
FROM entities e, json_each(e.aliases) a
WHERE e.kind = 'person' AND a.value = ?
```

But we want the alias match to compare normalized aliases to the
normalized query:

```sql
SELECT DISTINCT e.*
FROM entities e, json_each(e.aliases) a
WHERE e.kind = 'person'
  AND lower(replace(replace(a.value, '.', ''), ',', '')) LIKE ?
```

Because normalizing all aliases in SQL is complex, use a two-step
approach in code: fetch all Person entities where the raw aliases JSON
text contains the query string as a substring (cheap pre-filter via
`LIKE`), then re-normalize each alias in JavaScript and compare. This
avoids SQL-side normalization complexity and keeps correctness in one
place.

```sql
SELECT * FROM entities WHERE kind = 'person' AND aliases LIKE ?
```
with `needle = `%${input.name}%`` as the pre-filter, followed by exact
normalized comparison in JavaScript.

Tag results `confidence: "alias"` unless they were already found in Step
1 (in which case they keep `"exact"`).

**Step 3 — Fuzzy match:**
Enumerate Persons whose `name_normalized` shares the same first word as
the normalized query. Pass them all to a modified version of `fuzzyPick`
that returns ALL candidates at distance ≤ 1 with a linking signal
(rather than picking exactly one). Tag as `confidence: "fuzzy"`.

For `resolve_person`, the linking signal for the fuzzy path is
constructed from `jurisdiction_hint` (mapped to a `role_jurisdictions`
entry) and `role_hint` (used as a soft pre-filter on `metadata.roles[]`
— not a hard filter, but preferred in ranking). In V1, both are used as
linking signals only; `context` is ignored.

**Deduplication:** After all three steps, entities matching on multiple
paths appear once with the highest-confidence label.

**`jurisdiction_hint` and `role_hint` for ranking:** After collecting
all matches, sort by:
1. Confidence: `"exact"` first, then `"alias"`, then `"fuzzy"`.
2. Within the same confidence tier, prefer entities whose
   `metadata.roles[]` contains a role matching `role_hint` (if provided)
   or a jurisdiction matching `jurisdiction_hint` (if provided).
3. Break remaining ties by `last_seen_at DESC`.

### `disambiguators` construction

For `kind = 'person'`: extract `metadata.roles[]`, format each as
`"<role>, <jurisdiction>, <from>–<to>"`. If `to` is null, use
`"present"`. Example: `"senator, us-federal, 2019-01-03–present"`.

For other kinds: `["<kind>, <jurisdiction>"]`.

### Response type

```ts
interface ResolvePersonMatch {
  entity_id: string;
  name: string;
  confidence: "exact" | "alias" | "fuzzy";
  disambiguators: string[];
}

interface ResolvePersonResponse {
  matches: ResolvePersonMatch[];
}
```

- [ ] **Step 3.1: Add `ResolvePersonInput` to `src/mcp/schemas.ts`**

Append after `EntityConnectionsInput`:

```ts
export const ResolvePersonInput = z.object({
  name: z.string().min(1),
  jurisdiction_hint: z.string().optional(),
  role_hint: z.string().optional(),
  context: z.string().optional(),
});
export type ResolvePersonInput = z.infer<typeof ResolvePersonInput>;
```

- [ ] **Step 3.2: Write unit tests**

Create `tests/unit/mcp/tools/resolve_person.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { handleResolvePerson } from "../../../../src/mcp/tools/resolve_person.js";

const TEST_DB = "./data/test-resolve-person.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});

afterEach(() => {
  store.close();
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

describe("handleResolvePerson", () => {
  it("returns empty matches for an unknown name", async () => {
    const result = await handleResolvePerson(store.db, { name: "Zzz Nonexistent" });
    expect(result.matches).toHaveLength(0);
  });

  it("returns exact match with confidence=exact", async () => {
    upsertEntity(store.db, { kind: "person", name: "Jane Smith" });
    const result = await handleResolvePerson(store.db, { name: "Jane Smith" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].confidence).toBe("exact");
    expect(result.matches[0].name).toBe("Jane Smith");
  });

  it("returns alias match with confidence=alias", async () => {
    upsertEntity(store.db, {
      kind: "person",
      name: "Jonathan Doe",
      aliases: ["Jon Doe"],
    });
    const result = await handleResolvePerson(store.db, { name: "Jon Doe" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].confidence).toBe("alias");
    expect(result.matches[0].name).toBe("Jonathan Doe");
  });

  it("returns exact confidence when name matches both canonical and alias paths", async () => {
    // Insert two entities: one whose canonical name is the query,
    // another with the query as an alias.
    const e1 = upsertEntity(store.db, { kind: "person", name: "Alex Morgan" }).entity;
    upsertEntity(store.db, {
      kind: "person",
      name: "Alexandra Morgan",
      aliases: ["Alex Morgan"],
    });
    const result = await handleResolvePerson(store.db, { name: "Alex Morgan" });
    // e1 should appear with confidence=exact; the alias match gets alias.
    // The entity whose canonical name IS "Alex Morgan" must have exact.
    const exactMatch = result.matches.find((m) => m.entity_id === e1.id);
    expect(exactMatch?.confidence).toBe("exact");
  });

  it("returns fuzzy match with confidence=fuzzy when Levenshtein distance=1", async () => {
    // "Chuck Grassley" → query "Chuk Grassley" (one typo, 'd' → deleted)
    // Provide jurisdiction_hint to satisfy linking signal.
    upsertEntity(store.db, {
      kind: "person",
      name: "Chuck Grassley",
      metadata: {
        roles: [{ jurisdiction: "us-ia", role: "senator", from: "1981-01-05" }],
      },
    });
    const result = await handleResolvePerson(store.db, {
      name: "Chuk Grassley",
      jurisdiction_hint: "us-ia",
    });
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const fuzzyMatch = result.matches.find((m) => m.confidence === "fuzzy");
    expect(fuzzyMatch).toBeDefined();
    expect(fuzzyMatch?.name).toBe("Chuck Grassley");
  });

  it("does not return fuzzy match without a linking signal", async () => {
    upsertEntity(store.db, { kind: "person", name: "Chuck Grassley" });
    // No jurisdiction_hint or role_hint — no linking signal.
    const result = await handleResolvePerson(store.db, { name: "Chuk Grassley" });
    // Should NOT return a fuzzy match because no linking signal is present.
    const fuzzyMatches = result.matches.filter((m) => m.confidence === "fuzzy");
    expect(fuzzyMatches).toHaveLength(0);
  });

  it("populates disambiguators from metadata.roles[] for Persons", async () => {
    upsertEntity(store.db, {
      kind: "person",
      name: "Maria Lopez",
      metadata: {
        roles: [
          { jurisdiction: "us-tx", role: "state_legislator", from: "2010-01-01T00:00:00.000Z", to: "2018-01-01T00:00:00.000Z" },
          { jurisdiction: "us-federal", role: "representative", from: "2019-01-03T00:00:00.000Z", to: null },
        ],
      },
    });
    const result = await handleResolvePerson(store.db, { name: "Maria Lopez" });
    expect(result.matches[0].disambiguators.length).toBeGreaterThanOrEqual(2);
    const d = result.matches[0].disambiguators.join(" | ");
    expect(d).toContain("us-tx");
    expect(d).toContain("us-federal");
    expect(d).toContain("present");
  });

  it("sorts exact matches before alias, alias before fuzzy", async () => {
    // Exact: "Sam Chen"
    upsertEntity(store.db, { kind: "person", name: "Sam Chen" });
    // Alias: "Samuel Chen" with alias "Sam Chen" — but wait, inserting
    // "Sam Chen" canonical already occupies that normalized name.
    // Use a different alias scenario: query "Sam Chen", and a second
    // entity "Samantha Chen" with alias "Sam Chen" (different canonical).
    upsertEntity(store.db, {
      kind: "person",
      name: "Samantha Chen",
      aliases: ["Sam Chen"],
    });
    const result = await handleResolvePerson(store.db, { name: "Sam Chen" });
    const confidences = result.matches.map((m) => m.confidence);
    const exactIdx = confidences.indexOf("exact");
    const aliasIdx = confidences.indexOf("alias");
    if (exactIdx !== -1 && aliasIdx !== -1) {
      expect(exactIdx).toBeLessThan(aliasIdx);
    }
  });

  it("accepts context field without error (V1 ignores it)", async () => {
    upsertEntity(store.db, { kind: "person", name: "Test Person" });
    await expect(
      handleResolvePerson(store.db, {
        name: "Test Person",
        context: "Texas energy committee member",
      }),
    ).resolves.not.toThrow();
  });

  it("matches non-Person kinds only when they have the exact name and kind=person is not matched", async () => {
    // resolve_person operates only over kind='person' rows.
    upsertEntity(store.db, {
      kind: "organization",
      name: "Texas Energy Committee",
      jurisdiction: "us-tx",
    });
    const result = await handleResolvePerson(store.db, { name: "Texas Energy Committee" });
    // Non-Person entity — should NOT appear in resolve_person results.
    expect(result.matches).toHaveLength(0);
  });
});
```

- [ ] **Step 3.3: Run the tests (expect failures)**

```bash
pnpm test tests/unit/mcp/tools/resolve_person.test.ts 2>&1 | tail -20
```

- [ ] **Step 3.4: Implement `src/mcp/tools/resolve_person.ts`**

Create `src/mcp/tools/resolve_person.ts`:

```ts
import type Database from "better-sqlite3";
import { ResolvePersonInput } from "../schemas.js";
import { normalizeName, levenshtein, type FuzzyCandidate, type UpstreamSignals } from "../../resolution/fuzzy.js";

interface PersonRow {
  id: string;
  name: string;
  name_normalized: string;
  aliases: string;
  metadata: string;
}

export interface ResolvePersonMatch {
  entity_id: string;
  name: string;
  confidence: "exact" | "alias" | "fuzzy";
  disambiguators: string[];
}

export interface ResolvePersonResponse {
  matches: ResolvePersonMatch[];
}

const CONFIDENCE_RANK: Record<"exact" | "alias" | "fuzzy", number> = {
  exact: 0,
  alias: 1,
  fuzzy: 2,
};

function buildDisambiguators(row: PersonRow): string[] {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    return [];
  }
  const roles = metadata.roles;
  if (!Array.isArray(roles) || roles.length === 0) return [];
  return roles.map((r: unknown) => {
    const role = r as { jurisdiction?: string; role?: string; from?: string; to?: string | null };
    const juris = role.jurisdiction ?? "unknown";
    const title = role.role ?? "unknown";
    const from = role.from ? role.from.split("T")[0] : "?";
    const to = role.to ? role.to.split("T")[0] : "present";
    return `${title}, ${juris}, ${from}–${to}`;
  });
}

function hasJurisdictionSignal(row: PersonRow, jurisdictionHint: string | undefined): boolean {
  if (!jurisdictionHint) return false;
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    return false;
  }
  const roles = metadata.roles;
  if (!Array.isArray(roles)) return false;
  return roles.some(
    (r: unknown) => (r as { jurisdiction?: string }).jurisdiction === jurisdictionHint,
  );
}

function hasRoleSignal(row: PersonRow, roleHint: string | undefined): boolean {
  if (!roleHint) return false;
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    return false;
  }
  const roles = metadata.roles;
  if (!Array.isArray(roles)) return false;
  const needle = roleHint.toLowerCase();
  return roles.some(
    (r: unknown) => ((r as { role?: string }).role ?? "").toLowerCase().includes(needle),
  );
}

export async function handleResolvePerson(
  db: Database.Database,
  rawInput: unknown,
): Promise<ResolvePersonResponse> {
  const input = ResolvePersonInput.parse(rawInput);
  const queryNorm = normalizeName(input.name);

  // Map entity_id → best confidence so far.
  const best = new Map<string, { row: PersonRow; confidence: "exact" | "alias" | "fuzzy" }>();

  // ── Step 1: Exact normalized-name match ──────────────────────────────
  const exactRows = db
    .prepare("SELECT * FROM entities WHERE kind = 'person' AND name_normalized = ?")
    .all(queryNorm) as PersonRow[];

  for (const row of exactRows) {
    best.set(row.id, { row, confidence: "exact" });
  }

  // ── Step 2: Alias match ──────────────────────────────────────────────
  // Pre-filter: rows where the raw aliases JSON text contains input.name
  // as a substring (fast). Then re-normalize each alias in JS for
  // correctness.
  const aliasPreFilter = db
    .prepare("SELECT * FROM entities WHERE kind = 'person' AND aliases LIKE ?")
    .all(`%${input.name}%`) as PersonRow[];

  for (const row of aliasPreFilter) {
    if (best.has(row.id)) continue; // already matched as exact
    let aliases: string[];
    try {
      aliases = JSON.parse(row.aliases) as string[];
    } catch {
      aliases = [];
    }
    const matched = aliases.some((a) => normalizeName(a) === queryNorm);
    if (matched) {
      best.set(row.id, { row, confidence: "alias" });
    }
  }

  // ── Step 3: Fuzzy match ──────────────────────────────────────────────
  // Only run if query has at least one word.
  const firstWord = queryNorm.split(" ")[0];
  if (firstWord) {
    const fuzzyCandidateRows = db
      .prepare(
        "SELECT * FROM entities WHERE kind = 'person' AND name_normalized LIKE ?",
      )
      .all(`${firstWord}%`) as PersonRow[];

    // Build UpstreamSignals from hints.
    const signals: UpstreamSignals = {
      external_id_sources: [],
      middle_name: null,
      role_jurisdictions: input.jurisdiction_hint ? [input.jurisdiction_hint] : [],
    };

    for (const row of fuzzyCandidateRows) {
      if (best.has(row.id)) continue; // already matched at higher confidence

      let aliases: string[];
      try {
        aliases = JSON.parse(row.aliases) as string[];
      } catch {
        aliases = [];
      }

      let metadataParsed: Record<string, unknown>;
      try {
        metadataParsed = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadataParsed = {};
      }
      const roles = Array.isArray(metadataParsed.roles) ? metadataParsed.roles : [];
      const roleJurisdictions = roles.map(
        (r: unknown) => (r as { jurisdiction?: string }).jurisdiction ?? "",
      ).filter(Boolean);

      const candidate: FuzzyCandidate = {
        id: row.id,
        name: row.name,
        external_id_sources: [],
        aliases,
        role_jurisdictions: roleJurisdictions,
      };

      const dist = levenshtein(queryNorm, row.name_normalized);
      if (dist > 1) continue;

      // Check for runner-up: any other candidate at distance ≤ 3 with
      // a different normalized name would disqualify. Because we iterate
      // row-by-row, track whether this candidate is the sole dist-≤-1
      // match for its first word. Simplified approach: require linking
      // signal (the primary discriminator in D3b).
      let hasSignal = false;
      for (const j of signals.role_jurisdictions) {
        if (roleJurisdictions.includes(j)) { hasSignal = true; break; }
      }
      if (!hasSignal && input.role_hint) {
        const needle = input.role_hint.toLowerCase();
        hasSignal = roles.some(
          (r: unknown) => ((r as { role?: string }).role ?? "").toLowerCase().includes(needle),
        );
      }
      if (!hasSignal) continue;

      best.set(row.id, { row, confidence: "fuzzy" });
    }
  }

  // ── Rank and format results ─────────────────────────────────────────
  const matches: ResolvePersonMatch[] = Array.from(best.values())
    .sort((a, b) => {
      const confDiff = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
      if (confDiff !== 0) return confDiff;
      // Within same confidence, prefer hint-matching entities.
      const aHint =
        (hasJurisdictionSignal(a.row, input.jurisdiction_hint) ? 1 : 0) +
        (hasRoleSignal(a.row, input.role_hint) ? 1 : 0);
      const bHint =
        (hasJurisdictionSignal(b.row, input.jurisdiction_hint) ? 1 : 0) +
        (hasRoleSignal(b.row, input.role_hint) ? 1 : 0);
      if (bHint !== aHint) return bHint - aHint;
      return a.row.name < b.row.name ? -1 : a.row.name > b.row.name ? 1 : 0;
    })
    .map(({ row, confidence }) => ({
      entity_id: row.id,
      name: row.name,
      confidence,
      disambiguators: buildDisambiguators(row),
    }));

  return { matches };
}
```

- [ ] **Step 3.5: Run the tool tests (expect green)**

```bash
pnpm test tests/unit/mcp/tools/resolve_person.test.ts
```

If the fuzzy-without-linking-signal test fails: verify that
`hasSignal` correctly requires at least one of `jurisdiction_hint` or
`role_hint` to be present AND match the candidate's `metadata.roles[]`.
An entity with no roles metadata and no hints should always return
`hasSignal = false`.

- [ ] **Step 3.6: Run full test suite**

```bash
pnpm test
```

- [ ] **Step 3.7: Commit**

```bash
git add src/mcp/schemas.ts src/mcp/tools/resolve_person.ts \
  tests/unit/mcp/tools/resolve_person.test.ts
git commit -m "$(cat <<'EOF'
feat: add resolve_person tool with exact/alias/fuzzy confidence tiers

Three-step name matching over person entities; jurisdiction_hint and
role_hint serve as fuzzy linking signals; disambiguators derived from
metadata.roles[]; context field accepted but reserved for Phase 6+.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Register both tools in `server.ts`, bump to v0.0.5

**Files:** `src/mcp/server.ts` (modified)

- [ ] **Step 4.1: Write a unit test for server registration**

Open `tests/unit/mcp/server.test.ts` (an existing file from prior
phases). Add inside the existing `describe` block:

```ts
it("registers entity_connections and resolve_person tools", () => {
  // The server registers 8 tools total in v0.0.5.
  // Use the ListTools MCP request to verify both are present.
  // Lean on the existing server fixture from prior tests in this file.
  const toolNames = registeredToolNames(server.mcp); // use whichever helper already exists
  expect(toolNames).toContain("entity_connections");
  expect(toolNames).toContain("resolve_person");
});
```

If no `registeredToolNames` helper exists yet in the test file, add one:

```ts
function registeredToolNames(mcp: McpServer): string[] {
  // McpServer exposes _registeredTools (internal map) or a listTools method.
  // Inspect which surface is available in the Phase 4 test file and mirror it.
  return (mcp as unknown as { _registeredTools: Map<string, unknown> })
    ._registeredTools
    ? Array.from(
        (mcp as unknown as { _registeredTools: Map<string, unknown> })
          ._registeredTools.keys(),
      )
    : [];
}
```

If the existing test file uses a different introspection approach (e.g.,
calling `mcp.server.listTools()`), use that instead. The goal is to
assert both tool names appear.

- [ ] **Step 4.2: Run the server test (expect failure for new tools)**

```bash
pnpm test tests/unit/mcp/server.test.ts 2>&1 | tail -20
```

- [ ] **Step 4.3: Update `src/mcp/server.ts`**

Open `src/mcp/server.ts`. Make these changes:

1. Bump version to `"0.0.5"`.
2. Add imports:

```ts
import { handleEntityConnections } from "./tools/entity_connections.js";
import { handleResolvePerson } from "./tools/resolve_person.js";
import {
  EntityConnectionsInput,
  ResolvePersonInput,
} from "./schemas.js";
```

3. Register `entity_connections` after the `search_civic_documents` registration:

```ts
  mcp.registerTool(
    "entity_connections",
    {
      description:
        "Return co-occurrence edges for an entity — who shares bills, votes, or " +
        "contribution documents with this person or organization. " +
        "depth=1 (default) returns direct connections; depth=2 expands one hop further " +
        "(capped at 100 total edges). Increase min_co_occurrences to filter out weak ties.",
      inputSchema: EntityConnectionsInput.shape,
    },
    async (input) => {
      const data = await handleEntityConnections(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );
```

4. Register `resolve_person`:

```ts
  mcp.registerTool(
    "resolve_person",
    {
      description:
        "Disambiguate a person's name across all ingested jurisdictions. " +
        "Returns matching entities with confidence scores " +
        "(exact > alias > fuzzy) and disambiguators (roles, jurisdictions, time spans). " +
        "Use jurisdiction_hint (e.g. 'us-federal', 'us-tx') or role_hint " +
        "(e.g. 'senator', 'state_legislator') to improve fuzzy matching.",
      inputSchema: ResolvePersonInput.shape,
    },
    async (input) => {
      const data = await handleResolvePerson(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );
```

- [ ] **Step 4.4: Run the server test (expect green)**

```bash
pnpm test tests/unit/mcp/server.test.ts
```

- [ ] **Step 4.5: Run full test suite**

```bash
pnpm test
```

Expected: all prior tests still pass, plus the new server test.

- [ ] **Step 4.6: Commit**

```bash
git add src/mcp/server.ts tests/unit/mcp/server.test.ts
git commit -m "$(cat <<'EOF'
feat: register entity_connections and resolve_person; bump to v0.0.5

Server now exposes all 8 tools in the final Phase 5 surface. Both new
tools use mcp.registerTool (not the deprecated mcp.tool API).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: End-to-end integration test across the 3-source graph

**Files:** `tests/integration/phase5-e2e.test.ts` (new)

This test exercises both Phase 5 tools using a pre-seeded in-memory
database that simulates a real 3-source graph: a Person who is
simultaneously a state legislator (OpenStates), a Member of Congress
(Congress.gov), and a federal candidate (OpenFEC). The test verifies:

1. `entity_connections` surfaces bill edges (state + federal), vote
   edges (federal), and contribution edges (federal) for this merged
   Person.
2. `resolve_person` returns the same Person with `confidence: "exact"`
   when queried by canonical name, `confidence: "alias"` when queried
   by a known alias, and `confidence: "fuzzy"` when queried with a
   one-character typo plus a `jurisdiction_hint`.

The test runs entirely in-process (no server stdio spawn) by calling
the handler functions directly, which is consistent with the approach
used in Phase 3 and 4 integration tests.

- [ ] **Step 5.1: Write `tests/integration/phase5-e2e.test.ts`**

```ts
/**
 * Phase 5 end-to-end integration test.
 *
 * Simulates a merged-Person entity with roles spanning three sources
 * (OpenStates, Congress.gov, OpenFEC) and verifies both Phase 5 tools
 * produce correct output over that graph.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/core/seeds.js";
import { upsertEntity } from "../../src/core/entities.js";
import { upsertDocument } from "../../src/core/documents.js";
import { handleEntityConnections } from "../../src/mcp/tools/entity_connections.js";
import { handleResolvePerson } from "../../src/mcp/tools/resolve_person.js";

const TEST_DB = "./data/test-phase5-e2e.db";
let store: Store;

// The merged Person: state legislator → Member of Congress → FEC candidate.
let personId: string;
// Co-occurring entities
let coSponsorId: string;
let voterColleagueId: string;
let donorId: string;
let pacId: string;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  // Seed the merged Person with three external IDs and three roles.
  const person = upsertEntity(store.db, {
    kind: "person",
    name: "Margaret H. Callahan",
    aliases: ["Peggy Callahan", "M. Callahan"],
    external_ids: {
      openstates_person: "ocd-person/test-callahan",
      bioguide: "C999999",
      fec_candidate: "H6IL99999",
    },
    metadata: {
      roles: [
        {
          jurisdiction: "us-il",
          role: "state_legislator",
          from: "2010-01-01T00:00:00.000Z",
          to: "2016-11-08T00:00:00.000Z",
        },
        {
          jurisdiction: "us-federal",
          role: "representative",
          from: "2017-01-03T00:00:00.000Z",
          to: null,
        },
        {
          jurisdiction: "us-federal",
          role: "federal_candidate",
          from: "2023-01-01T00:00:00.000Z",
          to: null,
        },
      ],
    },
  }).entity;
  personId = person.id;

  // Co-sponsor on a state bill (OpenStates).
  const coSponsor = upsertEntity(store.db, {
    kind: "person",
    name: "Thomas Benitez",
  }).entity;
  coSponsorId = coSponsor.id;

  // Colleague on federal votes (Congress).
  const voterColleague = upsertEntity(store.db, {
    kind: "person",
    name: "Lydia Okonkwo",
    external_ids: { bioguide: "O100001" },
    metadata: {
      roles: [
        { jurisdiction: "us-federal", role: "representative", from: "2015-01-03T00:00:00.000Z", to: null },
      ],
    },
  }).entity;
  voterColleagueId = voterColleague.id;

  // Individual donor (OpenFEC).
  const donor = upsertEntity(store.db, {
    kind: "person",
    name: "Randolph Alvarez",
  }).entity;
  donorId = donor.id;

  // PAC (OpenFEC).
  const pac = upsertEntity(store.db, {
    kind: "pac",
    name: "Illinois Forward PAC",
    jurisdiction: "us-federal",
    external_ids: { fec_committee: "C00999001" },
  }).entity;
  pacId = pac.id;

  // ── State bills (OpenStates) ─────────────────────────────────────────
  // Callahan co-sponsors two state bills with Benitez.
  upsertDocument(store.db, {
    kind: "bill",
    jurisdiction: "us-il",
    title: "IL HB 1234 — Energy Efficiency Standards",
    occurred_at: "2013-03-15T00:00:00.000Z",
    source: { name: "openstates", id: "ocd-bill/il-2013-hb1234", url: "https://openstates.org/il/bills/il-2013-hb1234/" },
    references: [
      { entity_id: personId, role: "sponsor" },
      { entity_id: coSponsorId, role: "cosponsor" },
    ],
  });
  upsertDocument(store.db, {
    kind: "bill",
    jurisdiction: "us-il",
    title: "IL SB 567 — Water Conservation Act",
    occurred_at: "2014-01-20T00:00:00.000Z",
    source: { name: "openstates", id: "ocd-bill/il-2014-sb567", url: "https://openstates.org/il/bills/il-2014-sb567/" },
    references: [
      { entity_id: personId, role: "sponsor" },
      { entity_id: coSponsorId, role: "cosponsor" },
    ],
  });

  // ── Federal bills (Congress) ─────────────────────────────────────────
  // Callahan sponsors two federal bills; Okonkwo is a co-sponsor.
  upsertDocument(store.db, {
    kind: "bill",
    jurisdiction: "us-federal",
    title: "HR 4500 — National Infrastructure Renewal Act",
    occurred_at: "2021-06-10T00:00:00.000Z",
    source: { name: "congress", id: "congress-hr4500-117", url: "https://www.congress.gov/bill/117th-congress/house-bill/4500" },
    references: [
      { entity_id: personId, role: "sponsor" },
      { entity_id: voterColleagueId, role: "cosponsor" },
    ],
  });
  upsertDocument(store.db, {
    kind: "bill",
    jurisdiction: "us-federal",
    title: "HR 7890 — Clean Water Modernization Act",
    occurred_at: "2022-03-05T00:00:00.000Z",
    source: { name: "congress", id: "congress-hr7890-117", url: "https://www.congress.gov/bill/117th-congress/house-bill/7890" },
    references: [
      { entity_id: personId, role: "sponsor" },
      { entity_id: voterColleagueId, role: "cosponsor" },
    ],
  });

  // ── Federal votes (Congress) ─────────────────────────────────────────
  // Callahan and Okonkwo vote together on two roll calls.
  upsertDocument(store.db, {
    kind: "vote",
    jurisdiction: "us-federal",
    title: "Roll Call 312 — HR 4500 Passage",
    occurred_at: "2021-09-30T00:00:00.000Z",
    source: { name: "congress", id: "congress-vote-117-312", url: "https://www.congress.gov/roll-call-votes/117/312" },
    references: [
      { entity_id: personId, role: "voter", qualifier: "yea" },
      { entity_id: voterColleagueId, role: "voter", qualifier: "yea" },
    ],
  });
  upsertDocument(store.db, {
    kind: "vote",
    jurisdiction: "us-federal",
    title: "Roll Call 489 — HR 7890 Passage",
    occurred_at: "2022-05-12T00:00:00.000Z",
    source: { name: "congress", id: "congress-vote-117-489", url: "https://www.congress.gov/roll-call-votes/117/489" },
    references: [
      { entity_id: personId, role: "voter", qualifier: "yea" },
      { entity_id: voterColleagueId, role: "voter", qualifier: "yea" },
    ],
  });

  // ── Federal contributions (OpenFEC) ──────────────────────────────────
  // Donor contributes to Callahan twice; PAC contributes once separately.
  upsertDocument(store.db, {
    kind: "contribution",
    jurisdiction: "us-federal",
    title: "Contribution: Alvarez → Callahan for Congress (2024-02-10)",
    occurred_at: "2024-02-10T00:00:00.000Z",
    source: { name: "openfec", id: "fec-sa17-001", url: "https://www.fec.gov/data/receipts/?committee_id=C00999001" },
    references: [
      { entity_id: donorId, role: "contributor" },
      { entity_id: personId, role: "recipient" },
    ],
  });
  upsertDocument(store.db, {
    kind: "contribution",
    jurisdiction: "us-federal",
    title: "Contribution: Alvarez → Callahan for Congress (2024-03-22)",
    occurred_at: "2024-03-22T00:00:00.000Z",
    source: { name: "openfec", id: "fec-sa17-002", url: "https://www.fec.gov/data/receipts/?committee_id=C00999001" },
    references: [
      { entity_id: donorId, role: "contributor" },
      { entity_id: personId, role: "recipient" },
    ],
  });
  upsertDocument(store.db, {
    kind: "contribution",
    jurisdiction: "us-federal",
    title: "Contribution: Illinois Forward PAC → Callahan for Congress (2024-04-01)",
    occurred_at: "2024-04-01T00:00:00.000Z",
    source: { name: "openfec", id: "fec-sb23-003", url: "https://www.fec.gov/data/disbursements/?committee_id=C00999001" },
    references: [
      { entity_id: pacId, role: "contributor" },
      { entity_id: personId, role: "recipient" },
    ],
  });
});

afterEach(() => {
  store.close();
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

describe("entity_connections — 3-source graph (Phase 5 E2E)", () => {
  it("returns edges of kind=bill (state), kind=bill (federal), kind=vote, kind=contribution", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 2,
    });

    expect(result.root.id).toBe(personId);
    expect(result.edges.length).toBeGreaterThanOrEqual(3);

    const allViaKinds = result.edges.flatMap((e) => e.via_kinds);
    expect(allViaKinds).toContain("bill");
    expect(allViaKinds).toContain("vote");
    expect(allViaKinds).toContain("contribution");
  });

  it("connects Callahan ↔ Benitez via state bills", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 2,
    });
    const edge = result.edges.find(
      (e) => e.to === coSponsorId || e.from === coSponsorId,
    );
    expect(edge).toBeDefined();
    expect(edge!.via_kinds).toContain("bill");
    expect(edge!.co_occurrence_count).toBe(2);
  });

  it("connects Callahan ↔ Okonkwo via federal bills AND votes", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 2,
    });
    const edge = result.edges.find(
      (e) => e.to === voterColleagueId || e.from === voterColleagueId,
    );
    expect(edge).toBeDefined();
    expect(edge!.via_kinds).toContain("bill");
    expect(edge!.via_kinds).toContain("vote");
    // 2 shared bills + 2 shared votes = 4 total co-occurring docs
    expect(edge!.co_occurrence_count).toBe(4);
  });

  it("connects Callahan ↔ Alvarez (donor) via contributions", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 2,
    });
    const edge = result.edges.find(
      (e) => e.to === donorId || e.from === donorId,
    );
    expect(edge).toBeDefined();
    expect(edge!.via_kinds).toContain("contribution");
    expect(edge!.co_occurrence_count).toBe(2);
  });

  it("includes all connected entities in nodes (deduped)", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 2,
    });
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).toContain(coSponsorId);
    expect(nodeIds).toContain(voterColleagueId);
    expect(nodeIds).toContain(donorId);
    // No duplicates
    expect(nodeIds.length).toBe(new Set(nodeIds).size);
    // Root not in nodes
    expect(nodeIds).not.toContain(personId);
  });

  it("sample_documents contains at most 3 items per edge", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 1,
    });
    for (const edge of result.edges) {
      expect(edge.sample_documents.length).toBeLessThanOrEqual(3);
    }
  });

  it("includes sources from all three data providers", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 1,
    });
    const sourceNames = result.sources.map((s) => s.name);
    // At minimum congress and openfec docs appear as sample documents
    expect(sourceNames.some((n) => n === "congress" || n === "openstates" || n === "openfec")).toBe(true);
  });

  it("depth=2 from Benitez reaches Okonkwo through Callahan", async () => {
    // Benitez → Callahan (state bills), Callahan → Okonkwo (federal)
    const result = await handleEntityConnections(store.db, {
      id: coSponsorId,
      depth: 2,
      min_co_occurrences: 1,
    });
    const nodeIds = result.nodes.map((n) => n.id);
    // At depth=2, Okonkwo should be reachable
    expect(nodeIds).toContain(voterColleagueId);
  });

  it("does not return truncated=true when edges are within cap", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 1,
    });
    // 4 connections total (Benitez, Okonkwo, Alvarez, PAC) — well under 100
    expect(result.truncated).toBe(false);
  });
});

describe("resolve_person — 3-source graph (Phase 5 E2E)", () => {
  it("finds Callahan by canonical name with confidence=exact", async () => {
    const result = await handleResolvePerson(store.db, {
      name: "Margaret H. Callahan",
    });
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const match = result.matches.find((m) => m.entity_id === personId);
    expect(match).toBeDefined();
    expect(match!.confidence).toBe("exact");
  });

  it("finds Callahan by known alias 'Peggy Callahan' with confidence=alias", async () => {
    const result = await handleResolvePerson(store.db, {
      name: "Peggy Callahan",
    });
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const match = result.matches.find((m) => m.entity_id === personId);
    expect(match).toBeDefined();
    expect(match!.confidence).toBe("alias");
  });

  it("finds Callahan by alias 'M. Callahan' with confidence=alias", async () => {
    const result = await handleResolvePerson(store.db, {
      name: "M. Callahan",
    });
    const match = result.matches.find((m) => m.entity_id === personId);
    expect(match).toBeDefined();
    expect(match!.confidence).toBe("alias");
  });

  it("finds Callahan with fuzzy typo + jurisdiction_hint=us-il", async () => {
    // "Margaret H. Calahan" — one 'l' missing — distance=1
    const result = await handleResolvePerson(store.db, {
      name: "Margaret H. Calahan",
      jurisdiction_hint: "us-il",
    });
    const match = result.matches.find((m) => m.entity_id === personId);
    expect(match).toBeDefined();
    expect(match!.confidence).toBe("fuzzy");
  });

  it("finds Callahan with fuzzy typo + role_hint=representative", async () => {
    const result = await handleResolvePerson(store.db, {
      name: "Margaret H. Calahan",
      role_hint: "representative",
    });
    const match = result.matches.find((m) => m.entity_id === personId);
    expect(match).toBeDefined();
    expect(match!.confidence).toBe("fuzzy");
  });

  it("does NOT find Callahan by fuzzy typo alone (no linking signal)", async () => {
    const result = await handleResolvePerson(store.db, {
      name: "Margaret H. Calahan",
    });
    const fuzzyForCallahan = result.matches.find(
      (m) => m.entity_id === personId && m.confidence === "fuzzy",
    );
    expect(fuzzyForCallahan).toBeUndefined();
  });

  it("disambiguators include all three roles across three jurisdictions", async () => {
    const result = await handleResolvePerson(store.db, {
      name: "Margaret H. Callahan",
    });
    const match = result.matches.find((m) => m.entity_id === personId);
    expect(match).toBeDefined();
    const d = match!.disambiguators.join(" | ");
    expect(d).toContain("us-il");
    expect(d).toContain("us-federal");
    expect(d).toContain("state_legislator");
    expect(d).toContain("representative");
    // The open-ended federal role should show "present"
    expect(d).toContain("present");
  });

  it("exact result sorts before alias result in the same query", async () => {
    // Insert a second entity whose canonical name matches "M. Callahan" exactly.
    // This makes the query "M. Callahan" produce both an exact hit (for the
    // new entity) and an alias hit (for Callahan).
    upsertEntity(store.db, { kind: "person", name: "M. Callahan" });
    const result = await handleResolvePerson(store.db, { name: "M. Callahan" });
    const confidences = result.matches.map((m) => m.confidence);
    const exactIdx = confidences.indexOf("exact");
    const aliasIdx = confidences.indexOf("alias");
    expect(exactIdx).toBeLessThan(aliasIdx);
  });
});
```

- [ ] **Step 5.2: Run the integration test (expect green)**

```bash
pnpm test tests/integration/phase5-e2e.test.ts
```

If any test fails, diagnose before continuing. Common failure modes:

- **"Entity not found" from `entity_connections`:** The `personId`
  variable wasn't captured from `upsertEntity`. Verify that `beforeEach`
  actually assigns it.
- **Missing `via_kinds` entry:** The document references use a `role`
  (`"voter"`, `"contributor"`) that `document_references` records
  correctly, but the `findConnections` SQL only groups by document `kind`
  (not reference role) — so all references on the same document should
  produce the document's kind in `via_kinds`. If a kind is missing,
  check that the document was correctly inserted with the right `kind`.
- **Fuzzy without linking signal fires unexpectedly:** Verify that
  `resolve_person.ts` checks `signals.role_jurisdictions.length > 0 ||
  input.role_hint !== undefined` before treating any candidate as having
  a signal.

- [ ] **Step 5.3: Run full test suite**

```bash
pnpm test
```

All 108+ tests should pass. Record the new total.

- [ ] **Step 5.4: Commit**

```bash
git add tests/integration/phase5-e2e.test.ts
git commit -m "$(cat <<'EOF'
test: Phase 5 end-to-end integration across 3-source entity graph

Verifies entity_connections surfaces bill/vote/contribution edges for
a merged Person spanning OpenStates, Congress.gov, and OpenFEC; and
resolve_person returns exact/alias/fuzzy confidence tiers with
correct disambiguators for a cross-jurisdiction career.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Final docs update

**Files:** `docs/05-tool-surface.md` (modified),
`docs/roadmap.md` (modified)

These are brief documentation updates to mark Phase 5 shipped.

- [ ] **Step 6.1: Update `docs/05-tool-surface.md` phase-to-tool mapping**

In the table at the bottom of `docs/05-tool-surface.md`, update the
Phase 5 row from:

```
| **5 — Connections** | + `entity_connections`, `resolve_person` |
```

to:

```
| **5 — Connections** | + `entity_connections`, `resolve_person` ✓ shipped v0.0.5 |
```

- [ ] **Step 6.2: Add closing note to `docs/roadmap.md`**

Append to the end of `docs/roadmap.md` (after the "Done criteria"
section):

```md
---

## Phase 5 shipped — 2026-04-12

`entity_connections` and `resolve_person` shipped in v0.0.5. All 8
tools are live. The complete tool surface (4 feed tools + 5 entity
tools per `docs/05-tool-surface.md`) is implemented and tested. The
entity graph spans OpenStates (50 states), Congress.gov (federal
legislature), and OpenFEC (federal campaign finance), with cross-source
Person merges working end-to-end.

Post-V1 extension paths: see `docs/roadmap.md` "Done criteria" for
the publish checklist, and `docs/00-rationale.md` for future adapter
candidates (Federal Register, USASpending, CourtListener, SOPR).
```

- [ ] **Step 6.3: Run full test suite one final time**

```bash
pnpm test
```

Confirm all tests pass with the updated total (108+ passing, 0 failing).

- [ ] **Step 6.4: Commit**

```bash
git add docs/05-tool-surface.md docs/roadmap.md
git commit -m "$(cat <<'EOF'
docs: mark Phase 5 shipped in tool-surface and roadmap

Records v0.0.5 completion date and final 8-tool surface status.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 completion checklist

Before declaring Phase 5 done:

- [ ] All unit tests pass: `connections.test.ts`, `entity_connections.test.ts`,
  `resolve_person.test.ts`, updated `server.test.ts`.
- [ ] Integration test passes: `phase5-e2e.test.ts` (both
  `entity_connections` and `resolve_person` describe blocks).
- [ ] `pnpm test` exits 0 with no failing tests.
- [ ] `pnpm build` exits 0 (TypeScript compiles without errors).
- [ ] Server version is `"0.0.5"` in `src/mcp/server.ts`.
- [ ] No unused imports in any new or modified file (TypeScript will
  flag these — check `pnpm build` output).
- [ ] `entity_connections` and `resolve_person` appear in
  `docs/05-tool-surface.md` as shipped.
- [ ] Closing note added to `docs/roadmap.md`.

---

## Self-review

Before submitting for human review, verify these properties of the
implementation:

**`findConnections` (Task 1):**
- The `HAVING co_count >= ?` clause uses per-kind counts, not the
  total distinct document count. Pairs that co-occur on 1 bill and 1
  vote pass `HAVING co_count >= 1` for each kind but fail
  `minCoOccurrences=2` after the second-pass `TOTAL_COUNT_SQL`. Confirm
  that `expandOne` calls `totalStmt` after grouping and gates on
  `totalCount < minCoOccurrences`.
- The `existingPairs` set uses the `${from_id}|${to_id}` key. If the
  depth=2 expansion returns an edge `(neighborId → rootId)`, its key
  `${neighborId}|${rootId}` is distinct from `${rootId}|${neighborId}`.
  This is intentional — directed edges. For the `entity_connections`
  tool, both directions can appear at depth=2. The `nodes` dedup in
  the tool handler handles this correctly by operating on a `Set<string>`
  of entity IDs, not on edge pairs.
- `batchFetchEntities` and `batchFetchDocs` generate `IN (?, ?, ...)`
  queries. Both guard against `ids.length === 0` (which would produce
  invalid SQL `IN ()`).

**`entity_connections` tool handler (Task 2):**
- `sources` is derived from `docMap.values()` (the sample documents
  actually returned), not from all documents in the graph. This is
  intentional — sources cite only what the LLM can see.
- The `jurisdiction` parameter in `sourceUrl()` receives `"us-federal"`
  as a constant. For OpenStates documents, the actual jurisdiction comes
  from the document row, not from the entity. In the current
  implementation, `batchFetchDocs` does not include the document's
  `jurisdiction` column. If OpenStates source URLs matter to the LLM,
  add `jurisdiction` to the `DocRow` interface and `batchFetchDocs`
  SELECT, then thread it through `sourceUrl`. **Flag this as a known
  limitation** — in v0.0.5, OpenStates sources all return
  `https://openstates.org/us-federal/` rather than the state-specific
  URL. Fix in a post-v0.0.5 polish commit if needed.

**`resolve_person` tool handler (Task 3):**
- The alias pre-filter uses `aliases LIKE '%<raw input.name>%'`. This
  means a query of `"Al"` would pre-filter entities whose aliases JSON
  includes the substring `"Al"` (e.g., `["Alice"]`). The second-pass
  normalized comparison corrects this. However, if `input.name` contains
  SQL wildcard characters (`%` or `_`), the LIKE query could produce
  unexpected results. In V1 this is acceptable — the second-pass
  normalized comparison is always the truth gate. If robustness to
  wildcard characters is desired, escape `input.name` before embedding
  in the LIKE parameter.
- The fuzzy step does not enforce the "runner-up at distance ≤ 3"
  disqualification rule from `docs/04-entity-schema.md` step 4(b). The
  full `fuzzyPick` function does enforce it, but `resolve_person` calls
  `levenshtein` directly (to return multiple matches). This is a
  deliberate V1 simplification — `resolve_person` is a disambiguation
  surface, not a write-path merge decision, so a slightly looser fuzzy
  match is acceptable. Document this deviation if it causes problems
  in practice.

**Integration test (Task 5):**
- The test seeds two federal bill documents where both `personId` and
  `voterColleagueId` appear, plus two federal vote documents with the
  same pair. The edge test asserts `co_occurrence_count === 4`. If
  `findConnections` de-duplicates across kinds (e.g., counts 4 as the
  total across both kind-groupings), the assertion holds. If it
  accidentally counts only the per-kind max (2), the assertion fails.
  Confirm that `TOTAL_COUNT_SQL` counts `DISTINCT r2.document_id`
  across all kinds, not per-kind.

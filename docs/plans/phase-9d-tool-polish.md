# Phase 9d — Tool Polish (via_roles, had_role/had_jurisdiction, contributor_entity_id/side)

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.
> This is sub-phase 9d of the Phase 9 tool-surface completion
> (see `docs/plans/phase-9-overview.md`).

**Goal:** Land three small, independent parameter additions on
existing tools so heterogeneous civic-data queries stop requiring
client-side chaining:

1. **`via_roles[]`** on `entity_connections` edges — distinguish
   "sponsored" from "cosponsored" from "voted on" without dragging
   callers through `document_references` on their own.
2. **`had_role?` / `had_jurisdiction?`** on `search_entities` —
   filter cross-jurisdiction Person entities (D3b) by any historical
   role/jurisdiction in `metadata.roles[]`, not just the current
   primary `entities.jurisdiction`.
3. **`contributor_entity_id?` / `side?`** on `recent_contributions`
   — answer "what did donor X give to" without going through
   `entity_connections`. `candidate_or_committee` keeps its current
   recipient-side default for back-compat.

**Architecture:** Three independent param additions grouped into one
sub-phase because each on its own is too small to justify a phase.
Tasks are sequential (each ships its own commit with passing tests).
No new infrastructure, no D-item bumps required — these are
extensions within the R15 surface as already documented.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`,
`better-sqlite3`, `vitest` + `msw`.

---

## Scope impact

Docs updates (Task 4 bundles them):

- `docs/05-tool-surface.md`:
  - `entity_connections` — add `via_roles: string[]` to the edge
    shape next to `via_kinds`.
  - `search_entities` — add `had_role`, `had_jurisdiction` to the
    input list with a one-line cross-reference to D3b.
  - `recent_contributions` — add `contributor_entity_id`, `side`
    to the input list; document the back-compat default (when
    `candidate_or_committee` is set and `side` is omitted, `side`
    defaults to `"recipient"`).
- `CHANGELOG.md`: v0.4.0 entry already staged by 9a–9c. Append a
  "Phase 9d" bullet group under **Added** / **Changed**.
- No new R entries and no new D entries. Phase 9 overview reserves
  D12/D13 and R16/R17 for 9a/9b/9c. 9d's three additions are
  parameter-level refinements within the already-locked tool
  taxonomy and don't change any scope-level decision.

---

## File structure

```
src/
├── core/
│   └── connections.ts             # MODIFIED: + via_roles aggregation
└── mcp/
    ├── schemas.ts                 # MODIFIED: SearchEntitiesInput + had_role/had_jurisdiction;
    │                              #           RecentContributionsInput + contributor_entity_id/side
    └── tools/
        ├── entity_connections.ts  # MODIFIED: ConnectionEdge.via_roles in response
        ├── search_entities.ts     # MODIFIED: projectLocal filters roles[] from metadata
        └── recent_contributions.ts # MODIFIED: contributor resolution + side filter;
                                    #           threads contributor_name upstream
tests/
└── unit/mcp/tools/
    ├── entity_connections.test.ts  # MODIFIED: + via_roles cases
    ├── search_entities.test.ts     # MODIFIED: + had_role/had_jurisdiction cases
    └── recent_contributions.test.ts # MODIFIED: + contributor_entity_id/side cases
docs/
├── 05-tool-surface.md             # MODIFIED (Task 4)
└── plans/phase-9d-tool-polish.md  # this file

CHANGELOG.md                       # MODIFIED (Task 4)
```

---

## Task 1: `via_roles[]` on `entity_connections` edges

**Files:**
- Modify: `src/core/connections.ts`
- Modify: `src/mcp/tools/entity_connections.ts`
- Modify: `tests/unit/mcp/tools/entity_connections.test.ts`

The handler already reads `document_references` rows via
`EDGE_KIND_SQL` — roles live on those same rows as a sibling column
to `d.kind`. Surfacing `via_roles` is a SQL column addition plus
one extra `Set<string>` alongside the existing per-pair `Set<string>`
for kinds.

### Step 1: Failing test — via_roles distinguishes sponsor vs cosponsor

Append to `tests/unit/mcp/tools/entity_connections.test.ts`. Read
the file first to find the existing fixture-setup helper (a helper
that inserts two Person entities plus a bill with sponsorship
references is almost certainly already there; reuse it by pattern).

- [ ] Write the failing test:

```ts
describe("handleEntityConnections via_roles", () => {
  it("distinguishes sponsor vs cosponsor on separate bills between the same two people", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/ec-via-roles-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    const seedPerson = (id: string, name: string, ext: Record<string, string>): void => {
      db.prepare(
        `INSERT INTO entities
         (id, kind, name, name_normalized, jurisdiction, external_ids, aliases, metadata, first_seen_at, last_seen_at)
         VALUES (?, 'person', ?, ?, 'us-federal', ?, '[]', '{}', ?, ?)`,
      ).run(id, name, name.toLowerCase(), JSON.stringify(ext), now, now);
    };
    const seedBill = (id: string): void => {
      db.prepare(
        `INSERT INTO documents
         (id, source_name, source_id, kind, jurisdiction, title, summary,
          occurred_at, fetched_at, source_url, raw)
         VALUES (?, 'congress', ?, 'bill', 'us-federal', ?, NULL, ?, ?, ?, '{}')`,
      ).run(id, id, `Bill ${id}`, now, now, `https://example.test/${id}`);
    };
    const seedRef = (docId: string, entityId: string, role: string): void => {
      db.prepare(
        `INSERT INTO document_references (document_id, entity_id, role)
         VALUES (?, ?, ?)`,
      ).run(docId, entityId, role);
    };

    seedPerson("person-A", "Alice A", { bioguide: "A000001" });
    seedPerson("person-B", "Bob B", { bioguide: "B000001" });

    // Bill 1: A sponsors, B cosponsors.
    seedBill("bill-1");
    seedRef("bill-1", "person-A", "sponsor");
    seedRef("bill-1", "person-B", "cosponsor");

    // Bill 2: A cosponsors, B sponsors.
    seedBill("bill-2");
    seedRef("bill-2", "person-A", "cosponsor");
    seedRef("bill-2", "person-B", "sponsor");

    // No external-ID short-circuit — person-A already has bioguide.
    // Stub adapters to no-op so the handler doesn't try to hit the
    // network. (Use same pattern as existing tests in this file.)
    vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });

    const result = await handleEntityConnections(db, {
      id: "person-A",
      depth: 1,
      min_co_occurrences: 1,
    });

    const edgeToB = result.edges.find((e) => e.to === "person-B");
    expect(edgeToB).toBeDefined();
    expect(edgeToB!.via_kinds).toEqual(["bill"]);
    expect(new Set(edgeToB!.via_roles)).toEqual(new Set(["sponsor", "cosponsor"]));
  });

  it("exposes voter role on vote documents", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/ec-via-roles-vote-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities (id, kind, name, name_normalized, jurisdiction,
         external_ids, aliases, metadata, first_seen_at, last_seen_at)
       VALUES ('person-X', 'person', 'X', 'x', 'us-federal',
         '{"bioguide":"X000001"}', '[]', '{}', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO entities (id, kind, name, name_normalized, jurisdiction,
         external_ids, aliases, metadata, first_seen_at, last_seen_at)
       VALUES ('person-Y', 'person', 'Y', 'y', 'us-federal',
         '{"bioguide":"Y000001"}', '[]', '{}', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO documents (id, source_name, source_id, kind, jurisdiction,
         title, summary, occurred_at, fetched_at, source_url, raw)
       VALUES ('vote-1', 'congress', 'v1', 'vote', 'us-federal',
         'Vote 1', NULL, ?, ?, 'https://example.test/v1', '{}')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO document_references (document_id, entity_id, role)
       VALUES ('vote-1', 'person-X', 'voter'), ('vote-1', 'person-Y', 'voter')`,
    ).run();

    vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });
    vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills")
      .mockResolvedValue({ documentsUpserted: 0 });

    const result = await handleEntityConnections(db, {
      id: "person-X",
      depth: 1,
      min_co_occurrences: 1,
    });

    const edge = result.edges.find((e) => e.to === "person-Y");
    expect(edge).toBeDefined();
    expect(edge!.via_roles).toEqual(["voter"]);
  });
});
```

Run: `pnpm test tests/unit/mcp/tools/entity_connections.test.ts -t "via_roles"`

Expected: FAIL — `via_roles` doesn't exist on the edge object.

### Step 2: Add via_roles to findConnections

- [ ] Modify `src/core/connections.ts`:

Add role to `RawEdge`:

```ts
export interface RawEdge {
  from_id: string;
  to_id: string;
  via_kinds: string[];
  via_roles: string[];
  co_occurrence_count: number;
  sample_document_ids: string[];
}
```

Extend the kind-grouping SQL to also return `r2.role` (the second
side's role is what the edge is semantically "via" — the role of the
neighbor on the shared document):

```ts
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
```

Add `via_role` to `KindRow`:

```ts
interface KindRow {
  from_id: string;
  to_id: string;
  via_kind: string;
  via_role: string;
  co_count: number;
}
```

In `expandOne`, extend the per-pair aggregation to keep both sets:

```ts
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
```

And in the edge-push block:

```ts
edges.push({
  from_id: pair.from_id,
  to_id: pair.to_id,
  via_kinds: Array.from(pair.kinds),
  via_roles: Array.from(pair.roles),
  co_occurrence_count: totalCount,
  sample_document_ids: sampleRows.map((r) => r.id),
});
```

### Step 3: Thread via_roles through the handler

- [ ] Modify `src/mcp/tools/entity_connections.ts`:

Add `via_roles: string[]` to `ConnectionEdge`:

```ts
interface ConnectionEdge {
  from: string;
  to: string;
  via_kinds: string[];
  via_roles: string[];
  co_occurrence_count: number;
  sample_documents: DocumentMatch[];
}
```

In the edge-projection map (around line 302):

```ts
const edges: ConnectionEdge[] = rawEdges.map((e) => ({
  from: e.from_id,
  to: e.to_id,
  via_kinds: e.via_kinds,
  via_roles: e.via_roles,
  co_occurrence_count: e.co_occurrence_count,
  sample_documents: e.sample_document_ids.map(toDocMatch).filter((d): d is DocumentMatch => d !== null),
}));
```

### Step 4: Tests green

Run: `pnpm test tests/unit/mcp/tools/entity_connections.test.ts`

Expected: all existing tests still pass; the two new `via_roles`
cases pass.

Run: `pnpm test -t "connections"` (broad match across unit and
integration; should be fully green).

### Step 5: Commit

```bash
git add src/core/connections.ts src/mcp/tools/entity_connections.ts tests/unit/mcp/tools/entity_connections.test.ts
git commit -m "$(cat <<'EOF'
feat(entity_connections): add via_roles[] to edge output

Surfaces the neighbor's document-reference role alongside via_kinds
so callers can distinguish sponsored / cosponsored / voted /
contributor edges without dragging document_references client-side.
The role aggregation reuses the existing document_references JOIN
by adding r2.role to the per-pair GROUP BY.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `had_role?` / `had_jurisdiction?` on `search_entities`

**Files:**
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/tools/search_entities.ts`
- Modify: `tests/unit/mcp/tools/search_entities.test.ts`

Person entities store history in `metadata.roles[]` per D3b. The
roles JSON shape is:

```ts
{ jurisdiction: string; role: string; from?: string | null; to?: string | null }[]
```

(See `src/core/entities.ts` `RoleEntry` for the exact shape.)

SQLite's `json_each` can walk that array inside a WHERE clause. Both
filters AND together: a single `roles[]` entry must match all
provided `had_*` criteria simultaneously (a Texas state_legislator
entry satisfies `had_role=state_legislator,had_jurisdiction=us-tx`;
a Texas state_legislator plus a federal senator role on the same
person does NOT satisfy `had_role=senator,had_jurisdiction=us-tx`).

### Step 1: Failing tests

- [ ] Write the failing tests first.

Append to `tests/unit/mcp/tools/search_entities.test.ts`:

```ts
describe("handleSearchEntities had_role / had_jurisdiction", () => {
  it("had_role matches a historical role even when current jurisdiction is different", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/se-had-role-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities
       (id, kind, name, name_normalized, jurisdiction, external_ids, aliases, metadata, first_seen_at, last_seen_at)
       VALUES ('p1', 'person', 'Jane Doe', 'jane doe', 'us-federal',
         '{"bioguide":"D000001"}', '[]', ?, ?, ?)`,
    ).run(
      JSON.stringify({
        roles: [
          { jurisdiction: "us-tx", role: "state_legislator" },
          { jurisdiction: "us-federal", role: "senator" },
        ],
      }),
      now,
      now,
    );

    const result = await handleSearchEntities(db, {
      q: "jane",
      had_role: "state_legislator",
    });

    expect(result.results.map((r) => r.id)).toContain("p1");
  });

  it("had_jurisdiction matches a historical jurisdiction", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/se-had-juris-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities
       (id, kind, name, name_normalized, jurisdiction, external_ids, aliases, metadata, first_seen_at, last_seen_at)
       VALUES ('p1', 'person', 'Jane Doe', 'jane doe', 'us-federal',
         '{"bioguide":"D000001"}', '[]', ?, ?, ?)`,
    ).run(
      JSON.stringify({
        roles: [
          { jurisdiction: "us-tx", role: "state_legislator" },
          { jurisdiction: "us-federal", role: "senator" },
        ],
      }),
      now,
      now,
    );

    const result = await handleSearchEntities(db, {
      q: "jane",
      had_jurisdiction: "us-tx",
    });

    expect(result.results.map((r) => r.id)).toContain("p1");
  });

  it("had_role + had_jurisdiction require the SAME role entry to match both", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/se-had-and-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities
       (id, kind, name, name_normalized, jurisdiction, external_ids, aliases, metadata, first_seen_at, last_seen_at)
       VALUES ('p1', 'person', 'Jane Doe', 'jane doe', 'us-federal',
         '{"bioguide":"D000001"}', '[]', ?, ?, ?)`,
    ).run(
      JSON.stringify({
        roles: [
          { jurisdiction: "us-tx", role: "state_legislator" },
          { jurisdiction: "us-federal", role: "senator" },
        ],
      }),
      now,
      now,
    );

    // senator role is federal, not TX — no matching entry; must not match.
    const noMatch = await handleSearchEntities(db, {
      q: "jane",
      had_role: "senator",
      had_jurisdiction: "us-tx",
    });
    expect(noMatch.results.map((r) => r.id)).not.toContain("p1");

    // state_legislator + us-tx appear on the same entry; must match.
    const match = await handleSearchEntities(db, {
      q: "jane",
      had_role: "state_legislator",
      had_jurisdiction: "us-tx",
    });
    expect(match.results.map((r) => r.id)).toContain("p1");
  });

  it("had_role drops entities whose metadata has no roles[]", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/se-had-none-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities
       (id, kind, name, name_normalized, jurisdiction, external_ids, aliases, metadata, first_seen_at, last_seen_at)
       VALUES ('p2', 'person', 'Jim Smith', 'jim smith', 'us-federal',
         '{}', '[]', '{}', ?, ?)`,
    ).run(now, now);

    const result = await handleSearchEntities(db, {
      q: "jim",
      had_role: "senator",
    });
    expect(result.results.map((r) => r.id)).not.toContain("p2");
  });
});
```

Run: `pnpm test tests/unit/mcp/tools/search_entities.test.ts -t "had_role"`

Expected: FAIL — schema rejects the extra inputs.

### Step 2: Schema update

- [ ] Modify `src/mcp/schemas.ts`:

```ts
export const SearchEntitiesInput = z.object({
  q: z.string().min(1),
  kind: z.enum(["person", "organization", "committee", "pac", "agency"]).optional(),
  jurisdiction: z.string().optional(),
  had_role: z.string().optional(),
  had_jurisdiction: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type SearchEntitiesInput = z.infer<typeof SearchEntitiesInput>;
```

### Step 3: Handler — filter via json_each

- [ ] Modify `src/mcp/tools/search_entities.ts` in `projectLocal`:

The existing WHERE clause is built from `clauses[]`. Add a correlated
`EXISTS (SELECT 1 FROM json_each(e.metadata, '$.roles') ...)` when
either filter is set. `json_each` returns one row per array element
with the element in `value` (a JSON string); `json_extract` pulls
fields out.

Insert after the existing `jurisdiction` clause block:

```ts
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
```

Make sure the inserted params go in BEFORE the `params.push(input.limit)`
that currently lives just below the jurisdiction clause — the SQL
statement's `?` placeholders must line up. Read the surrounding
block carefully; the existing code pushes `input.limit` as the final
param, and the new placeholders belong in the WHERE clause so they
precede the `LIMIT ?`.

**Edge-case note:** `json_each` raises on non-array targets. Entities
with `metadata = '{}'` (no `roles` key) make `json_each(e.metadata, '$.roles')`
a no-op that returns zero rows rather than erroring — verified against
better-sqlite3's JSON1 build. The EXISTS clause is therefore
correctly false for those rows, which the fourth test above locks in.

### Step 4: Tests green

Run: `pnpm test tests/unit/mcp/tools/search_entities.test.ts`

Expected: all existing tests pass; four new `had_role` / `had_jurisdiction`
cases pass.

Run: `pnpm test -t "search_entities"`

### Step 5: Commit

```bash
git add src/mcp/schemas.ts src/mcp/tools/search_entities.ts tests/unit/mcp/tools/search_entities.test.ts
git commit -m "$(cat <<'EOF'
feat(search_entities): had_role / had_jurisdiction filters

Adds optional had_role and had_jurisdiction inputs that filter Person
entities by any entry in metadata.roles[]. Under D3b (cross-jurisdiction
Person model) the current entities.jurisdiction column only reflects
the primary role, so callers asking "anyone who was ever a state
legislator in Texas" couldn't express that via the existing
jurisdiction filter.

Filters AND against a single roles[] entry via a correlated EXISTS
over json_each — a role/jurisdiction match must come from the same
array element.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `contributor_entity_id?` / `side?` on `recent_contributions`

**Files:**
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/tools/recent_contributions.ts`
- Modify: `tests/unit/mcp/tools/recent_contributions.test.ts`

OpenFEC's `/schedules/schedule_a` has a `contributor_name` query
parameter (fuzzy string match against individual contributor names).
It does **not** have a first-class per-individual `contributor_id`
— OpenFEC only tracks committee IDs on the filer side, not
individual contributors. The approach:

- `contributor_entity_id` is a local entity UUID. We look up that
  entity's `name` in `entities` and pass it as the upstream
  `contributor_name` query param. Locally we filter `document_references`
  on the contributor side by matching the entity_id exactly.
- `side: "contributor" | "recipient" | "either"` controls how
  `candidate_or_committee` matches. Back-compat: when
  `candidate_or_committee` is set and `side` is omitted, default
  resolves to `"recipient"`. When `side` is explicit, it wins.
  `"either"` matches contributor OR recipient.
- `contributor_entity_id` is independent of `side` and always
  filters the contributor side (local) plus seeds the upstream
  `contributor_name` query param.
- Both filters combine as AND — a row must pass contributor-side
  AND recipient-side gates when both sets are provided.

### Step 1: Failing tests

- [ ] Write the failing tests.

Append to `tests/unit/mcp/tools/recent_contributions.test.ts`.
(Read the existing file first for its mock/setup patterns — the
handler uses `OpenFecAdapter.prototype.fetchRecentContributions`
and the existing tests almost certainly spy on that.)

```ts
describe("handleRecentContributions contributor-side filters", () => {
  it("threads contributor_entity_id through to the adapter as contributor_name", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/rc-cid-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities
       (id, kind, name, name_normalized, jurisdiction, external_ids, aliases, metadata, first_seen_at, last_seen_at)
       VALUES ('donor-1', 'person', 'JANE SMITH', 'jane smith', NULL,
         '{}', '[]', '{}', ?, ?)`,
    ).run(now, now);

    const spy = vi.spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockResolvedValue({ documentsUpserted: 0 });

    await handleRecentContributions(db, {
      window: { from: "2026-04-01T00:00:00Z", to: "2026-04-30T00:00:00Z" },
      contributor_entity_id: "donor-1",
    });

    expect(spy).toHaveBeenCalledOnce();
    const callOpts = spy.mock.calls[0][1] as { contributor_name?: string };
    expect(callOpts.contributor_name).toBe("JANE SMITH");
    spy.mockRestore();
  });

  it("side='contributor' filters candidate_or_committee against the contributor side", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/rc-side-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    // Two entities: one as contributor, one as recipient committee.
    db.prepare(
      `INSERT INTO entities VALUES
       ('donor', 'person', 'Acme Donor', 'acme donor', NULL, '{}', '[]', '{}', ?, ?),
       ('cmte', 'pac', 'Target PAC', 'target pac', 'us-federal', '{"fec_committee":"C1"}', '[]', '{}', ?, ?)`,
    ).run(now, now, now, now);
    db.prepare(
      `INSERT INTO documents
       (id, source_name, source_id, kind, jurisdiction, title, summary,
        occurred_at, fetched_at, source_url, raw)
       VALUES ('c1', 'openfec', 'T1', 'contribution', 'us-federal',
         'Contribution', NULL, '2026-04-10T00:00:00Z', ?, 'https://fec/T1', ?)`,
    ).run(
      now,
      JSON.stringify({
        amount: 2500,
        date: "2026-04-10",
        contributor_name: "ACME DONOR",
      }),
    );
    db.prepare(
      `INSERT INTO document_references (document_id, entity_id, role)
       VALUES ('c1', 'donor', 'contributor'), ('c1', 'cmte', 'recipient')`,
    ).run();

    vi.spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockResolvedValue({ documentsUpserted: 0 });

    const result = await handleRecentContributions(db, {
      window: { from: "2026-04-01T00:00:00Z", to: "2026-04-30T00:00:00Z" },
      candidate_or_committee: "acme",
      side: "contributor",
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].contributor.entity_id).toBe("donor");
  });

  it("candidate_or_committee without side defaults to recipient (back-compat)", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/rc-compat-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities VALUES
       ('donor', 'person', 'Target Donor', 'target donor', NULL, '{}', '[]', '{}', ?, ?),
       ('cmte', 'pac', 'Acme PAC', 'acme pac', 'us-federal', '{"fec_committee":"C1"}', '[]', '{}', ?, ?)`,
    ).run(now, now, now, now);
    db.prepare(
      `INSERT INTO documents
       (id, source_name, source_id, kind, jurisdiction, title, summary,
        occurred_at, fetched_at, source_url, raw)
       VALUES ('c1', 'openfec', 'T1', 'contribution', 'us-federal',
         'Contribution', NULL, '2026-04-10T00:00:00Z', ?, 'https://fec/T1', ?)`,
    ).run(
      now,
      JSON.stringify({ amount: 100, date: "2026-04-10", contributor_name: "TARGET DONOR" }),
    );
    db.prepare(
      `INSERT INTO document_references (document_id, entity_id, role)
       VALUES ('c1', 'donor', 'contributor'), ('c1', 'cmte', 'recipient')`,
    ).run();

    vi.spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockResolvedValue({ documentsUpserted: 0 });

    // "acme" matches recipient "Acme PAC" but not contributor "Target Donor".
    // Under back-compat default (side=recipient), must match.
    const result = await handleRecentContributions(db, {
      window: { from: "2026-04-01T00:00:00Z", to: "2026-04-30T00:00:00Z" },
      candidate_or_committee: "acme",
    });
    expect(result.results).toHaveLength(1);
  });

  it("contributor_entity_id + candidate_or_committee + side=recipient AND-combines", async () => {
    _resetToolCacheForTesting();
    const dbPath = `/tmp/rc-and-${Date.now()}-${Math.random()}.db`;
    await bootstrap({ dbPath });
    const db = openStore(dbPath).db;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities VALUES
       ('donor', 'person', 'DONOR', 'donor', NULL, '{}', '[]', '{}', ?, ?),
       ('match', 'pac', 'MATCH PAC', 'match pac', 'us-federal', '{}', '[]', '{}', ?, ?),
       ('other', 'pac', 'OTHER PAC', 'other pac', 'us-federal', '{}', '[]', '{}', ?, ?)`,
    ).run(now, now, now, now, now, now);

    const seedDoc = (id: string, recipientId: string): void => {
      db.prepare(
        `INSERT INTO documents
         (id, source_name, source_id, kind, jurisdiction, title, summary,
          occurred_at, fetched_at, source_url, raw)
         VALUES (?, 'openfec', ?, 'contribution', 'us-federal',
           'Contribution', NULL, '2026-04-10T00:00:00Z', ?, ?, ?)`,
      ).run(
        id,
        id,
        now,
        `https://fec/${id}`,
        JSON.stringify({ amount: 100, date: "2026-04-10", contributor_name: "DONOR" }),
      );
      db.prepare(
        `INSERT INTO document_references (document_id, entity_id, role)
         VALUES (?, 'donor', 'contributor'), (?, ?, 'recipient')`,
      ).run(id, id, recipientId);
    };
    seedDoc("c-match", "match");
    seedDoc("c-other", "other");

    vi.spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockResolvedValue({ documentsUpserted: 0 });

    const result = await handleRecentContributions(db, {
      window: { from: "2026-04-01T00:00:00Z", to: "2026-04-30T00:00:00Z" },
      contributor_entity_id: "donor",
      candidate_or_committee: "match",
      side: "recipient",
    });

    expect(result.results.map((r) => r.id)).toEqual(["c-match"]);
  });
});
```

Run: `pnpm test tests/unit/mcp/tools/recent_contributions.test.ts -t "contributor-side"`

Expected: FAIL — schema rejects new inputs.

### Step 2: Schema update

- [ ] Modify `src/mcp/schemas.ts`:

```ts
export const RecentContributionsInput = z.object({
  window: z.object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),
  candidate_or_committee: z.string().optional(),
  min_amount: z.number().min(0).optional(),
  contributor_entity_id: z.string().optional(),
  side: z.enum(["contributor", "recipient", "either"]).optional(),
});
export type RecentContributionsInput = z.infer<typeof RecentContributionsInput>;
```

### Step 3: Adapter — accept contributor_name

- [ ] Modify `src/adapters/openfec.ts` `fetchRecentContributions`:

Extend the opts type and query-param wiring:

```ts
async fetchRecentContributions(
  db: Database.Database,
  opts: {
    min_date: string;
    max_date?: string;
    committee_ids?: string[];
    contributor_name?: string;
    limit?: number;
  },
): Promise<{ documentsUpserted: number }> {
  const url = new URL(`${BASE_URL}/schedules/schedule_a/`);
  url.searchParams.set("min_date", opts.min_date);
  if (opts.max_date) url.searchParams.set("max_date", opts.max_date);
  for (const id of opts.committee_ids ?? []) {
    url.searchParams.append("committee_id", id);
  }
  if (opts.contributor_name) {
    url.searchParams.set("contributor_name", opts.contributor_name);
  }
  url.searchParams.set("per_page", String(opts.limit ?? 100));
  url.searchParams.set("sort", "-contribution_receipt_date");
  url.searchParams.set("api_key", this.opts.apiKey);

  // ... rest unchanged
}
```

(If `tests/unit/adapters/openfec.test.ts` already covers
`fetchRecentContributions` with tight URL assertions, add one new
case that asserts `contributor_name=...` is threaded. Don't break
existing cases — they don't set `contributor_name` so they should
still pass unchanged.)

### Step 4: Handler — contributor resolution + side filter

- [ ] Modify `src/mcp/tools/recent_contributions.ts`:

Resolve `contributor_entity_id` to a name up front; compute the
effective `side` value; rework `projectLocal` to consider both
contributor and recipient sides.

Replace the relevant block in `handleRecentContributions`:

```ts
const input = RecentContributionsInput.parse(rawInput);

// Default side semantics: when candidate_or_committee is set and
// side is omitted, default to "recipient" for back-compat. When side
// is set, it wins. contributor_entity_id is independent of `side`
// and always filters the contributor side locally.
const effectiveSide: "contributor" | "recipient" | "either" =
  input.side ?? (input.candidate_or_committee ? "recipient" : "either");

// Resolve contributor entity once (used by both projectLocal and
// fetchAndWrite).
let contributorEntity: { id: string; name: string } | undefined;
if (input.contributor_entity_id) {
  const row = db
    .prepare("SELECT id, name FROM entities WHERE id = ?")
    .get(input.contributor_entity_id) as { id: string; name: string } | undefined;
  if (!row) {
    throw new Error(`Entity not found: ${input.contributor_entity_id}`);
  }
  contributorEntity = row;
}

const toMMDDYYYY = (iso: string): string => { /* unchanged */ };
```

Rework `projectLocal`'s `candidate_or_committee` resolution to a
side-aware helper:

```ts
const projectLocal = (): RecentContributionsResponse => {
  // candidate_or_committee resolves to a single best-match entity id.
  // Under `side`, that match is applied to the contributor side,
  // recipient side, or either.
  let candOrCmteEntityId: string | undefined;
  if (input.candidate_or_committee) {
    const q = input.candidate_or_committee
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const match = db
      .prepare(
        `SELECT id FROM entities
         WHERE kind IN ('pac', 'organization', 'committee', 'person')
           AND name_normalized LIKE ? ESCAPE '\\'
         LIMIT 1`,
      )
      .get(`%${escapeLike(q)}%`) as { id: string } | undefined;
    candOrCmteEntityId = match?.id;
  }

  const docs = queryDocuments(db, {
    kind: "contribution",
    jurisdiction: "us-federal",
    from: input.window.from,
    to: input.window.to,
    limit: 200,
  });

  const results: ContributionSummary[] = [];

  for (const doc of docs) {
    const raw = doc.raw as {
      amount?: number;
      date?: string;
      contributor_name?: string;
    };
    const amount = raw.amount ?? 0;
    if (input.min_amount !== undefined && amount < input.min_amount) continue;

    const contribRef = doc.references.find((r) => r.role === "contributor");
    const recipientRef = doc.references.find((r) => r.role === "recipient");
    if (!recipientRef) continue;

    // contributor_entity_id filter — always contributor side.
    if (contributorEntity && contribRef?.entity_id !== contributorEntity.id) {
      continue;
    }

    // candidate_or_committee + side filter.
    if (candOrCmteEntityId) {
      const matchesContributor = contribRef?.entity_id === candOrCmteEntityId;
      const matchesRecipient = recipientRef.entity_id === candOrCmteEntityId;
      const ok =
        effectiveSide === "contributor" ? matchesContributor :
        effectiveSide === "recipient" ? matchesRecipient :
        matchesContributor || matchesRecipient;
      if (!ok) continue;
    }

    // ... rest of the row build (recipient/contributor row lookups,
    //     summary push) is unchanged from the existing handler.
  }

  // ... unchanged empty-diagnostic tail.
};
```

Update `fetchAndWrite` to forward `contributor_name` and include the
new args in the shaped-fetch cache key:

```ts
const fetchAndWrite = async (): Promise<{ primary_rows_written: number }> => {
  const adapter = new OpenFecAdapter({
    apiKey: requireEnv("API_DATA_GOV_KEY"),
    rateLimiter: getLimiter("openfec"),
  });
  const result = await adapter.fetchRecentContributions(db, {
    min_date: toMMDDYYYY(input.window.from),
    max_date: toMMDDYYYY(input.window.to),
    contributor_name: contributorEntity?.name,
  });
  return { primary_rows_written: result.documentsUpserted };
};

const result = await withShapedFetch(
  db,
  {
    source: "openfec",
    endpoint_path: "/schedules/schedule_a",
    args: {
      window: input.window,
      candidate_or_committee: input.candidate_or_committee,
      min_amount: input.min_amount,
      contributor_entity_id: input.contributor_entity_id,
      side: effectiveSide,
    },
    tool: "recent_contributions",
  },
  { scope: "recent", ms: 60 * 60 * 1000 },
  fetchAndWrite,
  projectLocal,
  () => getLimiter("openfec").peekWaitMs(),
);
```

(The `args` change means callers who mix `contributor_entity_id` or
`side` get a distinct cache row from the unfiltered
`recent_contributions` call. Same TTL.)

### Step 5: Tests green

Run: `pnpm test tests/unit/mcp/tools/recent_contributions.test.ts`

Expected: all existing tests pass (back-compat default case) plus
four new contributor-side cases.

Run: `pnpm test tests/unit/adapters/openfec.test.ts`

Expected: all green (the adapter added a pass-through param only;
existing tests continue to work).

### Step 6: Commit

```bash
git add src/mcp/schemas.ts src/mcp/tools/recent_contributions.ts src/adapters/openfec.ts tests/unit/mcp/tools/recent_contributions.test.ts tests/unit/adapters/openfec.test.ts
git commit -m "$(cat <<'EOF'
feat(recent_contributions): contributor_entity_id + side filters

Adds optional contributor_entity_id (entity-resolved donor) and side
("contributor" | "recipient" | "either") inputs so "what did donor X
give to" becomes answerable without entity_connections. The
contributor entity's name is threaded upstream as OpenFEC's
contributor_name query param.

Back-compat: when candidate_or_committee is set and side is omitted,
side defaults to "recipient" — the existing behavior. Cache key now
includes contributor_entity_id + side so donor-side queries don't
collide with recipient-side queries.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Docs + CHANGELOG + acceptance

**Files:**
- Modify: `docs/05-tool-surface.md`
- Modify: `CHANGELOG.md`

### Step 1: Update `docs/05-tool-surface.md`

- [ ] In the `recent_contributions` section (~line 61), update the
  input block to:

```
input:
  window: { from: string; to: string }        // ISO dates; required
  candidate_or_committee: string | undefined  // free-text, entity-resolved
  side: "contributor" | "recipient" | "either" | undefined
                                              // controls which side candidate_or_committee matches on;
                                              // defaults to "recipient" when candidate_or_committee
                                              // is set, "either" otherwise
  contributor_entity_id: string | undefined   // entity-resolved donor;
                                              // filters contributor side and threads to OpenFEC
                                              // as contributor_name
  min_amount: number | undefined
```

- [ ] In the `search_entities` section, extend the input block:

```
input:
  q: string
  kind: EntityKind | undefined
  jurisdiction: string | undefined  // filters on Organization.jurisdiction
                                    // and on Person roles[].jurisdiction (current)
  had_role: string | undefined      // matches any entry in metadata.roles[].role
  had_jurisdiction: string | undefined
                                    // matches any entry in metadata.roles[].jurisdiction
                                    // had_role + had_jurisdiction AND against the SAME entry
  limit: number (default 20, max 50)
```

- [ ] In the `entity_connections` edge shape (~line 188), change
  to include `via_roles`:

```
  edges: Array<{
    from: string; to: string;
    via_kinds: DocumentKind[];
    via_roles: string[];              // neighbor's roles on shared documents
                                      // (e.g. ["sponsor","cosponsor","voter"])
    co_occurrence_count: number;
    sample_documents: DocumentMatch[];
  }>,
```

### Step 2: Update `CHANGELOG.md`

- [ ] Append to the in-progress v0.4.0 section (created by 9a–9c):

```
### Added (Phase 9d)
- `entity_connections`: edges now include `via_roles[]` alongside
  `via_kinds[]`, distinguishing sponsored / cosponsored / voted /
  contributor edges.
- `search_entities`: optional `had_role` and `had_jurisdiction`
  filters over `metadata.roles[]`. Both AND against a single roles
  entry so a federal senator's state-legislator history in Texas
  matches `(had_role=state_legislator, had_jurisdiction=us-tx)` but
  the senator role alone does not.
- `recent_contributions`: optional `contributor_entity_id` and
  `side` inputs. Donor-side queries ("what did X give to") no
  longer require `entity_connections` chaining.

### Changed (Phase 9d)
- `recent_contributions` cache key expanded to include
  `contributor_entity_id` and `side`. Existing calls without the new
  inputs still hit the same cache row as before.
```

### Step 3: Acceptance

- [ ] `pnpm test` — all green.
- [ ] `pnpm build` — TypeScript clean.
- [ ] `docs/05-tool-surface.md` mentions `via_roles`, `had_role`,
      `had_jurisdiction`, `contributor_entity_id`, and `side` in
      the respective tool sections.
- [ ] `CHANGELOG.md` has a Phase 9d entry group under the v0.4.0
      section.
- [ ] Grep `via_roles` in `src/core/connections.ts` and
      `src/mcp/tools/entity_connections.ts` — at least one match
      each.
- [ ] Grep `had_role` in `src/mcp/schemas.ts` and
      `src/mcp/tools/search_entities.ts` — at least one match each.
- [ ] Grep `contributor_entity_id` in `src/mcp/schemas.ts` and
      `src/mcp/tools/recent_contributions.ts` — at least one match
      each.

### Step 4: Commit

```bash
git add docs/05-tool-surface.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: phase-9d tool-polish additions

- 05-tool-surface.md: document via_roles on entity_connections
  edges; had_role/had_jurisdiction on search_entities;
  contributor_entity_id/side on recent_contributions (with the
  recipient default for candidate_or_committee back-compat).
- CHANGELOG.md: append Phase 9d entries under v0.4.0.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Acceptance for Phase 9d as a whole

- [ ] 4 commits (Tasks 1–4).
- [ ] `pnpm test` all green.
- [ ] `pnpm build` clean.
- [ ] Tool count unchanged at 11 (9d adds params only, not tools).
- [ ] `docs/05-tool-surface.md` reflects the three polish additions.
- [ ] `CHANGELOG.md` v0.4.0 section has a Phase 9d group.

Phase 9d complete when all hold. With 9a–9d merged, Phase 9 is
complete and the v0.4.0 release train is ready for the separate
post-phase release decision (see phase-9-overview.md).

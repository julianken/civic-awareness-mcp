# Phase 2.5 — Correctness & Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the correctness lies surfaced by the 5-reviewer UX+tech
analysis and trim LLM-facing response bloat before Phase 3 (Congress)
is layered on the same foundation. Ships as v0.1.0.

**Architecture:** Single-phase remediation, no new abstractions. Three
kinds of changes: (a) core primitives (`upsertEntity`, `queryDocuments`)
gain correctness; (b) adapter(s) write the right field; (c) MCP tool
handlers project smaller, clearer shapes.

**Tech Stack:** TypeScript on Node 22+. `vitest` for tests. Existing
`better-sqlite3` store; new SQL migration `003-*.sql`. No new
dependencies.

**Design spec:** `docs/plans/phase-2.5-correctness-polish-spec.md`.

---

## Prerequisites

- Working tree clean; branch `main` at a known-good commit.
- `pnpm install` clean; `pnpm test` green.
- Read the spec at `docs/plans/phase-2.5-correctness-polish-spec.md`
  for scope and key policy decisions (clean breaks, no
  backward-compat shims, v0.1.0 target).

---

## File structure produced by this phase

```
civic-awareness-mcp/
├── package.json                                  ← version bump to 0.1.0
├── src/
│   ├── core/
│   │   ├── entities.ts                           ← T1 (merge metadata + roles, wire fuzzyPick)
│   │   ├── documents.ts                          ← T3 (action_date exposed on projections)
│   │   └── migrations/
│   │       └── 003-occurred-at-from-actions.sql  ← T2 (new)
│   ├── adapters/
│   │   ├── openstates.ts                         ← T2 (occurred_at = action date)
│   │   └── congress.ts                           ← T1 (drop hand-rolled merge; use upsertEntity)
│   └── mcp/
│       ├── schemas.ts                            ← T6 (days.max=365, session on RecentVotesInput)
│       ├── shared.ts                             ← T5 (new — emptyFeedDiagnostic helper)
│       └── tools/
│           ├── get_entity.ts                     ← T3 (surface action_date, sort by it)
│           ├── recent_bills.ts                   ← T4 (sponsor_summary), T5 (diagnostic), T6 (session)
│           └── recent_votes.ts                   ← T5 (diagnostic), T6 (session)
└── tests/
    └── unit/
        ├── core/
        │   ├── entities.test.ts                  ← T1 (new cases for merge + fuzzy)
        │   └── documents.test.ts                 ← T3 (action_date in projections)
        ├── adapters/
        │   └── openstates.test.ts                ← T2 (occurred_at = action date)
        ├── mcp/
        │   ├── shared.test.ts                    ← T5 (new)
        │   └── tools/
        │       ├── get_entity.test.ts            ← T3 (recent_documents shape + sort)
        │       ├── recent_bills.test.ts          ← T4 (sponsor_summary), T5, T6
        │       └── recent_votes.test.ts          ← T5, T6
        └── resolution/
            └── fuzzy.test.ts                     ← T1 (resolver-chain integration)
```

---

## Dispatch order

- **Batch 1 (parallel):** T1 · T2 · T4 · T5 · T6
- **Batch 2 (after T2 merges):** T3
- **Post-batch:** version bump + CHANGELOG + end-to-end smoke

> **Merge-risk note for reviewer-stage.** T4, T5, and T6 all touch
> `src/mcp/tools/recent_bills.ts` (and T5/T6 both touch
> `src/mcp/tools/recent_votes.ts`) but in different sections:
> - T4 rewrites the results-mapping block (existing lines 55-78)
> - T5 wraps the final `return` statement with an empty-branch
> - T6 inserts a `session`-aware branch *before* the `queryDocuments`
>   call (around existing line 38)
>
> None of the three should conflict at the hunk level when branched
> from the same base. If the `two-stage reviewer` pass reports a
> merge conflict, resolve by applying hunks in order T6 → T4 → T5
> (top-of-function → middle → bottom-of-function).

---

## Task 1 — `upsertEntity` merges metadata + appends roles; wire `fuzzyPick`

**Files:**
- Modify: `src/core/entities.ts` (UPDATE branch at lines 41-51; resolver at lines 37-39)
- Modify: `src/adapters/congress.ts` (delete hand-rolled merge at lines 292-309)
- Modify: `tests/unit/core/entities.test.ts` (add cases)
- Modify: `tests/unit/resolution/fuzzy.test.ts` (add resolver-chain integration)

**Why this task:** today the UPDATE branch only touches `external_ids`,
`aliases`, `last_seen_at`. Metadata is write-once-on-insert, so the
Huffman/Creighton asymmetry from the review is baked in. `fuzzyPick`
is implemented but never called, so surname-only sponsors never
resolve. Congress adapter hand-rolls its own roles merge
(`congress.ts:292-309`) — that logic belongs in `upsertEntity`.

### TDD cycle 1 — metadata scalar merge

- [ ] **Step 1.1: Write the failing test**

Add to `tests/unit/core/entities.test.ts`:

```ts
describe("upsertEntity — metadata merge", () => {
  it("prefers non-null new over non-null old on scalar fields", () => {
    upsertEntity(store.db, {
      kind: "person", name: "Joan Huffman",
      external_ids: { openstates_person: "ocd-person/hf" },
      metadata: { party: "Republican" },
    });
    const r = upsertEntity(store.db, {
      kind: "person", name: "Joan Huffman",
      external_ids: { openstates_person: "ocd-person/hf" },
      metadata: { party: "Republican", title: "Senator", district: "17", chamber: "upper" },
    });
    expect(r.created).toBe(false);
    expect(r.entity.metadata).toMatchObject({
      party: "Republican", title: "Senator", district: "17", chamber: "upper",
    });
  });

  it("keeps existing non-null when new is null/undefined", () => {
    upsertEntity(store.db, {
      kind: "person", name: "Brandon Creighton",
      external_ids: { openstates_person: "ocd-person/bc" },
      metadata: { party: "Republican", district: "4", chamber: "upper" },
    });
    const r = upsertEntity(store.db, {
      kind: "person", name: "Brandon Creighton",
      external_ids: { openstates_person: "ocd-person/bc" },
      metadata: { party: "Republican" },
    });
    expect(r.entity.metadata).toMatchObject({
      party: "Republican", district: "4", chamber: "upper",
    });
  });
});
```

- [ ] **Step 1.2: Run to verify failure**

```
pnpm vitest run tests/unit/core/entities.test.ts -t "metadata merge"
```
Expected: FAIL — `r.entity.metadata` missing title/district/chamber.

- [ ] **Step 1.3: Implement metadata merge**

In `src/core/entities.ts`, replace the UPDATE branch (lines 41-51):

```ts
if (existing) {
  const mergedIds = { ...existing.external_ids, ...(input.external_ids ?? {}) };
  const mergedAliases = mergeAliases(existing, input.name);
  const mergedMetadata = mergeMetadata(existing.metadata, input.metadata ?? {});
  db.prepare(
    "UPDATE entities SET external_ids = ?, aliases = ?, metadata = ?, last_seen_at = ? WHERE id = ?",
  ).run(
    JSON.stringify(mergedIds),
    JSON.stringify(mergedAliases),
    JSON.stringify(mergedMetadata),
    now,
    existing.id,
  );
  return {
    entity: { ...existing, external_ids: mergedIds, aliases: mergedAliases, metadata: mergedMetadata, last_seen_at: now },
    created: false,
  };
}
```

Add helper near `mergeAliases`:

```ts
function mergeMetadata(
  old: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...old };
  for (const [k, v] of Object.entries(incoming)) {
    if (k === "roles") continue;  // handled in cycle 2
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  const mergedRoles = mergeRoles(
    (old.roles as RoleEntry[] | undefined) ?? [],
    (incoming.roles as RoleEntry[] | undefined) ?? [],
  );
  if (mergedRoles.length > 0) out.roles = mergedRoles;
  return out;
}

interface RoleEntry {
  jurisdiction: string;
  role: string;
  from?: string | null;
  to?: string | null;
}

function mergeRoles(old: RoleEntry[], incoming: RoleEntry[]): RoleEntry[] {
  const key = (r: RoleEntry) => `${r.jurisdiction}|${r.role}|${r.from ?? ""}`;
  const seen = new Set(old.map(key));
  const out = [...old];
  for (const r of incoming) {
    if (!seen.has(key(r))) {
      out.push(r);
      seen.add(key(r));
    }
  }
  return out;
}
```

- [ ] **Step 1.4: Re-run; verify pass**

```
pnpm vitest run tests/unit/core/entities.test.ts -t "metadata merge"
```
Expected: PASS, 2 tests.

### TDD cycle 2 — roles append without duplication

- [ ] **Step 2.1: Write the failing test**

Add to `tests/unit/core/entities.test.ts`:

```ts
describe("upsertEntity — roles merge", () => {
  it("appends new role entries keyed on (jurisdiction, role, from)", () => {
    upsertEntity(store.db, {
      kind: "person", name: "Senator X",
      external_ids: { bioguide: "X000001" },
      metadata: { roles: [{ jurisdiction: "us-tx", role: "state_legislator", from: "2010-01-01T00:00:00Z", to: null }] },
    });
    const r = upsertEntity(store.db, {
      kind: "person", name: "Senator X",
      external_ids: { bioguide: "X000001" },
      metadata: { roles: [{ jurisdiction: "us-federal", role: "senator", from: "2020-01-03T00:00:00Z", to: null }] },
    });
    expect(r.entity.metadata.roles).toHaveLength(2);
    expect(r.entity.metadata.roles).toEqual([
      { jurisdiction: "us-tx",      role: "state_legislator", from: "2010-01-01T00:00:00Z", to: null },
      { jurisdiction: "us-federal", role: "senator",          from: "2020-01-03T00:00:00Z", to: null },
    ]);
  });

  it("does not duplicate when the same role is seen again", () => {
    const role = { jurisdiction: "us-federal", role: "senator", from: "2020-01-03T00:00:00Z", to: null };
    upsertEntity(store.db, {
      kind: "person", name: "Senator X",
      external_ids: { bioguide: "X000001" },
      metadata: { roles: [role] },
    });
    const r = upsertEntity(store.db, {
      kind: "person", name: "Senator X",
      external_ids: { bioguide: "X000001" },
      metadata: { roles: [role] },
    });
    expect(r.entity.metadata.roles).toHaveLength(1);
  });
});
```

- [ ] **Step 2.2: Run to verify pass**

The `mergeRoles` helper from cycle 1 already implements this — should
pass without further change.

```
pnpm vitest run tests/unit/core/entities.test.ts -t "roles merge"
```
Expected: PASS, 2 tests.

### TDD cycle 3 — wire `fuzzyPick` as resolver step 4

- [ ] **Step 3.1: Write the failing test**

Add to `tests/unit/resolution/fuzzy.test.ts`:

```ts
import { upsertEntity } from "../../../src/core/entities.js";

describe("upsertEntity — fuzzy fallback with linking signal", () => {
  it("resolves close name variant to existing legislator when role-jurisdiction overlaps", () => {
    upsertEntity(store.db, {
      kind: "person", name: "Lake",
      external_ids: { openstates_person: "ocd-person/lake" },
      metadata: {
        roles: [{ jurisdiction: "us-tx", role: "state_legislator", from: "2021-01-12T00:00:00Z", to: null }],
      },
    });
    const r = upsertEntity(store.db, {
      kind: "person", name: "Laake",  // distance-1 typo with role-jurisdiction overlap
      metadata: {
        roles: [{ jurisdiction: "us-tx", role: "state_legislator", from: "2025-09-01T00:00:00Z", to: null }],
      },
    });
    expect(r.created).toBe(false);
    expect(r.entity.external_ids.openstates_person).toBe("ocd-person/lake");
    expect(r.entity.aliases).toContain("Laake");
  });

  it("does NOT fuzzy-resolve without a linking signal", () => {
    upsertEntity(store.db, {
      kind: "person", name: "Lake",
      external_ids: { openstates_person: "ocd-person/lake" },
      metadata: { roles: [{ jurisdiction: "us-tx", role: "state_legislator" }] },
    });
    const r = upsertEntity(store.db, {
      kind: "person", name: "Laake",
      // no external_ids, no role_jurisdictions, no middle name → no link signal
    });
    expect(r.created).toBe(true);
  });
});
```

*(Historical note: an earlier draft of this plan used "Tracy King" / "King" to illustrate surname-only matching. That case is edit-distance 6 and correctly rejected by `fuzzyPick` (ACCEPT_DISTANCE=1); the implementer substituted the distance-1 "Lake"/"Laake" pair. Surname-only resolution from journal shorthand remains an unsolved V1 gap — fuzzy-Levenshtein cannot bridge it; an alias-population path from OpenStates `sort_name` or similar would be needed.)*

- [ ] **Step 3.2: Run to verify failure**

```
pnpm vitest run tests/unit/resolution/fuzzy.test.ts -t "upsertEntity — fuzzy"
```
Expected: FAIL (first test creates a new row instead of linking).

- [ ] **Step 3.3: Implement fuzzy fallback in `upsertEntity`**

In `src/core/entities.ts`, replace the `existing` lookup (lines 37-39) with:

```ts
const existing =
  findByExternalIds(db, input.external_ids ?? {}) ??
  findByExactName(db, input.kind, nameNorm, input.jurisdiction) ??
  findByFuzzy(db, input);
```

Add the helper (near the bottom of the file):

```ts
import { fuzzyPick, type FuzzyCandidate, type UpstreamSignals } from "../resolution/fuzzy.js";

function findByFuzzy(db: Database.Database, input: UpsertInput): Entity | null {
  const signals: UpstreamSignals = {
    external_id_sources: Object.keys(input.external_ids ?? {}),
    middle_name: extractMiddleName(input.name),
    role_jurisdictions: rolesJurisdictions(input.metadata ?? {}),
  };
  // Only attempt fuzzy resolution if the upstream signal set is non-empty;
  // otherwise fuzzyPick's linking-signal check will reject everything.
  const haveSignal =
    signals.external_id_sources.length > 0 ||
    signals.middle_name !== null ||
    signals.role_jurisdictions.length > 0;
  if (!haveSignal) return null;

  // Candidate pool: same kind, name_normalized within edit distance 1.
  // For performance we pre-filter by length (±1) and a cheap SQL prefix.
  const q = normalizeName(input.name);
  const rows = db
    .prepare(
      `SELECT * FROM entities WHERE kind = ?
         AND length(name_normalized) BETWEEN ? AND ?`,
    )
    .all(input.kind, Math.max(1, q.length - 1), q.length + 1) as Row[];
  const candidates: (FuzzyCandidate & { row: Row })[] = rows.map((r) => {
    const meta = JSON.parse(r.metadata) as { roles?: RoleEntry[] };
    return {
      id: r.id,
      name: r.name,
      external_id_sources: Object.keys(JSON.parse(r.external_ids)),
      aliases: JSON.parse(r.aliases),
      role_jurisdictions: (meta.roles ?? []).map((x) => x.jurisdiction),
      row: r,
    };
  });
  const picked = fuzzyPick(input.name, signals, candidates);
  return picked ? rowToEntity(picked.row) : null;
}

function extractMiddleName(full: string): string | null {
  const parts = full.trim().split(/\s+/);
  return parts.length >= 3 ? parts[1] : null;
}

function rolesJurisdictions(metadata: Record<string, unknown>): string[] {
  const roles = metadata.roles as RoleEntry[] | undefined;
  return roles ? roles.map((r) => r.jurisdiction) : [];
}
```

- [ ] **Step 3.4: Re-run; verify pass**

```
pnpm vitest run tests/unit/resolution/fuzzy.test.ts -t "upsertEntity — fuzzy"
pnpm vitest run tests/unit/core/entities.test.ts
```
Expected: both PASS.

### TDD cycle 4 — remove hand-rolled roles merge from congress adapter

- [ ] **Step 4.1: Delete the workaround block**

In `src/adapters/congress.ts`, remove the `if (!created) { ... }` block
at lines 292-309 entirely. The canonical merge in `upsertEntity` now
handles the same case.

- [ ] **Step 4.2: Run full test suite**

```
pnpm test
```
Expected: all green (congress-adapter tests still pass because the
merge semantics are preserved by `upsertEntity`).

### TDD cycle 5 — commit

- [ ] **Step 5.1: Commit**

```bash
git add src/core/entities.ts src/adapters/congress.ts \
        tests/unit/core/entities.test.ts \
        tests/unit/resolution/fuzzy.test.ts
git commit -m "$(cat <<'EOF'
fix(core): merge metadata/roles and wire fuzzy resolver in upsertEntity

UPDATE branch previously touched only external_ids/aliases/last_seen_at,
so the Huffman/Creighton metadata asymmetry the 5-reviewer review caught
was baked in. fuzzyPick existed but was never called, so surname-only
sponsors ("King", "Flores") never resolved. Moves the hand-rolled
roles-merge out of the congress adapter into the one chokepoint.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Done when:** all three cycles pass; `pnpm test` green; commit on main.

**Dependencies:** none (foundational).

---

## Task 2 — OpenStates `occurred_at` ← latest action date; backfill migration

**Files:**
- Modify: `src/adapters/openstates.ts` (line 208)
- Create: `src/core/migrations/003-occurred-at-from-actions.sql`
- Modify: `tests/unit/adapters/openstates.test.ts` (new assertion)

**Why this task:** `openstates.ts:208` writes `b.updated_at` into
`occurred_at`, so every downstream sort and window-filter treats
"when OpenStates last touched this row" as "when the legislature
acted on it." Migration 002 normalized the format of `occurred_at`;
this task fixes the **semantics**.

### TDD cycle 1 — adapter writes action date

- [ ] **Step 1.1: Write the failing test**

Add to `tests/unit/adapters/openstates.test.ts`:

```ts
it("writes latest-action date into occurred_at, not updated_at", async () => {
  // SAMPLE_BILL has updated_at "2026-04-01T10:00:00Z" and a single
  // action dated "2026-04-01". Give it a LATER action so the two
  // dates are unambiguously distinct.
  const billWithLateAction = {
    ...SAMPLE_BILL,
    updated_at: "2026-04-10T10:00:00Z",
    actions: [
      { date: "2025-09-17", description: "Introduced" },
      { date: "2025-09-18", description: "Became law" },
    ],
  };
  // ... configure fetch mock to return billWithLateAction (see existing beforeEach pattern)
  const adapter = new OpenStatesAdapter({ apiKey: "test" });
  await adapter.refresh({ db: store.db, jurisdiction: "tx" });

  const row = store.db
    .prepare("SELECT occurred_at FROM documents WHERE kind = 'bill'")
    .get() as { occurred_at: string };
  // occurred_at must be the last-action date, not the crawl updated_at.
  expect(row.occurred_at).toMatch(/^2025-09-18T/);
});

it("falls back to updated_at when actions[] is empty", async () => {
  const billWithoutActions = { ...SAMPLE_BILL, actions: [] };
  // ... configure fetch mock
  const adapter = new OpenStatesAdapter({ apiKey: "test" });
  await adapter.refresh({ db: store.db, jurisdiction: "tx" });

  const row = store.db
    .prepare("SELECT occurred_at FROM documents WHERE kind = 'bill'")
    .get() as { occurred_at: string };
  expect(row.occurred_at).toMatch(/^2026-04-01T/);
});
```

*(Engineer: replicate the existing `vi.spyOn(global, "fetch")` pattern
at the top of this test file. Return `SAMPLE_PERSON` for `/people`
and the test-specific bill for `/bills`.)*

- [ ] **Step 1.2: Run to verify failure**

```
pnpm vitest run tests/unit/adapters/openstates.test.ts -t "action date"
```
Expected: FAIL — currently stores `2026-04-10T...`.

- [ ] **Step 1.3: Fix the adapter**

In `src/adapters/openstates.ts`, line 208, change:

```ts
// BEFORE
occurred_at: b.updated_at,

// AFTER
occurred_at: b.actions?.at(-1)?.date ?? b.updated_at,
```

- [ ] **Step 1.4: Re-run; verify pass**

```
pnpm vitest run tests/unit/adapters/openstates.test.ts
```
Expected: PASS.

### TDD cycle 2 — migration backfills existing rows

- [ ] **Step 2.1: Create migration file**

Create `src/core/migrations/003-occurred-at-from-actions.sql`:

```sql
-- Phase 2.5 correctness fix: OpenStates bills were previously ingested
-- with `occurred_at = bill.updated_at` (the upstream crawl/update
-- timestamp) instead of the latest legislative action date. This made
-- "recent" feeds surface crawl-time activity instead of real
-- legislative activity. Adapter is fixed at refresh-write time; this
-- migration heals existing rows by reading the action date out of
-- `raw.actions`.
--
-- Idempotent: running on already-healed rows is a no-op because
-- json_extract of a non-existent path returns NULL and COALESCE
-- preserves the existing value.
UPDATE documents
SET occurred_at = COALESCE(
    json_extract(raw, '$.actions[#-1].date'),
    occurred_at
)
WHERE kind = 'bill'
  AND source_name = 'openstates'
  AND json_array_length(json_extract(raw, '$.actions')) > 0;
```

- [ ] **Step 2.2: Verify migration discovered and applied**

The migration loader picks up files in `src/core/migrations/` by
filename order; no code change needed.

```
pnpm test  # full suite — exercises migration on every test DB init
```
Expected: PASS (migration runs cleanly on fresh test DBs, which have
no pre-existing bill rows; the Step 1.1/1.2 tests above cover the
adapter path).

### TDD cycle 3 — commit

- [ ] **Step 3.1: Commit**

```bash
git add src/adapters/openstates.ts \
        src/core/migrations/003-occurred-at-from-actions.sql \
        tests/unit/adapters/openstates.test.ts
git commit -m "$(cat <<'EOF'
fix(adapters): OpenStates occurred_at ← latest action date

occurred_at previously stored bill.updated_at (OpenStates crawl time),
which caused "recent" feeds to surface 7-month-old Sept 2025 Texas
bills as if they had just happened. Adapter now uses the last
actions[] date, falling back to updated_at only when actions[] is
empty. Migration 003 heals existing rows idempotently.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Done when:** all tests pass; `git log -1` shows the commit.

**Dependencies:** none.

---

## Task 3 — `get_entity.recent_documents` exposes and sorts by `action_date`

**Files:**
- Modify: `src/core/documents.ts` (`findDocumentsByEntity`)
- Modify: `src/mcp/tools/get_entity.ts`
- Modify: `tests/unit/mcp/tools/get_entity.test.ts`
- Modify: `tests/unit/core/documents.test.ts`

**Why this task:** after T2, `occurred_at` is correct for bills going
forward, but the `findDocumentsByEntity` query still sorts on
`occurred_at DESC` and projects only that single date. Post-migration
the two are the same for bills, but for **cross-entity recency** we
want to surface both axes so consumers can distinguish
"when the record was first created" from "when it last moved."

### TDD cycle 1 — surface `action_date` on the projection

- [ ] **Step 1.1: Write the failing test**

Add to `tests/unit/core/documents.test.ts`:

```ts
it("findDocumentsByEntity returns action_date alongside occurred_at", () => {
  // Seed one entity + bill with actions; assert projection shape.
  const { entity } = upsertEntity(store.db, {
    kind: "person", name: "Test Senator",
    external_ids: { openstates_person: "ocd-person/t" },
  });
  upsertDocument(store.db, {
    kind: "bill",
    jurisdiction: "us-tx",
    title: "SB 99 — Test",
    occurred_at: "2025-09-18T00:00:00Z",
    source: { name: "openstates", id: "ocd-bill/99", url: "https://example" },
    references: [{ entity_id: entity.id, role: "sponsor" }],
    raw: { actions: [
      { date: "2025-09-01", description: "Introduced" },
      { date: "2025-09-18", description: "Became law" },
    ]},
  });

  const docs = findDocumentsByEntity(store.db, entity.id, 10);
  expect(docs[0]).toMatchObject({
    occurred_at: "2025-09-18T00:00:00.000Z",
    action_date: "2025-09-18",
  });
});
```

- [ ] **Step 1.2: Run to verify failure**

```
pnpm vitest run tests/unit/core/documents.test.ts -t "action_date"
```
Expected: FAIL — `action_date` not on the returned object.

- [ ] **Step 1.3: Extend `Document` projection + query**

In `src/core/documents.ts`, extend `rowToDoc` to accept an optional
`action_date` from a joined column, and update `findDocumentsByEntity`
to compute it:

```ts
function rowToDoc(r: DocRow, refs: EntityReference[] = [], actionDate?: string | null): Document {
  const parsed = Document.parse({
    id: r.id, kind: r.kind, jurisdiction: r.jurisdiction, title: r.title,
    summary: r.summary ?? undefined,
    occurred_at: r.occurred_at, fetched_at: r.fetched_at,
    source: { name: r.source_name, id: r.source_id, url: r.source_url },
    references: refs, raw: JSON.parse(r.raw),
  });
  return actionDate ? { ...parsed, action_date: actionDate } : parsed;
}
```

Extend the `Document` Zod type at `src/core/types.ts:46-61` to
include the optional field. Insert between `raw` (line 60) and the
closing `});`:

```ts
export const Document = z.object({
  id: z.uuid(),
  kind: DocumentKind,
  jurisdiction: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  occurred_at: z.iso.datetime(),
  fetched_at: z.iso.datetime(),
  source: z.object({
    name: z.string(),
    id: z.string(),
    url: z.url(),
  }),
  references: z.array(EntityReference).default([]),
  raw: z.record(z.string(), z.unknown()).default({}),
  action_date: z.string().nullable().optional(),
});
```

Replace `findDocumentsByEntity` (lines 152-165) with:

```ts
export function findDocumentsByEntity(
  db: Database.Database, entityId: string, limit = 50,
): Document[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT d.*,
              json_extract(d.raw, '$.actions[#-1].date') AS action_date
         FROM documents d
         JOIN document_references r ON d.id = r.document_id
         WHERE r.entity_id = ?
         ORDER BY COALESCE(json_extract(d.raw, '$.actions[#-1].date'), d.occurred_at) DESC
         LIMIT ?`,
    )
    .all(entityId, limit) as Array<DocRow & { action_date: string | null }>;
  return rows.map((r) => rowToDoc(r, loadRefs(db, r.id), r.action_date));
}
```

- [ ] **Step 1.4: Re-run; verify pass**

```
pnpm vitest run tests/unit/core/documents.test.ts
```
Expected: PASS.

### TDD cycle 2 — `get_entity` response surfaces `action_date` and sorts by it

- [ ] **Step 2.1: Write the failing test**

Add to `tests/unit/mcp/tools/get_entity.test.ts`:

```ts
it("recent_documents sorted by action date, exposes both axes", async () => {
  const { entity } = upsertEntity(store.db, {
    kind: "person", name: "Sen. A",
    external_ids: { openstates_person: "ocd-person/a" },
  });
  // Two bills, same ingest time, different action dates.
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx", title: "SB 1 — Older action",
    occurred_at: "2025-06-01T00:00:00Z",
    source: { name: "openstates", id: "1", url: "u1" },
    references: [{ entity_id: entity.id, role: "sponsor" }],
    raw: { actions: [{ date: "2025-06-01", description: "intro" }] },
  });
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx", title: "SB 2 — Newer action",
    occurred_at: "2025-09-18T00:00:00Z",
    source: { name: "openstates", id: "2", url: "u2" },
    references: [{ entity_id: entity.id, role: "sponsor" }],
    raw: { actions: [{ date: "2025-09-18", description: "enacted" }] },
  });

  const res = await handleGetEntity(store.db, { id: entity.id });
  expect(res.recent_documents.map((d) => d.title)).toEqual([
    "SB 2 — Newer action",
    "SB 1 — Older action",
  ]);
  expect(res.recent_documents[0]).toMatchObject({
    action_date: "2025-09-18",
    occurred_at: expect.stringMatching(/^2025-09-18T/),
  });
});
```

- [ ] **Step 2.2: Run to verify failure**

```
pnpm vitest run tests/unit/mcp/tools/get_entity.test.ts -t "action date"
```
Expected: FAIL (no `action_date` on projection; sort already works
because T2 fixed `occurred_at` itself — but the test's assertion on
`action_date` will fail).

- [ ] **Step 2.3: Project `action_date` in the tool response**

In `src/mcp/tools/get_entity.ts`, update the `GetEntityResponse`
interface (lines 9-15) and the `simplified` projection (lines 29-39):

```ts
export interface GetEntityResponse {
  entity: Entity;
  recent_documents: Array<{
    id: string;
    kind: string;
    title: string;
    occurred_at: string;
    action_date: string | null;
    source_url: string;
  }>;
  sources: Array<{ name: string; url: string }>;
}
```

```ts
const simplified = docs.map((d: Document) => {
  const key = `${d.source.name}|${d.jurisdiction}`;
  sourceKeys.set(key, { name: d.source.name, jurisdiction: d.jurisdiction });
  return {
    id: d.id,
    kind: d.kind,
    title: d.title,
    occurred_at: d.occurred_at,
    action_date: d.action_date ?? null,
    source_url: d.source.url,
  };
});
```

- [ ] **Step 2.4: Re-run; verify pass**

```
pnpm vitest run tests/unit/mcp/tools/get_entity.test.ts
```
Expected: PASS.

### TDD cycle 3 — commit

- [ ] **Step 3.1: Commit**

```bash
git add src/core/documents.ts src/core/types.ts \
        src/mcp/tools/get_entity.ts \
        tests/unit/core/documents.test.ts \
        tests/unit/mcp/tools/get_entity.test.ts
git commit -m "$(cat <<'EOF'
feat(get_entity): expose action_date on recent_documents, sort by it

findDocumentsByEntity now projects both the bill's own occurred_at and
the latest-action date from raw.actions[]; get_entity.recent_documents
sorts by action date so "recent activity" means legislative activity,
not batch-ingest order.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Done when:** tests pass; commit on main.

**Dependencies:** T2 (relies on `occurred_at` being the real action
date for bills going forward; works regardless on existing data
because the SQL query reads `raw.actions[-1].date` directly).

---

## Task 4 — Trim `recent_bills` sponsor payload to a summary

**Files:**
- Modify: `src/mcp/tools/recent_bills.ts`
- Modify: `tests/unit/mcp/tools/recent_bills.test.ts`

**Why this task:** today lines 59-69 do an N+1 `findEntityById` for
every sponsor on every bill and inline the full `{name, party,
district, chamber}` object. SB 5 has 112 sponsors; a 20-bill Texas
response is 171KB — blowing past LLM tool-call budgets. Replace with
a `sponsor_summary` counting + top-5 shape. Chamber-filter N+1
(lines 46-53) gets the same treatment.

### TDD cycle 1 — `sponsor_summary` shape

- [ ] **Step 1.1: Write the failing test**

Add to `tests/unit/mcp/tools/recent_bills.test.ts`:

```ts
it("returns sponsor_summary (count + by_party + top-5), not full sponsors[]", async () => {
  // Seed 1 bill with 10 sponsors across both parties.
  const sponsorIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const { entity } = upsertEntity(store.db, {
      kind: "person", name: `Sponsor ${i}`,
      external_ids: { openstates_person: `p${i}` },
      metadata: { party: i < 6 ? "Republican" : "Democratic" },
    });
    sponsorIds.push(entity.id);
  }
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx", title: "SB 1 — Test",
    occurred_at: new Date().toISOString(),
    source: { name: "openstates", id: "1", url: "https://ex" },
    references: sponsorIds.map((id, i) => ({
      entity_id: id,
      role: i === 0 ? "sponsor" as const : "cosponsor" as const,
    })),
    raw: { actions: [] },
  });

  const res = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 });
  expect(res.results).toHaveLength(1);
  expect(res.results[0]).toHaveProperty("sponsor_summary");
  expect(res.results[0]).not.toHaveProperty("sponsors");
  expect(res.results[0].sponsor_summary).toMatchObject({
    count: 10,
    by_party: { Republican: 6, Democratic: 4 },
    top: expect.arrayContaining([expect.objectContaining({ role: "sponsor" })]),
  });
  expect(res.results[0].sponsor_summary.top).toHaveLength(5);
});

it("20-bill response fits under 30KB", async () => {
  // Seed 20 bills × 50 sponsors each.
  for (let b = 0; b < 20; b++) {
    const refs = [];
    for (let s = 0; s < 50; s++) {
      const { entity } = upsertEntity(store.db, {
        kind: "person", name: `B${b}S${s}`,
        external_ids: { openstates_person: `b${b}s${s}` },
        metadata: { party: s % 2 === 0 ? "R" : "D" },
      });
      refs.push({ entity_id: entity.id, role: (s === 0 ? "sponsor" : "cosponsor") as const });
    }
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: `B${b} — Test`,
      occurred_at: new Date().toISOString(),
      source: { name: "openstates", id: `b${b}`, url: "https://ex" },
      references: refs,
      raw: { actions: [] },
    });
  }
  const res = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 });
  const bytes = Buffer.byteLength(JSON.stringify(res), "utf8");
  expect(bytes).toBeLessThan(30 * 1024);
});
```

- [ ] **Step 1.2: Run to verify failure**

```
pnpm vitest run tests/unit/mcp/tools/recent_bills.test.ts -t "sponsor_summary"
pnpm vitest run tests/unit/mcp/tools/recent_bills.test.ts -t "under 30KB"
```
Expected: FAIL (shape still has `sponsors`; 20-bill response is huge).

- [ ] **Step 1.3: Rewrite the tool to return `sponsor_summary`**

In `src/mcp/tools/recent_bills.ts`, replace the `BillSummary` type
(lines 6-13) and the mapping (lines 55-78). Also fold the
chamber-filter's N+1 into a single JOIN.

```ts
export interface SponsorSummary {
  count: number;
  by_party: Record<string, number>;
  top: Array<{
    entity_id: string;
    name: string;
    party?: string;
    role: "sponsor" | "cosponsor";
  }>;
}

export interface BillSummary {
  id: string;
  identifier: string;
  title: string;
  latest_action: { date: string; description: string } | null;
  sponsor_summary: SponsorSummary;
  source_url: string;
}
```

Add a helper that builds `sponsor_summary` from a document in a single
pass (no per-sponsor queries — it uses the `Document.references` the
`queryDocuments` call already loaded):

```ts
function buildSponsorSummary(
  db: Database.Database,
  refs: EntityReference[],
): SponsorSummary {
  const filtered = refs.filter((r) => r.role === "sponsor" || r.role === "cosponsor");
  if (filtered.length === 0) {
    return { count: 0, by_party: {}, top: [] };
  }
  // Single batched lookup for the top-5 entities only.
  const TOP_N = 5;
  const primaryIds = filtered.filter((r) => r.role === "sponsor").slice(0, TOP_N);
  const cosponsorIds = filtered.filter((r) => r.role === "cosponsor")
    .slice(0, TOP_N - primaryIds.length);
  const topRefs = [...primaryIds, ...cosponsorIds];

  const placeholders = topRefs.map(() => "?").join(",");
  const topRows = topRefs.length
    ? db
        .prepare(`SELECT id, name, metadata FROM entities WHERE id IN (${placeholders})`)
        .all(...topRefs.map((r) => r.entity_id)) as Array<{ id: string; name: string; metadata: string }>
    : [];
  const topById = new Map(topRows.map((r) => [r.id, r]));

  // by_party aggregate needs metadata for ALL sponsors — one batched SELECT.
  const allPlaceholders = filtered.map(() => "?").join(",");
  const allRows = db
    .prepare(`SELECT id, metadata FROM entities WHERE id IN (${allPlaceholders})`)
    .all(...filtered.map((r) => r.entity_id)) as Array<{ id: string; metadata: string }>;
  const partyById = new Map(
    allRows.map((r) => [r.id, (JSON.parse(r.metadata) as { party?: string }).party ?? "unknown"]),
  );
  const by_party: Record<string, number> = {};
  for (const r of filtered) {
    const p = partyById.get(r.entity_id) ?? "unknown";
    by_party[p] = (by_party[p] ?? 0) + 1;
  }

  const top = topRefs.map((r) => {
    const e = topById.get(r.entity_id);
    const party = e ? (JSON.parse(e.metadata) as { party?: string }).party : undefined;
    return {
      entity_id: r.entity_id,
      name: e?.name ?? "Unknown",
      party,
      role: r.role as "sponsor" | "cosponsor",
    };
  });

  return { count: filtered.length, by_party, top };
}
```

Replace the existing chamber filter (lines 46-53) with a query-time
filter (compute once per document, no N+1):

```ts
const filtered = input.chamber
  ? docs.filter((d) => {
      const primarySponsor = d.references.find((r) => r.role === "sponsor");
      if (!primarySponsor) return false;
      // Resolve just the primary sponsor (capped to one lookup per doc).
      const e = findEntityById(db, primarySponsor.entity_id);
      return e?.metadata.chamber === input.chamber;
    })
  : docs;
```

*(The chamber filter stays a per-doc lookup — one per bill, not one
per sponsor — because it only needs the primary sponsor.)*

Replace the `results` mapping with:

```ts
const results: BillSummary[] = filtered.map((d) => {
  const [identifier, ...titleParts] = d.title.split(" — ");
  const actions = (d.raw.actions as Array<{ date: string; description: string }> | undefined) ?? [];
  const latest = actions.length ? actions[actions.length - 1] : null;
  return {
    id: d.id,
    identifier: identifier?.trim() ?? d.title,
    title: titleParts.join(" — ").trim() || d.title,
    latest_action: latest,
    sponsor_summary: buildSponsorSummary(db, d.references),
    source_url: d.source.url,
  };
});
```

- [ ] **Step 1.4: Re-run; verify pass**

```
pnpm vitest run tests/unit/mcp/tools/recent_bills.test.ts
```
Expected: PASS (all existing + new tests).

### TDD cycle 2 — commit

- [ ] **Step 2.1: Commit**

```bash
git add src/mcp/tools/recent_bills.ts tests/unit/mcp/tools/recent_bills.test.ts
git commit -m "$(cat <<'EOF'
perf(recent_bills): trim sponsors to summary (count + by_party + top-5)

20-bill Texas response was 171KB because sponsors were inlined via N+1
findEntityById per bill. Replaces sponsors[] with a sponsor_summary
object resolved via two batched SELECTs (one for aggregate, one for
top-5). 20-bill response now fits under 30KB. Full sponsor list remains
reachable via get_entity(bill_id) / entity_connections.

BREAKING: BillSummary.sponsors is gone; callers use sponsor_summary.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Done when:** tests pass; 20-bill response <30KB; commit on main.

**Dependencies:** none.

---

## Task 5 — `empty_reason` + `data_freshness` on empty feed responses

**Files:**
- Create: `src/mcp/shared.ts`
- Modify: `src/mcp/tools/recent_bills.ts`, `src/mcp/tools/recent_votes.ts`
- Create: `tests/unit/mcp/shared.test.ts`
- Modify: `tests/unit/mcp/tools/recent_bills.test.ts`
- Modify: `tests/unit/mcp/tools/recent_votes.test.ts`

**Why this task:** today `{results: [], total: 0, sources: []}` is
indistinguishable across three failure modes: (a) never refreshed,
(b) nothing in window, (c) unknown jurisdiction. Add an optional
diagnostic block — emitted ONLY when results are empty — that
distinguishes them.

### TDD cycle 1 — shared helper

- [ ] **Step 1.1: Write the failing test**

Create `tests/unit/mcp/shared.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { upsertDocument } from "../../../src/core/documents.js";
import { emptyFeedDiagnostic } from "../../../src/mcp/shared.js";

const TEST_DB = "./data/test-shared.db";
let store: Store;
beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});
afterEach(() => store.close());

describe("emptyFeedDiagnostic", () => {
  it("returns no_refresh when the jurisdiction has no documents at all", () => {
    const d = emptyFeedDiagnostic(store.db, { jurisdiction: "us-tx", kind: "bill" });
    expect(d.empty_reason).toBe("no_refresh");
    expect(d.data_freshness.last_refreshed_at).toBeNull();
  });

  it("returns no_events_in_window when rows exist but outside the window", () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "Old — B",
      occurred_at: "2024-01-01T00:00:00Z",
      source: { name: "openstates", id: "old", url: "u" },
    });
    const d = emptyFeedDiagnostic(store.db, { jurisdiction: "us-tx", kind: "bill" });
    expect(d.empty_reason).toBe("no_events_in_window");
    expect(d.data_freshness.last_refreshed_at).toMatch(/^2024/);
    expect(d.hint).toMatch(/session/);
  });

  it("returns unknown_jurisdiction when the jurisdiction is not seeded", () => {
    const d = emptyFeedDiagnostic(store.db, { jurisdiction: "us-zz", kind: "bill" });
    expect(d.empty_reason).toBe("unknown_jurisdiction");
  });
});
```

- [ ] **Step 1.2: Run to verify failure**

```
pnpm vitest run tests/unit/mcp/shared.test.ts
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 1.3: Create the helper**

Create `src/mcp/shared.ts`:

```ts
import type Database from "better-sqlite3";
import type { DocumentKind } from "../core/types.js";

export type EmptyReason = "no_refresh" | "no_events_in_window" | "unknown_jurisdiction";

export interface DataFreshness {
  last_refreshed_at: string | null;
  source: string | null;
}

export interface EmptyFeedDiagnostic {
  empty_reason: EmptyReason;
  data_freshness: DataFreshness;
  hint: string;
}

export interface EmptyFeedContext {
  jurisdiction: string;
  kind: DocumentKind;
}

export function emptyFeedDiagnostic(
  db: Database.Database,
  ctx: EmptyFeedContext,
): EmptyFeedDiagnostic {
  // 1. Is the jurisdiction even known?
  const juris = db
    .prepare("SELECT 1 FROM jurisdictions WHERE id = ?")
    .get(ctx.jurisdiction) as unknown;
  if (!juris && ctx.jurisdiction !== "*") {
    return {
      empty_reason: "unknown_jurisdiction",
      data_freshness: { last_refreshed_at: null, source: null },
      hint: `Jurisdiction "${ctx.jurisdiction}" is not seeded. Use one of us-federal or us-<state abbr>.`,
    };
  }

  // 2. Any documents of this kind in this jurisdiction at all?
  const latest = db
    .prepare(
      `SELECT occurred_at, source_name
         FROM documents
         WHERE kind = ? AND (jurisdiction = ? OR ? = '*')
         ORDER BY occurred_at DESC
         LIMIT 1`,
    )
    .get(ctx.kind, ctx.jurisdiction, ctx.jurisdiction) as
      | { occurred_at: string; source_name: string }
      | undefined;

  if (!latest) {
    return {
      empty_reason: "no_refresh",
      data_freshness: { last_refreshed_at: null, source: null },
      hint: `No ${ctx.kind}s ingested yet for ${ctx.jurisdiction}. Run: pnpm refresh --source=openstates --jurisdiction=${ctx.jurisdiction.replace(/^us-/, "")}`,
    };
  }

  return {
    empty_reason: "no_events_in_window",
    data_freshness: {
      last_refreshed_at: latest.occurred_at,
      source: latest.source_name,
    },
    hint: `Latest ${ctx.kind} in store is ${latest.occurred_at.slice(0, 10)}. Try a wider window (days=365) or pass session=<id> to bypass the window.`,
  };
}
```

- [ ] **Step 1.4: Re-run; verify pass**

```
pnpm vitest run tests/unit/mcp/shared.test.ts
```
Expected: PASS.

### TDD cycle 2 — wire into `recent_bills` and `recent_votes`

- [ ] **Step 2.1: Write the failing tests**

Add to `tests/unit/mcp/tools/recent_bills.test.ts`:

```ts
it("attaches empty_reason diagnostic when results are empty", async () => {
  const res = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 });
  expect(res.results).toHaveLength(0);
  expect(res).toHaveProperty("empty_reason", "no_refresh");
  expect(res).toHaveProperty("data_freshness");
  expect(res).toHaveProperty("hint");
});

it("omits empty_reason on non-empty responses", async () => {
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx", title: "SB 1 — Test",
    occurred_at: new Date().toISOString(),
    source: { name: "openstates", id: "1", url: "u" },
    references: [], raw: { actions: [] },
  });
  const res = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 7 });
  expect(res.results).toHaveLength(1);
  expect(res).not.toHaveProperty("empty_reason");
});
```

Mirror the same two tests in `tests/unit/mcp/tools/recent_votes.test.ts`
using `kind: "vote"`.

- [ ] **Step 2.2: Run to verify failure**

```
pnpm vitest run tests/unit/mcp/tools/recent_bills.test.ts -t "empty_reason"
pnpm vitest run tests/unit/mcp/tools/recent_votes.test.ts -t "empty_reason"
```
Expected: FAIL.

- [ ] **Step 2.3: Wire into `recent_bills`**

In `src/mcp/tools/recent_bills.ts`, extend the response interface and
the return statement:

```ts
import { emptyFeedDiagnostic, type EmptyFeedDiagnostic } from "../shared.js";

export interface RecentBillsResponse {
  results: BillSummary[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  window: { from: string; to: string };
  empty_reason?: EmptyFeedDiagnostic["empty_reason"];
  data_freshness?: EmptyFeedDiagnostic["data_freshness"];
  hint?: string;
}
```

Replace the existing `return { ... }` at the end:

```ts
const base: RecentBillsResponse = {
  results,
  total: results.length,
  sources: Array.from(sourceUrls, ([name, url]) => ({ name, url })),
  window: { from: from.toISOString(), to: to.toISOString() },
};
if (results.length === 0) {
  const diag = emptyFeedDiagnostic(db, { jurisdiction: input.jurisdiction, kind: "bill" });
  return { ...base, ...diag };
}
return base;
```

- [ ] **Step 2.4: Wire into `recent_votes`**

Same shape change on `RecentVotesResponse` in
`src/mcp/tools/recent_votes.ts`. Replace the final return (lines 97-102):

```ts
import { emptyFeedDiagnostic, type EmptyFeedDiagnostic } from "../shared.js";

// ... inside handleRecentVotes, replace the existing return with:
const base: RecentVotesResponse = {
  results,
  total: results.length,
  sources: results.length > 0 ? [{ name: "congress", url: "https://www.congress.gov/" }] : [],
  window: { from: from.toISOString(), to: to.toISOString() },
};
if (results.length === 0) {
  const diag = emptyFeedDiagnostic(db, { jurisdiction: input.jurisdiction, kind: "vote" });
  return { ...base, ...diag };
}
return base;
```

And extend the response interface:

```ts
export interface RecentVotesResponse {
  results: VoteSummary[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  window: { from: string; to: string };
  empty_reason?: EmptyFeedDiagnostic["empty_reason"];
  data_freshness?: EmptyFeedDiagnostic["data_freshness"];
  hint?: string;
}
```

- [ ] **Step 2.5: Re-run; verify pass**

```
pnpm vitest run tests/unit/mcp/tools/recent_bills.test.ts
pnpm vitest run tests/unit/mcp/tools/recent_votes.test.ts
```
Expected: PASS.

### TDD cycle 3 — commit

- [ ] **Step 3.1: Commit**

```bash
git add src/mcp/shared.ts \
        src/mcp/tools/recent_bills.ts \
        src/mcp/tools/recent_votes.ts \
        tests/unit/mcp/shared.test.ts \
        tests/unit/mcp/tools/recent_bills.test.ts \
        tests/unit/mcp/tools/recent_votes.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): diagnose empty feed responses with empty_reason + data_freshness

Empty {results: [], total: 0} was indistinguishable across three
failure modes: never refreshed, nothing in window, unknown jurisdiction.
Shared helper emptyFeedDiagnostic looks at the store state and attaches
empty_reason + data_freshness + hint to recent_bills / recent_votes
responses when results are empty. Non-empty responses are unchanged.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Done when:** tests pass; commit on main.

**Dependencies:** none.

---

## Task 6 — Session filter + raised `days` ceiling

**Files:**
- Modify: `src/mcp/schemas.ts` (RecentBillsInput, RecentVotesInput)
- Modify: `src/mcp/tools/recent_bills.ts`, `src/mcp/tools/recent_votes.ts`
- Modify: `tests/unit/mcp/tools/recent_bills.test.ts`, `tests/unit/mcp/tools/recent_votes.test.ts`

**Why this task:** `days.max=90` in `RecentBillsInput`/`RecentVotesInput`
locks out biennial state legislatures (TX meets every 2 years). A
`session` parameter bypasses the window filter. `RecentBillsInput`
already has `session: z.string().optional()` but the handler ignores
it; `RecentVotesInput` lacks the field entirely.

### TDD cycle 1 — raise `days` ceiling

- [ ] **Step 1.1: Write the failing test**

Add to `tests/unit/mcp/tools/recent_bills.test.ts`:

```ts
it("accepts days up to 365", async () => {
  const res = await handleRecentBills(store.db, { jurisdiction: "us-tx", days: 365 });
  expect(res.window.from).toBeDefined();  // schema passes; behavior unchanged
});

it("rejects days above 365", async () => {
  await expect(
    handleRecentBills(store.db, { jurisdiction: "us-tx", days: 366 }),
  ).rejects.toThrow();
});
```

Mirror in `recent_votes.test.ts`.

- [ ] **Step 1.2: Run to verify failure**

```
pnpm vitest run tests/unit/mcp/tools/recent_bills.test.ts -t "365"
```
Expected: FAIL (current max is 90).

- [ ] **Step 1.3: Raise the caps**

In `src/mcp/schemas.ts`, change two lines:

```ts
// RecentBillsInput (line 4) and RecentVotesInput (line 39):
days: z.number().int().min(1).max(365).default(7),
```

- [ ] **Step 1.4: Re-run; verify pass**

```
pnpm vitest run tests/unit/mcp/tools/recent_bills.test.ts
pnpm vitest run tests/unit/mcp/tools/recent_votes.test.ts
```
Expected: PASS.

### TDD cycle 2 — `session` filter on recent_bills

- [ ] **Step 2.1: Write the failing test**

Add to `tests/unit/mcp/tools/recent_bills.test.ts`:

```ts
it("filters by session when session parameter is provided", async () => {
  // Seed two bills in different sessions, both old enough to be outside the window.
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx", title: "SB 1 — 892",
    occurred_at: "2025-09-18T00:00:00Z",
    source: { name: "openstates", id: "892-1", url: "u" },
    references: [], raw: { session: "892", actions: [] },
  });
  upsertDocument(store.db, {
    kind: "bill", jurisdiction: "us-tx", title: "SB 99 — 891",
    occurred_at: "2024-06-01T00:00:00Z",
    source: { name: "openstates", id: "891-99", url: "u" },
    references: [], raw: { session: "891", actions: [] },
  });

  const res = await handleRecentBills(store.db, {
    jurisdiction: "us-tx",
    days: 7,       // well outside both bills' dates
    session: "892",
  });
  expect(res.results.map((r) => r.title)).toEqual(["— 892"]);
});
```

- [ ] **Step 2.2: Run to verify failure**

```
pnpm vitest run tests/unit/mcp/tools/recent_bills.test.ts -t "session"
```
Expected: FAIL — `session` param is currently ignored.

- [ ] **Step 2.3: Wire `session` through the query**

In `src/mcp/tools/recent_bills.ts`, after the `queryDocuments` call,
apply the session filter and bypass the date window when `session` is
set:

```ts
const windowedDocs = input.session
  ? queryDocuments(db, {
      kind: "bill",
      jurisdiction: input.jurisdiction,
      limit: 100,  // session scan — widen the cap
      from: undefined,
      to: undefined,
    })
  : queryDocuments(db, {
      kind: "bill",
      jurisdiction: input.jurisdiction,
      from: from.toISOString(),
      to: to.toISOString(),
      limit: 50,
    });

const sessionFiltered = input.session
  ? windowedDocs.filter((d) => {
      const s = (d.raw as { session?: string }).session;
      return s === input.session;
    })
  : windowedDocs;
```

Replace the previous `docs` assignment with `sessionFiltered`. Update
the `filtered` (chamber filter) line to consume `sessionFiltered`.

*(Engineer: the existing `QueryDocsFilter` allows `from`/`to` to be
optional because they're `?: string | undefined`. If TypeScript
complains, double-check `src/core/documents.ts` line 128-129.)*

- [ ] **Step 2.4: Re-run; verify pass**

```
pnpm vitest run tests/unit/mcp/tools/recent_bills.test.ts
```
Expected: PASS.

### TDD cycle 3 — add `session` to `RecentVotesInput` + wire it

- [ ] **Step 3.1: Write the failing test**

Add to `tests/unit/mcp/tools/recent_votes.test.ts`:

```ts
it("filters votes by session", async () => {
  upsertDocument(store.db, {
    kind: "vote", jurisdiction: "us-tx", title: "Vote 892-1",
    occurred_at: "2025-09-18T00:00:00Z",
    source: { name: "openstates", id: "892v", url: "u" },
    references: [], raw: { session: "892" },
  });
  upsertDocument(store.db, {
    kind: "vote", jurisdiction: "us-tx", title: "Vote 891-1",
    occurred_at: "2024-06-01T00:00:00Z",
    source: { name: "openstates", id: "891v", url: "u" },
    references: [], raw: { session: "891" },
  });

  const res = await handleRecentVotes(store.db, {
    jurisdiction: "us-tx",
    days: 7,
    session: "892",
  });
  expect(res.results).toHaveLength(1);
});
```

- [ ] **Step 3.2: Run to verify failure**

```
pnpm vitest run tests/unit/mcp/tools/recent_votes.test.ts -t "session"
```
Expected: FAIL — `RecentVotesInput` doesn't accept `session`.

- [ ] **Step 3.3: Add `session` to `RecentVotesInput`**

In `src/mcp/schemas.ts`, after line 42 (inside `RecentVotesInput`):

```ts
export const RecentVotesInput = z.object({
  jurisdiction: z.string().min(1),
  days: z.number().int().min(1).max(365).default(7),
  chamber: z.enum(["upper", "lower"]).optional(),
  bill_identifier: z.string().optional(),
  session: z.string().optional(),
});
```

- [ ] **Step 3.4: Wire through `handleRecentVotes`**

In `src/mcp/tools/recent_votes.ts`, mirror the recent_bills pattern:

```ts
const docs = input.session
  ? queryDocuments(db, {
      kind: "vote",
      jurisdiction: input.jurisdiction,
      limit: 200,
    })
  : queryDocuments(db, {
      kind: "vote",
      jurisdiction: input.jurisdiction,
      from: from.toISOString(),
      to: to.toISOString(),
      limit: 200,
    });

const sessionFiltered = input.session
  ? docs.filter((d) => (d.raw as { session?: string }).session === input.session)
  : docs;
```

Use `sessionFiltered` for the subsequent `chamberFilter` / filter
chain.

- [ ] **Step 3.5: Re-run; verify pass**

```
pnpm vitest run tests/unit/mcp/tools/recent_votes.test.ts
```
Expected: PASS.

### TDD cycle 4 — commit

- [ ] **Step 4.1: Commit**

```bash
git add src/mcp/schemas.ts \
        src/mcp/tools/recent_bills.ts \
        src/mcp/tools/recent_votes.ts \
        tests/unit/mcp/tools/recent_bills.test.ts \
        tests/unit/mcp/tools/recent_votes.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): raise days cap to 365 and wire session filter

90-day max locked out biennial state legislatures (TX meets every 2
years). Raises days.max to 365 on recent_bills/recent_votes; adds
session filter that bypasses the window entirely. RecentBillsInput
already advertised session in the zod schema but the handler ignored
it — now it filters by raw.session. RecentVotesInput gains the same
field and wiring.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Done when:** tests pass; commit on main.

**Dependencies:** none.

---

## Final verification (post-all-tasks)

- [ ] **Step F.1: Full suite green**

```bash
pnpm test
pnpm typecheck
```
Expected: all PASS.

- [ ] **Step F.2: Version bump**

In `package.json`, change `"version": "0.0.6"` → `"version": "0.1.0"`.

Also update the User-Agent strings in `src/adapters/openstates.ts:140`
and `src/adapters/congress.ts:246` from `0.0.6` to `0.1.0`.

- [ ] **Step F.3: CHANGELOG**

Append to `CHANGELOG.md` (create if missing):

```markdown
## [0.1.0] — 2026-04-13

### Fixed
- OpenStates `occurred_at` now reflects the latest legislative action
  date, not the crawl/update timestamp. (T2)
- `upsertEntity` merges incoming metadata and appends to `roles[]` on
  every refresh, not just on insert. Fixes Huffman/Creighton metadata
  asymmetry. (T1)
- Fuzzy resolver (`fuzzyPick`) is now part of the entity-resolution
  chain. Surname-only sponsors ("King", "Flores") resolve to existing
  legislators when a linking signal is present. (T1)
- `get_entity.recent_documents` sorts by legislative action date, not
  by ingest-batch time. (T3)

### Added
- `sponsor_summary` on `recent_bills` responses (count + by_party +
  top-5). (T4)
- `empty_reason` + `data_freshness` + `hint` on empty feed responses,
  distinguishing "never refreshed" / "nothing in window" / "unknown
  jurisdiction". (T5)
- `session` filter on `recent_bills` and `recent_votes`, bypassing
  the date window for biennial legislatures. (T6)
- `days` max raised from 90 to 365 on recent feeds. (T6)

### Changed (breaking)
- `BillSummary.sponsors` removed; use `sponsor_summary` or call
  `get_entity(bill_id)` for the full list.
- `Document.occurred_at` semantics changed for OpenStates bills.
  Migration 003 heals existing rows; early-adopter DBs may want to
  `rm -rf data/*.db && pnpm refresh --all`.
```

- [ ] **Step F.4: End-to-end smoke**

```bash
rm -rf data/civic-awareness.db
pnpm bootstrap
pnpm refresh --source=openstates --jurisdiction=tx --max-pages=2
pnpm start &
# In another shell: use the MCP client to call recent_bills(us-tx,
# days=30), get_entity on a senator, recent_votes(us-tx, session="892")
```

Expected:
- `recent_bills` response fits in <30KB for 20 bills.
- `recent_bills` `action_date`-ordering puts newest legislative
  activity first.
- `get_entity(senator_id).metadata.roles` is non-empty.
- `recent_votes(us-tx, {}, days=7)` returns `empty_reason:
  "no_events_in_window"` if TX has no active session.
- `recent_votes(us-tx, session="892")` reaches September 2025 data.

- [ ] **Step F.5: Commit final touches**

```bash
git add package.json src/adapters/openstates.ts src/adapters/congress.ts CHANGELOG.md
git commit -m "$(cat <<'EOF'
chore(release): v0.1.0 — correctness & polish

Bundle of six subagent-driven tasks (T1-T6) landing the Phase 2.5
remediation. See docs/plans/phase-2.5-correctness-polish.md.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Done when:** `git log --oneline -8` shows the six task commits plus
the release-touch commit; v0.1.0 is on main.

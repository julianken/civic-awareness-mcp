# Phase 8a — Shaped-fetch Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the infrastructure for R15 (shaped-query hydration)
without touching any tool handlers. Introduces a new `fetch_log`
table, an `args_hash` canonicalizer, a `withShapedFetch` helper
that gates upstream calls by endpoint cache key, and the
corresponding rationale/decision doc updates. Existing tools
continue to use `ensureFresh` unchanged.

**Architecture:** The redesign replaces the jurisdiction-wide
`hydrations` model with a per-endpoint `(source, endpoint_path,
args_hash)` cache. Tools built in later phases will call
`withShapedFetch(db, key, ttl, fetchAndWrite, readLocal)` — which
checks the `fetch_log` TTL, coalesces concurrent identical calls
via singleflight, respects daily budget, runs the adapter fetch +
write-through in one atomic transaction, and falls back to cached
data on upstream failure. This phase ships the mechanism; no
tools are rewritten yet, so no behavior changes for users.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`,
`better-sqlite3`, `vitest` + `msw` for HTTP mocking.

**Scope impact:** Adds R15 to `docs/00-rationale.md`, adds the
second amendment to D5 in `docs/06-open-decisions.md`, and
updates `CLAUDE.md` with a "migration in-flight" banner so
subagents dispatched during the phase-8 window don't faithfully
re-implement R13's pattern. No adapter methods added; no tool
handlers touched; `hydrate.ts` and `freshness.ts` remain in place.

---

## File structure produced by this phase

```
src/
├── core/
│   ├── args_hash.ts                   # NEW: canonicalize + sha256 args hashing
│   ├── fetch_log.ts                   # NEW: CRUD over the fetch_log table
│   ├── tool_cache.ts                  # NEW: withShapedFetch orchestrator
│   └── migrations/
│       └── 005-fetch-log-table.sql    # NEW
docs/
├── 00-rationale.md                    # MODIFIED: + R15
├── 06-open-decisions.md               # MODIFIED: D5 second amendment
└── plans/
    └── phase-8a-shaped-fetch-infra.md # this file
CLAUDE.md                              # MODIFIED: R15 migration-in-flight banner
tests/
└── unit/
    └── core/
        ├── args_hash.test.ts          # NEW
        ├── fetch_log.test.ts          # NEW
        └── tool_cache.test.ts         # NEW
```

---

## Task 1: Decision records

**Files:**
- Modify: `docs/00-rationale.md` (append R15)
- Modify: `docs/06-open-decisions.md` (second amendment to D5)

- [ ] **Step 1: Append R15 to `docs/00-rationale.md`**

Append at the end of the file (preserve all prior R entries):

```markdown
## R15 — Shaped-query hydration replaces jurisdiction-wide pass-through (2026-04-14)

R13 introduced a transparent pass-through cache keyed on
`(source, jurisdiction, scope)`. On any cache miss the server
ran `refreshSource()`, which paginates the upstream — for
Congress.gov that's `/member` + `/bill` + `/vote` across two
Congresses at 250/page × up to 5 pages each. Cold `us-federal`
calls consistently hit the 20s deadline, returned
`partial_hydrate` stale notices, and frequently served empty
results. The cost model didn't match the call model:
`resolve_person("Angus King")` needs one endpoint, not
thousands of records.

R15 replaces the jurisdiction-wide pattern with per-tool
shaped upstream fetches. Each tool call does:

1. A narrow upstream fetch shaped to the source's capability
   (OpenStates `/people?name=`, Congress.gov
   `/member/{bioguide}/sponsored-legislation`, OpenFEC
   `/candidates/search?q=`, etc.)
2. Atomic write-through to `documents` + `entities` +
   `document_references` inside a single `db.transaction`.
3. Local SQL read using existing projection logic.
4. Return.

Freshness tracking moves to a new `fetch_log` table keyed on
`(source, endpoint_path, args_hash)`. The key sits at the real
deduplication boundary — the upstream request — so tools that
hit the same endpoint with the same args (e.g., `resolve_person`
and `search_entities` both calling OpenStates `/people`) share
warm cache rows.

`stale_notice` narrows to one case: an upstream fetch failed AND
we have stale cached data to fall back on. `partial_hydrate`,
`rate_limited`, and `daily_budget_exhausted` stale reasons are
retired — narrow calls either fit the bucket, or the caller sees
`upstream_failure` with stale fallback, or a real error.

R14 (per-document TTL via `documents.fetched_at`, used by
`get_bill`) is preserved alongside R15. The two are
complementary: R14 for single-resource tools where freshness is
inherent to the row; R15 for listing/search endpoints where
per-endpoint tracking in `fetch_log` is needed.

Rolls out in 11 sub-phases (phase-8a through phase-8.11); see
`docs/superpowers/specs/2026-04-14-shaped-query-hydration-design.md`
for the full design.
```

- [ ] **Step 2: Append second amendment to D5 in `docs/06-open-decisions.md`**

Find the D5 section. After the first "Amended 2026-04-13" block,
append:

```markdown
**Amended 2026-04-14 (R15):** D5's transparent-cache approach is
re-shaped from jurisdiction-wide pass-through to per-endpoint
shaped fetches. Cache keying moves from
`(source, jurisdiction, scope)` in the `hydrations` table to
`(source, endpoint_path, args_hash)` in a new `fetch_log` table.
Each tool call issues the narrow upstream query its shape
permits, writes-through atomically, and serves from local. The
20s jurisdiction hydration budget and its `partial_hydrate`
stale notice are eliminated — narrow fetches don't accrete
enough work to exceed rate-limit windows. The `pnpm refresh`
CLI continues to exist for operator bulk pre-fill and should
write `fetch_log` rows for the endpoints it covers.
```

- [ ] **Step 3: Verify both docs render**

Run: `head -5 docs/00-rationale.md` — first line is unchanged.
Run: `grep -c '^## R' docs/00-rationale.md` — count up by 1 vs. prior.
Run: `grep -c '^## D' docs/06-open-decisions.md` — unchanged (amended, not added).

- [ ] **Step 4: Commit**

```bash
git add docs/00-rationale.md docs/06-open-decisions.md
git commit -m "docs: add R15 (shaped-query hydration) + D5 second amendment

R15 replaces R13's jurisdiction-wide pass-through cache with
per-tool shaped upstream fetches and a fetch_log table keyed on
(source, endpoint_path, args_hash). D5 amended to reflect the
new keying. Rolls out across phase 8a-8.11.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: CLAUDE.md migration-in-flight banner

**Files:**
- Modify: `CLAUDE.md`

Purpose: any subagent dispatched during phase-8 must see R15's
direction, not silently re-implement R13's pattern from the
older CLAUDE.md text.

- [ ] **Step 1: Add a banner at the top of the "Key conventions" section**

Find the line `## Key conventions (locked by decision records)`.
Immediately before it, insert:

```markdown
> **⚠️ Phase-8 migration in flight (started 2026-04-14):** The
> hydration model is moving from R13 (transparent pass-through
> cache, jurisdiction-keyed) to R15 (shaped-query hydration,
> endpoint-keyed). Existing tools still call `ensureFresh` via
> `src/core/hydrate.ts`; new adapter methods and `withShapedFetch`
> in `src/core/tool_cache.ts` are the target pattern for all tool
> rewrites starting in phase 8b. See
> `docs/superpowers/specs/2026-04-14-shaped-query-hydration-design.md`
> and `docs/plans/phase-8a-shaped-fetch-infra.md` for the full
> design and rollout. During the migration window, do not
> introduce new `ensureFresh` calls — use `withShapedFetch` for
> any new code paths.
```

- [ ] **Step 2: Update the "Refresh (D5 → R13)" bullet in the same section**

Replace the existing "Refresh (D5 → R13):" bullet with:

```markdown
- **Refresh (D5 → R13 → R15):** Under the phase-8 migration
  (in flight), tools call `withShapedFetch(db, key, ttl,
  fetchAndWrite, readLocal)` from `src/core/tool_cache.ts`. The
  cache key is `(source, endpoint_path, args_hash)`; freshness
  rows live in the `fetch_log` table. Upstream fetch +
  write-through happen in one transaction and `fetch_log` is
  updated in the same transaction. `stale_notice` fires only
  when an upstream fetch failed and cached data exists as
  fallback. The `hydrations` table and `ensureFresh` still exist
  for tools not yet rewritten; both are removed in phase 8.10.
  `pnpm refresh` CLI remains for operator use.
```

- [ ] **Step 3: Update the "How to think about this MCP" section**

Find the paragraph that starts `- **Pass-through hydration (R13):**`.
Replace it with:

```markdown
- **Shaped-query hydration (R15, in flight):** Tools gate their
  upstream fetches on a `fetch_log` row keyed by
  `(source, endpoint_path, args_hash)`. On a miss they call
  the adapter's narrow shaped method, write-through inside a
  transaction, and serve from the local store. R13's
  jurisdiction-wide singleflight and `partial_hydrate` stale
  notice no longer apply. See
  `src/core/tool_cache.ts::withShapedFetch`.
```

- [ ] **Step 4: Verify markdown renders**

Run: `head -60 CLAUDE.md` and eyeball the banner position.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): add R15 migration-in-flight banner

Subagents dispatched during phase-8 rollout read CLAUDE.md fresh
each task. Banner directs them to withShapedFetch as the target
pattern instead of silently re-implementing R13's ensureFresh.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Migration 005 — create `fetch_log` table

**Files:**
- Create: `src/core/migrations/005-fetch-log-table.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- src/core/migrations/005-fetch-log-table.sql

CREATE TABLE IF NOT EXISTS fetch_log (
  source TEXT NOT NULL,
  endpoint_path TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('recent', 'full', 'detail')),
  fetched_at TEXT NOT NULL,
  last_rowcount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, endpoint_path, args_hash)
);

CREATE INDEX IF NOT EXISTS idx_fetch_log_fetched_at
  ON fetch_log(fetched_at);
```

- [ ] **Step 2: Check the migration runner picks up new files**

Confirm `src/core/store.ts` applies files from
`src/core/migrations/` in lexical order (prior 001-004 confirm
the pattern). Run: `ls src/core/migrations/` — new 005 file
appears last.

- [ ] **Step 3: Verify migration applies on fresh DB**

Run:
```bash
rm -f /tmp/phase8a-migration-test.db
CIVIC_AWARENESS_DB_PATH=/tmp/phase8a-migration-test.db pnpm bootstrap
```

Expected: bootstrap completes without errors.

Then:
```bash
sqlite3 /tmp/phase8a-migration-test.db ".schema fetch_log"
```

Expected output includes the CREATE TABLE and the index.

- [ ] **Step 4: Run the full test suite to confirm no regressions**

Run: `pnpm test`

Expected: all tests pass (migration is purely additive).

- [ ] **Step 5: Commit**

```bash
git add src/core/migrations/005-fetch-log-table.sql
git commit -m "feat(migrations): 005 fetch_log table for shaped-query TTL cache

Keyed on (source, endpoint_path, args_hash) per R15. Scope column
carries 'recent' | 'full' | 'detail' but is not part of the key —
a 'full' fetch supersedes a prior 'recent' for the same endpoint.
last_rowcount distinguishes 'upstream returned empty' from 'never
tried' for empty-result diagnostics.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `args_hash` module

**Files:**
- Create: `src/core/args_hash.ts`
- Test: `tests/unit/core/args_hash.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/core/args_hash.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hashArgs, canonicalizeArgs } from "../../../src/core/args_hash.js";

describe("args_hash", () => {
  describe("canonicalizeArgs", () => {
    it("lowercases + trims + collapses whitespace on string values", () => {
      expect(canonicalizeArgs("resolve_person", { name: "Angus King" }))
        .toBe('resolve_person:{"name":"angus king"}');
      expect(canonicalizeArgs("resolve_person", { name: "angus king" }))
        .toBe('resolve_person:{"name":"angus king"}');
      expect(canonicalizeArgs("resolve_person", { name: "  Angus  King  " }))
        .toBe('resolve_person:{"name":"angus king"}');
    });

    it("drops empty-string and undefined fields", () => {
      expect(canonicalizeArgs("resolve_person", { name: "Angus King", role_hint: "" }))
        .toBe('resolve_person:{"name":"angus king"}');
      expect(canonicalizeArgs("resolve_person", { name: "Angus King", role_hint: undefined }))
        .toBe('resolve_person:{"name":"angus king"}');
    });

    it("sorts object keys in codepoint order", () => {
      const a = canonicalizeArgs("resolve_person", { role_hint: "senator", name: "Angus King" });
      const b = canonicalizeArgs("resolve_person", { name: "Angus King", role_hint: "senator" });
      expect(a).toBe(b);
      expect(a).toBe('resolve_person:{"name":"angus king","role_hint":"senator"}');
    });

    it("normalizes jurisdictions to lowercase", () => {
      expect(canonicalizeArgs("recent_bills", { jurisdiction: "US-TX", days: 7 }))
        .toBe('recent_bills:{"days":7,"jurisdiction":"us-tx"}');
      expect(canonicalizeArgs("recent_bills", { jurisdiction: "us-tx", days: 7.0 }))
        .toBe('recent_bills:{"days":7,"jurisdiction":"us-tx"}');
    });

    it("preserves array order (semantic)", () => {
      const a = canonicalizeArgs("search_civic_documents", { q: "tax", kinds: ["bill", "vote"] });
      const b = canonicalizeArgs("search_civic_documents", { q: "tax", kinds: ["vote", "bill"] });
      expect(a).not.toBe(b);
    });

    it("prefixes with tool name to prevent cross-tool collision", () => {
      const a = canonicalizeArgs("get_entity", { id: "x" });
      const b = canonicalizeArgs("get_bill", { id: "x" });
      expect(a).not.toBe(b);
    });
  });

  describe("hashArgs", () => {
    it("produces 32 hex characters", () => {
      const h = hashArgs("resolve_person", { name: "Angus King" });
      expect(h).toMatch(/^[0-9a-f]{32}$/);
    });

    it("collides identical canonical forms", () => {
      expect(hashArgs("resolve_person", { name: "Angus King" }))
        .toBe(hashArgs("resolve_person", { name: "  angus king  " }));
    });

    it("does not collide distinct inputs", () => {
      expect(hashArgs("resolve_person", { name: "Smith" }))
        .not.toBe(hashArgs("resolve_person", { name: "John Smith" }));
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/core/args_hash.test.ts`

Expected: FAIL — "Cannot find module '../../../src/core/args_hash.js'"

- [ ] **Step 3: Implement the module**

Create `src/core/args_hash.ts`:

```ts
import { createHash } from "node:crypto";

function canonicalize(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("args_hash: non-finite number");
    return v;
  }
  if (typeof v === "string") {
    return v.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  }
  if (Array.isArray(v)) {
    return v.map(canonicalize);
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const cv = canonicalize(obj[k]);
      if (cv !== undefined) out[k] = cv;
    }
    return out;
  }
  throw new Error(`args_hash: unsupported type ${typeof v}`);
}

export function canonicalizeArgs(tool: string, args: unknown): string {
  return `${tool}:${JSON.stringify(canonicalize(args))}`;
}

export function hashArgs(tool: string, args: unknown): string {
  const payload = canonicalizeArgs(tool, args);
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/core/args_hash.test.ts`

Expected: PASS — all 9 test cases green.

- [ ] **Step 5: Commit**

```bash
git add src/core/args_hash.ts tests/unit/core/args_hash.test.ts
git commit -m "feat(core): args_hash canonicalization + sha256 hashing

Canonicalizes Zod-parsed tool inputs by recursive walk:
sorted keys, string NFC + trim + collapse + lowercase,
preserved array order, undefined/empty-string drops. Prefixes
with tool name to prevent cross-tool collisions. Returns 32
hex chars of sha256 (128-bit prefix).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `fetch_log` CRUD module

**Files:**
- Create: `src/core/fetch_log.ts`
- Test: `tests/unit/core/fetch_log.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/core/fetch_log.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { bootstrap } from "../../../src/cli/bootstrap.js";
import { openStore } from "../../../src/core/store.js";
import { getFetchLog, upsertFetchLog, isFetchLogFresh } from "../../../src/core/fetch_log.js";

let db: Database.Database;

beforeEach(async () => {
  const dbPath = `/tmp/fetch-log-test-${Date.now()}-${Math.random()}.db`;
  await bootstrap({ dbPath });
  db = openStore(dbPath).db;
});

describe("fetch_log", () => {
  it("returns null for an unknown key", () => {
    const row = getFetchLog(db, "openstates", "/people", "abc123");
    expect(row).toBeNull();
  });

  it("upsert then get round-trips", () => {
    const now = new Date().toISOString();
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: "abc123",
      scope: "full",
      fetched_at: now,
      last_rowcount: 42,
    });
    const row = getFetchLog(db, "openstates", "/people", "abc123");
    expect(row).toEqual({
      source: "openstates",
      endpoint_path: "/people",
      args_hash: "abc123",
      scope: "full",
      fetched_at: now,
      last_rowcount: 42,
    });
  });

  it("upsert overwrites existing row", () => {
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: "abc123",
      scope: "recent",
      fetched_at: "2026-04-01T00:00:00.000Z",
      last_rowcount: 0,
    });
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: "abc123",
      scope: "full",
      fetched_at: "2026-04-14T00:00:00.000Z",
      last_rowcount: 100,
    });
    const row = getFetchLog(db, "openstates", "/people", "abc123");
    expect(row?.scope).toBe("full");
    expect(row?.last_rowcount).toBe(100);
  });

  it("isFetchLogFresh returns true when within TTL", () => {
    const now = Date.now();
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: "abc123",
      scope: "full",
      fetched_at: new Date(now - 30 * 60 * 1000).toISOString(), // 30 min ago
      last_rowcount: 1,
    });
    expect(isFetchLogFresh(db, "openstates", "/people", "abc123", 60 * 60 * 1000))
      .toBe(true);
  });

  it("isFetchLogFresh returns false when past TTL", () => {
    const now = Date.now();
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: "abc123",
      scope: "full",
      fetched_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
      last_rowcount: 1,
    });
    expect(isFetchLogFresh(db, "openstates", "/people", "abc123", 60 * 60 * 1000))
      .toBe(false);
  });

  it("isFetchLogFresh returns false when row is absent", () => {
    expect(isFetchLogFresh(db, "openstates", "/people", "unknown", 60 * 60 * 1000))
      .toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/core/fetch_log.test.ts`

Expected: FAIL — "Cannot find module '../../../src/core/fetch_log.js'"

- [ ] **Step 3: Implement the module**

Create `src/core/fetch_log.ts`:

```ts
import type Database from "better-sqlite3";
import type { HydrationSource } from "./freshness.js";

export type FetchLogScope = "recent" | "full" | "detail";

export interface FetchLogRow {
  source: HydrationSource;
  endpoint_path: string;
  args_hash: string;
  scope: FetchLogScope;
  fetched_at: string;
  last_rowcount: number;
}

export function getFetchLog(
  db: Database.Database,
  source: HydrationSource,
  endpoint_path: string,
  args_hash: string,
): FetchLogRow | null {
  const row = db
    .prepare(
      `SELECT source, endpoint_path, args_hash, scope, fetched_at, last_rowcount
         FROM fetch_log
         WHERE source = ? AND endpoint_path = ? AND args_hash = ?`,
    )
    .get(source, endpoint_path, args_hash) as FetchLogRow | undefined;
  return row ?? null;
}

export function upsertFetchLog(db: Database.Database, row: FetchLogRow): void {
  db.prepare(
    `INSERT INTO fetch_log
       (source, endpoint_path, args_hash, scope, fetched_at, last_rowcount)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, endpoint_path, args_hash) DO UPDATE SET
       scope = excluded.scope,
       fetched_at = excluded.fetched_at,
       last_rowcount = excluded.last_rowcount`,
  ).run(
    row.source,
    row.endpoint_path,
    row.args_hash,
    row.scope,
    row.fetched_at,
    row.last_rowcount,
  );
}

export function isFetchLogFresh(
  db: Database.Database,
  source: HydrationSource,
  endpoint_path: string,
  args_hash: string,
  ttlMs: number,
): boolean {
  const row = getFetchLog(db, source, endpoint_path, args_hash);
  if (!row) return false;
  const ageMs = Date.now() - Date.parse(row.fetched_at);
  return ageMs < ttlMs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/core/fetch_log.test.ts`

Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/core/fetch_log.ts tests/unit/core/fetch_log.test.ts
git commit -m "feat(core): fetch_log CRUD for per-endpoint cache freshness

Get, upsert, and TTL check against the fetch_log table from
migration 005. No tool integration yet — consumers arrive in
subsequent phase-8a tasks.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `withShapedFetch` — TTL-hit path

**Files:**
- Create: `src/core/tool_cache.ts`
- Test: `tests/unit/core/tool_cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/core/tool_cache.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { bootstrap } from "../../../src/cli/bootstrap.js";
import { openStore } from "../../../src/core/store.js";
import { hashArgs } from "../../../src/core/args_hash.js";
import { upsertFetchLog } from "../../../src/core/fetch_log.js";
import {
  withShapedFetch,
  _resetToolCacheForTesting,
} from "../../../src/core/tool_cache.js";

let db: Database.Database;

beforeEach(async () => {
  _resetToolCacheForTesting();
  const dbPath = `/tmp/tool-cache-test-${Date.now()}-${Math.random()}.db`;
  await bootstrap({ dbPath });
  db = openStore(dbPath).db;
});

describe("withShapedFetch — TTL hit", () => {
  it("skips upstream when fetch_log row is fresh", async () => {
    const args = { name: "test" };
    const hash = hashArgs("__test__", args);
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: hash,
      scope: "full",
      fetched_at: new Date().toISOString(),
      last_rowcount: 5,
    });

    const fetchAndWrite = vi.fn(async () => ({ primary_rows_written: 0 }));
    const readLocal = vi.fn(() => ["cached-result"]);

    const result = await withShapedFetch(
      db,
      { source: "openstates", endpoint_path: "/people", args, tool: "__test__" },
      { scope: "full", ms: 24 * 60 * 60 * 1000 },
      fetchAndWrite,
      readLocal,
      () => 0,
    );

    expect(fetchAndWrite).not.toHaveBeenCalled();
    expect(readLocal).toHaveBeenCalledOnce();
    expect(result.value).toEqual(["cached-result"]);
    expect(result.stale_notice).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/core/tool_cache.test.ts`

Expected: FAIL — "Cannot find module '../../../src/core/tool_cache.js'"

- [ ] **Step 3: Implement the TTL-hit path**

Create `src/core/tool_cache.ts`:

```ts
import type Database from "better-sqlite3";
import { hashArgs } from "./args_hash.js";
import { isFetchLogFresh } from "./fetch_log.js";
import type { FetchLogScope } from "./fetch_log.js";
import type { HydrationSource } from "./freshness.js";
import type { StaleNotice } from "../mcp/shared.js";

export interface ShapedFetchKey {
  source: HydrationSource;
  endpoint_path: string;
  args: unknown;
  tool: string;
}

export interface ShapedFetchTTL {
  scope: FetchLogScope;
  ms: number;
}

export interface ShapedFetchResult<T> {
  value: T;
  stale_notice?: StaleNotice;
}

export function _resetToolCacheForTesting(): void {
  // Subsequent tasks add singleflight + budget singletons; reset them here.
}

export async function withShapedFetch<T>(
  db: Database.Database,
  key: ShapedFetchKey,
  ttl: ShapedFetchTTL,
  _fetchAndWrite: () => Promise<{ primary_rows_written: number }>,
  readLocal: () => T,
  _peekWaitMs: () => number,
): Promise<ShapedFetchResult<T>> {
  const args_hash = hashArgs(key.tool, key.args);

  if (isFetchLogFresh(db, key.source, key.endpoint_path, args_hash, ttl.ms)) {
    return { value: readLocal() };
  }

  // Subsequent tasks implement the miss path + singleflight + budget +
  // transactional write-through + stale fallback. Throw until they land.
  throw new Error("withShapedFetch TTL-miss path not yet implemented");
}
```

- [ ] **Step 4: Run test to verify TTL-hit test passes**

Run: `pnpm test tests/unit/core/tool_cache.test.ts -t "TTL hit"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/tool_cache.ts tests/unit/core/tool_cache.test.ts
git commit -m "feat(core): tool_cache withShapedFetch — TTL-hit skeleton

Reads from fetch_log and returns local result without calling
upstream when the row is fresh. Miss path stubbed; subsequent
tasks add fetch + singleflight + budget + transaction + stale
fallback.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `withShapedFetch` — TTL-miss with transactional write-through

**Files:**
- Modify: `src/core/tool_cache.ts`
- Modify: `tests/unit/core/tool_cache.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/core/tool_cache.test.ts`:

```ts
import { getFetchLog } from "../../../src/core/fetch_log.js";

describe("withShapedFetch — TTL miss", () => {
  it("calls fetchAndWrite on cache miss, updates fetch_log, returns readLocal", async () => {
    const fetchAndWrite = vi.fn(async () => ({ primary_rows_written: 7 }));
    const readLocal = vi.fn(() => ["fresh-result"]);

    const result = await withShapedFetch(
      db,
      { source: "openstates", endpoint_path: "/people", args: { name: "test" }, tool: "__test__" },
      { scope: "full", ms: 24 * 60 * 60 * 1000 },
      fetchAndWrite,
      readLocal,
      () => 0,
    );

    expect(fetchAndWrite).toHaveBeenCalledOnce();
    expect(readLocal).toHaveBeenCalledOnce();
    expect(result.value).toEqual(["fresh-result"]);
    expect(result.stale_notice).toBeUndefined();

    const logged = getFetchLog(
      db, "openstates", "/people",
      hashArgs("__test__", { name: "test" }),
    );
    expect(logged).not.toBeNull();
    expect(logged?.last_rowcount).toBe(7);
    expect(logged?.scope).toBe("full");
  });

  it("rolls back fetch_log if fetchAndWrite throws", async () => {
    const fetchAndWrite = vi.fn(async () => {
      throw new Error("upstream down");
    });
    const readLocal = vi.fn(() => [] as string[]);

    await expect(
      withShapedFetch(
        db,
        { source: "openstates", endpoint_path: "/people", args: { name: "test" }, tool: "__test__" },
        { scope: "full", ms: 24 * 60 * 60 * 1000 },
        fetchAndWrite,
        readLocal,
        () => 0,
      ),
    ).rejects.toThrow(/upstream down/);

    const logged = getFetchLog(
      db, "openstates", "/people",
      hashArgs("__test__", { name: "test" }),
    );
    expect(logged).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/core/tool_cache.test.ts -t "TTL miss"`

Expected: FAIL — miss path throws "not yet implemented."

- [ ] **Step 3: Implement the TTL-miss path**

Modify `src/core/tool_cache.ts`. Add the transaction helper (better-sqlite3's
`db.transaction()` is synchronous; we need async-compatible BEGIN/COMMIT/ROLLBACK
using prepared statements):

```ts
import { upsertFetchLog } from "./fetch_log.js";

async function runInTransaction<R>(
  db: Database.Database,
  fn: () => Promise<R>,
): Promise<R> {
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    const result = await fn();
    db.prepare("COMMIT").run();
    return result;
  } catch (err) {
    db.prepare("ROLLBACK").run();
    throw err;
  }
}
```

Replace the throwing miss path with:

```ts
const { primary_rows_written } = await runInTransaction(db, async () => {
  const result = await _fetchAndWrite();
  upsertFetchLog(db, {
    source: key.source,
    endpoint_path: key.endpoint_path,
    args_hash,
    scope: ttl.scope,
    fetched_at: new Date().toISOString(),
    last_rowcount: result.primary_rows_written,
  });
  return result;
});
void primary_rows_written;
return { value: readLocal() };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/core/tool_cache.test.ts -t "TTL miss"`

Expected: PASS — both new tests green.

Run full file: `pnpm test tests/unit/core/tool_cache.test.ts`

Expected: all tests (TTL hit + TTL miss) green.

- [ ] **Step 5: Commit**

```bash
git add src/core/tool_cache.ts tests/unit/core/tool_cache.test.ts
git commit -m "feat(core): withShapedFetch TTL-miss path with transactional write-through

On miss, runs fetchAndWrite inside a BEGIN IMMEDIATE / COMMIT
transaction and upserts the fetch_log row in the same transaction.
On fetchAndWrite throw, ROLLBACK drops the fetch_log write —
preventing 'fresh marker, empty store' silent failure.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `withShapedFetch` — singleflight coalescing

**Files:**
- Modify: `src/core/tool_cache.ts`
- Modify: `tests/unit/core/tool_cache.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/core/tool_cache.test.ts`:

```ts
describe("withShapedFetch — singleflight", () => {
  it("coalesces concurrent identical calls into one upstream fetch", async () => {
    let fetchCount = 0;
    let resolveFetch: (() => void) | null = null;
    const fetchAndWrite = async () => {
      fetchCount += 1;
      await new Promise<void>((resolve) => { resolveFetch = resolve; });
      return { primary_rows_written: 1 };
    };
    const readLocal = () => ["result"];

    const key = {
      source: "openstates" as const,
      endpoint_path: "/people",
      args: { name: "coalesce" },
      tool: "__test__",
    };
    const ttl = { scope: "full" as const, ms: 24 * 60 * 60 * 1000 };

    const p1 = withShapedFetch(db, key, ttl, fetchAndWrite, readLocal, () => 0);
    const p2 = withShapedFetch(db, key, ttl, fetchAndWrite, readLocal, () => 0);
    const p3 = withShapedFetch(db, key, ttl, fetchAndWrite, readLocal, () => 0);

    await new Promise((r) => setTimeout(r, 10));
    expect(fetchCount).toBe(1);

    resolveFetch!();
    const results = await Promise.all([p1, p2, p3]);

    expect(fetchCount).toBe(1);
    expect(results.map((r) => r.value)).toEqual([["result"], ["result"], ["result"]]);
  });

  it("different args do NOT coalesce", async () => {
    let fetchCount = 0;
    const fetchAndWrite = async () => {
      fetchCount += 1;
      return { primary_rows_written: 1 };
    };
    const readLocal = () => ["result"];
    const ttl = { scope: "full" as const, ms: 24 * 60 * 60 * 1000 };

    await Promise.all([
      withShapedFetch(
        db,
        { source: "openstates", endpoint_path: "/people", args: { name: "a" }, tool: "__test__" },
        ttl, fetchAndWrite, readLocal, () => 0,
      ),
      withShapedFetch(
        db,
        { source: "openstates", endpoint_path: "/people", args: { name: "b" }, tool: "__test__" },
        ttl, fetchAndWrite, readLocal, () => 0,
      ),
    ]);

    expect(fetchCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/core/tool_cache.test.ts -t "singleflight"`

Expected: FAIL — coalesce test shows `fetchCount` > 1.

- [ ] **Step 3: Implement singleflight**

Modify `src/core/tool_cache.ts`. Import and instantiate a module-level
Singleflight, wrap the miss path, and reset it in
`_resetToolCacheForTesting`:

```ts
import { Singleflight } from "./singleflight.js";

let sf = new Singleflight<ShapedFetchResult<unknown>>();

export function _resetToolCacheForTesting(): void {
  sf = new Singleflight<ShapedFetchResult<unknown>>();
}
```

Wrap the miss path (everything after the TTL-hit early return) in
`sf.do`:

```ts
const singleflightKey = `${key.source}:${key.endpoint_path}:${args_hash}`;
return (await sf.do(singleflightKey, async () => {
  if (isFetchLogFresh(db, key.source, key.endpoint_path, args_hash, ttl.ms)) {
    return { value: readLocal() } as ShapedFetchResult<unknown>;
  }
  const { primary_rows_written } = await runInTransaction(db, async () => {
    const result = await _fetchAndWrite();
    upsertFetchLog(db, {
      source: key.source,
      endpoint_path: key.endpoint_path,
      args_hash,
      scope: ttl.scope,
      fetched_at: new Date().toISOString(),
      last_rowcount: result.primary_rows_written,
    });
    return result;
  });
  void primary_rows_written;
  return { value: readLocal() } as ShapedFetchResult<unknown>;
})) as ShapedFetchResult<T>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/core/tool_cache.test.ts -t "singleflight"`

Expected: PASS — both coalesce and distinct-args tests green.

Full file: `pnpm test tests/unit/core/tool_cache.test.ts`

Expected: all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/core/tool_cache.ts tests/unit/core/tool_cache.test.ts
git commit -m "feat(core): withShapedFetch singleflight coalesces concurrent identical calls

Keyed on (source, endpoint_path, args_hash). Different args do
not coalesce. Double-check under lock handles the race where a
prior inflight call completed and wrote fetch_log just before
this call entered the singleflight block.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `withShapedFetch` — daily budget gate

**Files:**
- Modify: `src/core/tool_cache.ts`
- Modify: `tests/unit/core/tool_cache.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/core/tool_cache.test.ts`:

```ts
describe("withShapedFetch — daily budget", () => {
  it("propagates budget-exhausted when no cached data exists", async () => {
    process.env.CIVIC_AWARENESS_DAILY_BUDGET = "openstates=0";
    _resetToolCacheForTesting();

    const fetchAndWrite = vi.fn(async () => ({ primary_rows_written: 1 }));
    const readLocal = vi.fn(() => [] as string[]);

    await expect(
      withShapedFetch(
        db,
        { source: "openstates", endpoint_path: "/people", args: { name: "x" }, tool: "__test__" },
        { scope: "full", ms: 24 * 60 * 60 * 1000 },
        fetchAndWrite,
        readLocal,
        () => 0,
      ),
    ).rejects.toThrow(/daily budget/i);

    expect(fetchAndWrite).not.toHaveBeenCalled();

    delete process.env.CIVIC_AWARENESS_DAILY_BUDGET;
    _resetToolCacheForTesting();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/core/tool_cache.test.ts -t "daily budget"`

Expected: FAIL — no budget check exists yet.

- [ ] **Step 3: Implement budget gate**

Modify `src/core/tool_cache.ts`. Instantiate a `DailyBudget` at module
level; check before `runInTransaction`; record after commit. Reset in
`_resetToolCacheForTesting`:

```ts
import { DailyBudget } from "./budget.js";

let budget = new DailyBudget(process.env.CIVIC_AWARENESS_DAILY_BUDGET);

export function _resetToolCacheForTesting(): void {
  sf = new Singleflight<ShapedFetchResult<unknown>>();
  budget = new DailyBudget(process.env.CIVIC_AWARENESS_DAILY_BUDGET);
}
```

Inside the singleflight callback, before `runInTransaction`:

```ts
const b = budget.check(key.source);
if (!b.allowed) {
  throw new Error(`Daily budget for ${key.source} exhausted`);
}
```

After the transaction commits successfully:

```ts
budget.record(key.source);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/core/tool_cache.test.ts -t "daily budget"`

Expected: PASS.

Full file: `pnpm test tests/unit/core/tool_cache.test.ts`

Expected: all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/core/tool_cache.ts tests/unit/core/tool_cache.test.ts
git commit -m "feat(core): withShapedFetch daily-budget safety rail

Per-source daily cap checked before the upstream fetch;
successful transactions call budget.record(). Exhausted budget
throws; Task 10 adds stale-cached-fallback on top.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: `withShapedFetch` — upstream-failure stale fallback

**Files:**
- Modify: `src/core/tool_cache.ts`
- Modify: `tests/unit/core/tool_cache.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/core/tool_cache.test.ts`:

```ts
describe("withShapedFetch — stale fallback", () => {
  it("returns stale cached value + stale_notice when upstream fails", async () => {
    const args = { name: "expired" };
    const hash = hashArgs("__test__", args);
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: hash,
      scope: "full",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 3,
    });

    const fetchAndWrite = vi.fn(async () => {
      throw new Error("network down");
    });
    const readLocal = vi.fn(() => ["stale-but-useful"]);

    const result = await withShapedFetch(
      db,
      { source: "openstates", endpoint_path: "/people", args, tool: "__test__" },
      { scope: "full", ms: 24 * 60 * 60 * 1000 },
      fetchAndWrite,
      readLocal,
      () => 0,
    );

    expect(fetchAndWrite).toHaveBeenCalledOnce();
    expect(readLocal).toHaveBeenCalledOnce();
    expect(result.value).toEqual(["stale-but-useful"]);
    expect(result.stale_notice).toBeDefined();
    expect(result.stale_notice?.reason).toBe("upstream_failure");
    expect(result.stale_notice?.message).toMatch(/network down/);
  });

  it("propagates upstream error when no cached data exists", async () => {
    const fetchAndWrite = vi.fn(async () => {
      throw new Error("network down");
    });
    const readLocal = vi.fn(() => [] as string[]);

    await expect(
      withShapedFetch(
        db,
        { source: "openstates", endpoint_path: "/people", args: { name: "cold" }, tool: "__test__" },
        { scope: "full", ms: 24 * 60 * 60 * 1000 },
        fetchAndWrite,
        readLocal,
        () => 0,
      ),
    ).rejects.toThrow(/network down/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/core/tool_cache.test.ts -t "stale fallback"`

Expected: FAIL — first test throws instead of returning stale.

- [ ] **Step 3: Implement stale fallback**

Modify `src/core/tool_cache.ts`. Import `getFetchLog`. Inside the
singleflight callback, wrap `runInTransaction` in a try/catch. On
catch, if a prior `fetch_log` row exists, return `readLocal()` +
`stale_notice`; else re-throw:

```ts
import { getFetchLog, upsertFetchLog } from "./fetch_log.js";

// Inside the singleflight block, after the budget check:

try {
  const { primary_rows_written } = await runInTransaction(db, async () => {
    const result = await _fetchAndWrite();
    upsertFetchLog(db, {
      source: key.source,
      endpoint_path: key.endpoint_path,
      args_hash,
      scope: ttl.scope,
      fetched_at: new Date().toISOString(),
      last_rowcount: result.primary_rows_written,
    });
    return result;
  });
  budget.record(key.source);
  void primary_rows_written;
  return { value: readLocal() } as ShapedFetchResult<unknown>;
} catch (err) {
  const prior = getFetchLog(db, key.source, key.endpoint_path, args_hash);
  if (prior) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      value: readLocal(),
      stale_notice: {
        as_of: prior.fetched_at,
        reason: "upstream_failure",
        message: `Upstream ${key.source} fetch failed; serving stale cached data. ${msg}`,
      },
    } as ShapedFetchResult<unknown>;
  }
  throw err;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/core/tool_cache.test.ts -t "stale fallback"`

Expected: PASS — both tests green.

Run entire test suite to confirm no regressions:
`pnpm test`

Expected: all tests pass (phase-8a is fully additive).

- [ ] **Step 5: Commit**

```bash
git add src/core/tool_cache.ts tests/unit/core/tool_cache.test.ts
git commit -m "feat(core): withShapedFetch upstream-failure stale fallback

On fetchAndWrite throw with a prior fetch_log row present,
return readLocal() plus a stale_notice{reason: upstream_failure}.
Cold failure with no cached data propagates the error.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: `withShapedFetch` — rate-limit peek-wait gate

**Files:**
- Modify: `src/core/tool_cache.ts`
- Modify: `tests/unit/core/tool_cache.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/core/tool_cache.test.ts`:

```ts
describe("withShapedFetch — rate-limit peek", () => {
  it("throws when peek wait exceeds 2.5s threshold and no cached data", async () => {
    const fetchAndWrite = vi.fn(async () => ({ primary_rows_written: 1 }));
    const readLocal = vi.fn(() => [] as string[]);

    await expect(
      withShapedFetch(
        db,
        { source: "openstates", endpoint_path: "/people", args: { name: "rl" }, tool: "__test__" },
        { scope: "full", ms: 24 * 60 * 60 * 1000 },
        fetchAndWrite,
        readLocal,
        () => 5000, // 5s wait — above threshold
      ),
    ).rejects.toThrow(/rate.?limit/i);

    expect(fetchAndWrite).not.toHaveBeenCalled();
  });

  it("returns stale cached value when peek wait exceeds threshold", async () => {
    const args = { name: "rl-with-cache" };
    const hash = hashArgs("__test__", args);
    upsertFetchLog(db, {
      source: "openstates",
      endpoint_path: "/people",
      args_hash: hash,
      scope: "full",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 2,
    });

    const fetchAndWrite = vi.fn(async () => ({ primary_rows_written: 1 }));
    const readLocal = vi.fn(() => ["stale-ok"]);

    const result = await withShapedFetch(
      db,
      { source: "openstates", endpoint_path: "/people", args, tool: "__test__" },
      { scope: "full", ms: 24 * 60 * 60 * 1000 },
      fetchAndWrite,
      readLocal,
      () => 5000,
    );

    expect(fetchAndWrite).not.toHaveBeenCalled();
    expect(result.value).toEqual(["stale-ok"]);
    expect(result.stale_notice?.reason).toBe("upstream_failure");
    expect(result.stale_notice?.message).toMatch(/rate.?limit/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/core/tool_cache.test.ts -t "rate-limit peek"`

Expected: FAIL — no rate-limit gate exists; fetchAndWrite gets called.

- [ ] **Step 3: Implement the peek-wait gate**

In `src/core/tool_cache.ts`, after the budget check and before
`runInTransaction`, add a peek-wait check. Threshold matches the
existing `RATE_LIMIT_WAIT_THRESHOLD_MS` in `src/util/http.ts`.

```ts
import { RATE_LIMIT_WAIT_THRESHOLD_MS } from "../util/http.js";

// Inside the singleflight block, after the budget check:

const waitMs = _peekWaitMs();
if (waitMs > RATE_LIMIT_WAIT_THRESHOLD_MS) {
  throw new Error(
    `Rate limit for ${key.source} requires ${Math.ceil(waitMs / 1000)}s wait`,
  );
}
```

The existing stale-fallback catch block from Task 10 handles this
throw uniformly — returning cached data with `stale_notice` if any
exists, else propagating.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/core/tool_cache.test.ts -t "rate-limit peek"`

Expected: PASS — both tests green.

Full suite: `pnpm test`

Expected: all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/core/tool_cache.ts tests/unit/core/tool_cache.test.ts
git commit -m "feat(core): withShapedFetch rate-limit peek-wait gate

Before starting the transaction, peek the rate-limiter wait time.
If it exceeds RATE_LIMIT_WAIT_THRESHOLD_MS (2.5s), throw — the
stale-fallback catch returns cached data + stale_notice if any,
else propagates. Tools pass their source's RateLimiter.peekWaitMs
as the gate.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Acceptance check

After all 11 tasks commit, verify the whole phase-8a artifact:

- [ ] Run `pnpm test` — all tests green, no regressions.
- [ ] Run `pnpm build` — TypeScript compiles cleanly.
- [ ] Run `sqlite3 ./data/civic-awareness.db ".schema fetch_log"` on a bootstrapped DB — table exists with the R15 schema.
- [ ] Grep for `ensureFresh` — 9 tool handlers still call it (unchanged from before phase-8a).
- [ ] Grep for `withShapedFetch` — only `src/core/tool_cache.ts` and its test file; no tool handler uses it yet.

Phase 8a is complete when all five hold. Phase 8.2's docs shipped
as Tasks 1+2; phase 8b's first vertical (`recent_bills`) follows
in a new plan doc after 8a merges.

---

## Implementation notes (added 2026-04-14 post-execution)

Three scope expansions surfaced during implementation and were
folded into the relevant tasks:

1. **Task 3 — migration registry.** The plan assumed migrations
   apply via lexical directory scan; in reality `src/core/store.ts`
   uses an explicit `MIGRATIONS` array. Task 3 extended to include
   the version-5 registration and a bump to the count assertion in
   `tests/unit/core/store.test.ts`.

2. **Task 4 — cascade-drop for empty nested objects.** The plan's
   reference canonicalizer left `{a: {b: ""}}` as `{a: {}}`, which
   would fragment the cache against the semantically-equivalent
   `{}`. A follow-up commit (`27dc936`) moved the empty-string drop
   from the string branch to the object walker and added cascade
   logic so empty objects also drop. Arrays retain position
   semantics (empty strings preserved in arrays).

3. **Task 8 — transaction mutex.** better-sqlite3 permits at most
   one active transaction per connection. Singleflight coalesces
   concurrent identical calls, but concurrent calls with DIFFERENT
   keys both enter `runInTransaction` and the second's
   `BEGIN IMMEDIATE` throws. Task 8's `runInTransaction` now
   serializes transactions through a module-level `txMutex`
   (`Promise<void>` chain). The mutex is reset by
   `_resetToolCacheForTesting` alongside `sf` and `budget`.

All three additions shipped inside their nominal tasks (not as
separate commits) and are exercised by the unit tests. Recorded
here for future subagents who compare the plan against the final
artifact.

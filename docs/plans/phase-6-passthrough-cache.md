# Phase 6 — Transparent Pass-Through Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Flip the MCP from "explicit refresh" to "ask and receive."
Read tools transparently pass through to upstream APIs with the
local SQLite store acting as a TTL cache. Remove `refresh_source`
from the MCP tool surface. On upstream failure, serve stale local
data with a `stale_notice` field. Entity tools auto-hydrate their
jurisdiction on demand. CLI `pnpm refresh` retained for ops.

**Architecture:**
- New `hydrations` table tracks freshness per
  `(source, jurisdiction, scope)` where `scope ∈ {"recent","full"}`.
- New `src/core/freshness.ts` exposes TTL helpers (1h recent / 24h
  full) and `markFresh` / `getFreshness` functions.
- New `src/core/singleflight.ts` coalesces concurrent hydrates on
  the same key to one in-flight promise.
- New `src/core/budget.ts` tracks in-session request counts per
  source against a daily budget env var
  (`CIVIC_AWARENESS_DAILY_BUDGET`).
- New `src/core/hydrate.ts` orchestrates pass-through: pre-checks
  freshness + budget + rate-limit wait, calls `refreshSource()`
  with narrower options, handles deadline/failure, marks freshness.
- Existing adapters gain an optional `deadline?: number` (epoch ms)
  parameter — checked between pages.
- Existing read-tool handlers are wrapped: before `queryDocuments`,
  call `hydrate.ensureFresh()`. On hydrate failure, attach a
  `stale_notice` and serve whatever local data exists.
- `src/mcp/tools/refresh_source.ts` and its registration in
  `src/mcp/server.ts` are deleted (CLI path via
  `src/core/refresh.ts` untouched).

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`,
`better-sqlite3`, `vitest` with `msw`.

**Scope-level decision impact:** Adds R13 to
`docs/00-rationale.md` and a second amendment to D5 in
`docs/06-open-decisions.md` (both executed in Task 1, ahead of any
code). Supersedes the refresh-as-a-tool portion of
`docs/plans/phase-5-onboarding-and-refresh-tool.md` (auto-bootstrap
portion retained as shipped).

---

## File structure produced by this phase

```
docs/
├── 00-rationale.md                              (modified: R13 inserted)
├── 06-open-decisions.md                         (modified: D5 second amendment)
├── 05-tool-surface.md                           (modified: drop refresh_source)
├── 02-architecture.md                           (modified: pass-through section)
└── plans/
    └── phase-5-onboarding-and-refresh-tool.md   (modified: supersede banner)
CLAUDE.md                                        (modified: D5 bullet + mental model)
src/
├── core/
│   ├── migrations/
│   │   └── 004-hydrations-table.sql             ← Task 2 (new)
│   ├── store.ts                                 (modified in Task 2)
│   ├── freshness.ts                             ← Task 3 (new)
│   ├── singleflight.ts                          ← Task 4 (new)
│   ├── budget.ts                                ← Task 5 (new)
│   └── hydrate.ts                               ← Task 9 (new)
├── util/
│   └── http.ts                                  (modified in Task 7)
├── adapters/
│   ├── openstates.ts                            (modified in Task 6)
│   ├── congress.ts                              (modified in Task 6)
│   └── openfec.ts                               (modified in Task 6)
├── mcp/
│   ├── shared.ts                                (modified in Tasks 8 + 15)
│   ├── server.ts                                (modified in Task 16)
│   └── tools/
│       ├── recent_bills.ts                      (modified in Task 10)
│       ├── recent_votes.ts                      (modified in Task 11)
│       ├── recent_contributions.ts              (modified in Task 12)
│       ├── search_civic_documents.ts            (modified in Task 13)
│       ├── search_entities.ts                   (modified in Task 14)
│       ├── get_entity.ts                        (modified in Task 14)
│       ├── entity_connections.ts                (modified in Task 14)
│       ├── resolve_person.ts                    (modified in Task 14)
│       └── refresh_source.ts                    ← DELETED in Task 16
tests/
├── unit/
│   ├── core/
│   │   ├── freshness.test.ts                    ← Task 3
│   │   ├── singleflight.test.ts                 ← Task 4
│   │   ├── budget.test.ts                       ← Task 5
│   │   └── hydrate.test.ts                      ← Task 9
│   ├── util/
│   │   └── http.test.ts                         (modified in Task 7)
│   └── mcp/
│       └── tools/
│           └── refresh_source.test.ts           ← DELETED in Task 16
└── integration/
    └── passthrough-e2e.test.ts                  ← Task 17 (new)
package.json                                     (modified in Task 18: v0.2.0)
CHANGELOG.md                                     (modified in Task 18)
```

---

## Prerequisites

- Phase 5 (Connections & Resolution) complete and shipped (v0.1.0).
- `pnpm test` green on `main` at HEAD.
- `OPENSTATES_API_KEY` and `API_DATA_GOV_KEY` available in
  `.env.local` for integration tests (also in repo Actions secrets
  for nightly drift).

---

## Task 1: Decision records + CLAUDE.md + doc cascades

**Files:**
- Modify: `docs/00-rationale.md` — R13 (already inserted in
  prep; this task verifies and commits)
- Modify: `docs/06-open-decisions.md` — D5 second amendment
  (already inserted in prep; this task verifies and commits)
- Modify: `CLAUDE.md` — D5 bullet, mental-model bullet, caching bullet
  (already applied in prep; this task verifies and commits)
- Modify: `docs/plans/phase-5-onboarding-and-refresh-tool.md` —
  supersede banner (already applied in prep)
- Modify: `docs/05-tool-surface.md` — remove the `refresh_source`
  section; add a "Pass-through cache" section describing the
  TTL model and `stale_notice` shape
- Modify: `docs/02-architecture.md` — short section on the
  pass-through layer between tool handlers and the store

- [ ] **Step 1.1: Verify R13, D5 second amendment, CLAUDE.md,
      supersede banner are present**

Run:
```bash
grep -c "R13 — Transparent pass-through" docs/00-rationale.md
grep -c "Amended 2026-04-13 (second amendment)" docs/06-open-decisions.md
grep -c "D5 → R13" CLAUDE.md
grep -c "STATUS: PARTIALLY SUPERSEDED" docs/plans/phase-5-onboarding-and-refresh-tool.md
```
Expected: each prints `1`.

- [ ] **Step 1.2: Edit `docs/05-tool-surface.md` — remove
      `refresh_source` and add pass-through section**

Find the `refresh_source` tool section (Phase 5 addition). Replace
with:

```markdown
## Pass-through cache (R13)

Read tools transparently hydrate their jurisdiction from upstream
on cache miss. The SQLite store is a TTL cache, not a user concern.

- `scope="recent"` (feed pulls): TTL = 1h
- `scope="full"` (entity hydration): TTL = 24h
- Keyed per `(source, jurisdiction, scope)` in the `hydrations` table

On upstream failure, rate-limit wait > 2.5s, or daily-budget
exhaustion, tools serve stale local data with a `stale_notice`
sibling field on the response:

```json
{
  "results": [...],
  "stale_notice": {
    "as_of": "2026-04-12T14:30:00Z",
    "reason": "upstream_failure" | "rate_limited" | "partial_hydrate" | "daily_budget_exhausted",
    "message": "Human-readable one-line summary.",
    "retry_after_s": 60,
    "completeness": "active_session_only"
  }
}
```

`refresh_source` is not an MCP tool. The `pnpm refresh` CLI is
retained for operator use (cron, bulk seeding, historical backfill).
```

- [ ] **Step 1.3: Edit `docs/02-architecture.md` — add pass-through
      layer description**

Near the existing "Two design decisions to call out" section (or
wherever the read/write flow is documented), add:

```markdown
### Pass-through hydration (R13)

Read tool handlers do not query the store directly. They call
`src/core/hydrate.ts#ensureFresh(db, source, jurisdiction, scope)`
first. That function:
1. Checks `hydrations(source, jurisdiction, scope)` TTL.
2. If fresh → returns immediately; handler queries local.
3. If stale/missing → acquires singleflight lock; checks daily
   budget; checks rate-limit-wait threshold (2.5s); if all clear,
   calls a scoped `refreshSource()` (narrow window for `recent`,
   bounded pull for `full` with 20s deadline + partial fallback).
   Marks freshness. Releases lock.
4. On any failure (upstream 5xx, rate-limit exceeded, budget
   exhausted, deadline fired) → returns a `StaleNotice`; handler
   attaches it to the response and serves whatever local data
   matches.

Writes remain batch-normalized (same code path as the CLI) so
entity resolution produces the same graph regardless of trigger.
```

- [ ] **Step 1.4: Run docs sanity checks**

Run:
```bash
grep -rn "refresh_source" docs/ | grep -v "\.md.bak"
```
Expected: only historical references in R12, in `phase-5-onboarding-
and-refresh-tool.md`, and in the CHANGELOG (which will be updated in
Task 18). No remaining live references in `docs/05-tool-surface.md`
or `docs/02-architecture.md`.

- [ ] **Step 1.5: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: R13 + D5 second amendment + phase-6 plan activation

Adds R13 (transparent pass-through cache), second D5 amendment,
CLAUDE.md pass-through bullets, tool-surface + architecture updates,
and supersede banner on the old refresh-as-a-tool plan. No code
changes in this commit.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Migration 004 — `hydrations` table

**Files:**
- Create: `src/core/migrations/004-hydrations-table.sql`
- Modify: `src/core/store.ts` (append migration 4 to `MIGRATIONS`)
- Test: `tests/unit/core/store.test.ts` (add migration-applied case
  if a store test file exists; otherwise skip test — migration is
  exercised transitively in later tasks)

- [ ] **Step 2.1: Write the migration SQL**

Create `src/core/migrations/004-hydrations-table.sql`:

```sql
CREATE TABLE IF NOT EXISTS hydrations (
  source TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('recent', 'full')),
  last_fetched_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial')),
  PRIMARY KEY (source, jurisdiction, scope)
);

CREATE INDEX IF NOT EXISTS idx_hydrations_source_last
  ON hydrations(source, last_fetched_at);
```

- [ ] **Step 2.2: Register migration 4 in `src/core/store.ts`**

Edit the `MIGRATIONS` array:

```ts
const MIGRATIONS = [
  { version: 1, file: "001-init.sql" },
  { version: 2, file: "002-normalize-occurred-at.sql" },
  { version: 3, file: "003-occurred-at-from-actions.sql" },
  { version: 4, file: "004-hydrations-table.sql" },
] as const;
```

- [ ] **Step 2.3: Run the test suite — migration auto-applies**

Run: `pnpm test`
Expected: all existing tests pass (they call `openStore()` which
now applies migration 4 on an empty DB).

- [ ] **Step 2.4: Commit**

```bash
git add src/core/migrations/004-hydrations-table.sql src/core/store.ts
git commit -m "$(cat <<'EOF'
feat: 004 hydrations table for TTL cache freshness

Tracks (source, jurisdiction, scope) → last_fetched_at + status.
Consumed by src/core/freshness.ts in the next task.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `src/core/freshness.ts` — TTL helpers

**Files:**
- Create: `src/core/freshness.ts`
- Test: `tests/unit/core/freshness.test.ts`

- [ ] **Step 3.1: Write failing tests**

Create `tests/unit/core/freshness.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openStore } from "../../../src/core/store.js";
import {
  getFreshness,
  markFresh,
  isFresh,
  TTL_RECENT_MS,
  TTL_FULL_MS,
  type HydrationScope,
} from "../../../src/core/freshness.js";

let db: Database.Database;

beforeEach(() => {
  const store = openStore(":memory:");
  db = store.db;
});

describe("freshness", () => {
  it("returns null for unseen key", () => {
    const r = getFreshness(db, "openstates", "us-tx", "recent");
    expect(r).toBeNull();
  });

  it("markFresh → getFreshness round trip, status complete", () => {
    markFresh(db, "openstates", "us-tx", "recent", "complete");
    const r = getFreshness(db, "openstates", "us-tx", "recent");
    expect(r).toMatchObject({ status: "complete" });
    expect(r!.last_fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("isFresh true within TTL", () => {
    markFresh(db, "openstates", "us-tx", "recent", "complete");
    expect(isFresh(db, "openstates", "us-tx", "recent")).toBe(true);
  });

  it("isFresh false past TTL (recent=1h)", () => {
    const past = new Date(Date.now() - TTL_RECENT_MS - 1000).toISOString();
    db.prepare(
      "INSERT INTO hydrations (source, jurisdiction, scope, last_fetched_at, status) VALUES (?,?,?,?,?)",
    ).run("openstates", "us-tx", "recent", past, "complete");
    expect(isFresh(db, "openstates", "us-tx", "recent")).toBe(false);
  });

  it("isFresh false past TTL (full=24h)", () => {
    const past = new Date(Date.now() - TTL_FULL_MS - 1000).toISOString();
    db.prepare(
      "INSERT INTO hydrations (source, jurisdiction, scope, last_fetched_at, status) VALUES (?,?,?,?,?)",
    ).run("openstates", "us-tx", "full", past, "complete");
    expect(isFresh(db, "openstates", "us-tx", "full")).toBe(false);
  });

  it("markFresh overwrites prior row (upsert)", () => {
    markFresh(db, "openstates", "us-tx", "full", "partial");
    markFresh(db, "openstates", "us-tx", "full", "complete");
    const r = getFreshness(db, "openstates", "us-tx", "full");
    expect(r!.status).toBe("complete");
  });
});
```

Run: `pnpm test tests/unit/core/freshness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3.2: Implement `src/core/freshness.ts`**

```ts
import type Database from "better-sqlite3";

export type HydrationScope = "recent" | "full";
export type HydrationStatus = "complete" | "partial";
export type HydrationSource = "openstates" | "congress" | "openfec";

export const TTL_RECENT_MS = 60 * 60 * 1000;
export const TTL_FULL_MS = 24 * 60 * 60 * 1000;

export interface FreshnessRecord {
  source: HydrationSource;
  jurisdiction: string;
  scope: HydrationScope;
  last_fetched_at: string;
  status: HydrationStatus;
}

export function getFreshness(
  db: Database.Database,
  source: HydrationSource,
  jurisdiction: string,
  scope: HydrationScope,
): FreshnessRecord | null {
  const row = db
    .prepare(
      `SELECT source, jurisdiction, scope, last_fetched_at, status
         FROM hydrations
         WHERE source = ? AND jurisdiction = ? AND scope = ?`,
    )
    .get(source, jurisdiction, scope) as FreshnessRecord | undefined;
  return row ?? null;
}

export function markFresh(
  db: Database.Database,
  source: HydrationSource,
  jurisdiction: string,
  scope: HydrationScope,
  status: HydrationStatus,
): void {
  db.prepare(
    `INSERT INTO hydrations (source, jurisdiction, scope, last_fetched_at, status)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source, jurisdiction, scope) DO UPDATE SET
         last_fetched_at = excluded.last_fetched_at,
         status = excluded.status`,
  ).run(source, jurisdiction, scope, new Date().toISOString(), status);
}

export function isFresh(
  db: Database.Database,
  source: HydrationSource,
  jurisdiction: string,
  scope: HydrationScope,
): boolean {
  const rec = getFreshness(db, source, jurisdiction, scope);
  if (!rec) return false;
  const ageMs = Date.now() - new Date(rec.last_fetched_at).getTime();
  const ttl = scope === "recent" ? TTL_RECENT_MS : TTL_FULL_MS;
  return ageMs < ttl;
}
```

- [ ] **Step 3.3: Run tests**

Run: `pnpm test tests/unit/core/freshness.test.ts`
Expected: all tests pass.

- [ ] **Step 3.4: Commit**

```bash
git add src/core/freshness.ts tests/unit/core/freshness.test.ts
git commit -m "$(cat <<'EOF'
feat: freshness helpers with 1h recent / 24h full TTLs

Reads/writes hydrations table keyed by (source, jurisdiction, scope).
Partial vs complete status tracked separately for deadline-fired
entity hydrations.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `src/core/singleflight.ts` — coalescing mutex

**Files:**
- Create: `src/core/singleflight.ts`
- Test: `tests/unit/core/singleflight.test.ts`

Singleflight: when multiple concurrent calls target the same key,
exactly one executes the underlying operation; the rest share its
promise.

- [ ] **Step 4.1: Write failing tests**

Create `tests/unit/core/singleflight.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Singleflight } from "../../../src/core/singleflight.js";

describe("Singleflight", () => {
  it("coalesces concurrent calls on same key", async () => {
    const sf = new Singleflight<string>();
    let runs = 0;
    const fn = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 10));
      return "ok";
    };
    const [a, b, c] = await Promise.all([
      sf.do("k", fn),
      sf.do("k", fn),
      sf.do("k", fn),
    ]);
    expect(runs).toBe(1);
    expect(a).toBe("ok");
    expect(b).toBe("ok");
    expect(c).toBe("ok");
  });

  it("runs separately for different keys", async () => {
    const sf = new Singleflight<string>();
    let runs = 0;
    const fn = async () => {
      runs += 1;
      return "ok";
    };
    await Promise.all([sf.do("k1", fn), sf.do("k2", fn)]);
    expect(runs).toBe(2);
  });

  it("releases key after completion (new call triggers new run)", async () => {
    const sf = new Singleflight<number>();
    let runs = 0;
    const fn = async () => {
      runs += 1;
      return runs;
    };
    await sf.do("k", fn);
    await sf.do("k", fn);
    expect(runs).toBe(2);
  });

  it("propagates errors and releases key", async () => {
    const sf = new Singleflight<number>();
    await expect(sf.do("k", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    // next call on same key should run fresh
    const r = await sf.do("k", async () => 42);
    expect(r).toBe(42);
  });
});
```

Run: `pnpm test tests/unit/core/singleflight.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4.2: Implement `src/core/singleflight.ts`**

```ts
export class Singleflight<T> {
  private inflight = new Map<string, Promise<T>>();

  async do(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      try {
        return await fn();
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
```

- [ ] **Step 4.3: Run tests**

Run: `pnpm test tests/unit/core/singleflight.test.ts`
Expected: all tests pass.

- [ ] **Step 4.4: Commit**

```bash
git add src/core/singleflight.ts tests/unit/core/singleflight.test.ts
git commit -m "$(cat <<'EOF'
feat: singleflight mutex for hydration coalescing

Concurrent hydrate calls on the same (source, jurisdiction, scope)
key share one promise. Without this, two parallel entity-tool calls
on us-tx would double the rate-limit cost.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `src/core/budget.ts` — daily budget guard

**Files:**
- Create: `src/core/budget.ts`
- Test: `tests/unit/core/budget.test.ts`

Tracks in-process request counts per source against an env-var
budget. Resets at UTC midnight.

- [ ] **Step 5.1: Write failing tests**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DailyBudget } from "../../../src/core/budget.js";

describe("DailyBudget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));
  });

  it("parses env var format", () => {
    const b = new DailyBudget("openstates=450,congress=4500,openfec=900");
    expect(b.remaining("openstates")).toBe(450);
    expect(b.remaining("congress")).toBe(4500);
    expect(b.remaining("openfec")).toBe(900);
  });

  it("check + record decrements remaining", () => {
    const b = new DailyBudget("openstates=10");
    expect(b.check("openstates").allowed).toBe(true);
    b.record("openstates");
    expect(b.remaining("openstates")).toBe(9);
  });

  it("check returns allowed=false when exhausted", () => {
    const b = new DailyBudget("openstates=2");
    b.record("openstates");
    b.record("openstates");
    expect(b.check("openstates").allowed).toBe(false);
  });

  it("resets at UTC day boundary", () => {
    const b = new DailyBudget("openstates=5");
    b.record("openstates");
    b.record("openstates");
    expect(b.remaining("openstates")).toBe(3);
    vi.setSystemTime(new Date("2026-04-14T00:00:01Z"));
    expect(b.remaining("openstates")).toBe(5);
  });

  it("unlimited when env unset", () => {
    const b = new DailyBudget(undefined);
    expect(b.check("openstates").allowed).toBe(true);
    expect(b.remaining("openstates")).toBe(Number.POSITIVE_INFINITY);
  });
});
```

Run: `pnpm test tests/unit/core/budget.test.ts`
Expected: FAIL.

- [ ] **Step 5.2: Implement `src/core/budget.ts`**

```ts
import type { HydrationSource } from "./freshness.js";

export interface BudgetCheck {
  allowed: boolean;
  remaining: number;
}

export class DailyBudget {
  private limits: Map<string, number>;
  private used: Map<string, number>;
  private dayKey: string;

  constructor(envValue: string | undefined) {
    this.limits = new Map();
    this.used = new Map();
    this.dayKey = DailyBudget.dayKeyNow();
    if (!envValue) return;
    for (const pair of envValue.split(",")) {
      const [k, v] = pair.split("=").map((s) => s.trim());
      if (!k || !v) continue;
      const n = Number(v);
      if (Number.isFinite(n)) this.limits.set(k, n);
    }
  }

  check(source: HydrationSource): BudgetCheck {
    this.rollIfNewDay();
    const limit = this.limits.get(source);
    if (limit === undefined) return { allowed: true, remaining: Number.POSITIVE_INFINITY };
    const used = this.used.get(source) ?? 0;
    const remaining = Math.max(0, limit - used);
    return { allowed: remaining > 0, remaining };
  }

  record(source: HydrationSource): void {
    this.rollIfNewDay();
    this.used.set(source, (this.used.get(source) ?? 0) + 1);
  }

  remaining(source: HydrationSource): number {
    return this.check(source).remaining;
  }

  private rollIfNewDay(): void {
    const now = DailyBudget.dayKeyNow();
    if (now !== this.dayKey) {
      this.dayKey = now;
      this.used.clear();
    }
  }

  private static dayKeyNow(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
```

- [ ] **Step 5.3: Run tests**

Run: `pnpm test tests/unit/core/budget.test.ts`
Expected: all pass.

- [ ] **Step 5.4: Commit**

```bash
git add src/core/budget.ts tests/unit/core/budget.test.ts
git commit -m "$(cat <<'EOF'
feat: daily budget guard per source

Caps in-session request counts below upstream hard limits. Configured
via CIVIC_AWARENESS_DAILY_BUDGET env (e.g.,
"openstates=450,congress=4500,openfec=900"). Unset = unlimited.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Adapter deadline support

**Files:**
- Modify: `src/adapters/openstates.ts`
- Modify: `src/adapters/congress.ts`
- Modify: `src/adapters/openfec.ts`
- Test: existing adapter tests continue to pass; add one test per
  adapter verifying deadline-check behavior

The `refresh()` method on each adapter accepts an optional
`deadline?: number` (epoch ms). Before beginning each page fetch,
adapters check `Date.now() < deadline`; if expired, they stop
looping and return what they have so far. This lets the hydrator
enforce a wall-clock cap on entity `hydrateFull`.

- [ ] **Step 6.1: Extend each adapter's refresh options type**

For each adapter, add `deadline?: number` to the options interface
(exact name varies — look in `src/adapters/base.ts` or the adapter
itself). Example pattern (openstates):

```ts
export interface OpenStatesRefreshOptions {
  db: Database.Database;
  maxPages?: number;
  jurisdiction?: string;
  deadline?: number;  // epoch ms; stop looping when Date.now() >= deadline
}
```

Inside the refresh loop (typically `while (nextUrl && page < maxPages)`),
add:

```ts
if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
  break;
}
```

Immediately *before* each page fetch (after the pagination check).

Apply the same pattern to `congress.ts` and `openfec.ts`.

- [ ] **Step 6.2: Add deadline tests**

Example test for openstates (adapt paths as needed):

```ts
it("refresh stops at deadline", async () => {
  // msw handler that returns multi-page data with delay
  // ... setup to ensure the second page would be fetched normally ...
  const past = Date.now() - 1; // already expired
  const r = await adapter.refresh({ db, maxPages: 5, jurisdiction: "tx", deadline: past });
  // expect the loop to have exited before any fetch
  expect(r.documentsUpserted).toBe(0);
});
```

Write similar deadline tests in `tests/unit/adapters/congress.test.ts`
and `tests/unit/adapters/openfec.test.ts`.

Run: `pnpm test tests/unit/adapters/`
Expected: new deadline tests pass; existing tests still pass.

- [ ] **Step 6.3: Commit**

```bash
git add src/adapters/ tests/unit/adapters/
git commit -m "$(cat <<'EOF'
feat: adapter deadline support for wall-clock bounded hydration

Adapters now accept deadline?: number (epoch ms). Loop exits before
each page fetch when now >= deadline. Used by hydrateFull to enforce
20s cap on entity hydration.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Rate-limit peek + 2.5s threshold

**Files:**
- Modify: `src/util/http.ts`
- Test: `tests/unit/util/http.test.ts` (if exists; otherwise add
  targeted tests)

The RateLimiter needs a `peekWaitMs()` method that reports the
required wait time without consuming a token. The hydrator uses
this to short-circuit: if `peekWaitMs() > 2500`, abort and serve
stale.

- [ ] **Step 7.1: Write failing test**

Add to `tests/unit/util/http.test.ts` (or create it):

```ts
import { describe, it, expect } from "vitest";
import { RateLimiter, RATE_LIMIT_WAIT_THRESHOLD_MS } from "../../../src/util/http.js";

describe("RateLimiter.peekWaitMs", () => {
  it("returns 0 when tokens available", () => {
    const r = new RateLimiter({ tokensPerInterval: 2, intervalMs: 1000 });
    expect(r.peekWaitMs()).toBe(0);
  });

  it("returns positive wait when depleted", async () => {
    const r = new RateLimiter({ tokensPerInterval: 1, intervalMs: 1000 });
    await r.acquire(); // consume the one token
    const w = r.peekWaitMs();
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThanOrEqual(1000);
  });

  it("peek does not consume a token", async () => {
    const r = new RateLimiter({ tokensPerInterval: 2, intervalMs: 1000 });
    r.peekWaitMs();
    r.peekWaitMs();
    // two calls shouldn't deplete; we should still be able to acquire twice without wait
    const start = Date.now();
    await r.acquire();
    await r.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe("rate-limit threshold constant", () => {
  it("is 2500ms", () => {
    expect(RATE_LIMIT_WAIT_THRESHOLD_MS).toBe(2500);
  });
});
```

Run: `pnpm test tests/unit/util/http.test.ts`
Expected: FAIL — `peekWaitMs` / `RATE_LIMIT_WAIT_THRESHOLD_MS`
undefined.

- [ ] **Step 7.2: Implement**

Edit `src/util/http.ts`:

```ts
export const RATE_LIMIT_WAIT_THRESHOLD_MS = 2500;

export class RateLimiter {
  // ... existing fields ...

  peekWaitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    // Tokens refill at rate tokensPerInterval per intervalMs.
    // Time to next whole token:
    const msPerToken = this.opts.intervalMs / this.opts.tokensPerInterval;
    const tokensNeeded = 1 - this.tokens;
    return Math.ceil(tokensNeeded * msPerToken);
  }
}
```

Note: `this.tokens` is tracked as an integer in the current
implementation. If `peekWaitMs` needs fractional precision, refill
logic may need updating to match. Verify by running the test suite.

- [ ] **Step 7.3: Run tests**

Run: `pnpm test tests/unit/util/http.test.ts`
Expected: pass.

- [ ] **Step 7.4: Commit**

```bash
git add src/util/http.ts tests/unit/util/http.test.ts
git commit -m "$(cat <<'EOF'
feat: RateLimiter.peekWaitMs + 2.5s threshold constant

Hydrator uses peekWaitMs() to short-circuit when the per-host bucket
would require waiting > RATE_LIMIT_WAIT_THRESHOLD_MS (2500ms) to
proceed. Aborted hydrates serve stale local data with stale_notice.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `StaleNotice` type + sibling field on tool responses

**Files:**
- Modify: `src/mcp/shared.ts` — add `StaleNotice` type
- Modify: each tool response type (`RecentBillsResponse` etc.) to
  include optional `stale_notice?: StaleNotice` sibling field

- [ ] **Step 8.1: Define `StaleNotice` in shared.ts**

Append to `src/mcp/shared.ts`:

```ts
export type StaleReason =
  | "upstream_failure"
  | "rate_limited"
  | "partial_hydrate"
  | "daily_budget_exhausted";

export interface StaleNotice {
  as_of: string;
  reason: StaleReason;
  message: string;
  retry_after_s?: number;
  completeness?: string;
}
```

- [ ] **Step 8.2: Add optional `stale_notice?: StaleNotice` to each
      tool response interface**

Tool response files to update (add the field alongside existing
optional diagnostic fields):

- `src/mcp/tools/recent_bills.ts` → `RecentBillsResponse`
- `src/mcp/tools/recent_votes.ts` → `RecentVotesResponse`
- `src/mcp/tools/recent_contributions.ts` → `RecentContributionsResponse`
- `src/mcp/tools/search_civic_documents.ts` → response type
- `src/mcp/tools/search_entities.ts` → response type
- `src/mcp/tools/get_entity.ts` → response type
- `src/mcp/tools/entity_connections.ts` → response type
- `src/mcp/tools/resolve_person.ts` → response type

Add the field:
```ts
stale_notice?: StaleNotice;
```

Do not populate it yet — only declare the field so later tasks
have a type-safe slot.

- [ ] **Step 8.3: Compile + test**

Run: `pnpm build && pnpm test`
Expected: no new failures; types compile.

- [ ] **Step 8.4: Commit**

```bash
git add src/mcp/
git commit -m "$(cat <<'EOF'
feat: StaleNotice type + sibling field on all tool responses

Additive, backward compatible. Populated by the hydrator-wrapped
tool handlers in the next tasks.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `src/core/hydrate.ts` — pass-through orchestrator

**Files:**
- Create: `src/core/hydrate.ts`
- Test: `tests/unit/core/hydrate.test.ts`

This is the heart of the pivot. `ensureFresh` is called by each
read tool before querying. It checks freshness, runs the hydrate
if needed, and returns either `{ ok: true }` or
`{ ok: false, stale_notice: StaleNotice }`. The tool handler then
decides to proceed normally (on `ok`) or to attach the notice to
its response (on failure).

Source/jurisdiction mapping lives here:
- `sourcesFor(kind, jurisdiction)` — e.g., `("bill", "us-federal")`
  → `["congress"]`; `("bill", "us-tx")` → `["openstates"]`;
  `("contribution", "us-federal")` → `["openfec"]`.

- [ ] **Step 9.1: Write failing tests**

Create `tests/unit/core/hydrate.test.ts`. Tests should cover:

1. `ensureFresh` returns `ok` when freshness is fresh (no upstream
   call).
2. `ensureFresh` triggers refresh when stale; on success, marks
   fresh and returns `ok`.
3. `ensureFresh` on rate-limit peek > 2.5s → returns `stale_notice
   {reason:"rate_limited"}`.
4. `ensureFresh` on daily-budget exhaustion → returns
   `stale_notice{reason:"daily_budget_exhausted"}`.
5. `ensureFresh` on adapter failure (refreshSource throws) →
   returns `stale_notice{reason:"upstream_failure"}`.
6. `ensureFresh` with scope=full and deadline fire → marks
   `partial` in hydrations, returns `stale_notice{reason:
   "partial_hydrate"}`.
7. Concurrent `ensureFresh` calls on same `(source, jurisdiction,
   scope)` coalesce via singleflight (verified by a mock adapter
   that counts invocations).
8. `sourcesFor("bill", "us-federal")` → `["congress"]`,
   `sourcesFor("bill", "us-tx")` → `["openstates"]`,
   `sourcesFor("vote", "us-federal")` → `["congress"]`,
   `sourcesFor("contribution", "us-federal")` → `["openfec"]`.

Use msw to mock upstream responses and vi.mock to replace the
`refreshSource` function when testing failure paths.

Run: `pnpm test tests/unit/core/hydrate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 9.1.5: Add tagged `ConfigurationError` class**

The R13 decision calls for "hard error on missing API key" — i.e.,
missing env must NOT be converted to a graceful `stale_notice`.
Introduce a tagged error class so the hydrator can re-throw
configuration errors while still catching upstream errors.

Edit `src/util/env.ts` (or create it if absent):

```ts
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    throw new ConfigurationError(
      `Required environment variable ${key} is not set. ` +
      `See README for setup; this server cannot function without API keys.`,
    );
  }
  return v;
}
```

Verify: existing callers of `requireEnv` don't need changes; the
tagged subclass is `instanceof Error` so generic catches still work.
Hydrate's catch below re-throws `ConfigurationError` instances.

- [ ] **Step 9.2: Implement `src/core/hydrate.ts`**

```ts
import type Database from "better-sqlite3";
import type { DocumentKind } from "./types.js";
import {
  getFreshness,
  isFresh,
  markFresh,
  type HydrationScope,
  type HydrationSource,
} from "./freshness.js";
import { Singleflight } from "./singleflight.js";
import { DailyBudget } from "./budget.js";
import { RATE_LIMIT_WAIT_THRESHOLD_MS } from "../util/http.js";
import { refreshSource } from "./refresh.js";
import type { StaleNotice } from "../mcp/shared.js";
import { logger } from "../util/logger.js";
import { ConfigurationError } from "../util/env.js";

const FULL_HYDRATE_MAX_PAGES = 5;
const FULL_HYDRATE_DEADLINE_MS = 20_000;
const RECENT_HYDRATE_MAX_PAGES = 2;

const sf = new Singleflight<EnsureFreshResult>();
const budget = new DailyBudget(process.env.CIVIC_AWARENESS_DAILY_BUDGET);

export interface EnsureFreshResult {
  ok: boolean;
  stale_notice?: StaleNotice;
}

export function sourcesFor(
  kind: DocumentKind,
  jurisdiction: string,
): HydrationSource[] {
  if (jurisdiction === "*") return [];
  if (kind === "contribution") return ["openfec"];
  if (jurisdiction === "us-federal") return ["congress"];
  return ["openstates"];
}

export function sourcesForFullHydrate(jurisdiction: string): HydrationSource[] {
  if (jurisdiction === "*" || jurisdiction === undefined) return [];
  if (jurisdiction === "us-federal") return ["congress", "openfec"];
  return ["openstates"];
}

export async function ensureFresh(
  db: Database.Database,
  source: HydrationSource,
  jurisdiction: string,
  scope: HydrationScope,
  rateLimiterWaitMs: () => number,
): Promise<EnsureFreshResult> {
  if (isFresh(db, source, jurisdiction, scope)) return { ok: true };

  const key = `${source}:${jurisdiction}:${scope}`;
  return sf.do(key, async () => {
    // Re-check after acquiring singleflight (another caller may
    // have completed the hydrate while we waited).
    if (isFresh(db, source, jurisdiction, scope)) return { ok: true };

    const b = budget.check(source);
    if (!b.allowed) {
      return staleResult(db, source, jurisdiction, scope, {
        reason: "daily_budget_exhausted",
        message: `Daily request budget for ${source} exhausted; serving stale local data.`,
      });
    }

    const wait = rateLimiterWaitMs();
    if (wait > RATE_LIMIT_WAIT_THRESHOLD_MS) {
      return staleResult(db, source, jurisdiction, scope, {
        reason: "rate_limited",
        message: `Rate limit for ${source} requires ${Math.ceil(wait / 1000)}s wait; serving stale local data.`,
        retry_after_s: Math.ceil(wait / 1000),
      });
    }

    try {
      const deadline = scope === "full"
        ? Date.now() + FULL_HYDRATE_DEADLINE_MS
        : undefined;
      const maxPages = scope === "full"
        ? FULL_HYDRATE_MAX_PAGES
        : RECENT_HYDRATE_MAX_PAGES;

      const result = await refreshSource(db, {
        source,
        jurisdictions: jurisdictionArg(source, jurisdiction),
        maxPages,
        deadline,
      });
      budget.record(source);

      const partial = scope === "full" && deadline !== undefined && Date.now() >= deadline;
      markFresh(db, source, jurisdiction, scope, partial ? "partial" : "complete");

      if (partial) {
        return staleResult(db, source, jurisdiction, scope, {
          reason: "partial_hydrate",
          message: `Hydration for ${jurisdiction} exceeded the ${FULL_HYDRATE_DEADLINE_MS / 1000}s budget; partial data returned.`,
          completeness: "active_session_only",
        }, /*includeData*/ true);
      }
      return { ok: true };
    } catch (err) {
      // Configuration errors (missing env / API keys) must fail
      // hard per R13. Do not degrade to stale_notice.
      if (err instanceof ConfigurationError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("hydrate failed", { source, jurisdiction, scope, error: msg });
      return staleResult(db, source, jurisdiction, scope, {
        reason: "upstream_failure",
        message: `Upstream ${source} fetch failed; serving stale local data. ${msg}`,
      });
    }
  });
}

function jurisdictionArg(source: HydrationSource, jurisdiction: string): string[] | undefined {
  if (source !== "openstates") return undefined;
  return [jurisdiction.replace(/^us-/, "")];
}

function staleResult(
  db: Database.Database,
  source: HydrationSource,
  jurisdiction: string,
  scope: HydrationScope,
  noticeBase: Omit<StaleNotice, "as_of">,
  includeData = false,
): EnsureFreshResult {
  const existing = getFreshness(db, source, jurisdiction, scope);
  const as_of = existing?.last_fetched_at ?? new Date(0).toISOString();
  return {
    ok: includeData,
    stale_notice: { as_of, ...noticeBase },
  };
}
```

Notes:
- `refreshSource` needs a new `deadline` field in its options.
  Task 6 added deadline to adapters; also add it to
  `RefreshSourceOptions` in `src/core/refresh.ts` and pass it
  through to the adapter call. Update that as part of this task.
- The `rateLimiterWaitMs` callback is injected by the caller so the
  hydrator doesn't need to know which adapter's limiter to consult.
  Callers (tool handlers) look up the adapter's limiter and pass
  its `peekWaitMs` bound. See Task 10 for the wiring.

- [ ] **Step 9.3: Update `src/core/refresh.ts` to thread deadline**

Add `deadline?: number` to `RefreshSourceOptions`, and pass it
into each `adapter.refresh(...)` call.

- [ ] **Step 9.4: Run hydrate tests**

Run: `pnpm test tests/unit/core/hydrate.test.ts tests/unit/core/refresh.test.ts`
Expected: all pass.

- [ ] **Step 9.5: Commit**

```bash
git add src/core/hydrate.ts src/core/refresh.ts tests/unit/core/hydrate.test.ts
git commit -m "$(cat <<'EOF'
feat: pass-through hydration orchestrator

src/core/hydrate.ts wraps refreshSource with freshness, singleflight,
budget, rate-limit threshold, and deadline for scope=full. Returns
{ok:true} on success or {ok, stale_notice} on any failure path so
tool handlers can attach the notice to their response.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Wire hydration into `recent_bills`

**Files:**
- Modify: `src/mcp/tools/recent_bills.ts`
- Test: `tests/unit/mcp/tools/recent_bills.test.ts` (extend)

Each adapter needs to expose its rate limiter so the tool handler
can pass `peekWaitMs` into `ensureFresh`. Expose via a lightweight
registry or adapter singleton. Simplest: add a module-level map in
`src/core/hydrate.ts`:

```ts
// Lazy-init per source. Export from hydrate.ts.
const limiters: Partial<Record<HydrationSource, RateLimiter>> = {};
export function getLimiter(source: HydrationSource): RateLimiter {
  if (!limiters[source]) {
    limiters[source] = new RateLimiter(limiterConfigFor(source));
  }
  return limiters[source]!;
}
```

And update each adapter to accept an injected limiter in its
constructor, falling back to `getLimiter(source)` by default.

- [ ] **Step 10.1: Add limiter registry to hydrate.ts (or a new
      module `src/core/limiters.ts` if cleaner)**

Configure:
- openstates: `{ tokensPerInterval: 8, intervalMs: 60_000 }` (under
  the 10/min free-tier cap)
- congress: `{ tokensPerInterval: 80, intervalMs: 60_000 }` (under
  ~5000/hr)
- openfec: `{ tokensPerInterval: 15, intervalMs: 60_000 }` (under
  1000/hr)

- [ ] **Step 10.2: Thread limiter into adapters so they share the
      same instance the hydrator checks**

Update each adapter constructor to optionally accept a
`rateLimiter: RateLimiter` param; default to `getLimiter("openstates")`
etc. Refresh then uses this limiter for its upstream calls.

- [ ] **Step 10.3: Wrap `handleRecentBills`**

```ts
import { ensureFresh, sourcesFor, getLimiter } from "../../core/hydrate.js";

export async function handleRecentBills(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentBillsResponse> {
  const input = RecentBillsInput.parse(rawInput);

  let stale_notice: StaleNotice | undefined;
  const sources = sourcesFor("bill", input.jurisdiction);
  for (const src of sources) {
    const r = await ensureFresh(
      db, src, input.jurisdiction, "recent",
      () => getLimiter(src).peekWaitMs(),
    );
    if (r.stale_notice) {
      stale_notice = r.stale_notice;
      break; // first failure wins; serving stale
    }
  }

  // ... existing queryDocuments + mapping logic unchanged ...

  const base: RecentBillsResponse = { results, total, sources: /*...*/, window: /*...*/ };
  if (stale_notice) base.stale_notice = stale_notice;
  if (results.length === 0) {
    const diag = emptyFeedDiagnostic(db, { jurisdiction: input.jurisdiction, kind: "bill" });
    return { ...base, ...diag };
  }
  return base;
}
```

- [ ] **Step 10.4: Add/extend tests**

In `tests/unit/mcp/tools/recent_bills.test.ts`, add cases:
- Fresh cache → no upstream call (msw throws if hit unexpectedly).
- Stale cache → msw fulfills upstream → data flows back.
- Upstream 500 → `stale_notice.reason === "upstream_failure"`;
  local data still served.
- Rate-limited (preload limiter to empty) →
  `stale_notice.reason === "rate_limited"`.

Run: `pnpm test tests/unit/mcp/tools/recent_bills.test.ts`
Expected: all pass.

- [ ] **Step 10.5: Commit**

```bash
git add src/mcp/tools/recent_bills.ts src/core/hydrate.ts \
        src/adapters/ tests/unit/mcp/tools/recent_bills.test.ts
git commit -m "$(cat <<'EOF'
feat(recent_bills): transparent pass-through hydration

Tool handler now calls ensureFresh() before querying. Stale cache
triggers an upstream pull; failures serve stale local with a
stale_notice. Adapter rate limiters are shared with the hydrator
so peekWaitMs() reflects real bucket state.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Wire hydration into `recent_votes`

**Files:**
- Modify: `src/mcp/tools/recent_votes.ts`
- Test: extend `tests/unit/mcp/tools/recent_votes.test.ts`

Same pattern as Task 10 with `kind="vote"`. Votes today only come
from congress; `sourcesFor("vote", "us-federal")` → `["congress"]`.
For `us-<state>`, there is no vote source yet (OpenStates vote
ingestion is deferred) — `sourcesFor` returns `[]` and `ensureFresh`
is not called. Verify.

- [ ] **Steps 11.1–11.4: mirror Task 10**
- [ ] **Step 11.5: Commit**

```bash
git commit -m "feat(recent_votes): transparent pass-through hydration

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Wire hydration into `recent_contributions`

**Files:**
- Modify: `src/mcp/tools/recent_contributions.ts`
- Test: extend `tests/unit/mcp/tools/recent_contributions.test.ts`

`sourcesFor("contribution", "us-federal")` → `["openfec"]`. For any
other jurisdiction, tool returns empty today (per D2 scope).

- [ ] **Steps 12.1–12.4: mirror Task 10**
- [ ] **Step 12.5: Commit**

```bash
git commit -m "feat(recent_contributions): transparent pass-through hydration

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Wire hydration into `search_civic_documents`

**Files:**
- Modify: `src/mcp/tools/search_civic_documents.ts`
- Test: extend its test file

Search has no single jurisdiction. Decision: if the input includes
a `jurisdiction` filter, treat it like a feed and call
`ensureFresh` with `scope="recent"`. If no jurisdiction filter,
serve local only — we don't hydrate "everything."

- [ ] **Step 13.1: Implement conditional hydrate**

```ts
if (input.jurisdiction) {
  // infer kind(s) from input.kinds or iterate if unspecified
  // for each relevant source, call ensureFresh
}
```

- [ ] **Step 13.2: Tests + commit**

Same pattern. Commit message:
```
feat(search_civic_documents): pass-through hydration when jurisdiction filter present
```

---

## Task 14: Entity auto-hydrate

**Files:**
- Modify: `src/mcp/tools/search_entities.ts`
- Modify: `src/mcp/tools/get_entity.ts`
- Modify: `src/mcp/tools/entity_connections.ts`
- Modify: `src/mcp/tools/resolve_person.ts`
- Test: extend each test file

Entity tools use `scope="full"` — longer TTL (24h), bounded pull
(`maxPages=5`, 20s deadline), partial-result fallback.

Behavior per tool:

- **`search_entities`:** If `input.jurisdiction` is provided, call
  `ensureFresh(..., "full")` for each source in
  `sourcesForFullHydrate(jurisdiction)`. Otherwise serve local only.
- **`get_entity`:** Entity ID is already known — the graph must
  have it. Look up the entity, collect its `metadata.roles[]`
  jurisdictions, and (optionally) call `ensureFresh` for each to
  keep the `recent_documents` slice fresh. On failure, attach
  stale_notice but still return the entity.
- **`entity_connections`:** Same as `get_entity` — infer
  jurisdictions from the source entity's roles, hydrate each.
- **`resolve_person`:** If `input.jurisdiction_hint` is provided,
  hydrate that jurisdiction. Otherwise serve local.

- [ ] **Steps 14.1–14.4: implement + test for each tool**
- [ ] **Step 14.5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: entity tools auto-hydrate on cold jurisdictions

search_entities, get_entity, entity_connections, resolve_person all
now call ensureFresh with scope='full' for jurisdictions referenced
in the query. Bounded by maxPages=5 AND 20s wall-clock deadline;
partial results on deadline fire get stale_notice.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Update empty-feed hints (drop CLI references)

**Files:**
- Modify: `src/mcp/shared.ts:emptyFeedDiagnostic`

Under pass-through, "no refresh" is no longer a reachable state
unless hydrate failed — in which case the `stale_notice` is already
present. The `empty_reason: "no_refresh"` hint that tells the LLM
to run `pnpm refresh` is obsolete.

- [ ] **Step 15.1: Rewrite `emptyFeedDiagnostic`**

```ts
export function emptyFeedDiagnostic(
  db: Database.Database,
  ctx: EmptyFeedContext,
): EmptyFeedDiagnostic {
  if (ctx.jurisdiction !== "*") {
    const juris = db
      .prepare("SELECT 1 FROM jurisdictions WHERE id = ?")
      .get(ctx.jurisdiction) as unknown;
    if (!juris) {
      return {
        empty_reason: "unknown_jurisdiction",
        data_freshness: { last_refreshed_at: null, source: null },
        hint: `Jurisdiction "${ctx.jurisdiction}" is not seeded. Use "us-federal" or "us-<state-abbr>".`,
      };
    }
  }

  const latest = db
    .prepare(
      `SELECT fetched_at, source_name
         FROM documents
         WHERE kind = ? AND (jurisdiction = ? OR ? = '*')
         ORDER BY fetched_at DESC
         LIMIT 1`,
    )
    .get(ctx.kind, ctx.jurisdiction, ctx.jurisdiction) as
      | { fetched_at: string; source_name: string }
      | undefined;

  if (!latest) {
    return {
      empty_reason: "no_events_in_window",
      data_freshness: { last_refreshed_at: null, source: null },
      hint:
        `No ${ctx.kind}s for ${ctx.jurisdiction} returned by upstream. ` +
        "If this is unexpected, check stale_notice for hydrate failures.",
    };
  }

  return {
    empty_reason: "no_events_in_window",
    data_freshness: {
      last_refreshed_at: latest.fetched_at,
      source: latest.source_name,
    },
    hint: `Last ${ctx.kind} refresh landed ${latest.fetched_at.slice(0, 10)}. Try a wider window (days=365) or pass session=<id> to bypass the window.`,
  };
}
```

Also remove `"no_refresh"` from the `EmptyReason` union type and
drop the `"no_refresh"` branch from callers if any remain.

- [ ] **Step 15.2: Update tests**

Remove or adapt any tests asserting `empty_reason === "no_refresh"`
or hint strings containing `pnpm refresh`.

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 15.3: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore: drop CLI refresh hints from empty-feed diagnostics

Under pass-through, 'no_refresh' is not a reachable empty-state.
Hint now points to stale_notice for diagnosis.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Remove `refresh_source` from the MCP tool surface

**Files:**
- Delete: `src/mcp/tools/refresh_source.ts`
- Delete: `tests/unit/mcp/tools/refresh_source.test.ts`
- Modify: `src/mcp/server.ts` — drop registration
- Modify: `src/mcp/schemas.ts` — drop `RefreshSourceInput` export
  if no other consumer; verify `src/cli/refresh.ts` doesn't import it
- Keep: `src/core/refresh.ts` (used by CLI + hydrator)
- Keep: `src/cli/refresh.ts` (CLI remains unchanged)

- [ ] **Step 16.1: Verify no live imports of `handleRefreshSource`
      or `RefreshSourceInput` outside the deleted files**

Run:
```bash
grep -rn "handleRefreshSource\|RefreshSourceInput" src/ tests/
```
Expected: only in `src/mcp/server.ts`, `src/mcp/schemas.ts`, the
deleted files. CLI should import from `src/core/refresh.ts` directly.

- [ ] **Step 16.2: Remove registration in `server.ts`**

Delete the entire `mcp.registerTool("refresh_source", ...)` block
(currently lines 157–178). Also remove the import:
```ts
import { handleRefreshSource } from "./tools/refresh_source.js";
```
And the `RefreshSourceInput` from the schemas import at top of
server.ts.

- [ ] **Step 16.3: Delete files**

```bash
rm src/mcp/tools/refresh_source.ts
rm tests/unit/mcp/tools/refresh_source.test.ts
```

- [ ] **Step 16.4: Clean up `schemas.ts`**

If `RefreshSourceInput` is no longer imported anywhere, remove its
export. Otherwise keep it (the CLI may use it for arg parsing).

- [ ] **Step 16.5: Run full suite + integration**

```bash
pnpm test
pnpm build
```
Expected: all green. The MCP `tools/list` integration test should
now show 8 tools (not 9).

- [ ] **Step 16.6: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor: drop refresh_source from MCP tool surface

Superseded by pass-through hydration (R13). src/core/refresh.ts
retained for CLI use; src/cli/refresh.ts unchanged. Tool surface
is now 8 read tools, all pass-through.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Integration test — pass-through end-to-end

**Files:**
- Create: `tests/integration/passthrough-e2e.test.ts`

Exercises the full pass-through flow via a scripted MCP session.

- [ ] **Step 17.1: Write the test**

Scenarios:
1. Cold store + msw upstream fixture → `recent_bills({jurisdiction:
   "us-tx"})` returns non-empty `results`, no `stale_notice`, and
   the `hydrations` row exists for `(openstates, us-tx, recent)`.
2. Warm store (hydrated in scenario 1) + msw set to FAIL if hit →
   second call returns cached results with no `stale_notice`.
3. Advance system time past 1h + msw serving → third call triggers
   a fresh upstream pull.
4. Advance past 1h + msw returning 503 → fourth call returns local
   results with `stale_notice.reason === "upstream_failure"`.
5. Rate-limit drained + msw fixture → call returns local with
   `stale_notice.reason === "rate_limited"`.
6. Cold `entity_connections({entity_id: <tx-senator>})` triggers
   `scope="full"` hydrate for us-tx. Success path: complete status,
   no stale_notice. Deadline-fire path (mock adapter delays past
   20s): partial status + `stale_notice.reason === "partial_hydrate"`.
7. Two concurrent `recent_bills({jurisdiction:"us-tx"})` calls
   with a cold store → msw receives exactly one upstream request
   (singleflight coalesce).

- [ ] **Step 17.2: Run**

Run: `pnpm test tests/integration/passthrough-e2e.test.ts`
Expected: all scenarios pass.

- [ ] **Step 17.3: Commit**

```bash
git commit -m "$(cat <<'EOF'
test: pass-through cache integration end-to-end

Covers cold fill, warm hit, TTL expiry, upstream failure, rate
limit, entity full hydrate (success + deadline-fire partial), and
singleflight coalescing.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Version bump + CHANGELOG + final docs

**Files:**
- Modify: `package.json` — `version: "0.2.0"`
- Modify: `src/mcp/server.ts` — server version string `"0.2.0"`
- Modify: `CHANGELOG.md` — v0.2.0 entry
- Modify: `README.md` — if it mentions `refresh_source`, update

- [ ] **Step 18.1: Bump versions**

Edit `package.json` and the `version:` literal in
`src/mcp/server.ts` from `0.0.6` / `0.1.0` to `0.2.0`.

- [ ] **Step 18.2: CHANGELOG entry**

Prepend to `CHANGELOG.md`:

```markdown
## v0.2.0 — 2026-04-13

**Transparent pass-through cache (R13).** The MCP is no longer an
empty database waiting to be filled by the user — it's a live
interface to OpenStates, Congress.gov, and OpenFEC with the SQLite
store acting as a TTL cache. Cache misses fetch upstream
transparently. Upstream failures serve stale local data with a
`stale_notice` field. Entity tools auto-hydrate their jurisdiction.

### Added
- `src/core/freshness.ts` — TTL helpers (1h recent / 24h full)
- `src/core/singleflight.ts` — concurrent-hydrate coalescing
- `src/core/budget.ts` — daily request budget guard
  (`CIVIC_AWARENESS_DAILY_BUDGET` env var)
- `src/core/hydrate.ts` — pass-through orchestrator
- `hydrations` table (migration 004)
- `stale_notice` sibling field on every tool response envelope
- Adapter `deadline?: number` option for wall-clock bounded pulls
- `RateLimiter.peekWaitMs()` for rate-limit-as-failure checks

### Changed
- All 8 read tools now hydrate transparently when data is stale or
  missing. No user-visible refresh step.
- Empty-feed diagnostic hints no longer reference `pnpm refresh`.
- Entity tools bound their first-call hydration to `maxPages=5` AND
  a 20s wall-clock deadline; partial results are marked and
  surfaced via `stale_notice`.

### Removed
- `refresh_source` MCP tool (superseded by pass-through). The
  `pnpm refresh` CLI remains for operator use.

### Docs
- `docs/00-rationale.md`: R13 added
- `docs/06-open-decisions.md`: D5 second amendment
- `CLAUDE.md`: D5 bullet + pass-through mental model
- `docs/plans/phase-5-onboarding-and-refresh-tool.md`: supersede
  banner (auto-bootstrap portion retained)
```

- [ ] **Step 18.3: Scan README for `refresh_source` references**

Run:
```bash
grep -n "refresh_source" README.md
```
Update or remove any live mentions. Historical mentions in a
"version history" section can stay.

- [ ] **Step 18.4: Final test + build**

```bash
pnpm test
pnpm build
pnpm run lint || true   # if a lint script exists
```
Expected: all green.

- [ ] **Step 18.5: Commit**

```bash
git add package.json src/mcp/server.ts CHANGELOG.md README.md
git commit -m "$(cat <<'EOF'
chore(release): v0.2.0 — transparent pass-through cache

Supersedes R12 / refresh_source tool surface. MCP is now
user-ready out of the box — no CLI step required to get data.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (run after all tasks)

- [ ] `grep -rn "refresh_source" src/` returns nothing (tool deleted).
- [ ] `grep -rn "pnpm refresh" src/` returns nothing in handler code
  (only in CLI + docs).
- [ ] `pnpm test` all green.
- [ ] `pnpm build` clean.
- [ ] Server `tools/list` returns 8 tools.
- [ ] A cold `recent_bills({jurisdiction:"us-tx"})` in a fresh DB
  returns non-empty results with no manual setup (smoke test via
  Claude Desktop or `pnpm dlx @modelcontextprotocol/inspector`).
- [ ] CHANGELOG reflects v0.2.0.
- [ ] R13 present in `docs/00-rationale.md`.
- [ ] Second amendment present in `docs/06-open-decisions.md` under D5.
- [ ] Phase 5 onboarding plan carries supersede banner.
- [ ] CLAUDE.md D5 bullet matches R13 description.

---

## Post-phase — launch polish (out of scope for this plan)

These are tracked separately but should be handled after v0.2.0:

- Trigger nightly drift workflow to flip CI badge green
  (`gh workflow run nightly-drift.yml`).
- Local refresh smoke test with `.env.local`.
- Claude Desktop smoke test.
- Decide: publish v0.2.0 to npm? v0.2.0 is the honest "V1" (D8
  says "publish after V1"). If yes, add `main`, `bin`, `files`,
  `publishConfig` to `package.json` and run `npm publish`.
- External registries: mcp.so, mcpservers.org, Official MCP
  Registry.
- Demo GIF / asciinema.

# Phase 5 — Onboarding Polish + Refresh-as-a-Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the "users must run `pnpm refresh` in a terminal
before any MCP tool returns interesting data" friction by (A)
auto-bootstrapping the database schema on first server start and (C)
exposing refresh as an MCP tool that Claude can invoke in-session.

**Architecture:**
- **Auto-bootstrap (A):** `src/index.ts` detects a missing or
  un-migrated DB on startup and runs `bootstrap()` before the MCP
  server connects. No data is seeded — the user's first tool call
  either returns an empty slice (read tools) or triggers a refresh
  (`refresh_source`).
- **Refresh-as-a-tool (C):** A new `refresh_source` MCP tool accepts
  `{ source, jurisdictions?, max_pages? }`. Internally it calls a
  newly-extracted `src/core/refresh.ts#refreshSource()` function
  — the same function the `pnpm refresh` CLI now calls. One MCP
  consent prompt covers the whole batch refresh (which internally
  may make many upstream HTTP requests, all under one consent
  grant since a tool call is the consent boundary in MCP).

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`,
`better-sqlite3`, `vitest` with `msw`.

**Scope-level decision impact:** This plan revisits D5 in
`docs/06-open-decisions.md` and adds R12 to `docs/00-rationale.md`.
D5's original read-only server constraint is preserved in spirit —
the server does not auto-refresh on query-path tool calls. Only
`refresh_source` writes to the DB, and only when explicitly
invoked with user consent. See Task 1 for the exact doc text.

---

## Prerequisites

- Phase 4 complete (all three adapters shipped).
- `API_DATA_GOV_KEY` and `OPENSTATES_API_KEY` set in `.env.local`
  and as repo Actions secrets (done 2026-04-13 at commit `ade4a3b`).
- `pnpm test` green on `main` at HEAD.

---

## Task 1 — Decision-record updates (R12 + D5 amendment)

**Files:**
- Modify: `docs/00-rationale.md` — insert R12 section before
  "## How to add to this doc"
- Modify: `docs/06-open-decisions.md` — append an `Amended` line to
  D5

- [ ] **Step 1.1: Add R12 to `docs/00-rationale.md`**

Insert the following block immediately before the `## How to add to
this doc` heading (currently at the tail of the file). Do not
remove R8 or any prior R-entry.

```markdown
## R12 — Refresh as an MCP tool alongside the CLI

**Originally decided:** R8 + D5 locked refresh as out-of-process
via `pnpm refresh --source=<name>`. Rationale was server
determinism, predictable latency, and entity-resolution
reproducibility (batch normalization produces a stable graph).

**Revisited on:** 2026-04-13

**New decision:** Refresh remains a batch operation and remains
available via the CLI, but is **additionally** exposed as an MCP
tool, `refresh_source`. The server still does not auto-refresh on
read-tool invocations — every refresh is an explicit, consented,
batch operation. The CLI and the tool are thin wrappers over a
single `refreshSource()` core function.

**Why:**

1. **Onboarding friction.** Under the CLI-only model, a user who
   wires the MCP server into Claude Desktop or Claude Code hits an
   empty-DB wall on their first query. The solution — "open a
   terminal, run `pnpm refresh --source=<name>`, wait, retry" —
   breaks the in-conversation flow that is the whole point of MCP.

2. **The reasons for D5's constraint are preserved.** The server
   is still read-only on the query path (the 8 feed/entity tools).
   Only `refresh_source` writes, and only when the user approves
   the tool call. Entity-resolution reproducibility is not harmed:
   refresh is still a batch normalization pass, the same code as
   the CLI, producing the same entity graph.

3. **MCP consent boundaries align with the design.** In MCP, the
   *tool call* is the consent boundary, not the upstream HTTP
   request. A single `refresh_source` call may fan out to hundreds
   of upstream requests, but the user approves it once with full
   context ("refresh Texas bills" → one prompt → batch runs → done).

4. **Client-allowlist support absorbs the remaining friction for
   trusted users.** Claude Code supports persistent per-tool
   allowlisting via `permissions.allow: ["mcp__civic_awareness__*"]`.
   A user who trusts their own server instance sees zero prompts
   after one config line. Claude Desktop lacks this (issue #24433
   closed NOT PLANNED, 2026-03), so Desktop users will still see a
   per-session prompt for `refresh_source` — but that's one prompt
   per refresh intent, not per upstream request.

**What this does NOT change:**

- `pnpm refresh` CLI continues to work, unchanged from the user's
  perspective. It now calls the same `refreshSource()` function
  the MCP tool does.
- The 8 existing read tools (`recent_bills`, `recent_votes`,
  `recent_contributions`, `search_civic_documents`,
  `search_entities`, `get_entity`, `entity_activity`,
  `entity_connections`, `resolve_person`) remain pure reads from
  SQLite. No upstream HTTP on the query path.
- Rate-limiting infrastructure in `src/util/http.ts` (per-host
  token bucket, backoff, `Retry-After`) still governs the refresh
  path. A `refresh_source` tool call that hits 429 will back off
  identically to the CLI path.
- Batch resolution (D3b cross-jurisdiction Person) still runs
  post-ingest as part of `refreshSource()`. The entity graph
  produced is identical regardless of trigger (CLI or tool).

**Related work shipped in this phase:**

- Auto-bootstrap on `pnpm start` (Task 3 of
  `docs/plans/phase-5-onboarding-and-refresh-tool.md`). Previously
  deferred to "V2 polish" per D6; promoted because the new
  `refresh_source` flow assumes the DB exists.
```

- [ ] **Step 1.2: Run a visual diff to confirm the insert landed
  in the right place**

```bash
grep -nE "^## R1[12]|^## How to add" docs/00-rationale.md
```

Expected output (line numbers may differ):
```
171:## R11 — Scope pivot from Arizona-civic to US-legislative
242:## R12 — Refresh as an MCP tool alongside the CLI
3??:## How to add to this doc
```

R12 must appear between R11 and "How to add".

- [ ] **Step 1.3: Amend D5 in `docs/06-open-decisions.md`**

Find the D5 "Decision" paragraph (currently ends with `"…requires
prioritizing active sessions and backfilling history over multiple
refresh cycles)."`). Append a new paragraph immediately after it,
inside the same D5 section — do **not** rewrite the existing text.

Old text ends at:

```
…requires prioritizing active sessions and backfilling history
over multiple refresh cycles).
```

New paragraph to append:

```markdown

**Amended 2026-04-13:** Refresh is additionally exposed as an MCP
tool (`refresh_source`) alongside the existing CLI, sharing a
single `refreshSource()` core function. The server remains
read-only on the query path; `refresh_source` is the only
write-capable tool and requires explicit per-call user consent
(MCP default behavior). See R12 in `docs/00-rationale.md` and
`docs/plans/phase-5-onboarding-and-refresh-tool.md`.
```

- [ ] **Step 1.4: Commit**

```bash
git add docs/00-rationale.md docs/06-open-decisions.md
git commit -m "$(cat <<'EOF'
docs(decisions): revisit D5 — refresh as MCP tool alongside CLI

Adds R12 to rationale doc explaining the onboarding and
consent-boundary reasoning. Appends an Amended line to D5
preserving the original decision history.
EOF
)"
```

---

## Task 2 — Extract `refreshSource()` core function

**Why:** The CLI currently owns the per-source dispatch logic
inline in `src/cli/refresh.ts#main()`. For the MCP tool to share
behavior, that logic must live in a reusable function the CLI and
the tool both call.

**Files:**
- Create: `src/core/refresh.ts` — new `refreshSource()` function
- Modify: `src/cli/refresh.ts` — delegate to the new function
- Create: `tests/unit/core/refresh.test.ts` — dispatch + aggregation tests

- [ ] **Step 2.1: Write the failing test**

Create `tests/unit/core/refresh.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { refreshSource } from "../../../src/core/refresh.js";

const TEST_DB = "./data/test-core-refresh.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  process.env.API_DATA_GOV_KEY = "test-key";
  process.env.OPENSTATES_API_KEY = "test-key";
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  delete process.env.API_DATA_GOV_KEY;
  delete process.env.OPENSTATES_API_KEY;
});

describe("refreshSource — source dispatch", () => {
  it("dispatches openfec to OpenFecAdapter and returns aggregated result", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [], pagination: { pages: 1 } }), {
        status: 200,
      }),
    );
    const result = await refreshSource(store.db, {
      source: "openfec",
      maxPages: 1,
    });
    expect(result.source).toBe("openfec");
    expect(result.errors).toEqual([]);
    expect(result.entitiesUpserted).toBe(0);
    expect(result.documentsUpserted).toBe(0);
  });

  it("dispatches congress to CongressAdapter", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ members: [], bills: [], votes: [], pagination: {} }), {
        status: 200,
      }),
    );
    const result = await refreshSource(store.db, {
      source: "congress",
      maxPages: 1,
    });
    expect(result.source).toBe("congress");
    expect(result.errors).toEqual([]);
  });

  it("iterates jurisdictions for openstates and aggregates counts", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [], pagination: { max_page: 1 } }), {
        status: 200,
      }),
    );
    const result = await refreshSource(store.db, {
      source: "openstates",
      jurisdictions: ["tx", "ca"],
      maxPages: 1,
    });
    expect(result.source).toBe("openstates");
    expect(result.jurisdictionsProcessed).toEqual(["tx", "ca"]);
    expect(result.errors).toEqual([]);
  });

  it("throws on unknown source", async () => {
    await expect(
      refreshSource(store.db, { source: "bogus" as never, maxPages: 1 }),
    ).rejects.toThrow(/unknown source/i);
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
pnpm vitest run tests/unit/core/refresh.test.ts
```

Expected: FAIL — `Cannot find module '../../../src/core/refresh.js'`.

- [ ] **Step 2.3: Create `src/core/refresh.ts`**

```typescript
import type Database from "better-sqlite3";
import { OpenStatesAdapter } from "../adapters/openstates.js";
import { CongressAdapter } from "../adapters/congress.js";
import { OpenFecAdapter } from "../adapters/openfec.js";
import { requireEnv } from "../util/env.js";
import { logger } from "../util/logger.js";

export type RefreshSource = "openstates" | "congress" | "openfec";

export interface RefreshSourceOptions {
  source: RefreshSource;
  maxPages?: number;
  jurisdictions?: string[];
}

export interface RefreshSourceResult {
  source: RefreshSource;
  entitiesUpserted: number;
  documentsUpserted: number;
  errors: string[];
  jurisdictionsProcessed?: string[];
}

export async function refreshSource(
  db: Database.Database,
  opts: RefreshSourceOptions,
): Promise<RefreshSourceResult> {
  if (opts.source === "openfec") {
    const adapter = new OpenFecAdapter({ apiKey: requireEnv("API_DATA_GOV_KEY") });
    logger.info("refreshing source", { source: "openfec" });
    const r = await adapter.refresh({ db, maxPages: opts.maxPages });
    return {
      source: "openfec",
      entitiesUpserted: r.entitiesUpserted,
      documentsUpserted: r.documentsUpserted,
      errors: r.errors.map((e) => String(e)),
    };
  }
  if (opts.source === "congress") {
    const adapter = new CongressAdapter({ apiKey: requireEnv("API_DATA_GOV_KEY") });
    logger.info("refreshing source", { source: "congress" });
    const r = await adapter.refresh({ db, maxPages: opts.maxPages });
    return {
      source: "congress",
      entitiesUpserted: r.entitiesUpserted,
      documentsUpserted: r.documentsUpserted,
      errors: r.errors.map((e) => String(e)),
    };
  }
  if (opts.source === "openstates") {
    const adapter = new OpenStatesAdapter({ apiKey: requireEnv("OPENSTATES_API_KEY") });
    const targets = opts.jurisdictions ?? listStateJurisdictions(db);
    let entities = 0;
    let documents = 0;
    const errors: string[] = [];
    for (const state of targets) {
      logger.info("refreshing state", { state });
      const r = await adapter.refresh({ db, maxPages: opts.maxPages, jurisdiction: state });
      entities += r.entitiesUpserted;
      documents += r.documentsUpserted;
      for (const err of r.errors) errors.push(`${state}: ${String(err)}`);
    }
    return {
      source: "openstates",
      entitiesUpserted: entities,
      documentsUpserted: documents,
      errors,
      jurisdictionsProcessed: targets,
    };
  }
  throw new Error(`unknown source: ${String(opts.source)}`);
}

function listStateJurisdictions(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT id FROM jurisdictions WHERE level = 'state' ORDER BY id")
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id.replace(/^us-/, ""));
}
```

- [ ] **Step 2.4: Run test to verify it passes**

```bash
pnpm vitest run tests/unit/core/refresh.test.ts
```

Expected: 4/4 pass.

- [ ] **Step 2.5: Refactor `src/cli/refresh.ts` to delegate**

Replace the body of `main()` (the if/else-if dispatch on
`args.source`) with a single call to `refreshSource()`. The CLI
retains arg parsing and logging; the core function owns the
dispatch and per-source behavior.

Full new contents of `src/cli/refresh.ts`:

```typescript
import { openStore } from "../core/store.js";
import { seedJurisdictions } from "../core/seeds.js";
import { refreshSource, type RefreshSource } from "../core/refresh.js";
import { optionalEnv } from "../util/env.js";
import { logger } from "../util/logger.js";

interface Args {
  source: string;
  maxPages?: number;
  jurisdictions?: string[];
}

function parseArgs(argv: string[]): Args {
  let source = "openstates";
  let maxPages: number | undefined;
  let jurisdictions: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) source = argv[++i];
    else if (argv[i].startsWith("--source=")) source = argv[i].slice("--source=".length);
    else if (argv[i] === "--max-pages" && argv[i + 1]) maxPages = parseInt(argv[++i], 10);
    else if (argv[i].startsWith("--max-pages=")) maxPages = parseInt(argv[i].slice("--max-pages=".length), 10);
    else if (argv[i] === "--jurisdictions" && argv[i + 1]) {
      jurisdictions = argv[++i].split(",").map((s) => s.trim().toLowerCase());
    } else if (argv[i].startsWith("--jurisdictions=")) {
      jurisdictions = argv[i]
        .slice("--jurisdictions=".length)
        .split(",")
        .map((s) => s.trim().toLowerCase());
    }
  }
  return { source, maxPages, jurisdictions };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = optionalEnv("CIVIC_AWARENESS_DB_PATH", "./data/civic-awareness.db");
  const store = openStore(dbPath);
  seedJurisdictions(store.db);

  if (args.source !== "openstates" && args.source !== "congress" && args.source !== "openfec") {
    logger.error("unknown source; valid values: openstates, congress, openfec", {
      source: args.source,
    });
    process.exit(1);
  }

  const result = await refreshSource(store.db, {
    source: args.source as RefreshSource,
    maxPages: args.maxPages,
    jurisdictions: args.jurisdictions,
  });

  logger.info("refresh complete", {
    source: result.source,
    entitiesUpserted: result.entitiesUpserted,
    documentsUpserted: result.documentsUpserted,
    errorCount: result.errors.length,
    jurisdictionsProcessed: result.jurisdictionsProcessed,
  });
  if (result.errors.length > 0) {
    logger.error("refresh had errors", { errors: result.errors });
  }

  store.close();
}

main().catch((err) => {
  logger.error("refresh failed", { error: String(err) });
  process.exit(1);
});
```

- [ ] **Step 2.6: Run full test suite to verify nothing regressed**

```bash
pnpm typecheck && pnpm test
```

Expected: `pnpm typecheck` clean; `pnpm test` reports 161+ tests
passing (157 pre-existing + 4 new from Step 2.1).

- [ ] **Step 2.7: Commit**

```bash
git add src/core/refresh.ts src/cli/refresh.ts tests/unit/core/refresh.test.ts
git commit -m "$(cat <<'EOF'
refactor(core): extract refreshSource() for reuse by CLI and MCP tool

Move the per-source dispatch logic out of src/cli/refresh.ts main()
into a new src/core/refresh.ts. CLI becomes a thin wrapper over
the core function. Prepares for Task 4 where the MCP
`refresh_source` tool will call the same function.

Behavior is unchanged from the CLI's perspective; 4 new unit tests
cover dispatch and openstates jurisdiction aggregation.
EOF
)"
```

---

## Task 3 — Auto-bootstrap on server start

**Why:** The new `refresh_source` tool assumes the DB exists with
the schema applied and jurisdictions seeded. Under the current
model a user must run `pnpm bootstrap` separately before starting
the server. Move that into `src/index.ts` so the first `pnpm
start` (or the Claude Desktop first launch) "just works."

**Files:**
- Modify: `src/index.ts` — detect missing DB or missing schema
- Create: `tests/unit/index.test.ts` — verify bootstrap runs when
  DB is missing

**Approach:** Reuse the existing `bootstrap()` from
`src/cli/bootstrap.ts`. The check "is this DB un-bootstrapped?" is
"does the `jurisdictions` table have any rows?" — if zero, run
`bootstrap()` before connecting the MCP transport. This is
idempotent and cheap (the bootstrap function itself is already
idempotent per Phase 1).

- [ ] **Step 3.1: Write the failing test**

Create `tests/unit/index.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { openStore, type Store } from "../../src/core/store.js";
import { autoBootstrapIfNeeded } from "../../src/index.js";

const TEST_DB = "./data/test-auto-bootstrap.db";

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  mkdirSync("./data", { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

describe("autoBootstrapIfNeeded", () => {
  it("bootstraps when the DB file does not exist", async () => {
    expect(existsSync(TEST_DB)).toBe(false);
    await autoBootstrapIfNeeded(TEST_DB);
    expect(existsSync(TEST_DB)).toBe(true);

    const store: Store = openStore(TEST_DB);
    const count = (store.db
      .prepare("SELECT COUNT(*) AS n FROM jurisdictions")
      .get() as { n: number }).n;
    store.close();
    expect(count).toBeGreaterThan(0);
  });

  it("is a no-op when the DB is already bootstrapped", async () => {
    await autoBootstrapIfNeeded(TEST_DB);
    const store1: Store = openStore(TEST_DB);
    const count1 = (store1.db
      .prepare("SELECT COUNT(*) AS n FROM jurisdictions")
      .get() as { n: number }).n;
    store1.close();

    await autoBootstrapIfNeeded(TEST_DB);
    const store2: Store = openStore(TEST_DB);
    const count2 = (store2.db
      .prepare("SELECT COUNT(*) AS n FROM jurisdictions")
      .get() as { n: number }).n;
    store2.close();

    expect(count2).toBe(count1);
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

```bash
pnpm vitest run tests/unit/index.test.ts
```

Expected: FAIL — `autoBootstrapIfNeeded` is not exported from
`src/index.ts`.

- [ ] **Step 3.3: Update `src/index.ts`**

```typescript
#!/usr/bin/env node
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./mcp/server.js";
import { bootstrap } from "./cli/bootstrap.js";
import { openStore } from "./core/store.js";
import { logger } from "./util/logger.js";

const DB_PATH = process.env.CIVIC_AWARENESS_DB_PATH ?? "./data/civic-awareness.db";

export async function autoBootstrapIfNeeded(dbPath: string): Promise<void> {
  if (!existsSync(dbPath)) {
    logger.info("database file missing — auto-bootstrapping", { dbPath });
    await bootstrap({ dbPath });
    return;
  }
  const store = openStore(dbPath);
  const row = store.db
    .prepare("SELECT COUNT(*) AS n FROM jurisdictions")
    .get() as { n: number };
  store.close();
  if (row.n === 0) {
    logger.info("jurisdictions table empty — auto-bootstrapping", { dbPath });
    await bootstrap({ dbPath });
  }
}

async function main(): Promise<void> {
  logger.info("starting civic-awareness-mcp", { dbPath: DB_PATH });
  await autoBootstrapIfNeeded(DB_PATH);
  const { mcp } = buildServer({ dbPath: DB_PATH });
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info("ready");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error("fatal", { error: String(err) });
    process.exit(1);
  });
}
```

Note: wrap `main()` in the `import.meta.url` guard so importing
`autoBootstrapIfNeeded` from a test file does not boot the MCP
server. This matches the pattern already used in `src/cli/bootstrap.ts`.

- [ ] **Step 3.4: Run test to verify it passes**

```bash
pnpm vitest run tests/unit/index.test.ts
```

Expected: 2/2 pass.

- [ ] **Step 3.5: Manual smoke test**

```bash
rm -f ./data/test-manual-bootstrap.db
CIVIC_AWARENESS_DB_PATH=./data/test-manual-bootstrap.db \
  timeout 3 pnpm dev 2>&1 | head -5
# expect: "database file missing — auto-bootstrapping", then "ready"
rm -f ./data/test-manual-bootstrap.db
```

- [ ] **Step 3.6: Commit**

```bash
git add src/index.ts tests/unit/index.test.ts
git commit -m "$(cat <<'EOF'
feat(server): auto-bootstrap DB on first start

If the DB file is missing or the jurisdictions table is empty,
run bootstrap() before connecting the MCP transport. Removes the
'pnpm bootstrap must be run first' friction for Claude Desktop
and Claude Code users. Idempotent: no-op when already bootstrapped.

Previously deferred to V2 polish per D6 commentary; promoted in
Phase 5 because the new refresh_source tool depends on a
schema-ready DB existing at startup.
EOF
)"
```

---

## Task 4 — `refresh_source` MCP tool

**Files:**
- Modify: `src/mcp/schemas.ts` — add `RefreshSourceInput`
- Create: `src/mcp/tools/refresh_source.ts` — tool handler
- Modify: `src/mcp/server.ts` — register the tool
- Create: `tests/unit/mcp/tools/refresh_source.test.ts`

- [ ] **Step 4.1: Write the failing test**

Create `tests/unit/mcp/tools/refresh_source.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { handleRefreshSource } from "../../../../src/mcp/tools/refresh_source.js";

const TEST_DB = "./data/test-tool-refresh-source.db";
let store: Store;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  process.env.API_DATA_GOV_KEY = "test-key";
  process.env.OPENSTATES_API_KEY = "test-key";
  vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ results: [], members: [], bills: [], votes: [], pagination: { pages: 1, max_page: 1 } }),
      { status: 200 },
    ),
  );
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  delete process.env.API_DATA_GOV_KEY;
  delete process.env.OPENSTATES_API_KEY;
});

describe("refresh_source tool handler", () => {
  it("returns expected response shape for congress", async () => {
    const result = await handleRefreshSource(store.db, {
      source: "congress",
      max_pages: 1,
    });
    expect(result.source).toBe("congress");
    expect(result.entities_upserted).toBe(0);
    expect(result.documents_upserted).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.jurisdictions_processed).toBeUndefined();
  });

  it("returns jurisdictions_processed for openstates", async () => {
    const result = await handleRefreshSource(store.db, {
      source: "openstates",
      jurisdictions: ["tx"],
      max_pages: 1,
    });
    expect(result.source).toBe("openstates");
    expect(result.jurisdictions_processed).toEqual(["tx"]);
  });

  it("rejects invalid source via zod", async () => {
    await expect(
      handleRefreshSource(store.db, { source: "bogus", max_pages: 1 }),
    ).rejects.toThrow();
  });

  it("caps max_pages to a sane upper bound", async () => {
    await expect(
      handleRefreshSource(store.db, { source: "congress", max_pages: 9999 }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4.2: Add the zod schema to `src/mcp/schemas.ts`**

Append to the end of the file:

```typescript
export const RefreshSourceInput = z.object({
  source: z.enum(["openstates", "congress", "openfec"]),
  // OpenStates only. If omitted for openstates, refreshes all seeded state
  // jurisdictions — heavy against the 500/day free tier; default to an
  // explicit single state in practice.
  jurisdictions: z.array(z.string().min(2).max(4)).optional(),
  // Cap: 50 pages is well above V1 daily budgets and catches accidental
  // unbounded invocations. Default 2 (conservative first-touch).
  max_pages: z.number().int().min(1).max(50).default(2),
});
export type RefreshSourceInput = z.infer<typeof RefreshSourceInput>;
```

- [ ] **Step 4.3: Create `src/mcp/tools/refresh_source.ts`**

```typescript
import type Database from "better-sqlite3";
import { refreshSource } from "../../core/refresh.js";
import { RefreshSourceInput } from "../schemas.js";

export interface RefreshSourceResponse {
  source: string;
  entities_upserted: number;
  documents_upserted: number;
  errors: string[];
  jurisdictions_processed?: string[];
}

export async function handleRefreshSource(
  db: Database.Database,
  rawInput: unknown,
): Promise<RefreshSourceResponse> {
  const input = RefreshSourceInput.parse(rawInput);
  const result = await refreshSource(db, {
    source: input.source,
    jurisdictions: input.jurisdictions,
    maxPages: input.max_pages,
  });
  return {
    source: result.source,
    entities_upserted: result.entitiesUpserted,
    documents_upserted: result.documentsUpserted,
    errors: result.errors,
    jurisdictions_processed: result.jurisdictionsProcessed,
  };
}
```

- [ ] **Step 4.4: Register the tool in `src/mcp/server.ts`**

Add the import alongside the other tool imports:

```typescript
import { handleRefreshSource } from "./tools/refresh_source.js";
```

Add `RefreshSourceInput` to the schema import block:

```typescript
import {
  RecentBillsInput,
  RecentVotesInput,
  RecentContributionsInput,
  SearchEntitiesInput,
  GetEntityInput,
  SearchDocumentsInput,
  EntityConnectionsInput,
  ResolvePersonInput,
  RefreshSourceInput,
} from "./schemas.js";
```

Add the `registerTool` block at the end of `buildServer()` (just
before the `return { mcp, store };` line):

```typescript
  mcp.registerTool(
    "refresh_source",
    {
      description:
        "Refresh the local SQLite store from an upstream civic-data API. " +
        "Source must be one of 'openstates', 'congress', 'openfec'. For " +
        "openstates, pass `jurisdictions: ['tx']` (or similar) to scope the " +
        "refresh — omitting it iterates all seeded states, which consumes " +
        "the 500/day OpenStates free-tier budget quickly. `max_pages` defaults " +
        "to 2 (conservative). This tool writes to the DB and requires user " +
        "consent per MCP semantics; one consent grant covers the whole batch.",
      inputSchema: RefreshSourceInput.shape,
    },
    async (input) => {
      const data = await handleRefreshSource(store.db, input);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );
```

- [ ] **Step 4.5: Run tests**

```bash
pnpm vitest run tests/unit/mcp/tools/refresh_source.test.ts
pnpm typecheck && pnpm test
```

Expected: the new tool test passes 4/4; overall suite reports 163+
tests passing (previous + 2 new files).

- [ ] **Step 4.6: Bump server version in `src/mcp/server.ts`**

Change `version: "0.0.5"` to `version: "0.0.6"`.

- [ ] **Step 4.7: Commit**

```bash
git add src/mcp/schemas.ts src/mcp/tools/refresh_source.ts src/mcp/server.ts \
        tests/unit/mcp/tools/refresh_source.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add refresh_source tool for in-session data refresh

New MCP tool exposes the same refreshSource() core function the
CLI uses. Users can now ask Claude to refresh a source without
dropping to a terminal. One MCP consent prompt covers the whole
batch; the tool internally may make many upstream HTTP requests,
all governed by the existing src/util/http.ts rate limiter.

Preserves D5 spirit: the 8 read tools remain pure reads from
SQLite. Only refresh_source writes, and only on explicit user
consent. See R12 in docs/00-rationale.md.

Server version bumped 0.0.5 → 0.0.6.
EOF
)"
```

---

## Task 5 — README + docs updates

**Files:**
- Modify: `README.md` — tool table, populate section, allowlist snippet
- Modify: `docs/05-tool-surface.md` — add `refresh_source` entry (if
  the file exists; if not, skip this sub-step)

- [ ] **Step 5.1: Update the tool table in `README.md`**

Find the existing 8-row tool table (under "Tools"). Add a 9th row:

```markdown
| [`refresh_source`](#) | Trigger a batch refresh of one upstream source (openstates, congress, openfec). Writes to the DB; the only non-read tool. |
```

Update the header text above the table from "8 tools" to "9 tools"
wherever it appears (including any opening prose).

- [ ] **Step 5.2: Replace the "Populate the store" section**

Old section (currently documents only the CLI). Replace with:

```markdown
### Populate the store

Two paths, same underlying function:

**In-session via the MCP tool (recommended):**

Ask Claude to refresh: "Refresh Texas bills", "Refresh federal
campaign contributions for 2026", etc. Claude calls the
`refresh_source` tool with one consent prompt, then the batch
runs.

**Out-of-session via the CLI:**

```bash
# API keys in .env.local: OPENSTATES_API_KEY, API_DATA_GOV_KEY
# (the api.data.gov key works for both Congress.gov and OpenFEC)
pnpm refresh --source=openstates --jurisdictions=tx --max-pages=1
pnpm refresh --source=congress   --max-pages=1
pnpm refresh --source=openfec    --max-pages=1
```

Both paths upsert into `./data/civic-awareness.db` (gitignored).
The schema auto-bootstraps on first server start — no `pnpm
bootstrap` needed unless you want to create the DB ahead of time.

The 8 read tools remain pure reads from SQLite. Only
`refresh_source` writes, and only when you invoke it.
```

- [ ] **Step 5.3: Add a "Skipping consent prompts" subsection**

Add this subsection after "Environment variables" in the README:

```markdown
### Skipping per-call consent prompts (Claude Code users)

Claude Code prompts for approval on every MCP tool call by
default. If you trust your own instance of this server, add this
to your user-level `settings.json` (or the project-level
`.claude/settings.json`):

```json
{
  "permissions": {
    "allow": ["mcp__civic_awareness__*"]
  }
}
```

After that, calls to any of the 9 tools — including
`refresh_source` — run without prompts. To silence only read
tools and keep the refresh prompt:

```json
{
  "permissions": {
    "allow": [
      "mcp__civic_awareness__recent_bills",
      "mcp__civic_awareness__recent_votes",
      "mcp__civic_awareness__recent_contributions",
      "mcp__civic_awareness__search_entities",
      "mcp__civic_awareness__get_entity",
      "mcp__civic_awareness__search_civic_documents",
      "mcp__civic_awareness__entity_connections",
      "mcp__civic_awareness__resolve_person"
    ],
    "ask": ["mcp__civic_awareness__refresh_source"]
  }
}
```

Claude Desktop does not persist per-tool allowlists across
sessions (see
[anthropics/claude-code#24433](https://github.com/anthropics/claude-code/issues/24433)).
Desktop users will see the per-call prompt every session.
```

- [ ] **Step 5.4: Update `docs/05-tool-surface.md` if it exists**

```bash
test -f docs/05-tool-surface.md && echo "exists, update it" || echo "skip"
```

If it exists, add a `refresh_source` section mirroring the format of
the existing 8 tool entries. Input schema and response shape should
match `src/mcp/schemas.ts#RefreshSourceInput` and
`src/mcp/tools/refresh_source.ts#RefreshSourceResponse`.

- [ ] **Step 5.5: Commit**

```bash
git add README.md docs/05-tool-surface.md 2>/dev/null
git commit -m "$(cat <<'EOF'
docs: document refresh_source tool + consent allowlist

- README tool table grows from 8 to 9 rows
- Populate-the-store section now leads with the in-session tool
  flow and keeps the CLI as the out-of-session path
- New "Skipping per-call consent prompts" subsection shows the
  Claude Code settings.json pattern for trusted allowlisting
- docs/05-tool-surface.md entry for refresh_source (if file exists)
EOF
)"
```

---

## Task 6 — Final verification + version sync

**Files:**
- Modify: `package.json` — bump `version` to `0.0.6` (matches
  `src/mcp/server.ts`)
- Modify: `tests/drift/drift.test.ts` — update UA string to match
  (optional; only if the current UA hardcodes the version)

- [ ] **Step 6.1: Bump `package.json` version**

```json
{
  "name": "civic-awareness-mcp",
  "version": "0.0.6",
  ...
}
```

- [ ] **Step 6.2: Sync the drift UA string**

Check `tests/drift/drift.test.ts` line 20 — the User-Agent includes
the version:

```bash
grep -n "civic-awareness-mcp-drift" tests/drift/drift.test.ts
```

If it hardcodes `0.0.5`, bump to `0.0.6`. If it uses a variable,
nothing to do.

- [ ] **Step 6.3: Full test + typecheck + build**

```bash
pnpm typecheck
pnpm test
pnpm build
node dist/index.js < /dev/null &
sleep 0.3 && kill $! 2>/dev/null
```

Expected: typecheck clean, all tests pass, `node dist/index.js`
starts without error (the sleep+kill is a smoke test that the
build artifact doesn't crash on startup with an empty stdin).

- [ ] **Step 6.4: Commit**

```bash
git add package.json tests/drift/drift.test.ts 2>/dev/null
git commit -m "chore(version): bump to 0.0.6 for refresh_source tool release"
```

- [ ] **Step 6.5: Push**

```bash
git push
```

---

## Self-review checklist (run before dispatching)

- [ ] Every task produces a working, testable artifact on its own
  (Task 1 is docs-only; Tasks 2–6 each ship real behavior).
- [ ] No placeholders, no "TBD", no "similar to above" — every code
  block is the actual code to paste.
- [ ] Method signatures agree across tasks (`refreshSource` in
  Task 2 matches what `handleRefreshSource` calls in Task 4;
  `autoBootstrapIfNeeded` signature in Task 3 matches its test).
- [ ] Spec coverage: A (auto-bootstrap) = Task 3; C
  (refresh-as-a-tool) = Tasks 2 + 4; doc updates required by
  CLAUDE.md = Task 1.
- [ ] Rate-limit concerns from the brainstorming discussion
  surface in `max_pages` cap (Task 4.2) and tool description
  (Task 4.4).
- [ ] Consent story documented for both Code and Desktop users
  (Task 5.3).
- [ ] D5 is amended in place, not rewritten; R12 is a new entry
  (Task 1 Step 1.1 and 1.3).

---

## Out of scope for Phase 5

- **Elicitation-based cost estimation.** The brainstorming
  discussion surfaced the idea of showing "this refresh will make
  ~N requests; you have M left today" as an elicitation before
  approval. Deferred because OpenStates does not expose a
  remaining-quota endpoint, so any estimate would be heuristic,
  and the 2025-11-25 elicitation spec changes require SDK work
  that is not blocked on for V1 usability.
- **Auto-refresh on stale reads.** Some servers refresh when query
  results are empty or stale-looking. Rejected because it
  re-introduces the unpredictable-latency failure mode D5
  originally avoided, and `refresh_source` with consent makes the
  user intent explicit.
- **Scheduled refresh from inside the server.** Cron-in-process.
  Rejected: the GitHub Actions nightly workflow exists for
  scheduled refreshes and is the right place for that operational
  concern.
- **Paid-tier support for OpenStates.** Not planned — V1 assumes
  free-tier users. When/if a paid-tier feature is requested,
  revisit `src/util/http.ts` rate-limit parameters.

---

## Done criteria

- All 6 tasks committed, tests green, typecheck clean.
- `node dist/index.js` starts with an empty DB, auto-bootstraps,
  and serves 9 tools.
- `refresh_source` tool called through the MCP Inspector (or
  Claude Code) populates the DB and subsequent read tools return
  data.
- `docs/00-rationale.md` has R12 between R11 and "How to add".
- `docs/06-open-decisions.md` D5 has an "Amended 2026-04-13" line.
- `README.md` lists 9 tools and includes the allowlist snippet.
- Package and server versions both at `0.0.6`.

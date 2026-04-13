# Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a TypeScript Node.js MCP server with a SQLite-backed
entity/document store, full test harness, and a working bootstrap
command — but zero real data sources yet.

**Architecture:** TypeScript on Node 22+. `@modelcontextprotocol/sdk`
for MCP protocol. `better-sqlite3` for synchronous local storage.
`zod` for schema validation. `vitest` for testing. See
`docs/02-architecture.md`.

**Tech Stack:** TypeScript, Node.js 22+, pnpm, vitest, better-sqlite3,
zod, @modelcontextprotocol/sdk.

---

## Prerequisites

Before executing this plan:

- User has confirmed `docs/06-open-decisions.md` D1–D6.
- Node.js 22+ installed (`node --version` >= v22.0.0).
- pnpm installed (`npm i -g pnpm`).
- `git init` has been run in the repo root and an initial commit made
  covering the planning docs.

---

## File structure produced by this phase

```
civic-awareness-mcp/
├── .gitignore                          (already exists)
├── package.json                        ← Task 1
├── pnpm-lock.yaml                      ← Task 1
├── tsconfig.json                       ← Task 1
├── vitest.config.ts                    ← Task 1
├── .prettierrc                         ← Task 1
├── src/
│   ├── index.ts                        ← Task 9
│   ├── core/
│   │   ├── types.ts                    ← Task 2
│   │   ├── store.ts                    ← Task 3
│   │   ├── migrations/
│   │   │   └── 001-init.sql            ← Task 3
│   │   ├── seeds.ts                    ← Task 4
│   │   ├── entities.ts                 ← Task 6
│   │   └── documents.ts                ← Task 7
│   ├── resolution/
│   │   └── fuzzy.ts                    ← Task 5
│   ├── util/
│   │   ├── http.ts                     ← Task 8
│   │   └── logger.ts                   ← Task 9
│   ├── mcp/
│   │   └── server.ts                   ← Task 9
│   └── cli/
│       └── bootstrap.ts                ← Task 10
└── tests/
    └── unit/
        ├── core/
        │   ├── types.test.ts           ← Task 2
        │   ├── store.test.ts           ← Task 3
        │   ├── entities.test.ts        ← Task 6
        │   └── documents.test.ts       ← Task 7
        ├── resolution/
        │   └── fuzzy.test.ts           ← Task 5
        ├── util/
        │   └── http.test.ts            ← Task 8
        └── mcp/
            └── server.test.ts          ← Task 9
```

---

## Task 1: Project initialization

**Files:** `package.json`, `tsconfig.json`, `vitest.config.ts`,
`.prettierrc`, `tests/unit/smoke.test.ts`

- [ ] **Step 1.1: Initialize pnpm**

```bash
cd /Users/j/repos/civic-awareness-mcp
pnpm init
```

Overwrite the generated `package.json` with:

```json
{
  "name": "civic-awareness-mcp",
  "version": "0.0.1",
  "description": "MCP server for US federal and state legislative civic data",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "civic-awareness-mcp": "dist/index.js"
  },
  "scripts": {
    "build": "tsc && cp -R src/core/migrations dist/core/migrations",
    "test": "vitest run",
    "test:watch": "vitest",
    "bootstrap": "tsx src/cli/bootstrap.ts",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write ."
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
```

- [ ] **Step 1.2: Install dependencies**

```bash
pnpm add @modelcontextprotocol/sdk better-sqlite3 zod
pnpm add -D typescript vitest @types/node @types/better-sqlite3 tsx prettier
```

- [ ] **Step 1.3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 1.4: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 10000,
  },
});
```

- [ ] **Step 1.5: Create .prettierrc**

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 1.6: Smoke test**

Create `tests/unit/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 1.7: Run tests and typecheck**

```bash
pnpm test
pnpm typecheck
```

Expected: 1 test passing, no type errors.

- [ ] **Step 1.8: Commit**

```bash
git add .
git commit -m "chore: initialize TypeScript project with vitest"
```

---

## Task 2: Core zod schemas

**Files:** `src/core/types.ts`, `tests/unit/core/types.test.ts`

- [ ] **Step 2.1: Write the failing test**

`tests/unit/core/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Entity, Document, EntityKind, DocumentKind } from "../../../src/core/types.js";

describe("Entity schema", () => {
  it("parses a valid person entity", () => {
    const parsed = Entity.parse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      kind: "person",
      name: "Jane Doe",
      aliases: ["Doe, Jane"],
      external_ids: { openstates_person: "ocd-person/abc" },
      first_seen_at: "2026-04-12T00:00:00.000Z",
      last_seen_at: "2026-04-12T00:00:00.000Z",
    });
    expect(parsed.name).toBe("Jane Doe");
    expect(parsed.jurisdiction).toBeUndefined();
    expect(parsed.external_ids.openstates_person).toBe("ocd-person/abc");
  });

  it("rejects invalid kind", () => {
    expect(() => Entity.parse({ kind: "alien", id: "x", name: "x" })).toThrow();
  });

  it("fills in defaults", () => {
    const parsed = Entity.parse({
      id: "x", kind: "person", name: "X",
      first_seen_at: "2026-04-12T00:00:00.000Z",
      last_seen_at: "2026-04-12T00:00:00.000Z",
    });
    expect(parsed.aliases).toEqual([]);
    expect(parsed.external_ids).toEqual({});
  });
});

describe("Document schema", () => {
  it("parses a valid bill document", () => {
    const parsed = Document.parse({
      id: "x",
      kind: "bill",
      jurisdiction: "us-federal",
      title: "HR1234",
      occurred_at: "2026-04-01T00:00:00.000Z",
      fetched_at: "2026-04-12T00:00:00.000Z",
      source: { name: "congress", id: "hr-1234-119", url: "https://congress.gov/x" },
    });
    expect(parsed.kind).toBe("bill");
    expect(parsed.references).toEqual([]);
  });
});

describe("Kind enums", () => {
  it("EntityKind includes pac", () => {
    expect(() => EntityKind.parse("pac")).not.toThrow();
  });
  it("DocumentKind includes contribution", () => {
    expect(() => DocumentKind.parse("contribution")).not.toThrow();
  });
});
```

- [ ] **Step 2.2: Run test to confirm failure**

```bash
pnpm test tests/unit/core/types.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 2.3: Implement `src/core/types.ts`**

```ts
import { z } from "zod";

export const Jurisdiction = z.object({
  id: z.string(),
  level: z.enum(["federal", "state"]),
  name: z.string(),
});
export type Jurisdiction = z.infer<typeof Jurisdiction>;

export const EntityKind = z.enum(["person", "organization", "committee", "pac", "agency"]);
export type EntityKind = z.infer<typeof EntityKind>;

export const ExternalIds = z.record(z.string(), z.string());

export const Entity = z.object({
  id: z.string(),
  kind: EntityKind,
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  jurisdiction: z.string().optional(),
  external_ids: ExternalIds.default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
  first_seen_at: z.iso.datetime(),
  last_seen_at: z.iso.datetime(),
});
export type Entity = z.infer<typeof Entity>;

export const ReferenceRole = z.enum([
  "sponsor", "cosponsor", "voter", "contributor",
  "recipient", "subject", "officer", "member",
]);
export type ReferenceRole = z.infer<typeof ReferenceRole>;

export const EntityReference = z.object({
  entity_id: z.string(),
  role: ReferenceRole,
  qualifier: z.string().optional(),
});
export type EntityReference = z.infer<typeof EntityReference>;

export const DocumentKind = z.enum([
  "bill", "bill_action", "vote", "contribution", "expenditure",
]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const Document = z.object({
  id: z.string(),
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
});
export type Document = z.infer<typeof Document>;
```

- [ ] **Step 2.4: Run test and confirm green**

```bash
pnpm test tests/unit/core/types.test.ts
```

Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add src/core/types.ts tests/unit/core/types.test.ts
git commit -m "feat: add core Entity and Document zod schemas"
```

---

## Task 3: SQLite store + migrations

**Files:** `src/core/store.ts`, `src/core/migrations/001-init.sql`,
`tests/unit/core/store.test.ts`

**Design note:** The store applies SQL migration scripts using a helper
function `runSqlScript(db, sql)` that wraps `better-sqlite3`'s
multi-statement execution method. This indirection also makes it easier
to mock migrations in tests.

- [ ] **Step 3.1: Write the failing test**

`tests/unit/core/store.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore } from "../../../src/core/store.js";

const TEST_DB = "./data/test-store.db";
afterEach(() => { if (existsSync(TEST_DB)) rmSync(TEST_DB); });

describe("openStore", () => {
  it("creates the DB file", () => {
    const s = openStore(TEST_DB);
    expect(existsSync(TEST_DB)).toBe(true);
    s.close();
  });

  it("applies migrations on first open", () => {
    const s = openStore(TEST_DB);
    const tables = s.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("entities");
    expect(tables).toContain("documents");
    expect(tables).toContain("document_references");
    expect(tables).toContain("jurisdictions");
    expect(tables).toContain("schema_migrations");
    s.close();
  });

  it("is idempotent", () => {
    openStore(TEST_DB).close();
    const s = openStore(TEST_DB);
    const count = s.db
      .prepare("SELECT COUNT(*) as c FROM schema_migrations")
      .get() as { c: number };
    expect(count.c).toBe(1);
    s.close();
  });
});
```

- [ ] **Step 3.2: Create migration SQL**

`src/core/migrations/001-init.sql`:

```sql
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE jurisdictions (
  id    TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('federal','state')),
  name  TEXT NOT NULL
);

-- NOTE: No UNIQUE constraint on (kind, jurisdiction, name_normalized)
-- or similar that would include Person rows. Under D3b, Persons are
-- cross-jurisdiction (jurisdiction is NULL) and two legitimate Persons
-- with the same normalized name must coexist until a linking signal
-- merges them. See docs/04-entity-schema.md, "Schema invariants".
CREATE TABLE entities (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  jurisdiction    TEXT REFERENCES jurisdictions(id),
  external_ids    TEXT NOT NULL DEFAULT '{}',
  aliases         TEXT NOT NULL DEFAULT '[]',
  metadata        TEXT NOT NULL DEFAULT '{}',
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);
CREATE INDEX idx_entities_name_norm ON entities(name_normalized);
CREATE INDEX idx_entities_kind      ON entities(kind);
CREATE INDEX idx_entities_juris     ON entities(jurisdiction);

CREATE TABLE documents (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  jurisdiction    TEXT NOT NULL REFERENCES jurisdictions(id),
  title           TEXT NOT NULL,
  summary         TEXT,
  occurred_at     TEXT NOT NULL,
  fetched_at      TEXT NOT NULL,
  source_name     TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  source_url      TEXT NOT NULL,
  raw             TEXT NOT NULL DEFAULT '{}',
  UNIQUE (source_name, source_id)
);
CREATE INDEX idx_documents_occurred   ON documents(occurred_at DESC);
CREATE INDEX idx_documents_kind_juris ON documents(kind, jurisdiction, occurred_at DESC);

CREATE TABLE document_references (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id    TEXT NOT NULL REFERENCES entities(id)  ON DELETE CASCADE,
  role         TEXT NOT NULL,
  qualifier    TEXT,
  PRIMARY KEY (document_id, entity_id, role)
);
CREATE INDEX idx_docrefs_entity ON document_references(entity_id, role);
```

- [ ] **Step 3.3: Implement `src/core/store.ts`**

```ts
import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Store {
  db: Database.Database;
  close(): void;
}

const MIGRATIONS = [
  { version: 1, file: "001-init.sql" },
] as const;

function runSqlScript(db: Database.Database, sql: string): void {
  // better-sqlite3 exposes a method that runs multi-statement SQL scripts.
  // We wrap it here so tests can substitute a fake if needed.
  (db as any).exec(sql);
}

export function openStore(path: string): Store {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return { db, close: () => db.close() };
}

function applyMigrations(db: Database.Database): void {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();

  const applied = tableExists
    ? new Set(
        db.prepare("SELECT version FROM schema_migrations").all().map((r: any) => r.version),
      )
    : new Set<number>();

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const sql = readFileSync(resolve(__dirname, "migrations", migration.file), "utf-8");
    runSqlScript(db, sql);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(migration.version, new Date().toISOString());
  }
}
```

- [ ] **Step 3.4: Run test and confirm green**

```bash
pnpm test tests/unit/core/store.test.ts
```

Expected: PASS.

- [ ] **Step 3.5: Commit**

```bash
git add src/core/store.ts src/core/migrations/001-init.sql tests/unit/core/store.test.ts
git commit -m "feat: SQLite store with migration runner"
```

---

## Task 4: Jurisdictions seed

**Files:** `src/core/seeds.ts`, appended tests in
`tests/unit/core/store.test.ts`

- [ ] **Step 4.1: Append test**

At the bottom of `tests/unit/core/store.test.ts`:

```ts
import { seedJurisdictions } from "../../../src/core/seeds.js";

describe("seedJurisdictions", () => {
  it("inserts us-federal and the Phase 1 test-fixture states", () => {
    const s = openStore(TEST_DB);
    seedJurisdictions(s.db);
    const rows = s.db
      .prepare("SELECT id, level, name FROM jurisdictions ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "us-ca", level: "state", name: "California" },
      { id: "us-federal", level: "federal", name: "United States" },
      { id: "us-ny", level: "state", name: "New York" },
      { id: "us-tx", level: "state", name: "Texas" },
    ]);
    s.close();
  });

  it("is idempotent", () => {
    const s = openStore(TEST_DB);
    seedJurisdictions(s.db);
    seedJurisdictions(s.db);
    const c = s.db.prepare("SELECT COUNT(*) as c FROM jurisdictions").get() as { c: number };
    // us-federal + 50 states. Keep in sync with JURISDICTIONS in src/core/seeds.ts.
    expect(c.c).toBe(51);
    s.close();
  });
});
```

- [ ] **Step 4.2: Implement `src/core/seeds.ts`**

```ts
import type Database from "better-sqlite3";

// Phase 1 seeds the full V1 jurisdiction roster: `us-federal` plus
// all 50 U.S. states. This lets `pnpm refresh --all` (Phase 2)
// iterate every state without requiring the operator to hand-seed
// extras. D.C. and Puerto Rico territories are excluded from V1;
// add them when/if their OpenStates coverage enters scope.
// Keep this list in sync with seedJurisdictions's test (51 rows).
const JURISDICTIONS = [
  { id: "us-federal", level: "federal", name: "United States" },
  { id: "us-al", level: "state", name: "Alabama" },
  { id: "us-ak", level: "state", name: "Alaska" },
  { id: "us-az", level: "state", name: "Arizona" },
  { id: "us-ar", level: "state", name: "Arkansas" },
  { id: "us-ca", level: "state", name: "California" },
  { id: "us-co", level: "state", name: "Colorado" },
  { id: "us-ct", level: "state", name: "Connecticut" },
  { id: "us-de", level: "state", name: "Delaware" },
  { id: "us-fl", level: "state", name: "Florida" },
  { id: "us-ga", level: "state", name: "Georgia" },
  { id: "us-hi", level: "state", name: "Hawaii" },
  { id: "us-id", level: "state", name: "Idaho" },
  { id: "us-il", level: "state", name: "Illinois" },
  { id: "us-in", level: "state", name: "Indiana" },
  { id: "us-ia", level: "state", name: "Iowa" },
  { id: "us-ks", level: "state", name: "Kansas" },
  { id: "us-ky", level: "state", name: "Kentucky" },
  { id: "us-la", level: "state", name: "Louisiana" },
  { id: "us-me", level: "state", name: "Maine" },
  { id: "us-md", level: "state", name: "Maryland" },
  { id: "us-ma", level: "state", name: "Massachusetts" },
  { id: "us-mi", level: "state", name: "Michigan" },
  { id: "us-mn", level: "state", name: "Minnesota" },
  { id: "us-ms", level: "state", name: "Mississippi" },
  { id: "us-mo", level: "state", name: "Missouri" },
  { id: "us-mt", level: "state", name: "Montana" },
  { id: "us-ne", level: "state", name: "Nebraska" },
  { id: "us-nv", level: "state", name: "Nevada" },
  { id: "us-nh", level: "state", name: "New Hampshire" },
  { id: "us-nj", level: "state", name: "New Jersey" },
  { id: "us-nm", level: "state", name: "New Mexico" },
  { id: "us-ny", level: "state", name: "New York" },
  { id: "us-nc", level: "state", name: "North Carolina" },
  { id: "us-nd", level: "state", name: "North Dakota" },
  { id: "us-oh", level: "state", name: "Ohio" },
  { id: "us-ok", level: "state", name: "Oklahoma" },
  { id: "us-or", level: "state", name: "Oregon" },
  { id: "us-pa", level: "state", name: "Pennsylvania" },
  { id: "us-ri", level: "state", name: "Rhode Island" },
  { id: "us-sc", level: "state", name: "South Carolina" },
  { id: "us-sd", level: "state", name: "South Dakota" },
  { id: "us-tn", level: "state", name: "Tennessee" },
  { id: "us-tx", level: "state", name: "Texas" },
  { id: "us-ut", level: "state", name: "Utah" },
  { id: "us-vt", level: "state", name: "Vermont" },
  { id: "us-va", level: "state", name: "Virginia" },
  { id: "us-wa", level: "state", name: "Washington" },
  { id: "us-wv", level: "state", name: "West Virginia" },
  { id: "us-wi", level: "state", name: "Wisconsin" },
  { id: "us-wy", level: "state", name: "Wyoming" },
];

export function seedJurisdictions(db: Database.Database): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO jurisdictions (id, level, name) VALUES (?, ?, ?)",
  );
  for (const j of JURISDICTIONS) stmt.run(j.id, j.level, j.name);
}
```

- [ ] **Step 4.3: Run test, confirm green, commit**

```bash
pnpm test tests/unit/core/store.test.ts
git add src/core/seeds.ts tests/unit/core/store.test.ts
git commit -m "feat: seed us-federal and Phase 1 test-fixture state jurisdictions"
```

---

## Task 5: Name normalization + fuzzy matching

**Files:** `src/resolution/fuzzy.ts`, `tests/unit/resolution/fuzzy.test.ts`

- [ ] **Step 5.1: Write test**

`tests/unit/resolution/fuzzy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeName, levenshtein, fuzzyPick } from "../../../src/resolution/fuzzy.js";

describe("normalizeName", () => {
  it("lowercases", () => expect(normalizeName("Jane Doe")).toBe("jane doe"));
  it("strips punct", () => expect(normalizeName("O'Brien, Jr.")).toBe("obrien jr"));
  it("collapses whitespace", () => expect(normalizeName("  Jane    Doe  ")).toBe("jane doe"));
  it("commas as separators", () => expect(normalizeName("Doe, Jane")).toBe("doe jane"));
});

describe("levenshtein", () => {
  it("identical=0", () => expect(levenshtein("abc", "abc")).toBe(0));
  it("sub=1", () => expect(levenshtein("abc", "abd")).toBe(1));
  it("ins=1", () => expect(levenshtein("abc", "abcd")).toBe(1));
  it("different=3", () => expect(levenshtein("abc", "xyz")).toBe(3));
});

describe("fuzzyPick", () => {
  // Under D3b, fuzzyPick requires a positive linking signal and uses
  // Levenshtein ≤ 1. A candidate with no linking signal is never
  // returned even on a distance-0 match.
  const candidates = [
    {
      id: "1",
      name: "Jane Doe",
      external_id_sources: ["openstates_person"],
      aliases: ["Jane A. Doe"],
      role_jurisdictions: ["us-tx"],
    },
    {
      id: "2",
      name: "John Doe",
      external_id_sources: ["bioguide"],
      aliases: [],
      role_jurisdictions: ["us-federal"],
    },
    {
      id: "3",
      name: "Janet Doex",
      external_id_sources: [],
      aliases: [],
      role_jurisdictions: [],
    },
  ];

  it("unique close match with shared external_id source family links", () => {
    const picked = fuzzyPick(
      "Jane Doe",
      { external_id_sources: ["openstates_person"], middle_name: null, role_jurisdictions: [] },
      candidates,
    );
    expect(picked?.id).toBe("1");
  });

  it("unique close match with role-jurisdiction overlap links", () => {
    const picked = fuzzyPick(
      "Jane Doe",
      { external_id_sources: [], middle_name: null, role_jurisdictions: ["us-tx"] },
      candidates,
    );
    expect(picked?.id).toBe("1");
  });

  it("unique close match with middle name matching an alias links", () => {
    const picked = fuzzyPick(
      "Jane A. Doe",
      { external_id_sources: [], middle_name: "A", role_jurisdictions: [] },
      candidates,
    );
    expect(picked?.id).toBe("1");
  });

  it("no linking signal returns null even on distance-0 match", () => {
    const picked = fuzzyPick(
      "Jane Doe",
      { external_id_sources: ["fec_candidate"], middle_name: null, role_jurisdictions: ["us-ca"] },
      candidates,
    );
    expect(picked).toBeNull();
  });

  it("distance 2 is over threshold and returns null", () => {
    // "Jae Doe" → "Jane Doe" is distance 1 (one insertion); "Jae Doe"
    // → "Jan Doe" would be distance 1 too. Use a clearly-distance-2
    // input to verify the tightened threshold rejects it.
    const picked = fuzzyPick(
      "Jaen Doex",
      { external_id_sources: ["openstates_person"], middle_name: null, role_jurisdictions: [] },
      candidates,
    );
    expect(picked).toBeNull();
  });

  it("no close match returns null", () => {
    const picked = fuzzyPick(
      "Zzz Martin",
      { external_id_sources: ["openstates_person"], middle_name: null, role_jurisdictions: [] },
      candidates,
    );
    expect(picked).toBeNull();
  });
});
```

- [ ] **Step 5.2: Implement `src/resolution/fuzzy.ts`**

```ts
export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

export interface FuzzyCandidate {
  id: string;
  name: string;
  /** External-ID source families this candidate already has an ID in
   *  (e.g. "openstates_person", "bioguide", "fec_candidate"). */
  external_id_sources: string[];
  /** Any known aliases, used for middle-name/initial linking. */
  aliases: string[];
  /** Jurisdictions appearing in this candidate's metadata.roles[]. */
  role_jurisdictions: string[];
}

/** Information about the upstream record whose identity we're trying
 *  to resolve. At least one field must overlap with a candidate for
 *  fuzzyPick to return it (D3b linking-signal requirement). */
export interface UpstreamSignals {
  external_id_sources: string[];
  /** Middle name or initial from the upstream record, if present. */
  middle_name: string | null;
  /** Jurisdictions associated with the upstream record (e.g. the
   *  jurisdiction of the document referencing this entity). */
  role_jurisdictions: string[];
}

// D3b: tightened from ≤ 2 to ≤ 1 to compensate for nationwide name
// collision risk under the US-federal + 50-state scope.
const ACCEPT_DISTANCE = 1;
const RUNNER_UP_MIN_DISTANCE = 3;

function hasLinkingSignal(c: FuzzyCandidate, s: UpstreamSignals): boolean {
  // Shared external_id source family.
  for (const src of s.external_id_sources) {
    if (c.external_id_sources.includes(src)) return true;
  }
  // Middle name/initial matches an alias token.
  if (s.middle_name) {
    const needle = s.middle_name.toLowerCase().replace(/\./g, "");
    for (const alias of c.aliases) {
      if (normalizeName(alias).split(" ").includes(needle)) return true;
    }
  }
  // Role-jurisdiction overlap.
  for (const j of s.role_jurisdictions) {
    if (c.role_jurisdictions.includes(j)) return true;
  }
  return false;
}

export function fuzzyPick<T extends FuzzyCandidate>(
  query: string,
  signals: UpstreamSignals,
  candidates: T[],
): T | null {
  const q = normalizeName(query);
  const scored = candidates
    .map((c) => ({ c, d: levenshtein(q, normalizeName(c.name)) }))
    .sort((a, b) => a.d - b.d);
  if (scored.length === 0) return null;
  const best = scored[0];
  if (best.d > ACCEPT_DISTANCE) return null;
  const runnerUp = scored[1];
  if (runnerUp && runnerUp.d < RUNNER_UP_MIN_DISTANCE) return null;
  if (!hasLinkingSignal(best.c, signals)) return null;
  return best.c;
}
```

- [ ] **Step 5.3: Test, commit**

```bash
pnpm test tests/unit/resolution/fuzzy.test.ts
git add src/resolution/fuzzy.ts tests/unit/resolution/fuzzy.test.ts
git commit -m "feat: name normalization and fuzzy matching"
```

---

## Task 6: Entity upsert / query

**Files:** `src/core/entities.ts`, `tests/unit/core/entities.test.ts`

See `docs/04-entity-schema.md` for the resolution algorithm this
implements.

- [ ] **Step 6.1: Write the failing test**

`tests/unit/core/entities.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { upsertEntity, findEntityById, listEntities } from "../../../src/core/entities.js";

const TEST_DB = "./data/test-entities.db";
let store: Store;
beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});
afterEach(() => store.close());

describe("upsertEntity", () => {
  it("inserts new when no match (Person — no jurisdiction)", () => {
    const r = upsertEntity(store.db, {
      kind: "person", name: "Jane Doe",
      external_ids: { openstates_person: "ocd-person/abc" },
    });
    expect(r.created).toBe(true);
    expect(r.entity.jurisdiction).toBeUndefined();
    expect(r.entity.external_ids.openstates_person).toBe("ocd-person/abc");
  });

  it("matches by external_id", () => {
    const first = upsertEntity(store.db, {
      kind: "person", name: "Jane Doe",
      external_ids: { openstates_person: "ocd-person/abc" },
    });
    const second = upsertEntity(store.db, {
      kind: "person", name: "J. Doe",
      external_ids: { openstates_person: "ocd-person/abc" },
    });
    expect(second.created).toBe(false);
    expect(second.entity.id).toBe(first.entity.id);
    expect(second.entity.aliases).toContain("J. Doe");
  });

  it("matches Person by exact normalized name across jurisdictions (D3b)", () => {
    // Under D3b, Persons are cross-jurisdiction: the same normalized
    // name merges regardless of which jurisdiction the upstream
    // record came from.
    const first = upsertEntity(store.db, { kind: "person", name: "Jane Doe" });
    const second = upsertEntity(store.db, { kind: "person", name: "Jane  Doe" });
    expect(second.created).toBe(false);
    expect(second.entity.id).toBe(first.entity.id);
  });

  it("Organization exact-name match is still scoped to jurisdiction", () => {
    // Organizations/committees/PACs remain per-jurisdiction: the same
    // org name in two different states is two different orgs.
    const a = upsertEntity(store.db, {
      kind: "organization", name: "Ethics Committee", jurisdiction: "us-tx",
    });
    const b = upsertEntity(store.db, {
      kind: "organization", name: "Ethics Committee", jurisdiction: "us-ca",
    });
    expect(b.created).toBe(true);
    expect(b.entity.id).not.toBe(a.entity.id);
  });

  it("does not cross kinds", () => {
    const a = upsertEntity(store.db, { kind: "person", name: "ACME" });
    const b = upsertEntity(store.db, {
      kind: "organization", name: "ACME", jurisdiction: "us-federal",
    });
    expect(b.created).toBe(true);
    expect(b.entity.id).not.toBe(a.entity.id);
  });
});

describe("findEntityById and listEntities", () => {
  it("findEntityById returns null for missing", () => {
    expect(findEntityById(store.db, "nope")).toBeNull();
  });
  it("listEntities filters by kind", () => {
    upsertEntity(store.db, { kind: "person", name: "Jane" });
    upsertEntity(store.db, {
      kind: "organization", name: "ACME", jurisdiction: "us-federal",
    });
    expect(listEntities(store.db, { kind: "person" })).toHaveLength(1);
  });
});
```

- [ ] **Step 6.2: Implement `src/core/entities.ts`**

```ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Entity, type EntityKind } from "./types.js";
import { normalizeName } from "../resolution/fuzzy.js";

export interface UpsertInput {
  kind: EntityKind;
  name: string;
  jurisdiction?: string;
  external_ids?: Record<string, string>;
  aliases?: string[];
  metadata?: Record<string, unknown>;
}
export interface UpsertResult { entity: Entity; created: boolean }

interface Row {
  id: string; kind: string; name: string; name_normalized: string;
  jurisdiction: string | null; external_ids: string; aliases: string;
  metadata: string; first_seen_at: string; last_seen_at: string;
}

function rowToEntity(r: Row): Entity {
  return Entity.parse({
    id: r.id, kind: r.kind, name: r.name,
    jurisdiction: r.jurisdiction ?? undefined,
    external_ids: JSON.parse(r.external_ids),
    aliases: JSON.parse(r.aliases),
    metadata: JSON.parse(r.metadata),
    first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at,
  });
}

export function upsertEntity(db: Database.Database, input: UpsertInput): UpsertResult {
  const now = new Date().toISOString();
  const nameNorm = normalizeName(input.name);

  const existing =
    findByExternalIds(db, input.external_ids ?? {}) ??
    findByExactName(db, input.kind, nameNorm, input.jurisdiction);

  if (existing) {
    const mergedIds = { ...existing.external_ids, ...(input.external_ids ?? {}) };
    const mergedAliases = mergeAliases(existing, input.name);
    db.prepare(
      "UPDATE entities SET external_ids = ?, aliases = ?, last_seen_at = ? WHERE id = ?",
    ).run(JSON.stringify(mergedIds), JSON.stringify(mergedAliases), now, existing.id);
    return {
      entity: { ...existing, external_ids: mergedIds, aliases: mergedAliases, last_seen_at: now },
      created: false,
    };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO entities
     (id, kind, name, name_normalized, jurisdiction, external_ids, aliases, metadata, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.kind, input.name, nameNorm, input.jurisdiction ?? null,
    JSON.stringify(input.external_ids ?? {}),
    JSON.stringify(input.aliases ?? []),
    JSON.stringify(input.metadata ?? {}),
    now, now,
  );
  return {
    entity: {
      id, kind: input.kind, name: input.name,
      aliases: input.aliases ?? [], jurisdiction: input.jurisdiction,
      external_ids: input.external_ids ?? {}, metadata: input.metadata ?? {},
      first_seen_at: now, last_seen_at: now,
    },
    created: true,
  };
}

function findByExternalIds(db: Database.Database, ids: Record<string, string>): Entity | null {
  for (const [source, id] of Object.entries(ids)) {
    const pattern = `%"${source}":"${id}"%`;
    const row = db
      .prepare("SELECT * FROM entities WHERE external_ids LIKE ? LIMIT 1")
      .get(pattern) as Row | undefined;
    if (row) return rowToEntity(row);
  }
  return null;
}

function findByExactName(
  db: Database.Database, kind: string, nameNorm: string, j: string | undefined,
): Entity | null {
  // D3b: Person rows are cross-jurisdiction — match on (kind, name)
  // only. Organization/committee/pac/agency rows stay scoped by
  // jurisdiction, so "Ethics Committee" in two states stays distinct.
  const rows = kind === "person"
    ? db
        .prepare(
          `SELECT * FROM entities WHERE kind = 'person' AND name_normalized = ?`,
        )
        .all(nameNorm) as Row[]
    : db
        .prepare(
          `SELECT * FROM entities
           WHERE kind = ? AND name_normalized = ?
             AND ((? IS NOT NULL AND jurisdiction = ?) OR (? IS NULL AND jurisdiction IS NULL))`,
        )
        .all(kind, nameNorm, j ?? null, j ?? null, j ?? null) as Row[];
  return rows.length === 1 ? rowToEntity(rows[0]) : null;
}

function mergeAliases(existing: Entity, newName: string): string[] {
  if (newName === existing.name || existing.aliases.includes(newName)) return existing.aliases;
  return [...existing.aliases, newName];
}

export function findEntityById(db: Database.Database, id: string): Entity | null {
  const row = db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToEntity(row) : null;
}

export interface ListFilter { kind?: EntityKind; jurisdiction?: string; limit?: number }

export function listEntities(db: Database.Database, f: ListFilter = {}): Entity[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (f.kind) { clauses.push("kind = ?"); params.push(f.kind); }
  if (f.jurisdiction) { clauses.push("jurisdiction = ?"); params.push(f.jurisdiction); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(f.limit ?? 50);
  const rows = db
    .prepare(`SELECT * FROM entities ${where} ORDER BY last_seen_at DESC LIMIT ?`)
    .all(...params) as Row[];
  return rows.map(rowToEntity);
}
```

- [ ] **Step 6.3: Test and commit**

```bash
pnpm test tests/unit/core/entities.test.ts
git add src/core/entities.ts tests/unit/core/entities.test.ts
git commit -m "feat: entity upsert with external_id and exact-name resolution"
```

---

## Task 7: Document upsert and queries

**Files:** `src/core/documents.ts`, `tests/unit/core/documents.test.ts`

- [ ] **Step 7.1: Write the failing test**

`tests/unit/core/documents.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { upsertEntity } from "../../../src/core/entities.js";
import {
  upsertDocument, queryDocuments, findDocumentsByEntity,
} from "../../../src/core/documents.js";

const TEST_DB = "./data/test-documents.db";
let store: Store;
beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});
afterEach(() => store.close());

describe("upsertDocument", () => {
  it("inserts new", () => {
    const r = upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "HR1234",
      occurred_at: "2026-03-01T00:00:00.000Z",
      source: { name: "congress", id: "hr-1234-119", url: "https://x/1" },
    });
    expect(r.created).toBe(true);
  });
  it("updates on source conflict", () => {
    const input = {
      kind: "bill" as const, jurisdiction: "us-federal", title: "v1",
      occurred_at: "2026-03-01T00:00:00.000Z",
      source: { name: "congress", id: "hr-1234-119", url: "https://x/1" },
    };
    upsertDocument(store.db, input);
    const second = upsertDocument(store.db, { ...input, title: "v2" });
    expect(second.created).toBe(false);
    expect(second.document.title).toBe("v2");
  });
  it("writes references", () => {
    const { entity } = upsertEntity(store.db, {
      kind: "person", name: "Jane",
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "HR1",
      occurred_at: "2026-03-01T00:00:00.000Z",
      source: { name: "congress", id: "1", url: "https://x/1" },
      references: [{ entity_id: entity.id, role: "sponsor" }],
    });
    expect(findDocumentsByEntity(store.db, entity.id)).toHaveLength(1);
  });
});

describe("queryDocuments", () => {
  beforeEach(() => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "HR1",
      occurred_at: "2026-03-01T00:00:00.000Z",
      source: { name: "congress", id: "1", url: "https://x/1" },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-federal", title: "HR2",
      occurred_at: "2026-04-01T00:00:00.000Z",
      source: { name: "congress", id: "2", url: "https://x/2" },
    });
  });
  it("filters by kind", () => {
    expect(queryDocuments(store.db, { kind: "bill", jurisdiction: "us-federal", limit: 10 })).toHaveLength(2);
  });
  it("filters by window", () => {
    const docs = queryDocuments(store.db, {
      kind: "bill", jurisdiction: "us-federal", from: "2026-03-15T00:00:00.000Z", limit: 10,
    });
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("HR2");
  });
  it("orders DESC by occurred_at", () => {
    const docs = queryDocuments(store.db, { kind: "bill", jurisdiction: "us-federal", limit: 10 });
    expect(docs[0].title).toBe("HR2");
  });
});
```

- [ ] **Step 7.2: Implement `src/core/documents.ts`**

```ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Document, type DocumentKind, type EntityReference } from "./types.js";

export interface UpsertDocInput {
  kind: DocumentKind;
  jurisdiction: string;
  title: string;
  summary?: string;
  occurred_at: string;
  source: { name: string; id: string; url: string };
  references?: EntityReference[];
  raw?: Record<string, unknown>;
}
export interface UpsertDocResult { document: Document; created: boolean }

interface DocRow {
  id: string; kind: string; jurisdiction: string; title: string;
  summary: string | null; occurred_at: string; fetched_at: string;
  source_name: string; source_id: string; source_url: string; raw: string;
}

function rowToDoc(r: DocRow, refs: EntityReference[] = []): Document {
  return Document.parse({
    id: r.id, kind: r.kind, jurisdiction: r.jurisdiction, title: r.title,
    summary: r.summary ?? undefined,
    occurred_at: r.occurred_at, fetched_at: r.fetched_at,
    source: { name: r.source_name, id: r.source_id, url: r.source_url },
    references: refs, raw: JSON.parse(r.raw),
  });
}

function writeReferences(db: Database.Database, docId: string, refs: EntityReference[]): void {
  db.prepare("DELETE FROM document_references WHERE document_id = ?").run(docId);
  const stmt = db.prepare(
    "INSERT INTO document_references (document_id, entity_id, role, qualifier) VALUES (?, ?, ?, ?)",
  );
  for (const ref of refs) stmt.run(docId, ref.entity_id, ref.role, ref.qualifier ?? null);
}

function loadRefs(db: Database.Database, docId: string): EntityReference[] {
  const rows = db
    .prepare("SELECT entity_id, role, qualifier FROM document_references WHERE document_id = ?")
    .all(docId) as Array<{ entity_id: string; role: string; qualifier: string | null }>;
  return rows.map((r) => ({
    entity_id: r.entity_id,
    role: r.role as EntityReference["role"],
    qualifier: r.qualifier ?? undefined,
  }));
}

export function upsertDocument(db: Database.Database, input: UpsertDocInput): UpsertDocResult {
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT * FROM documents WHERE source_name = ? AND source_id = ?")
    .get(input.source.name, input.source.id) as DocRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE documents
       SET kind = ?, jurisdiction = ?, title = ?, summary = ?, occurred_at = ?,
           fetched_at = ?, source_url = ?, raw = ?
       WHERE id = ?`,
    ).run(
      input.kind, input.jurisdiction, input.title, input.summary ?? null,
      input.occurred_at, now, input.source.url,
      JSON.stringify(input.raw ?? {}), existing.id,
    );
    writeReferences(db, existing.id, input.references ?? []);
    const merged = {
      ...existing,
      kind: input.kind,
      jurisdiction: input.jurisdiction,
      title: input.title,
      summary: input.summary ?? null,
      occurred_at: input.occurred_at,
      fetched_at: now,
      source_url: input.source.url,
      raw: JSON.stringify(input.raw ?? {}),
    } as DocRow;
    return { document: rowToDoc(merged, input.references ?? []), created: false };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO documents
     (id, kind, jurisdiction, title, summary, occurred_at, fetched_at,
      source_name, source_id, source_url, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.kind, input.jurisdiction, input.title, input.summary ?? null,
    input.occurred_at, now, input.source.name, input.source.id, input.source.url,
    JSON.stringify(input.raw ?? {}),
  );
  writeReferences(db, id, input.references ?? []);

  return {
    document: {
      id, kind: input.kind, jurisdiction: input.jurisdiction,
      title: input.title, summary: input.summary,
      occurred_at: input.occurred_at, fetched_at: now,
      source: input.source, references: input.references ?? [], raw: input.raw ?? {},
    },
    created: true,
  };
}

export interface QueryDocsFilter {
  kind?: DocumentKind;
  kinds?: DocumentKind[];
  jurisdiction?: string;
  from?: string;
  to?: string;
  limit: number;
}

export function queryDocuments(db: Database.Database, f: QueryDocsFilter): Document[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (f.kind) { clauses.push("kind = ?"); params.push(f.kind); }
  else if (f.kinds?.length) {
    const qs = f.kinds.map(() => "?").join(",");
    clauses.push(`kind IN (${qs})`);
    params.push(...f.kinds);
  }
  if (f.jurisdiction) { clauses.push("jurisdiction = ?"); params.push(f.jurisdiction); }
  if (f.from) { clauses.push("occurred_at >= ?"); params.push(f.from); }
  if (f.to) { clauses.push("occurred_at <= ?"); params.push(f.to); }
  params.push(f.limit);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM documents ${where} ORDER BY occurred_at DESC LIMIT ?`)
    .all(...params) as DocRow[];
  return rows.map((r) => rowToDoc(r, loadRefs(db, r.id)));
}

export function findDocumentsByEntity(
  db: Database.Database, entityId: string, limit = 50,
): Document[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT d.* FROM documents d
       JOIN document_references r ON d.id = r.document_id
       WHERE r.entity_id = ?
       ORDER BY d.occurred_at DESC
       LIMIT ?`,
    )
    .all(entityId, limit) as DocRow[];
  return rows.map((r) => rowToDoc(r, loadRefs(db, r.id)));
}
```

- [ ] **Step 7.3: Test and commit**

```bash
pnpm test tests/unit/core/documents.test.ts
git add src/core/documents.ts tests/unit/core/documents.test.ts
git commit -m "feat: document upsert and query with entity references"
```

---

## Task 8: Rate-limited HTTP client

**Files:** `src/util/http.ts`, `tests/unit/util/http.test.ts`

- [ ] **Step 8.1: Write test**

`tests/unit/util/http.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RateLimiter } from "../../../src/util/http.js";

describe("RateLimiter", () => {
  it("allows immediate call under limit", async () => {
    const rl = new RateLimiter({ tokensPerInterval: 5, intervalMs: 1000 });
    const start = Date.now();
    await rl.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("blocks when tokens exhausted", async () => {
    const rl = new RateLimiter({ tokensPerInterval: 2, intervalMs: 200 });
    await rl.acquire();
    await rl.acquire();
    const start = Date.now();
    await rl.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });
});
```

- [ ] **Step 8.2: Implement `src/util/http.ts`**

```ts
export interface RateLimiterOptions {
  tokensPerInterval: number;
  intervalMs: number;
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  constructor(private opts: RateLimiterOptions) {
    this.tokens = opts.tokensPerInterval;
    this.lastRefill = Date.now();
  }
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = this.opts.intervalMs / this.opts.tokensPerInterval;
    await sleep(waitMs);
    return this.acquire();
  }
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = (elapsed / this.opts.intervalMs) * this.opts.tokensPerInterval;
    if (newTokens >= 1) {
      this.tokens = Math.min(
        this.opts.tokensPerInterval,
        this.tokens + Math.floor(newTokens),
      );
      this.lastRefill = now;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchOptions extends RequestInit {
  userAgent: string;
  rateLimiter?: RateLimiter;
  retries?: number;
}

export async function rateLimitedFetch(url: string, opts: FetchOptions): Promise<Response> {
  const { userAgent, rateLimiter, retries = 3, ...init } = opts;
  const headers = new Headers(init.headers ?? {});
  headers.set("User-Agent", userAgent);

  let attempt = 0;
  while (true) {
    if (rateLimiter) await rateLimiter.acquire();
    const res = await fetch(url, { ...init, headers });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) return res;
      const retryAfter = Number(res.headers.get("Retry-After") ?? 0) * 1000;
      const backoff = retryAfter || Math.min(30000, 1000 * Math.pow(2, attempt));
      await sleep(backoff);
      attempt += 1;
      continue;
    }
    return res;
  }
}
```

- [ ] **Step 8.3: Test and commit**

```bash
pnpm test tests/unit/util/http.test.ts
git add src/util/http.ts tests/unit/util/http.test.ts
git commit -m "feat: rate-limited fetch with exponential backoff"
```

---

## Task 9: MCP server skeleton + logger

**Files:** `src/util/logger.ts`, `src/mcp/server.ts`, `src/index.ts`,
`tests/unit/mcp/server.test.ts`

- [ ] **Step 9.1: Write the failing test**

`tests/unit/mcp/server.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildServer } from "../../../src/mcp/server.js";

describe("buildServer", () => {
  it("constructs an MCP server with no tools registered yet", () => {
    const { mcp, store } = buildServer({ dbPath: ":memory:" });
    expect(mcp).toBeDefined();
    expect(store).toBeDefined();
    store.close();
  });
});
```

- [ ] **Step 9.2: Implement `src/util/logger.ts`**

```ts
type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const envLevel = (process.env.LOG_LEVEL as Level) ?? "info";
const threshold = LEVELS[envLevel] ?? LEVELS.info;

function log(level: Level, message: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  // MCP uses stdio; logs must go to stderr.
  const line = JSON.stringify({ level, message, ...extra, ts: new Date().toISOString() });
  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (msg: string, x?: Record<string, unknown>) => log("debug", msg, x),
  info:  (msg: string, x?: Record<string, unknown>) => log("info",  msg, x),
  warn:  (msg: string, x?: Record<string, unknown>) => log("warn",  msg, x),
  error: (msg: string, x?: Record<string, unknown>) => log("error", msg, x),
};
```

- [ ] **Step 9.3: Implement `src/mcp/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openStore, type Store } from "../core/store.js";

export interface BuildServerOptions { dbPath: string }
export interface CivicAwarenessServer { mcp: McpServer; store: Store }

export function buildServer(opts: BuildServerOptions): CivicAwarenessServer {
  const store = openStore(opts.dbPath);
  const mcp = new McpServer(
    { name: "civic-awareness-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  // Phase 2 registers tools here.
  return { mcp, store };
}
```

- [ ] **Step 9.4: Implement `src/index.ts`**

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./mcp/server.js";
import { logger } from "./util/logger.js";

const DB_PATH = process.env.CIVIC_AWARENESS_DB ?? "./data/civic-awareness.db";

async function main(): Promise<void> {
  logger.info("starting civic-awareness-mcp", { dbPath: DB_PATH });
  const { mcp } = buildServer({ dbPath: DB_PATH });
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info("ready");
}

main().catch((err) => {
  logger.error("fatal", { error: String(err) });
  process.exit(1);
});
```

- [ ] **Step 9.5: Run tests, build, commit**

```bash
pnpm test
pnpm build
git add src/util/logger.ts src/mcp/server.ts src/index.ts tests/unit/mcp/server.test.ts
git commit -m "feat: MCP server scaffold over stdio"
```

---

## Task 10: Bootstrap CLI

**Files:** `src/cli/bootstrap.ts`, `tests/unit/cli/bootstrap.test.ts`

- [ ] **Step 10.1: Write the failing test**

`tests/unit/cli/bootstrap.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { bootstrap } from "../../../src/cli/bootstrap.js";
import { openStore } from "../../../src/core/store.js";

const TEST_DB = "./data/test-bootstrap.db";
afterEach(() => { if (existsSync(TEST_DB)) rmSync(TEST_DB); });

describe("bootstrap", () => {
  it("creates DB with schema and seeded jurisdictions", async () => {
    await bootstrap({ dbPath: TEST_DB });
    const s = openStore(TEST_DB);
    const c = s.db.prepare("SELECT COUNT(*) as c FROM jurisdictions").get() as { c: number };
    // Keep in sync with seedJurisdictions: us-federal + all 50 states.
    expect(c.c).toBe(51);
    s.close();
  });
});
```

- [ ] **Step 10.2: Implement `src/cli/bootstrap.ts`**

```ts
import { openStore } from "../core/store.js";
import { seedJurisdictions } from "../core/seeds.js";
import { logger } from "../util/logger.js";

export interface BootstrapOptions { dbPath: string }

export async function bootstrap(opts: BootstrapOptions): Promise<void> {
  logger.info("bootstrapping store", { dbPath: opts.dbPath });
  const store = openStore(opts.dbPath);
  seedJurisdictions(store.db);
  store.close();
  logger.info("bootstrap complete");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.CIVIC_AWARENESS_DB ?? "./data/civic-awareness.db";
  bootstrap({ dbPath }).catch((err) => {
    logger.error("bootstrap failed", { error: String(err) });
    process.exit(1);
  });
}
```

- [ ] **Step 10.3: Run bootstrap end-to-end and commit**

```bash
pnpm test tests/unit/cli/bootstrap.test.ts
rm -rf ./data
pnpm bootstrap
ls -la ./data/civic-awareness.db
git add src/cli/bootstrap.ts tests/unit/cli/bootstrap.test.ts
git commit -m "feat: bootstrap CLI"
```

---

## Task 11: Local run instructions in README

**Files:** modify `README.md`.

- [ ] **Step 11.1: Append run instructions**

Add to `README.md` after "Documentation map":

````markdown
## Running locally

```bash
pnpm install
pnpm bootstrap   # creates ./data/civic-awareness.db
pnpm test
pnpm build
pnpm start       # runs the MCP over stdio
```

Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "civic-awareness": {
      "command": "node",
      "args": ["/absolute/path/to/civic-awareness-mcp/dist/index.js"]
    }
  }
}
```
````

- [ ] **Step 11.2: Commit**

```bash
git add README.md
git commit -m "docs: add local run instructions"
```

---

## Phase 1 completion checklist

- [ ] `pnpm test` passes with zero failures
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` succeeds and produces `dist/`
- [ ] `pnpm bootstrap` creates `./data/civic-awareness.db` with seeded jurisdictions
- [ ] Smoke test from Task 9: MCP server responds to `initialize` over stdio
- [ ] All commits are in git; branch is clean
- [ ] `docs/06-open-decisions.md` has **Decided** entries for D1–D6 and D10

Once green, proceed to `docs/plans/phase-2-openstates.md`.

---

## Self-review

- **Spec coverage:** All scope from `docs/02-architecture.md` Phase 1
  (scaffolding + core store + empty MCP) is implemented.
- **No placeholders:** Every step has concrete code and exact commands.
- **Type consistency:** `Entity`, `Document`, `EntityKind`, `DocumentKind`
  defined once in Task 2, used identically in Tasks 6, 7, 9. Function
  names (`upsertEntity`, `upsertDocument`, `queryDocuments`,
  `findDocumentsByEntity`, `findEntityById`, `listEntities`,
  `seedJurisdictions`, `openStore`, `buildServer`, `bootstrap`) match
  between tests, implementations, and callers.

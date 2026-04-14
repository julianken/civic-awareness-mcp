# Phase 8e — `search_civic_documents` Vertical Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`.

**Goal:** Migrate `search_civic_documents` off `ensureFresh`/`sourcesFor`. Under R15 this tool is **local-only** — it searches the existing corpus populated by other tools' shaped fetches. No adapter methods added. Add an `empty_reason: "store_not_warmed"` diagnostic when the local store has no documents matching the query.

**Architecture:** Simplest vertical. Drop the `ensureFresh` loop; add one diagnostic branch.

---

## Task 1: Handler rewrite + unit tests

**Files:** `src/mcp/tools/search_civic_documents.ts`, `tests/unit/mcp/tools/search_civic_documents.test.ts`

- [ ] **Step 1: Rewrite the handler.**

Replace `handleSearchDocuments`:

```ts
import type Database from "better-sqlite3";
import type { DocumentKind } from "../../core/types.js";
import { SearchDocumentsInput } from "../schemas.js";
import { escapeLike } from "../../util/sql.js";
import type { StaleNotice } from "../shared.js";

// ... keep all existing interfaces: DocumentMatch, SearchDocumentsResponse, Row ...

export interface SearchDocumentsResponse {
  results: DocumentMatch[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  empty_reason?: "store_not_warmed";
  hint?: string;
  stale_notice?: StaleNotice;
}

export async function handleSearchDocuments(
  db: Database.Database,
  rawInput: unknown,
): Promise<SearchDocumentsResponse> {
  const input = SearchDocumentsInput.parse(rawInput);

  const clauses = ["title LIKE ? ESCAPE '\\'"];
  const params: unknown[] = [`%${escapeLike(input.q)}%`];
  if (input.jurisdiction) {
    clauses.push("jurisdiction = ?");
    params.push(input.jurisdiction);
  }
  if (input.kinds?.length) {
    const qs = input.kinds.map(() => "?").join(",");
    clauses.push(`kind IN (${qs})`);
    params.push(...input.kinds);
  }
  if (input.sources?.length) {
    const qs = input.sources.map(() => "?").join(",");
    clauses.push(`source_name IN (${qs})`);
    params.push(...input.sources);
  }
  if (input.from) { clauses.push("occurred_at >= ?"); params.push(input.from); }
  if (input.to)   { clauses.push("occurred_at <= ?"); params.push(input.to); }
  params.push(input.limit);

  const rows = db.prepare(
    `SELECT id, kind, title, summary, occurred_at, source_url, source_name, jurisdiction
     FROM documents WHERE ${clauses.join(" AND ")}
     ORDER BY occurred_at DESC LIMIT ?`,
  ).all(...params) as Row[];

  const sourceKeys = new Map<string, { name: string; jurisdiction: string }>();
  const results: DocumentMatch[] = rows.map((r) => {
    sourceKeys.set(`${r.source_name}|${r.jurisdiction}`, {
      name: r.source_name, jurisdiction: r.jurisdiction,
    });
    return {
      id: r.id, kind: r.kind, title: r.title,
      summary: r.summary ?? undefined,
      occurred_at: r.occurred_at, source_url: r.source_url,
    };
  });

  const sources = Array.from(sourceKeys.values()).map(({ name, jurisdiction }) => {
    if (name === "openstates") {
      const stateAbbr = jurisdiction.replace(/^us-/, "");
      return { name, url: `https://openstates.org/${stateAbbr}/` };
    }
    return { name, url: "" };
  });

  const response: SearchDocumentsResponse = { results, total: results.length, sources };

  if (results.length === 0) {
    // Check whether the store has ANY documents in the queried jurisdiction/kind.
    // If not, caller should warm the cache by calling recent_bills / recent_votes / etc.
    const anyRow = db.prepare(
      `SELECT 1 FROM documents ${input.jurisdiction ? "WHERE jurisdiction = ?" : ""} LIMIT 1`,
    ).get(...(input.jurisdiction ? [input.jurisdiction] : [])) as unknown;
    if (!anyRow) {
      response.empty_reason = "store_not_warmed";
      response.hint = input.jurisdiction
        ? `No documents for ${input.jurisdiction}. Try calling recent_bills/recent_votes/recent_contributions first to warm the cache.`
        : "Local store is empty. Try calling a feed tool (recent_bills, recent_votes, recent_contributions) first to warm the cache.";
    }
  }

  return response;
}
```

- [ ] **Step 2: Rewrite unit tests.**

Remove `vi.mock("../../../../src/core/hydrate.js", ...)` and `ensureFresh`/`sourcesFor` mocks. Preserve existing scenarios (search by query, jurisdiction filter, kinds filter, sources filter, from/to window, limit).

Add:
- `empty_reason: "store_not_warmed"` is set when query returns empty AND store has no matching docs
- `empty_reason` is NOT set when query returns empty but store has other docs (regular miss, not cold store)

Example:

```ts
it("sets empty_reason: store_not_warmed when local store is empty", async () => {
  const result = await handleSearchDocuments(db, { q: "test", limit: 10 });
  expect(result.results).toEqual([]);
  expect(result.empty_reason).toBe("store_not_warmed");
  expect(result.hint).toContain("warm the cache");
});

it("does NOT set empty_reason when store has docs but none match", async () => {
  // Pre-seed a document that doesn't match the query.
  db.prepare(
    `INSERT INTO documents (id, source_name, source_id, kind, jurisdiction,
       title, summary, occurred_at, fetched_at, source_url, raw)
     VALUES ('d1', 'openstates', 'x1', 'bill', 'us-tx',
       'HB1 — Unrelated', NULL, '2026-04-10T00:00:00Z', datetime('now'),
       'https://openstates.org/tx/bills/HB1', '{}')`,
  ).run();

  const result = await handleSearchDocuments(db, { q: "nomatch", limit: 10 });
  expect(result.results).toEqual([]);
  expect(result.empty_reason).toBeUndefined();
});
```

- [ ] **Step 3: Unit tests green.**

- [ ] **Step 4: Full suite — expect some integration failures** (R13 scenarios referencing ensureFresh for search_civic_documents).

- [ ] **Step 5: Commit.**

```bash
git add src/mcp/tools/search_civic_documents.ts tests/unit/mcp/tools/search_civic_documents.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): search_civic_documents local-only under R15

Drops the ensureFresh/sourcesFor fanout loop. Under R15 this tool
reads whatever other tools have already hydrated into documents;
when the local store has no matching docs, returns an empty result
with empty_reason: "store_not_warmed" and a hint pointing at
recent_bills/recent_votes/recent_contributions to warm the cache.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Integration test cleanup

**Files:** Any integration test file referencing search_civic_documents on R13 path.

- [ ] **Step 1: Grep for R13 search_civic_documents scenarios.** `grep -r "handleSearchDocuments\|search_civic_documents" tests/integration/`. Delete scenarios that use `ensureFresh` mocks. Preserve scenarios that exercise pure-local semantics.

- [ ] **Step 2: Full suite green.**

- [ ] **Step 3: Commit.**

```bash
git add tests/integration/
git commit -m "$(cat <<'EOF'
test: drop R13 scenarios for search_civic_documents

Search is local-only under R15 — no ensureFresh integration to test.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Acceptance

- [ ] `pnpm test` green.
- [ ] `pnpm build` clean.
- [ ] `grep ensureFresh src/mcp/tools/search_civic_documents.ts` = 0.
- [ ] `grep sourcesFor src/mcp/tools/search_civic_documents.ts` = 0.
- [ ] `empty_reason: "store_not_warmed"` present in `SearchDocumentsResponse` type.

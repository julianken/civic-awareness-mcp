# Phase 8i — Deletion + Release Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`.

**Goal:** Delete R13 infrastructure now that all 9 tools are on R15. Drop the `hydrations` table via migration 006. Bump to 0.3.0. Clean up all remaining R13 references.

---

## Files to delete

- `src/core/hydrate.ts`
- `src/core/freshness.ts`
- `tests/unit/core/hydrate.test.ts`
- `tests/unit/core/freshness.test.ts`
- `tests/unit/core/hydrations-migration.test.ts` (if exists)
- `tests/integration/passthrough-e2e.test.ts` (legacy R13 integration file; shaped replacement exists)
- `scripts/smoke-passthrough.ts` (R13 smoke script)

## Files to modify

- `src/core/migrations/006-drop-hydrations.sql` (NEW): `DROP TABLE hydrations;`
- `src/core/store.ts`: add version-6 registration; bump test count expectation if needed
- `src/index.ts`: remove any re-exports of `ensureFresh`/`sourcesFor` (if present)
- `tests/integration/phase5-e2e.test.ts`: remove any stale import of `ensureFresh` types (if the adapter-stub rewrite left imports behind)
- `package.json`: version `0.2.0` → `0.3.0`
- `src/mcp/server.ts`: update the hardcoded version string (line ~30) to match
- `CHANGELOG.md` (create if missing): add entry for 0.3.0 describing R15
- `CLAUDE.md`: remove the "Phase-8 migration in flight" banner; update "Refresh" bullet to final R15 wording

## Tasks

### Task 1: Migration 006 + store.ts registration + CLI check

- [ ] Create `src/core/migrations/006-drop-hydrations.sql`:

```sql
DROP TABLE IF EXISTS hydrations;
```

- [ ] In `src/core/store.ts`, add `{ version: 6, file: "006-drop-hydrations.sql" }` to `MIGRATIONS`.
- [ ] If `tests/unit/core/store.test.ts` has a migration-count assertion, bump from 5 to 6.
- [ ] Verify `scripts/refresh.ts` or `src/cli/refresh.ts` still compiles — it should not depend on `hydrate.ts`/`freshness.ts`.
- [ ] Fresh-DB test: `rm /tmp/t.db; CIVIC_AWARENESS_DB_PATH=/tmp/t.db pnpm bootstrap` then `sqlite3 /tmp/t.db ".schema hydrations"` should return empty.
- [ ] Full suite green.
- [ ] Commit: `feat(migrations): 006 drop hydrations table`

### Task 2: Delete R13 source modules

- [ ] Delete `src/core/hydrate.ts` and `src/core/freshness.ts`.
- [ ] Check `src/index.ts` for re-exports — remove any.
- [ ] Check `src/core/limiters.ts` and `src/core/budget.ts` — if they import `HydrationSource` from `freshness.ts`, inline the type locally (`type HydrationSource = "openstates" | "congress" | "openfec"`).
- [ ] Check `src/core/tool_cache.ts` and `src/core/fetch_log.ts` — same: move the `HydrationSource` import from `./freshness.js` to a local type definition or to a new `src/core/sources.ts` module.
- [ ] Verify `pnpm build` compiles.
- [ ] Full suite green.
- [ ] Commit: `refactor: delete R13 hydrate + freshness modules`

### Task 3: Delete R13 tests + smoke script

- [ ] Delete `tests/unit/core/hydrate.test.ts`, `tests/unit/core/freshness.test.ts`.
- [ ] Delete `tests/unit/core/hydrations-migration.test.ts` if it exists.
- [ ] Delete `tests/integration/passthrough-e2e.test.ts`.
- [ ] Delete `scripts/smoke-passthrough.ts`.
- [ ] Check `tests/integration/phase5-e2e.test.ts` for stale imports — remove any.
- [ ] Full suite green.
- [ ] Commit: `test: delete R13-era tests and smoke script`

### Task 4: Version bump + CHANGELOG

- [ ] `package.json`: version `0.2.0` → `0.3.0`.
- [ ] `src/mcp/server.ts`: update hardcoded version string (search for `"0.2.0"`).
- [ ] `CHANGELOG.md`: add entry:

```markdown
## 0.3.0 (2026-04-14)

### Changed
- Hydration architecture rewritten from R13 (jurisdiction-wide
  pass-through cache) to R15 (shaped-query hydration per endpoint).
  All 9 MCP tools now use `withShapedFetch` with narrow
  shape-specific adapter methods.
- Cache key migrated from `hydrations(source, jurisdiction, scope)`
  to `fetch_log(source, endpoint_path, args_hash)`.
- `stale_notice` narrowed: retired `partial_hydrate`,
  `rate_limited`, and `daily_budget_exhausted` reasons.
  `upstream_failure` is the only reason emitted when cached data
  exists as fallback.

### Removed
- `hydrations` table (migration 006).
- `src/core/hydrate.ts`, `src/core/freshness.ts`.

### Cache state
- Upgraders lose their R13 `hydrations` rows on first launch.
  Fine-grained `fetch_log` rows are populated fresh on next tool
  calls. DailyBudget prevents refetch storm.
```

- [ ] Commit: `chore(release): v0.3.0 — R15 shaped-query hydration`

### Task 5: CLAUDE.md cleanup

- [ ] Remove the "Phase-8 migration in flight" banner (lines 50-61 of current CLAUDE.md).
- [ ] Update the "Refresh" bullet — drop the "R13 → R15" arrow chain; describe R15 as current:

```markdown
- **Refresh (D5 → R15):** Tools call `withShapedFetch(db, key, ttl,
  fetchAndWrite, readLocal, peekWaitMs)` from `src/core/tool_cache.ts`.
  Cache key is `(source, endpoint_path, args_hash)`; freshness rows
  live in the `fetch_log` table. Upstream fetch + write-through happen
  in one transaction; `fetch_log` is updated in the same transaction.
  `stale_notice` fires only when an upstream fetch failed and cached
  data exists as fallback. `pnpm refresh` CLI remains for operator
  bulk pre-fill.
```

- [ ] Update the "How to think about this MCP" section's "Shaped-query hydration" bullet — drop "(in flight)".
- [ ] Update the "What NOT to do" bullet — drop the "hydrations table retained through phase 8.10" clause.
- [ ] Commit: `docs(claude.md): R15 complete — remove migration-in-flight banner`

## Acceptance

- `grep ensureFresh src/` = 0 matches (other than historical comment references, if any)
- `grep sourcesFor src/` = 0
- `grep 'hydrations' src/core/migrations/` = matches 004 + 006 only (create + drop)
- `pnpm test` green
- `pnpm build` clean
- `sqlite3 <fresh DB> ".schema hydrations"` = empty
- `sqlite3 <fresh DB> ".schema fetch_log"` = table exists

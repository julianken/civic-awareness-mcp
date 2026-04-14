# Phase 8f — `resolve_person` + `search_entities` Vertical Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`.

**Goal:** Migrate `resolve_person` AND `search_entities` off `ensureFresh` in a single paired vertical. Both tools hit the same underlying endpoints (OpenStates `/people`, OpenFEC `/candidates/search`, Congress.gov `/member`) — so they share `fetch_log` rows under R15's endpoint-keyed cache, meaning a `resolve_person` call warms the cache for a subsequent `search_entities` call with the same name/jurisdiction.

**Architecture:** Three narrow adapter methods (`searchPeople`), paired handler rewrite, unit test rewrite, integration cleanup.

---

## Task 1: OpenStates `searchPeople`

`src/adapters/openstates.ts`, `tests/unit/adapters/openstates.test.ts`

```ts
async searchPeople(
  db: Database.Database,
  opts: { jurisdiction?: string; name?: string; limit?: number },
): Promise<{ entitiesUpserted: number }> {
  const url = new URL(`${BASE_URL}/people`);
  if (opts.jurisdiction) {
    const abbr = opts.jurisdiction.replace(/^us-/, "").toLowerCase();
    url.searchParams.set("jurisdiction", abbr);
  }
  if (opts.name) url.searchParams.set("name", opts.name);
  url.searchParams.set("per_page", String(opts.limit ?? 20));

  const res = await rateLimitedFetch(url.toString(), {
    userAgent: "civic-awareness-mcp/0.1.0 (+github)",
    rateLimiter: this.rateLimiter,
    headers: { "X-API-KEY": this.opts.apiKey },
  });
  if (!res.ok) throw new Error(`OpenStates /people returned ${res.status}`);
  const body = (await res.json()) as { results?: OpenStatesPerson[] };
  let entitiesUpserted = 0;
  for (const p of body.results ?? []) {
    this.upsertPerson(db, p);
    entitiesUpserted += 1;
  }
  return { entitiesUpserted };
}
```

Tests: 2 (happy path with jurisdiction+name params, writes person; empty response returns 0).

Commit: `feat(openstates): searchPeople narrow method for R15 people search`

---

## Task 2: OpenFEC `searchCandidates`

`src/adapters/openfec.ts`, `tests/unit/adapters/openfec.test.ts`

```ts
async searchCandidates(
  db: Database.Database,
  opts: { q: string; limit?: number },
): Promise<{ entitiesUpserted: number }> {
  const url = new URL(`${BASE_URL}/candidates/search/`);
  url.searchParams.set("q", opts.q);
  url.searchParams.set("per_page", String(opts.limit ?? 20));
  url.searchParams.set("api_key", this.opts.apiKey);

  const res = await rateLimitedFetch(url.toString(), {
    userAgent: "civic-awareness-mcp/0.1.0 (+github)",
    rateLimiter: this.rateLimiter,
  });
  if (!res.ok) throw new Error(`OpenFEC /candidates/search returned ${res.status}`);
  const body = (await res.json()) as { results?: FecCandidate[] };
  let entitiesUpserted = 0;
  for (const c of body.results ?? []) {
    this.upsertCandidate(db, c);
    entitiesUpserted += 1;
  }
  return { entitiesUpserted };
}
```

Tests: 2 (happy path asserts `q=`, writes candidate; empty returns 0).

Commit: `feat(openfec): searchCandidates narrow method for R15 entity search`

---

## Task 3: Congress.gov `searchMembers`

`src/adapters/congress.ts`, `tests/unit/adapters/congress.test.ts`

Congress.gov has no name-search endpoint. This fetches one page of `/member?congress=N` for the current congress and relies on the local store's subsequent query to filter by name. The page of 250 members per congress is ~the full current House + Senate, so this effectively refreshes the federal member list.

```ts
async searchMembers(
  db: Database.Database,
  opts: { limit?: number } = {},
): Promise<{ entitiesUpserted: number }> {
  const congress = this.congresses[0];
  const url = new URL(`${BASE_URL}/member`);
  url.searchParams.set("congress", String(congress));
  url.searchParams.set("limit", String(opts.limit ?? 250));
  url.searchParams.set("api_key", this.opts.apiKey);

  const res = await rateLimitedFetch(url.toString(), {
    userAgent: "civic-awareness-mcp/0.1.0 (+github)",
    rateLimiter: this.rateLimiter,
  });
  if (!res.ok) throw new Error(`Congress.gov /member returned ${res.status}`);
  const body = (await res.json()) as { members?: CongressMember[] };
  let entitiesUpserted = 0;
  for (const m of body.members ?? []) {
    this.upsertMember(db, m);
    entitiesUpserted += 1;
  }
  return { entitiesUpserted };
}
```

Tests: 2 (happy path asserts `congress=119` in URL, writes member; empty returns 0).

Commit: `feat(congress): searchMembers narrow method for R15 member search`

---

## Task 4: `search_entities` handler rewrite

`src/mcp/tools/search_entities.ts`, `tests/unit/mcp/tools/search_entities.test.ts`

Rewrite around `withShapedFetch`. Pattern:

- If `input.jurisdiction` is not set → local-only (SELECT from `entities`)
- If `input.jurisdiction === "us-federal"` → call both Congress.gov `searchMembers` AND OpenFEC `searchCandidates`
- If `input.jurisdiction === "us-<state>"` → call OpenStates `searchPeople({jurisdiction, name: q})`

Each source's fetch is guarded by its own `withShapedFetch` call (distinct endpoint paths, shared keys with `resolve_person`). Result is always the local SQL projection — same as today. Multiple `withShapedFetch` calls run in parallel via `Promise.all`.

Key shape:

```ts
const projectLocal = (): SearchEntitiesResponse => {
  // existing SELECT from entities + roles_seen mapping, unchanged
};

if (!input.jurisdiction) {
  return projectLocal();  // local-only
}

const ttl = { scope: "full" as const, ms: 24 * 60 * 60 * 1000 };
const calls: Promise<unknown>[] = [];

if (input.jurisdiction === "us-federal") {
  calls.push(
    withShapedFetch(
      db,
      { source: "congress", endpoint_path: "/member", args: {}, tool: "searchMembers" },
      ttl,
      async () => {
        const adapter = new CongressAdapter({ apiKey: requireEnv("API_DATA_GOV_KEY"), rateLimiter: getLimiter("congress") });
        const r = await adapter.searchMembers(db);
        return { primary_rows_written: r.entitiesUpserted };
      },
      () => {},  // readLocal is no-op for the fanout; we project at the end
      () => getLimiter("congress").peekWaitMs(),
    ),
    withShapedFetch(
      db,
      { source: "openfec", endpoint_path: "/candidates/search", args: { q: input.q }, tool: "searchCandidates" },
      ttl,
      async () => {
        const adapter = new OpenFecAdapter({ apiKey: requireEnv("API_DATA_GOV_KEY"), rateLimiter: getLimiter("openfec") });
        const r = await adapter.searchCandidates(db, { q: input.q });
        return { primary_rows_written: r.entitiesUpserted };
      },
      () => {},
      () => getLimiter("openfec").peekWaitMs(),
    ),
  );
} else {
  calls.push(
    withShapedFetch(
      db,
      { source: "openstates", endpoint_path: "/people", args: { jurisdiction: input.jurisdiction, name: input.q }, tool: "searchPeople" },
      ttl,
      async () => {
        const adapter = new OpenStatesAdapter({ apiKey: requireEnv("OPENSTATES_API_KEY"), rateLimiter: getLimiter("openstates") });
        const r = await adapter.searchPeople(db, { jurisdiction: input.jurisdiction, name: input.q });
        return { primary_rows_written: r.entitiesUpserted };
      },
      () => {},
      () => getLimiter("openstates").peekWaitMs(),
    ),
  );
}

// Collect stale_notices — surface the first one
let stale_notice: StaleNotice | undefined;
for (const r of await Promise.all(calls)) {
  const res = r as { stale_notice?: StaleNotice };
  if (res.stale_notice && !stale_notice) stale_notice = res.stale_notice;
}

const response = projectLocal();
if (stale_notice) response.stale_notice = stale_notice;
return response;
```

Note the `tool` field is `"searchMembers"` / `"searchCandidates"` / `"searchPeople"` — this is the CANONICAL tool for that endpoint, and `resolve_person` will use the same tool names for its calls so the cache is shared.

Unit test rewrite: mock the three adapter methods; test local-only (no jurisdiction), federal fanout, state fanout, cache hit, stale_notice propagation.

Commit: `feat(mcp): search_entities on withShapedFetch (R15)`

---

## Task 5: `resolve_person` handler rewrite

`src/mcp/tools/resolve_person.ts`, `tests/unit/mcp/tools/resolve_person.test.ts`

Similar fanout as `search_entities` but the tool has `jurisdiction_hint` (optional) and `role_hint` (optional). Shared cache keys with `search_entities` (same `tool` names: "searchMembers", "searchCandidates", "searchPeople").

If `input.jurisdiction_hint` is set, fan out like search_entities. Otherwise, local-only (existing behavior — the current code already short-circuits without jurisdiction_hint).

Preserve the existing three-tier resolution logic (exact name match → alias match → fuzzy with linking signal). Just replace the ensureFresh loop at the top.

Commit: `feat(mcp): resolve_person on withShapedFetch (R15)`

---

## Task 6: Integration cleanup + shaped e2e scenarios

Drop R13 scenarios for `search_entities` / `resolve_person` from integration test files. Add scenarios to `passthrough-e2e.shaped.test.ts`:

1. `search_entities` federal: calls both Congress.gov and OpenFEC → `upstreamHits === 2`
2. `search_entities` state (us-tx) + subsequent `resolve_person` with same jurisdiction/name: second call is cache hit (shared endpoint)
3. `resolve_person` upstream failure with no cache propagates

Commit: `test: resolve_person + search_entities integration on R15 path`

---

## Acceptance

- `grep ensureFresh src/mcp/tools/search_entities.ts` = 0
- `grep ensureFresh src/mcp/tools/resolve_person.ts` = 0
- `pnpm test` green
- `pnpm build` clean

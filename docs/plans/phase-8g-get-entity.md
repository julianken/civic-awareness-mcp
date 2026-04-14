# Phase 8g — `get_entity` Vertical Plan

**Goal:** Migrate `get_entity` off `ensureFresh` onto per-source direct-lookup `withShapedFetch`. Each entity has 0-3 external IDs; fanout narrowly to the sources that have them.

---

## Task 1: Three narrow "fetch by ID" adapter methods

### OpenStates `fetchPerson(db, ocd_id)`

Direct lookup: `/people/{ocd-id}`. Writes-through via existing `upsertPerson`.

```ts
async fetchPerson(
  db: Database.Database,
  ocdId: string,
): Promise<{ entitiesUpserted: number }> {
  const url = `${BASE_URL}/people/${encodeURIComponent(ocdId)}`;
  const res = await rateLimitedFetch(url, {
    userAgent: "civic-awareness-mcp/0.1.0 (+github)",
    rateLimiter: this.rateLimiter,
    headers: { "X-API-KEY": this.opts.apiKey },
  });
  if (res.status === 404) return { entitiesUpserted: 0 };
  if (!res.ok) throw new Error(`OpenStates /people/${ocdId} returned ${res.status}`);
  const body = (await res.json()) as OpenStatesPerson;
  this.upsertPerson(db, body);
  return { entitiesUpserted: 1 };
}
```

Tests: happy path, 404 returns 0.

### Congress.gov `fetchMember(db, bioguide_id)`

```ts
async fetchMember(
  db: Database.Database,
  bioguideId: string,
): Promise<{ entitiesUpserted: number }> {
  const url = new URL(`${BASE_URL}/member/${bioguideId}`);
  url.searchParams.set("api_key", this.opts.apiKey);
  const res = await rateLimitedFetch(url.toString(), {
    userAgent: "civic-awareness-mcp/0.1.0 (+github)",
    rateLimiter: this.rateLimiter,
  });
  if (res.status === 404) return { entitiesUpserted: 0 };
  if (!res.ok) throw new Error(`Congress.gov /member/${bioguideId} returned ${res.status}`);
  const body = (await res.json()) as { member?: CongressMember };
  if (!body.member) return { entitiesUpserted: 0 };
  this.upsertMember(db, body.member);
  return { entitiesUpserted: 1 };
}
```

Tests: happy path, 404 returns 0.

### OpenFEC `fetchCandidate(db, fec_candidate_id)`

```ts
async fetchCandidate(
  db: Database.Database,
  candidateId: string,
): Promise<{ entitiesUpserted: number }> {
  const url = new URL(`${BASE_URL}/candidate/${candidateId}/`);
  url.searchParams.set("api_key", this.opts.apiKey);
  const res = await rateLimitedFetch(url.toString(), {
    userAgent: "civic-awareness-mcp/0.1.0 (+github)",
    rateLimiter: this.rateLimiter,
  });
  if (res.status === 404) return { entitiesUpserted: 0 };
  if (!res.ok) throw new Error(`OpenFEC /candidate/${candidateId} returned ${res.status}`);
  const body = (await res.json()) as { results?: FecCandidate[] };
  const c = body.results?.[0];
  if (!c) return { entitiesUpserted: 0 };
  this.upsertCandidate(db, c, this.cycles[0]);
  return { entitiesUpserted: 1 };
}
```

Tests: happy path, 404 returns 0.

Commits: one per adapter method.

---

## Task 2: `get_entity` handler rewrite

Replace the `sourcesForFullHydrate` loop with per-external-ID fanout. Only hit a source if the entity has that source's external ID.

```ts
export async function handleGetEntity(db, rawInput) {
  const input = GetEntityInput.parse(rawInput);
  const entity = findEntityById(db, input.id);
  if (!entity) throw new Error(`Entity not found: ${input.id}`);

  const ttl = { scope: "detail" as const, ms: 24 * 60 * 60 * 1000 };
  const calls: Promise<{ stale_notice?: StaleNotice }>[] = [];

  if (entity.external_ids.bioguide) {
    const bioguide = entity.external_ids.bioguide;
    calls.push(
      withShapedFetch(
        db,
        { source: "congress", endpoint_path: `/member/${bioguide}`, args: { bioguide }, tool: "fetchMember" },
        ttl,
        async () => {
          const adapter = new CongressAdapter({ apiKey: requireEnv("API_DATA_GOV_KEY"), rateLimiter: getLimiter("congress") });
          const r = await adapter.fetchMember(db, bioguide);
          return { primary_rows_written: r.entitiesUpserted };
        },
        () => {},
        () => getLimiter("congress").peekWaitMs(),
      ),
    );
  }

  if (entity.external_ids.openstates_person) {
    const ocdId = entity.external_ids.openstates_person;
    calls.push(
      withShapedFetch(
        db,
        { source: "openstates", endpoint_path: `/people/${ocdId}`, args: { ocdId }, tool: "fetchPerson" },
        ttl,
        async () => {
          const adapter = new OpenStatesAdapter({ apiKey: requireEnv("OPENSTATES_API_KEY"), rateLimiter: getLimiter("openstates") });
          const r = await adapter.fetchPerson(db, ocdId);
          return { primary_rows_written: r.entitiesUpserted };
        },
        () => {},
        () => getLimiter("openstates").peekWaitMs(),
      ),
    );
  }

  if (entity.external_ids.fec_candidate) {
    const fecId = entity.external_ids.fec_candidate;
    calls.push(
      withShapedFetch(
        db,
        { source: "openfec", endpoint_path: `/candidate/${fecId}`, args: { fecId }, tool: "fetchCandidate" },
        ttl,
        async () => {
          const adapter = new OpenFecAdapter({ apiKey: requireEnv("API_DATA_GOV_KEY"), rateLimiter: getLimiter("openfec") });
          const r = await adapter.fetchCandidate(db, fecId);
          return { primary_rows_written: r.entitiesUpserted };
        },
        () => {},
        () => getLimiter("openfec").peekWaitMs(),
      ),
    );
  }

  let stale_notice: StaleNotice | undefined;
  for (const res of await Promise.all(calls)) {
    if (res.stale_notice && !stale_notice) stale_notice = res.stale_notice;
  }

  // Re-read the entity in case the fetches updated it.
  const refreshedEntity = findEntityById(db, input.id) ?? entity;
  const docs = findDocumentsByEntity(db, refreshedEntity.id, 10);
  // ... rest of projection logic (sources map, FEC URLs, response shape) unchanged ...
}
```

Preserve the existing projection logic verbatim (sources map, FEC URL construction).

Unit tests rewrite: mock the three adapter methods; test each fanout path (bioguide-only, ocd-only, fec-only, multi-id, no external-ids = no fanout).

Commit: `feat(mcp): get_entity on withShapedFetch (R15)`

---

## Task 3: Integration cleanup + shaped e2e

Find and remove R13 `get_entity` scenarios in integration tests. Add to `passthrough-e2e.shaped.test.ts`: an entity with bioguide triggers one congress fetch; same call twice is cache hit; entity with no external IDs triggers zero fetches.

Commit: `test: get_entity integration on R15 path`

---

## Acceptance

- `grep ensureFresh src/mcp/tools/get_entity.ts` = 0
- `pnpm test` green, `pnpm build` clean

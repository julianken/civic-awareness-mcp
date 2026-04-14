# Phase 8h — `entity_connections` Vertical Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`.

**Goal:** Migrate `entity_connections` off `ensureFresh`. Cold-path fan-out per external ID the target entity carries, including the **empty-result short-circuit for entities with zero external IDs** (per phase-8a Decision 9 / spec §entity_connections cold-path).

**Architecture:** Widest fanout of any tool — up to 5 API calls per cold entity (Congress.gov sponsored-legislation + cosponsored-legislation, OpenStates person detail + sponsored bills, OpenFEC contributions-to-candidate via two-step). Reuses some adapter methods from prior verticals (`fetchMember`, `fetchPerson`, `fetchCandidate` from 8g); adds new narrow methods for sponsored-legislation + contributions-by-candidate.

---

## Task 1: Congress.gov sponsored/cosponsored legislation methods

`src/adapters/congress.ts`

Add two methods that call the per-member sponsored-legislation endpoints. Both fetch one page and reuse existing `upsertBill`.

```ts
async fetchMemberSponsoredBills(
  db: Database.Database,
  bioguideId: string,
  opts: { limit?: number } = {},
): Promise<{ documentsUpserted: number }> {
  const url = new URL(`${BASE_URL}/member/${bioguideId}/sponsored-legislation`);
  url.searchParams.set("limit", String(opts.limit ?? 250));
  url.searchParams.set("api_key", this.opts.apiKey);
  const res = await rateLimitedFetch(url.toString(), {
    userAgent: "civic-awareness-mcp/0.1.0 (+github)",
    rateLimiter: this.rateLimiter,
  });
  if (res.status === 404) return { documentsUpserted: 0 };
  if (!res.ok) throw new Error(`Congress.gov sponsored-legislation returned ${res.status}`);
  const body = (await res.json()) as { sponsoredLegislation?: CongressBill[] };
  let documentsUpserted = 0;
  for (const b of body.sponsoredLegislation ?? []) {
    this.upsertBill(db, b);
    documentsUpserted += 1;
  }
  return { documentsUpserted };
}

async fetchMemberCosponsoredBills(
  db: Database.Database,
  bioguideId: string,
  opts: { limit?: number } = {},
): Promise<{ documentsUpserted: number }> {
  // Same shape, endpoint = `/member/${bioguideId}/cosponsored-legislation`,
  // response field = `cosponsoredLegislation`.
}
```

Tests: 2 per method (happy path + 404).

Commit: `feat(congress): fetchMemberSponsored/Cosponsored for R15 entity_connections`

---

## Task 2: OpenStates bills-by-sponsor method

`src/adapters/openstates.ts`

```ts
async fetchBillsBySponsor(
  db: Database.Database,
  opts: { sponsor: string; limit?: number },
): Promise<{ documentsUpserted: number }> {
  const url = new URL(`${BASE_URL}/bills`);
  url.searchParams.set("sponsor", opts.sponsor);
  url.searchParams.set("sort", "updated_desc");
  url.searchParams.set("per_page", String(opts.limit ?? 20));
  for (const inc of ["sponsorships", "abstracts", "actions"]) {
    url.searchParams.append("include", inc);
  }
  const res = await rateLimitedFetch(url.toString(), {
    userAgent: "civic-awareness-mcp/0.1.0 (+github)",
    rateLimiter: this.rateLimiter,
    headers: { "X-API-KEY": this.opts.apiKey },
  });
  if (!res.ok) throw new Error(`OpenStates /bills?sponsor=${opts.sponsor} returned ${res.status}`);
  const body = (await res.json()) as { results?: OpenStatesBill[] };
  let documentsUpserted = 0;
  for (const b of body.results ?? []) {
    this.upsertBill(db, b);
    documentsUpserted += 1;
  }
  return { documentsUpserted };
}
```

Tests: happy path, asserts `sponsor=` param in URL.

Commit: `feat(openstates): fetchBillsBySponsor for R15 entity_connections`

---

## Task 3: OpenFEC contributions-to-candidate (two-step) method

`src/adapters/openfec.ts`

OpenFEC `schedule_a` doesn't support `candidate_id` — must go through `principal_committees`. Two-step: fetch the candidate, read its `principal_committees[].committee_id`, then call schedule_a with those committee_ids.

```ts
async fetchContributionsToCandidate(
  db: Database.Database,
  opts: { candidateId: string; min_date?: string; limit?: number },
): Promise<{ documentsUpserted: number }> {
  // Step 1: fetch candidate to get committee IDs
  const candUrl = new URL(`${BASE_URL}/candidate/${opts.candidateId}/`);
  candUrl.searchParams.set("api_key", this.opts.apiKey);
  const candRes = await rateLimitedFetch(candUrl.toString(), {
    userAgent: "civic-awareness-mcp/0.1.0 (+github)",
    rateLimiter: this.rateLimiter,
  });
  if (candRes.status === 404) return { documentsUpserted: 0 };
  if (!candRes.ok) throw new Error(`OpenFEC /candidate returned ${candRes.status}`);
  const candBody = (await candRes.json()) as { results?: FecCandidate[] };
  const candidate = candBody.results?.[0];
  const committeeIds = candidate?.principal_committees?.map((c) => c.committee_id) ?? [];
  if (committeeIds.length === 0) return { documentsUpserted: 0 };

  // Step 2: fetch schedule_a filtered by those committee IDs
  return this.fetchRecentContributions(db, {
    min_date: opts.min_date ?? "01/01/2023",  // default to recent cycle window
    committee_ids: committeeIds,
    limit: opts.limit,
  });
}
```

Tests: happy path (mock both calls — candidate → committees, schedule_a → contributions); candidate 404 returns 0; candidate has no principal_committees returns 0.

Commit: `feat(openfec): fetchContributionsToCandidate two-step method for R15`

---

## Task 4: `entity_connections` handler rewrite

Current handler: `sourcesForFullHydrate(juris)` loop over entity role jurisdictions, then runs `findConnections` over the local store.

New handler:

1. Load entity; if `Object.keys(entity.external_ids).length === 0`:
   ```ts
   return { root, edges: [], nodes: [], sources: [], truncated: false, empty_reason: "no_external_ids" };
   ```
2. Else fan out per external_id:
   - `bioguide` → `fetchMemberSponsoredBills` + `fetchMemberCosponsoredBills`
   - `openstates_person` → `fetchBillsBySponsor`
   - `fec_candidate` → `fetchContributionsToCandidate`
   Each wrapped in `withShapedFetch` with unique `tool` names and endpoint_paths that include the external ID.
3. After `Promise.all`, call the existing `findConnections(db, root.id, depth, min_co_occurrences)` and project.
4. Surface first non-empty `stale_notice` from the fanout calls.

Add `empty_reason: "no_external_ids"` to the `EntityConnectionsResponse` type in `src/mcp/tools/entity_connections.ts`. Also add `empty_reason` to the `StaleReason` type if not already there? No — `empty_reason` is a separate diagnostic field, not a StaleReason. Just add it to the response type:

```ts
export interface EntityConnectionsResponse {
  root: EntityMatch;
  edges: ConnectionEdge[];
  nodes: EntityMatch[];
  sources: Array<{ name: string; url: string }>;
  truncated: boolean;
  empty_reason?: "no_external_ids";
  stale_notice?: StaleNotice;
}
```

Unit test rewrite: mock all 4 adapter methods via `vi.spyOn`; cover fanout paths per external_id combination, no-external-ids short-circuit, upstream failure propagation, stale_notice surfacing. Preserve existing findConnections projection scenarios.

Commit: `feat(mcp): entity_connections on withShapedFetch (R15)`

---

## Task 5: Integration cleanup + shaped e2e

Drop R13 scenarios. Add shaped e2e:
- Entity with bioguide → 2 upstream calls (sponsored + cosponsored)
- Entity with no external_ids → empty result + `empty_reason: "no_external_ids"`, NO upstream calls

Commit: `test: entity_connections integration on R15 path`

---

## Acceptance

- `grep ensureFresh src/mcp/tools/entity_connections.ts` = 0
- `pnpm test` green, `pnpm build` clean
- `empty_reason: "no_external_ids"` present in `EntityConnectionsResponse` type

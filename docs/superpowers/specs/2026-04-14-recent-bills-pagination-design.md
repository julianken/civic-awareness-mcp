# 2026-04-14 — Bill-listing pagination + high-cost confirmation

Removes the `max(20)` / `max(50)` schema caps on `recent_bills` and
`list_bills`. Tools now honor any caller-provided `limit` value, with
a two-call confirmation gate at `limit > 500` to protect the daily
OpenStates rate budget.

## Context

`recent_bills.limit` is currently capped at 20 in zod
(`src/mcp/schemas.ts:16`). `list_bills.limit` is capped at 50
(`src/mcp/schemas.ts:103`). Both adapters call
`fetchAndUpsertBillsFromUrl` (`src/adapters/openstates.ts:356`),
which makes a single upstream HTTP request — no pagination loop.

The 20 cap on `recent_bills` is internally consistent: OpenStates
enforces `per_page <= 20` server-side in its `BillPagination`
class. Asking for 21 returns a 4xx; the cap matches reality.

The 50 cap on `list_bills` is a latent bug: the schema accepts up to
50 but the single-page adapter sends `per_page=50`, OpenStates either
silently caps to 20 or returns a 4xx. No tests cover this path.

A user asking for "the last 30 bills out of California" hit the 20
cap during a real test session. The friction is real for biennial
state legislatures (Montana, Nevada, Texas in off-years) where any
`days`-bounded query returns empty and "give me the last N updated"
is the only useful shape.

## Decision

Honor any `limit` value the caller asks for. Add a soft confirmation
gate at `limit > 500` that returns a cost-estimate envelope without
issuing any upstream fetches; the caller re-calls with
`acknowledge_high_cost: true` to actually execute.

Pagination is added to the OpenStates and Congress.gov bill-listing
adapter methods. The rate limiter (already present per source) gates
inter-page request timing.

## Schema changes

### `RecentBillsInput`

```ts
limit: z.number().int().min(1).optional(),
acknowledge_high_cost: z.boolean().optional(),
```

Drop `.max(20)`. `acknowledge_high_cost` is a control flag — opt-in
permission to spend rate budget.

### `ListBillsInput`

```ts
limit: z.number().int().min(1).default(20),
acknowledge_high_cost: z.boolean().optional(),
```

Drop `.max(50)`. Default of 20 preserved (it's the existing default;
unrelated to the cap).

## Response shape

`recent_bills` and `list_bills` both grow a discriminated union:

```ts
type RecentBillsResponse =
  | NormalRecentBillsResponse                 // existing shape
  | RequiresConfirmationResponse;

interface RequiresConfirmationResponse {
  requires_confirmation: true;
  requested_limit: number;
  estimated_cost: {
    upstream_calls: number;
    openstates_daily_budget_pct?: number;     // state jurisdictions
    congress_hourly_budget_pct?: number;      // us-federal
    response_tokens_estimate: number;
  };
  message: string;
}
```

The `requires_confirmation: true` discriminator is unambiguous —
existing callers already destructure `results` / `total`, which
aren't present on the confirmation envelope.

## Cost estimation

Per source (mutually exclusive based on jurisdiction):

| Source | `upstream_calls` | Budget pct |
|---|---|---|
| OpenStates (state jurisdictions) | `ceil(limit / 20)` | `upstream_calls / 500 * 100` (daily) |
| Congress.gov (`us-federal`) | `ceil(limit / 250)` | `upstream_calls / 5000 * 100` (hourly) |
| Wildcard (`*`) | 0 | n/a — local-only path, gate doesn't trip |

`response_tokens_estimate = limit * 150` (rough per-`BillSummary`
token cost; documented in the design, not load-bearing).

Confirmation gate trips when `limit > 500` regardless of source.
This is intentionally simpler than per-source thresholds; the
estimate envelope shows the per-source numbers so the caller can
reason about actual cost.

## Adapter pagination

### OpenStates

`fetchAndUpsertBillsFromUrl` grows a `target` parameter:

```ts
private async fetchAndUpsertBillsFromUrl(
  db: Database.Database,
  url: URL,
  opts?: { chamber?: "upper" | "lower"; target?: number },
): Promise<{ documentsUpserted: number }>
```

When `target` is set and `> 20`:

1. Set `per_page=20` on the URL (overriding caller's `per_page` if
   any).
2. Loop `page = 1, 2, ...` until any of:
   - Accumulated upserted count ≥ `target`
   - `body.pagination.max_page` reached
   - HTTP error (propagates as today)
3. Return total `documentsUpserted`. The adapter does NOT truncate
   to exactly `target`; the last page may contribute up to 19 rows
   beyond `target`. Those extras are written to the local DB cache
   (improving hit rate for future requests) and the handler's
   existing `projectLocal()` enforces the final row cap at `limit`.

When `target` is unset (existing callers) or `≤ 20`: behave as
today — single fetch, single page.

### Congress.gov

`CongressAdapter.fetchRecentBills` grows the same `target`
parameter. Loop on `offset=0, 250, 500, ...` with `limit=250`,
terminating when accumulated ≥ `target` or upstream returns an
empty page. Same no-truncation semantics as OpenStates: handler
projection enforces the final cap.

### Loop safety rails

- The existing per-source rate limiter
  (`getLimiter("openstates")` / `getLimiter("congress")`) gates
  inter-page request timing. No extra wall-clock deadline added —
  rate limiter is the budget enforcer.
- No `maxPages` ceiling beyond what `target` (= `limit`) implies.
  The schema-level confirmation gate at `limit > 500` is the safety
  rail; once acknowledged, the caller has authorized the cost.
- HTTP errors continue to propagate as today (no swallowing).

## Cache key behavior

`limit` continues to join the `withShapedFetch` args bag
(`src/mcp/tools/recent_bills.ts:289`). `limit=200` and `limit=300`
remain distinct cache rows. Intentional: a caller narrowing from
300 to 200 is a different question; sharing rows would either
over-fetch for 200 or under-serve 300.

`acknowledge_high_cost` does NOT join the args bag. The cache row
for `limit=1000` is identical regardless of which call populated
it — and only the executing call ever populates it (the warning
call returns early without fetching).

## Caller flow

1. LLM calls `recent_bills(jurisdiction="us-ca", limit=1000)`.
2. Tool returns:
   ```
   {
     requires_confirmation: true,
     requested_limit: 1000,
     estimated_cost: {
       upstream_calls: 50,
       openstates_daily_budget_pct: 10,
       response_tokens_estimate: 150000
     },
     message: "This call will issue 50 OpenStates requests (~10% of today's budget). Re-call with acknowledge_high_cost: true to proceed."
   }
   ```
   No upstream fetch happens.
3. LLM surfaces the cost to the human, gets approval.
4. LLM re-calls
   `recent_bills(jurisdiction="us-ca", limit=1000, acknowledge_high_cost: true)`.
5. Tool executes normally: 50 paginated OpenStates fetches,
   write-through, local projection, return.

## Doc updates

### `docs/06-open-decisions.md` — D12 amendment

Append:

> **Amended 2026-04-14 (R18):** The `max(20)` / `max(50)` caps on
> bill-listing tool `limit` parameters are removed. Tools now honor
> any `limit` value, returning a `requires_confirmation` envelope
> (no upstream fetch) for `limit > 500` until the caller passes
> `acknowledge_high_cost: true`. Pagination is added to the
> OpenStates and Congress.gov bill-listing adapter methods. See
> R18 in `docs/00-rationale.md`.

### `docs/00-rationale.md` — R18 entry

```
## R18 — Honor caller-requested `limit`, gate at >500 for confirmation (2026-04-14)

D12 (2026-04-14) introduced `limit` on feed tools with a
`max(20)` cap matching OpenStates `/bills` `per_page`. A real
test session showed the cap is the wrong shape: a caller asking
for 30 bills hit the friction immediately, and biennial-state
queries routinely want 50–200 in one shot.

The user's stance: tools should not impose caps as a design
choice — they should honor the caller's request and only push
back when honoring it would impose a real, quantifiable cost.

The real cost is the OpenStates 500/day rate budget, not the
upstream API's per-call ceiling. OpenStates won't reject
`per_page=20, page=5000` — it will return empty pages forever
and charge a request for each. One confused `limit=100000`
call drains the daily budget for every other tool sharing the
process.

R18 keeps the principle (honor the caller) but adds a
confirmation gate above an intuitive threshold (500). The gate
is a soft barrier — the caller passes `acknowledge_high_cost`
to proceed — not a hard cap. Pagination is added to the
adapters so any acknowledged request executes correctly.

Threshold is literal `limit > 500`, not per-source budget
percentage. Federal queries below 500 are trivial cost-wise;
the symmetric threshold is simpler to explain and document.

Locked in phase-9e (`docs/plans/phase-9e-bill-pagination.md`,
forthcoming).
```

## Tests required

### Unit tests

`tests/unit/mcp/tools/recent_bills.test.ts`:

- `limit=200` triggers 10 paginated OpenStates fetches, returns
  200 results.
- `limit=600` without `acknowledge_high_cost` returns
  `requires_confirmation` envelope; no upstream fetch occurs
  (assert via mock not called).
- `limit=600, acknowledge_high_cost: true` executes; makes 30
  OpenStates pages.
- `limit=600` for `us-federal` returns confirmation envelope
  with `congress_hourly_budget_pct` populated, not
  `openstates_daily_budget_pct`.
- `limit=600` for `jurisdiction="*"` (wildcard) executes
  immediately with no confirmation gate (local-only path).

`tests/unit/mcp/tools/list_bills.test.ts`: parallel suite for
`list_bills`.

`tests/unit/adapters/openstates.test.ts`:

- `fetchRecentBills` with `limit=50` makes 3 calls
  (`per_page=20` × `page=1,2,3`).
- Loop terminates when `pagination.max_page < ceil(limit/20)`.
- Result count truncates to exactly `limit` even when last
  page returns more than needed.

### Integration test

`tests/integration/passthrough-e2e.shaped.test.ts` or sibling:
multi-page msw response sequence for OpenStates `/bills`,
assert `documentsUpserted` count matches and final response
contains exactly `limit` rows.

## Tradeoffs accepted

- **Polymorphic response shape.** `recent_bills` and `list_bills`
  return EITHER the existing response shape OR the confirmation
  envelope. The discriminator (`requires_confirmation`) is
  unambiguous, but the TypeScript type union ripples through any
  consumer that destructures the response. Acceptable because the
  MCP boundary is JSON anyway.

- **Confirmation is advisory, not authenticated.** A misaligned
  LLM could blindly set `acknowledge_high_cost: true` on the first
  call without surfacing the cost. The cost-estimate envelope is
  friction, not a security boundary. A nonce-based design would
  be stronger; deferred until friction proves insufficient.

- **No session-level skip.** A caller doing many large pulls in a
  row sees the gate every time. Acceptable for V1; revisit if a
  real workflow surfaces the friction.

- **Cache rows per distinct limit.** `limit=200` and `limit=300`
  fetch separately. A bucketing scheme (50/100/200/500) would
  improve cache hit rate for similar requests but complicates
  cache-key reasoning. Defer until measured.

## Out of scope

- `recent_votes`, `recent_contributions`,
  `search_civic_documents` — separate `limit` semantics, separate
  adapters; this spec is bounded to bill-listing tools.
- Mid-call MCP elicitation (alternative to two-call pattern) —
  defer; client support uneven.
- Quantizing `limit` into cache buckets — defer until cache miss
  rate becomes a measurable problem.
- Session-level acknowledgment preference — defer.

## Files changed

- `src/mcp/schemas.ts`
- `src/mcp/tools/recent_bills.ts`
- `src/mcp/tools/list_bills.ts`
- `src/adapters/openstates.ts`
- `src/adapters/congress.ts`
- `docs/05-tool-surface.md` (document confirmation envelope shape)
- `docs/06-open-decisions.md`
- `docs/00-rationale.md`
- `tests/unit/mcp/tools/recent_bills.test.ts`
- `tests/unit/mcp/tools/list_bills.test.ts`
- `tests/unit/adapters/openstates.test.ts`
- `tests/integration/passthrough-e2e.shaped.test.ts` (or sibling)

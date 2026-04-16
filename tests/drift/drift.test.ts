/**
 * Upstream API drift detection.
 *
 * These tests hit the real OpenStates, Congress.gov, and OpenFEC APIs
 * with tiny queries (per_page=5, one page each) and assert that the
 * response shapes our adapters depend on are still present. They
 * catch upstream field renames, removed fields, or endpoint moves
 * before those changes silently break the adapters.
 *
 * Designed to be invoked by the nightly GitHub Actions workflow with
 * API keys in repo secrets. Each `describe` block skips silently when
 * its corresponding key is absent, so:
 *
 *   pnpm test            # mocked tests only; drift blocks skip
 *   pnpm test:drift      # runs this file; blocks skip per missing key
 *   pnpm test:drift      # with both env vars set → all blocks run
 */
import { describe, it, expect } from "vitest";

const UA = "civic-awareness-mcp-drift/0.0.6 (+https://github.com/julianken/civic-awareness-mcp)";

// Small pause helper — be polite to public civic APIs even when tests
// run in sequence. One second between requests keeps us well under any
// documented rate limit and well under any undocumented one.
async function pause(ms = 1000): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HAS_OPENSTATES = !!process.env.OPENSTATES_API_KEY;
const HAS_API_DATA_GOV = !!process.env.API_DATA_GOV_KEY;

// ─── OpenStates ──────────────────────────────────────────────────────

// Live API tests need generous timeouts — CI runners have variable latency.
describe.skipIf(!HAS_OPENSTATES)("OpenStates drift", { timeout: 30_000 }, () => {
  const base = "https://v3.openstates.org";
  const headers = { "X-API-KEY": process.env.OPENSTATES_API_KEY!, "User-Agent": UA };

  it("/bills response shape matches the OpenStatesBill interface", async () => {
    await pause();
    // `include` must be repeated, not comma-joined — OpenStates v3
    // returns 422 on comma-joined values. See adapter fix 2026-04-13.
    const res = await fetch(
      `${base}/bills?jurisdiction=tx&per_page=5&page=1&include=sponsorships&include=actions`,
      { headers },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results?: Array<Record<string, unknown>>;
      pagination?: { max_page?: number };
    };
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results!.length).toBeGreaterThan(0);

    const first = body.results![0];
    // Fields the openstates adapter's upsertBill reads.
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("identifier");
    expect(first).toHaveProperty("title");
    expect(first).toHaveProperty("updated_at");
    expect(first).toHaveProperty("openstates_url");
    expect(first).toHaveProperty("jurisdiction");
    expect((first.jurisdiction as { id?: string })?.id).toMatch(
      /ocd-jurisdiction\/country:us\/state:/,
    );

    expect(body.pagination?.max_page).toBeTypeOf("number");
  });

  it("/people response shape matches the OpenStatesPerson interface", async () => {
    await pause();
    const res = await fetch(`${base}/people?jurisdiction=tx&per_page=5&page=1`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results!.length).toBeGreaterThan(0);

    const first = body.results![0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("jurisdiction");
  });
});

// ─── Congress.gov ────────────────────────────────────────────────────

describe.skipIf(!HAS_API_DATA_GOV)("Congress.gov drift", () => {
  const base = "https://api.congress.gov/v3";
  const key = process.env.API_DATA_GOV_KEY!;

  it("/member response shape matches the CongressMember interface", async () => {
    await pause();
    const res = await fetch(`${base}/member?congress=119&limit=5&api_key=${key}&format=json`, {
      headers: { "User-Agent": UA },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members?: Array<Record<string, unknown>> };
    expect(Array.isArray(body.members)).toBe(true);
    expect(body.members!.length).toBeGreaterThan(0);

    const first = body.members![0];
    expect(first).toHaveProperty("bioguideId");
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("terms");
  });

  it("/bill response shape matches the CongressBill interface", async () => {
    await pause();
    const res = await fetch(`${base}/bill?congress=119&limit=5&api_key=${key}&format=json`, {
      headers: { "User-Agent": UA },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bills?: Array<Record<string, unknown>> };
    expect(Array.isArray(body.bills)).toBe(true);
    expect(body.bills!.length).toBeGreaterThan(0);

    const first = body.bills![0];
    expect(first).toHaveProperty("congress");
    expect(first).toHaveProperty("type");
    expect(first).toHaveProperty("number");
    expect(first).toHaveProperty("title");
    expect(first).toHaveProperty("updateDate");
  });
});

// ─── OpenFEC ─────────────────────────────────────────────────────────

describe.skipIf(!HAS_API_DATA_GOV)("OpenFEC drift", () => {
  const base = "https://api.open.fec.gov/v1";
  const key = process.env.API_DATA_GOV_KEY!;

  it("/candidates/search response shape matches the FecCandidate interface", async () => {
    await pause();
    const res = await fetch(
      `${base}/candidates/search?election_year=2026&candidate_status=C&per_page=5&api_key=${key}`,
      { headers: { "User-Agent": UA } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results!.length).toBeGreaterThan(0);

    const first = body.results![0];
    expect(first).toHaveProperty("candidate_id");
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("office");
  });

  it("/committees response shape matches the FecCommittee interface", async () => {
    await pause();
    const res = await fetch(
      `${base}/committees?cycle=2026&per_page=5&api_key=${key}`,
      { headers: { "User-Agent": UA } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results!.length).toBeGreaterThan(0);

    const first = body.results![0];
    expect(first).toHaveProperty("committee_id");
    expect(first).toHaveProperty("name");
  });

  it("/schedules/schedule_a response shape matches FecScheduleA", async () => {
    await pause();
    const res = await fetch(
      `${base}/schedules/schedule_a?two_year_transaction_period=2026&per_page=5&api_key=${key}`,
      { headers: { "User-Agent": UA } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
    expect(Array.isArray(body.results)).toBe(true);
    // Schedule A may be empty very early in a cycle; relax the count check.
    if (body.results!.length > 0) {
      const first = body.results![0];
      expect(first).toHaveProperty("transaction_id");
      expect(first).toHaveProperty("committee_id");
      expect(first).toHaveProperty("contribution_receipt_amount");
      expect(first).toHaveProperty("contribution_receipt_date");
    }
  });
});

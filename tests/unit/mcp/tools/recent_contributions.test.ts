import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { upsertFetchLog } from "../../../../src/core/fetch_log.js";
import { hashArgs } from "../../../../src/core/args_hash.js";
import { _resetToolCacheForTesting } from "../../../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../../../src/core/limiters.js";
import { OpenFecAdapter } from "../../../../src/adapters/openfec.js";
import { handleRecentContributions } from "../../../../src/mcp/tools/recent_contributions.js";

const TEST_DB = "./data/test-tool-recent-contributions.db";
let store: Store;

const RECENT = new Date().toISOString();
const OLD = new Date(Date.now() - 90 * 86400 * 1000).toISOString();

let committeeEntityId: string;
let contributorEntityId: string;

/**
 * Pre-seeds a fetch_log row for (openfec, /schedules/schedule_a, args)
 * so `withShapedFetch` takes the TTL-hit path — the adapter method is
 * NOT called, and the handler runs the SQL projection directly. Used
 * for tests that focus on projection behaviour rather than hydration.
 */
function seedFetchLogFresh(args: Record<string, unknown>): void {
  upsertFetchLog(store.db, {
    source: "openfec",
    endpoint_path: "/schedules/schedule_a",
    args_hash: hashArgs("recent_contributions", args),
    scope: "recent",
    fetched_at: new Date().toISOString(),
    last_rowcount: 1,
  });
}

beforeEach(() => {
  _resetToolCacheForTesting();
  _resetLimitersForTesting();
  process.env.API_DATA_GOV_KEY = "test-key";

  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  // Create a committee (recipient) entity.
  const { entity: committee } = upsertEntity(store.db, {
    kind: "pac",
    name: "Smith for Congress",
    jurisdiction: "us-federal",
    external_ids: { fec_committee: "C00123456" },
  });
  committeeEntityId = committee.id;

  // Create a contributor entity.
  const { entity: contributor } = upsertEntity(store.db, {
    kind: "person",
    name: "Jones, Alice M.",
    jurisdiction: undefined,
  });
  contributorEntityId = contributor.id;

  // Seed a recent contribution document.
  upsertDocument(store.db, {
    kind: "contribution",
    jurisdiction: "us-federal",
    title: "Contribution: Jones, Alice M. → C00123456 ($2800.00)",
    occurred_at: RECENT,
    source: {
      name: "openfec",
      id: "SA17.1234567",
      url: "https://www.fec.gov/data/committee/C00123456/",
    },
    references: [
      { entity_id: contributorEntityId, role: "contributor" },
      { entity_id: committeeEntityId, role: "recipient" },
    ],
    raw: {
      transaction_id: "SA17.1234567",
      amount: 2800.0,
      date: RECENT.slice(0, 10),
      contributor_name: "Jones, Alice M.",
      contributor_city: "PHOENIX",   // stored but never exposed
      contributor_state: "AZ",
      contributor_zip: "85001",
      contributor_employer: "Self-Employed",
      committee_id: "C00123456",
    },
  });

  // Seed an old contribution outside any reasonable window.
  upsertDocument(store.db, {
    kind: "contribution",
    jurisdiction: "us-federal",
    title: "Contribution: Brown, Bob → C00123456 ($500.00)",
    occurred_at: OLD,
    source: {
      name: "openfec",
      id: "SA17.0000001",
      url: "https://www.fec.gov/data/committee/C00123456/",
    },
    references: [
      {
        entity_id: contributorEntityId,
        role: "contributor",
      },
      { entity_id: committeeEntityId, role: "recipient" },
    ],
    raw: {
      transaction_id: "SA17.0000001",
      amount: 500.0,
      date: OLD.slice(0, 10),
      contributor_name: "Brown, Bob",
      committee_id: "C00123456",
    },
  });
});

afterEach(() => {
  store.close();
  delete process.env.API_DATA_GOV_KEY;
});

describe("recent_contributions tool — projection (TTL-hit path)", () => {
  it("returns only contributions within the required window", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    const window = { from: oneWeekAgo, to: now };
    seedFetchLogFresh({ window, candidate_or_committee: undefined, min_amount: undefined, contributor_entity_id: undefined, side: "either" });

    const result = await handleRecentContributions(store.db, { window });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].amount).toBe(2800.0);
  });

  it("filters by min_amount", async () => {
    const oneYearAgo = new Date(Date.now() - 365 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    const window = { from: oneYearAgo, to: now };
    seedFetchLogFresh({ window, candidate_or_committee: undefined, min_amount: 1000, contributor_entity_id: undefined, side: "either" });

    const result = await handleRecentContributions(store.db, {
      window,
      min_amount: 1000,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].amount).toBe(2800.0);
  });

  it("filters by candidate_or_committee resolved to entity", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    const window = { from: oneWeekAgo, to: now };
    seedFetchLogFresh({ window, candidate_or_committee: "Smith for Congress", min_amount: undefined, contributor_entity_id: undefined, side: "recipient" });

    const result = await handleRecentContributions(store.db, {
      window,
      candidate_or_committee: "Smith for Congress",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].recipient.name).toBe("Smith for Congress");
    expect(result.results[0].recipient.entity_id).toBe(committeeEntityId);
  });

  it("does not expose contributor address or employer in response", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    const window = { from: oneWeekAgo, to: now };
    seedFetchLogFresh({ window, candidate_or_committee: undefined, min_amount: undefined, contributor_entity_id: undefined, side: "either" });

    const result = await handleRecentContributions(store.db, { window });
    expect(result.results).toHaveLength(1);
    const contrib = result.results[0];

    // These fields must not appear anywhere in the ContributionSummary.
    const serialized = JSON.stringify(contrib);
    expect(serialized).not.toContain("PHOENIX");
    expect(serialized).not.toContain("85001");
    expect(serialized).not.toContain("Self-Employed");
    expect(serialized).not.toContain("contributor_city");
    expect(serialized).not.toContain("contributor_zip");
    expect(serialized).not.toContain("contributor_employer");
  });

  it("includes contributor entity_id when the contributor is a known entity", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    const window = { from: oneWeekAgo, to: now };
    seedFetchLogFresh({ window, candidate_or_committee: undefined, min_amount: undefined, contributor_entity_id: undefined, side: "either" });

    const result = await handleRecentContributions(store.db, { window });
    expect(result.results[0].contributor.entity_id).toBe(contributorEntityId);
  });

  it("includes source provenance", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    const window = { from: oneWeekAgo, to: now };
    seedFetchLogFresh({ window, candidate_or_committee: undefined, min_amount: undefined, contributor_entity_id: undefined, side: "either" });

    const result = await handleRecentContributions(store.db, { window });
    expect(result.sources).toContainEqual(
      expect.objectContaining({ name: "openfec" }),
    );
  });

  it("rejects input with missing window", async () => {
    await expect(
      handleRecentContributions(store.db, {} as unknown),
    ).rejects.toThrow();
  });

  it("rejects input with window.from but missing window.to", async () => {
    await expect(
      handleRecentContributions(store.db, {
        window: { from: new Date().toISOString() },
      } as unknown),
    ).rejects.toThrow();
  });

  it("skips contribution records with a missing amount", async () => {
    const occurredAt = new Date().toISOString();
    upsertDocument(store.db, {
      kind: "contribution",
      jurisdiction: "us-federal",
      title: "Contribution: Malformed → C00123456 (no amount)",
      occurred_at: occurredAt,
      source: {
        name: "openfec",
        id: "SA17.NOAMOUNT",
        url: "https://www.fec.gov/data/committee/C00123456/",
      },
      references: [
        { entity_id: contributorEntityId, role: "contributor" },
        { entity_id: committeeEntityId, role: "recipient" },
      ],
      raw: {
        transaction_id: "SA17.NOAMOUNT",
        date: occurredAt.slice(0, 10),
        contributor_name: "Malformed Donor",
        committee_id: "C00123456",
      },
    });

    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    const window = { from: oneWeekAgo, to: now };
    seedFetchLogFresh({ window, candidate_or_committee: undefined, min_amount: undefined, contributor_entity_id: undefined, side: "either" });

    const result = await handleRecentContributions(store.db, { window });
    // Pre-seeded $2800 record survives; the malformed one without amount is excluded.
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).not.toBe("SA17.NOAMOUNT");
    expect(result.results.every((r) => r.amount > 0)).toBe(true);
  });

  it("attaches empty_reason diagnostic when results are empty", async () => {
    const farPast = new Date(Date.now() - 1000 * 86400 * 1000).toISOString();
    const almostFarPast = new Date(Date.now() - 999 * 86400 * 1000).toISOString();
    const window = { from: farPast, to: almostFarPast };
    seedFetchLogFresh({ window, candidate_or_committee: undefined, min_amount: undefined, contributor_entity_id: undefined, side: "either" });

    const res = await handleRecentContributions(store.db, { window });
    expect(res.results).toHaveLength(0);
    expect(res).toHaveProperty("empty_reason");
  });
});

describe("recent_contributions tool — R15 hydration path", () => {
  it("invokes OpenFEC fetchRecentContributions on cache miss", async () => {
    const fetchSpy = vi
      .spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    const res = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    // Local projection still runs — recent fixture is in-window.
    expect(res.results).toHaveLength(1);
    expect(res.stale_notice).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("passes MM/DD/YYYY-formatted dates to the adapter", async () => {
    const fetchSpy = vi
      .spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleRecentContributions(store.db, {
      window: {
        from: "2026-04-01T00:00:00.000Z",
        to: "2026-04-30T00:00:00.000Z",
      },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      store.db,
      expect.objectContaining({
        min_date: "04/01/2026",
        max_date: "04/30/2026",
      }),
    );

    fetchSpy.mockRestore();
  });

  it("cache hit: does NOT call the adapter on the second call within TTL", async () => {
    const fetchSpy = vi
      .spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    const window = { from: oneWeekAgo, to: now };

    await handleRecentContributions(store.db, { window });
    await handleRecentContributions(store.db, { window });

    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it("upstream failure with no cached data propagates the error", async () => {
    const fetchSpy = vi
      .spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockRejectedValue(new Error("network down"));

    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();

    await expect(
      handleRecentContributions(store.db, {
        window: { from: oneWeekAgo, to: now },
      }),
    ).rejects.toThrow(/network down/);

    fetchSpy.mockRestore();
  });

  it("upstream failure with stale cached data surfaces stale_notice and still serves local data", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    const window = { from: oneWeekAgo, to: now };

    upsertFetchLog(store.db, {
      source: "openfec",
      endpoint_path: "/schedules/schedule_a",
      args_hash: hashArgs("recent_contributions", {
        window, candidate_or_committee: undefined, min_amount: undefined,
        contributor_entity_id: undefined, side: "either",
      }),
      scope: "recent",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 1,
    });

    const fetchSpy = vi
      .spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockRejectedValue(new Error("simulated upstream failure"));

    const res = await handleRecentContributions(store.db, { window });

    expect(res.stale_notice?.reason).toBe("upstream_failure");
    expect(res.results.length).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("stale_notice propagates into empty-results diagnostic response", async () => {
    // Wipe fixtures so the projection is empty while the stale-fallback
    // path triggers on the /schedules/schedule_a key.
    store.db.prepare("DELETE FROM documents WHERE kind = 'contribution'").run();

    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    const window = { from: oneWeekAgo, to: now };

    upsertFetchLog(store.db, {
      source: "openfec",
      endpoint_path: "/schedules/schedule_a",
      args_hash: hashArgs("recent_contributions", {
        window, candidate_or_committee: undefined, min_amount: undefined,
        contributor_entity_id: undefined, side: "either",
      }),
      scope: "recent",
      fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      last_rowcount: 0,
    });

    const fetchSpy = vi
      .spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockRejectedValue(new Error("upstream down"));

    const res = await handleRecentContributions(store.db, { window });
    expect(res.results).toHaveLength(0);
    expect(res).toHaveProperty("empty_reason");
    expect(res.stale_notice?.reason).toBe("upstream_failure");

    fetchSpy.mockRestore();
  });
});

describe("recent_contributions tool — contributor-side filters", () => {
  it("threads contributor_entity_id through to the adapter as contributor_name", async () => {
    const fetchSpy = vi
      .spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockResolvedValue({ documentsUpserted: 0 });

    const { entity: donor } = upsertEntity(store.db, {
      kind: "person",
      name: "JANE SMITH",
      jurisdiction: undefined,
    });

    await handleRecentContributions(store.db, {
      window: { from: "2026-04-01T00:00:00Z", to: "2026-04-30T00:00:00Z" },
      contributor_entity_id: donor.id,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const callOpts = fetchSpy.mock.calls[0][1] as { contributor_name?: string };
    expect(callOpts.contributor_name).toBe("JANE SMITH");
    fetchSpy.mockRestore();
  });

  it("side='contributor' filters candidate_or_committee against the contributor side", async () => {
    const fetchSpy = vi
      .spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockResolvedValue({ documentsUpserted: 0 });

    // Distinct entities so "acme" only matches the contributor side here.
    const { entity: acmeDonor } = upsertEntity(store.db, {
      kind: "person",
      name: "Acme Donor",
      jurisdiction: undefined,
    });
    const { entity: targetPac } = upsertEntity(store.db, {
      kind: "pac",
      name: "Target PAC",
      jurisdiction: "us-federal",
      external_ids: { fec_committee: "C99999999" },
    });

    const occurredAt = new Date().toISOString();
    upsertDocument(store.db, {
      kind: "contribution",
      jurisdiction: "us-federal",
      title: "Contribution: Acme Donor → Target PAC ($2500.00)",
      occurred_at: occurredAt,
      source: {
        name: "openfec",
        id: "SA17.SIDE1",
        url: "https://www.fec.gov/data/committee/C99999999/",
      },
      references: [
        { entity_id: acmeDonor.id, role: "contributor" },
        { entity_id: targetPac.id, role: "recipient" },
      ],
      raw: {
        amount: 2500,
        date: occurredAt.slice(0, 10),
        contributor_name: "Acme Donor",
      },
    });

    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    const result = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
      candidate_or_committee: "acme",
      side: "contributor",
    });

    expect(result.results.some((r) => r.contributor.entity_id === acmeDonor.id)).toBe(true);
    // The pre-seeded Smith/Jones contribution must NOT appear — "acme"
    // resolves to acmeDonor, which isn't the contributor on that doc.
    expect(
      result.results.every((r) => r.contributor.entity_id === acmeDonor.id),
    ).toBe(true);
    fetchSpy.mockRestore();
  });

  it("candidate_or_committee without side defaults to recipient (back-compat)", async () => {
    const fetchSpy = vi
      .spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockResolvedValue({ documentsUpserted: 0 });

    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    // "Smith for Congress" matches the pre-seeded recipient committee.
    // Under back-compat default (side=recipient), it must match.
    const result = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
      candidate_or_committee: "smith",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].recipient.entity_id).toBe(committeeEntityId);
    fetchSpy.mockRestore();
  });

  it("contributor_entity_id + candidate_or_committee + side=recipient AND-combines", async () => {
    const fetchSpy = vi
      .spyOn(OpenFecAdapter.prototype, "fetchRecentContributions")
      .mockResolvedValue({ documentsUpserted: 0 });

    // Seed another recipient PAC + a contribution from the same
    // contributor to it. Only contributions matching BOTH the donor
    // and the "smith" recipient should survive.
    const { entity: otherPac } = upsertEntity(store.db, {
      kind: "pac",
      name: "Other PAC",
      jurisdiction: "us-federal",
      external_ids: { fec_committee: "C00888888" },
    });

    const occurredAt = new Date().toISOString();
    upsertDocument(store.db, {
      kind: "contribution",
      jurisdiction: "us-federal",
      title: "Contribution: Jones, Alice M. → C00888888 ($100.00)",
      occurred_at: occurredAt,
      source: {
        name: "openfec",
        id: "SA17.AND1",
        url: "https://www.fec.gov/data/committee/C00888888/",
      },
      references: [
        { entity_id: contributorEntityId, role: "contributor" },
        { entity_id: otherPac.id, role: "recipient" },
      ],
      raw: {
        amount: 100,
        date: occurredAt.slice(0, 10),
        contributor_name: "Jones, Alice M.",
      },
    });

    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();
    const result = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
      contributor_entity_id: contributorEntityId,
      candidate_or_committee: "smith",
      side: "recipient",
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].recipient.entity_id).toBe(committeeEntityId);
    expect(result.results[0].contributor.entity_id).toBe(contributorEntityId);
    fetchSpy.mockRestore();
  });

  it("throws when contributor_entity_id does not resolve", async () => {
    await expect(
      handleRecentContributions(store.db, {
        window: { from: "2026-04-01T00:00:00Z", to: "2026-04-30T00:00:00Z" },
        contributor_entity_id: "does-not-exist",
      }),
    ).rejects.toThrow(/Entity not found/);
  });
});

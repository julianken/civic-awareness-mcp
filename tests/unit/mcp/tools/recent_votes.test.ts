import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleRecentVotes } from "../../../../src/mcp/tools/recent_votes.js";

vi.mock("../../../../src/core/hydrate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/core/hydrate.js")>();
  return { ...actual, ensureFresh: vi.fn() };
});
import { ensureFresh } from "../../../../src/core/hydrate.js";
const mockEnsureFresh = vi.mocked(ensureFresh);

const TEST_DB = "./data/test-tool-recent-votes.db";
let store: Store;

const RECENT = new Date().toISOString();
const OLD = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

function seedVote(id: string, occurred: string, chamber: string, billId: string, result: string) {
  upsertDocument(store.db, {
    kind: "vote",
    jurisdiction: "us-federal",
    title: `Vote 119-${chamber}-${id}: ${billId} — On Passage`,
    occurred_at: occurred,
    source: {
      name: "congress",
      id: `vote-119-${chamber.toLowerCase()}-${id}`,
      url: `https://www.congress.gov/roll-call-votes/119/${chamber.toLowerCase()}/${id}`,
    },
    raw: {
      congress: 119,
      chamber,
      rollNumber: parseInt(id, 10),
      question: "On Passage",
      result,
      bill: { type: "HR", number: billId.replace("HR", "") },
      totals: { yea: 218, nay: 210, present: 2, notVoting: 5 },
    },
  });
}

beforeEach(() => {
  mockEnsureFresh.mockReset();
  mockEnsureFresh.mockResolvedValue({ ok: true });

  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  upsertEntity(store.db, {
    kind: "person",
    name: "Schumer, Charles E.",
    jurisdiction: undefined,
    external_ids: { bioguide: "S000148" },
    metadata: {
      roles: [{ jurisdiction: "us-federal", role: "senator", from: "1999-01-03T00:00:00.000Z", to: null }],
    },
  });
  seedVote("42", RECENT, "House", "HR1234", "Passed");
  seedVote("43", RECENT, "Senate", "S567", "Failed");
  seedVote("10", OLD, "House", "HR99", "Passed");
});
afterEach(() => store.close());

describe("recent_votes tool", () => {
  it("returns only votes within the time window", async () => {
    const result = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    expect(result.results).toHaveLength(2);
  });

  it("filters by chamber", async () => {
    const result = await handleRecentVotes(store.db, {
      jurisdiction: "us-federal",
      days: 7,
      chamber: "upper",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].chamber).toBe("Senate");
  });

  it("filters by bill_identifier", async () => {
    const result = await handleRecentVotes(store.db, {
      jurisdiction: "us-federal",
      days: 7,
      bill_identifier: "HR1234",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].bill_identifier).toBe("HR1234");
  });

  it("returns tally from raw.totals", async () => {
    const result = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    const vote = result.results.find((v) => v.bill_identifier === "HR1234");
    expect(vote?.tally.yea).toBe(218);
    expect(vote?.tally.nay).toBe(210);
    expect(vote?.tally.present).toBe(2);
    expect(vote?.tally.absent).toBe(5);
  });

  it("includes result field", async () => {
    const result = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    const passed = result.results.find((v) => v.bill_identifier === "HR1234");
    expect(passed?.result).toBe("Passed");
  });

  it("includes source provenance", async () => {
    const result = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    expect(result.sources).toContainEqual(
      expect.objectContaining({ name: "congress" }),
    );
  });

  it("rejects input with no jurisdiction", async () => {
    await expect(
      handleRecentVotes(store.db, { days: 7 }),
    ).rejects.toThrow();
  });

  it("accepts days up to 365", async () => {
    const res = await handleRecentVotes(store.db, { jurisdiction: "us-or", days: 365 });
    expect(res.window.from).toBeDefined();
  });

  it("rejects days above 365", async () => {
    await expect(
      handleRecentVotes(store.db, { jurisdiction: "us-or", days: 366 }),
    ).rejects.toThrow();
  });

  it("filters votes by session", async () => {
    upsertDocument(store.db, {
      kind: "vote", jurisdiction: "us-tx", title: "Vote 892-1",
      occurred_at: "2025-09-18T00:00:00Z",
      source: { name: "openstates", id: "892v", url: "https://ex" },
      references: [], raw: { session: "892" },
    });
    upsertDocument(store.db, {
      kind: "vote", jurisdiction: "us-tx", title: "Vote 891-1",
      occurred_at: "2024-06-01T00:00:00Z",
      source: { name: "openstates", id: "891v", url: "https://ex" },
      references: [], raw: { session: "891" },
    });

    const res = await handleRecentVotes(store.db, {
      jurisdiction: "us-tx",
      days: 7,
      session: "892",
    });
    expect(res.results).toHaveLength(1);
  });

  it("attaches empty_reason diagnostic when results are empty", async () => {
    const res = await handleRecentVotes(store.db, { jurisdiction: "us-or", days: 7 });
    expect(res.results).toHaveLength(0);
    expect(res).toHaveProperty("empty_reason", "no_refresh");
  });

  it("omits empty_reason on non-empty responses", async () => {
    upsertDocument(store.db, {
      kind: "vote", jurisdiction: "us-or", title: "Vote 1",
      occurred_at: new Date().toISOString(),
      source: { name: "openstates", id: "v1", url: "https://ex" },
      references: [], raw: {},
    });
    const res = await handleRecentVotes(store.db, { jurisdiction: "us-or", days: 7 });
    expect(res.results).toHaveLength(1);
    expect(res).not.toHaveProperty("empty_reason");
  });

  it("hydration: fresh cache returns results with no stale_notice", async () => {
    mockEnsureFresh.mockResolvedValue({ ok: true });
    const res = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    expect(res.results).toHaveLength(2);
    expect(res.stale_notice).toBeUndefined();
  });

  it("hydration: upstream failure attaches stale_notice, still serves local data", async () => {
    const notice = {
      as_of: "2026-04-13T00:00:00.000Z",
      reason: "upstream_failure" as const,
      message: "Upstream congress fetch failed; serving stale local data.",
    };
    mockEnsureFresh.mockResolvedValue({ ok: false, stale_notice: notice });
    const res = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    expect(res.stale_notice?.reason).toBe("upstream_failure");
    expect(res.results.length).toBeGreaterThan(0);
  });

  it("hydration: rate-limited attaches stale_notice with retry_after_s", async () => {
    const notice = {
      as_of: "2026-04-13T00:00:00.000Z",
      reason: "rate_limited" as const,
      message: "Rate limit for congress requires 120s wait; serving stale local data.",
      retry_after_s: 120,
    };
    mockEnsureFresh.mockResolvedValue({ ok: false, stale_notice: notice });
    const res = await handleRecentVotes(store.db, { jurisdiction: "us-federal", days: 7 });
    expect(res.stale_notice?.reason).toBe("rate_limited");
    expect(res.stale_notice?.retry_after_s).toBe(120);
  });

  it("hydration: stale_notice propagates to empty-results diagnostic response", async () => {
    const notice = {
      as_of: "2026-04-13T00:00:00.000Z",
      reason: "upstream_failure" as const,
      message: "Upstream failed.",
    };
    mockEnsureFresh.mockResolvedValue({ ok: false, stale_notice: notice });
    // us-or has no vote documents in the db
    const res = await handleRecentVotes(store.db, { jurisdiction: "us-or", days: 7 });
    expect(res.results).toHaveLength(0);
    expect(res).toHaveProperty("empty_reason");
    expect(res.stale_notice?.reason).toBe("upstream_failure");
  });

  it("hydration: us-state jurisdiction calls ensureFresh with openstates", async () => {
    // sourcesFor("vote", "us-tx") returns ["openstates"] — openstates is the
    // source for state votes even though ingest is not yet implemented
    mockEnsureFresh.mockResolvedValue({ ok: true });
    const res = await handleRecentVotes(store.db, { jurisdiction: "us-tx", days: 7 });
    expect(mockEnsureFresh).toHaveBeenCalledWith(
      expect.anything(), "openstates", "us-tx", "recent", expect.any(Function),
    );
    expect(res.stale_notice).toBeUndefined();
  });
});

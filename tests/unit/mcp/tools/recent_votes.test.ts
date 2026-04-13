import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleRecentVotes } from "../../../../src/mcp/tools/recent_votes.js";

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
});

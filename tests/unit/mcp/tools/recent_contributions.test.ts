import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleRecentContributions } from "../../../../src/mcp/tools/recent_contributions.js";

const TEST_DB = "./data/test-tool-recent-contributions.db";
let store: Store;

const RECENT = new Date().toISOString();
const OLD = new Date(Date.now() - 90 * 86400 * 1000).toISOString();

let committeeEntityId: string;
let contributorEntityId: string;

beforeEach(() => {
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

afterEach(() => store.close());

describe("recent_contributions tool", () => {
  it("returns only contributions within the required window", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();

    const result = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].amount).toBe(2800.0);
  });

  it("filters by min_amount", async () => {
    const oneYearAgo = new Date(Date.now() - 365 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();

    const result = await handleRecentContributions(store.db, {
      window: { from: oneYearAgo, to: now },
      min_amount: 1000,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].amount).toBe(2800.0);
  });

  it("filters by candidate_or_committee resolved to entity", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();

    const result = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
      candidate_or_committee: "Smith for Congress",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].recipient.name).toBe("Smith for Congress");
    expect(result.results[0].recipient.entity_id).toBe(committeeEntityId);
  });

  it("does not expose contributor address or employer in response", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();

    const result = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
    });
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

    const result = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
    });
    expect(result.results[0].contributor.entity_id).toBe(contributorEntityId);
  });

  it("includes source provenance", async () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const now = new Date().toISOString();

    const result = await handleRecentContributions(store.db, {
      window: { from: oneWeekAgo, to: now },
    });
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
});

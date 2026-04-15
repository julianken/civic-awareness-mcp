import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/federal/seeds.js";
import { upsertDocument } from "../../../src/core/documents.js";
import { ensureVoteFresh } from "../../../src/federal/hydrate_vote.js";
import { CongressAdapter, VoteNotFoundError } from "../../../src/federal/adapters/congress.js";

const TEST_DB = "./data/test-hydrate-vote.db";
let store: Store;
let fetchVoteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  process.env.API_DATA_GOV_KEY = "test-key";
  fetchVoteSpy = vi
    .spyOn(CongressAdapter.prototype, "fetchVote")
    .mockImplementation(async (db: Database.Database) => {
      upsertDocument(db, {
        kind: "vote",
        jurisdiction: "us-federal",
        title: "Vote 119-Senate-42: HR1234 — On Passage",
        occurred_at: "2026-04-01T00:00:00.000Z",
        source: {
          name: "congress",
          id: "vote-119-senate-42",
          url: "https://www.congress.gov/roll-call-votes/119/senate/42",
        },
        raw: { congress: 119, chamber: "Senate", rollNumber: 42, positions: [] },
      });
      const row = store.db
        .prepare("SELECT id FROM documents WHERE source_id = ?")
        .get("vote-119-senate-42") as { id: string };
      return { documentId: row.id };
    });
});

afterEach(() => {
  store.close();
  fetchVoteSpy.mockRestore();
  delete process.env.API_DATA_GOV_KEY;
});

describe("ensureVoteFresh", () => {
  it("fetches upstream when the vote is missing (composite path)", async () => {
    const result = await ensureVoteFresh(store.db, {
      composite: { congress: 119, chamber: "upper", session: 1, roll_number: 42 },
    });
    expect(fetchVoteSpy).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.documentId).toBeTruthy();
  });

  it("skips upstream when fetched_at is < 1h old", async () => {
    upsertDocument(store.db, {
      kind: "vote",
      jurisdiction: "us-federal",
      title: "Vote 119-Senate-42: HR1234 — On Passage",
      occurred_at: "2026-04-01T00:00:00.000Z",
      source: {
        name: "congress",
        id: "vote-119-senate-42",
        url: "https://www.congress.gov/roll-call-votes/119/senate/42",
      },
      raw: { congress: 119, chamber: "Senate", rollNumber: 42, positions: [] },
    });
    const result = await ensureVoteFresh(store.db, {
      composite: { congress: 119, chamber: "upper", session: 1, roll_number: 42 },
    });
    expect(fetchVoteSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("refetches when fetched_at is > 1h old", async () => {
    upsertDocument(store.db, {
      kind: "vote",
      jurisdiction: "us-federal",
      title: "Vote 119-Senate-42: HR1234 — On Passage",
      occurred_at: "2026-04-01T00:00:00.000Z",
      source: {
        name: "congress",
        id: "vote-119-senate-42",
        url: "https://www.congress.gov/roll-call-votes/119/senate/42",
      },
      raw: { congress: 119, chamber: "Senate", rollNumber: 42, positions: [] },
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    store.db
      .prepare("UPDATE documents SET fetched_at = ? WHERE source_id = ?")
      .run(twoHoursAgo, "vote-119-senate-42");
    await ensureVoteFresh(store.db, {
      composite: { congress: 119, chamber: "upper", session: 1, roll_number: 42 },
    });
    expect(fetchVoteSpy).toHaveBeenCalledOnce();
  });

  it("returns stale_notice on upstream_failure when local row exists", async () => {
    upsertDocument(store.db, {
      kind: "vote",
      jurisdiction: "us-federal",
      title: "Vote 119-Senate-42: HR1234 — On Passage",
      occurred_at: "2026-04-01T00:00:00.000Z",
      source: {
        name: "congress",
        id: "vote-119-senate-42",
        url: "https://www.congress.gov/roll-call-votes/119/senate/42",
      },
      raw: { congress: 119, chamber: "Senate", rollNumber: 42, positions: [] },
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    store.db
      .prepare("UPDATE documents SET fetched_at = ? WHERE source_id = ?")
      .run(twoHoursAgo, "vote-119-senate-42");
    fetchVoteSpy.mockRejectedValueOnce(new Error("boom"));
    const result = await ensureVoteFresh(store.db, {
      composite: { congress: 119, chamber: "upper", session: 1, roll_number: 42 },
    });
    expect(result.ok).toBe(true);
    expect(result.stale_notice?.reason).toBe("upstream_failure");
    expect(result.documentId).toBeTruthy();
  });

  it("returns not_found on VoteNotFoundError", async () => {
    fetchVoteSpy.mockRejectedValueOnce(
      new VoteNotFoundError(119, "lower", 1, 9999),
    );
    const result = await ensureVoteFresh(store.db, {
      composite: { congress: 119, chamber: "lower", session: 1, roll_number: 9999 },
    });
    expect(result.ok).toBe(false);
    expect(result.stale_notice?.reason).toBe("not_found");
  });

  it("returns ok on direct vote_id lookup when local row exists and is fresh", async () => {
    upsertDocument(store.db, {
      kind: "vote",
      jurisdiction: "us-federal",
      title: "Vote 119-Senate-42: HR1234 — On Passage",
      occurred_at: "2026-04-01T00:00:00.000Z",
      source: {
        name: "congress",
        id: "vote-119-senate-42",
        url: "https://www.congress.gov/roll-call-votes/119/senate/42",
      },
      raw: { congress: 119, chamber: "Senate", rollNumber: 42, positions: [] },
    });
    const localId = (store.db
      .prepare("SELECT id FROM documents WHERE source_id = ?")
      .get("vote-119-senate-42") as { id: string }).id;

    const result = await ensureVoteFresh(store.db, { vote_id: localId });
    expect(fetchVoteSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.documentId).toBe(localId);
  });

  it("vote_id lookup: no-op-with-stale-notice when row missing and no composite available", async () => {
    const result = await ensureVoteFresh(store.db, { vote_id: "unknown-uuid" });
    expect(fetchVoteSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.stale_notice?.reason).toBe("not_found");
  });
});

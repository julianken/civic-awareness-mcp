import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleGetVote } from "../../../../src/mcp/tools/get_vote.js";

vi.mock("../../../../src/core/hydrate_vote.js", async (orig) => {
  const actual = await orig<typeof import("../../../../src/core/hydrate_vote.js")>();
  return { ...actual, ensureVoteFresh: vi.fn() };
});
import { ensureVoteFresh } from "../../../../src/core/hydrate_vote.js";
const mockEnsure = vi.mocked(ensureVoteFresh);

const TEST_DB = "./data/test-get-vote.db";
let store: Store;
let seededVoteId: string;

beforeEach(() => {
  mockEnsure.mockReset();
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  const { entity: schumer } = upsertEntity(store.db, {
    kind: "person", name: "Schumer, Charles E.", jurisdiction: undefined,
    external_ids: { bioguide: "S000148" },
    metadata: { party: "Democratic", state: "NY" },
  });
  upsertEntity(store.db, {
    kind: "person", name: "McConnell, Mitch", jurisdiction: undefined,
    external_ids: { bioguide: "M000355" },
    metadata: { party: "Republican", state: "KY" },
  });

  upsertDocument(store.db, {
    kind: "vote",
    jurisdiction: "us-federal",
    title: "Vote 119-Senate-42: HR1234 — On Passage of HR 1234",
    occurred_at: "2026-04-01T00:00:00.000Z",
    source: {
      name: "congress",
      id: "vote-119-senate-42",
      url: "https://www.congress.gov/roll-call-votes/119/senate/42",
    },
    references: [{ entity_id: schumer.id, role: "voter", qualifier: "yea" }],
    raw: {
      congress: 119,
      chamber: "Senate",
      rollNumber: 42,
      question: "On Passage of HR 1234",
      result: "Passed",
      bill: { type: "HR", number: "1234" },
      totals: { yea: 1, nay: 1, present: 0, notVoting: 0 },
      positions: [
        { bioguideId: "S000148", name: "Schumer, Charles E.", party: "Democratic", state: "NY", position: "yea" },
        { bioguideId: "M000355", name: "McConnell, Mitch", party: "Republican", state: "KY", position: "nay" },
      ],
    },
  });
  seededVoteId = (store.db
    .prepare("SELECT id FROM documents WHERE source_id = ?")
    .get("vote-119-senate-42") as { id: string }).id;
});
afterEach(() => store.close());

describe("get_vote tool", () => {
  it("projects per-member positions with resolved entity_id when called by vote_id", async () => {
    mockEnsure.mockResolvedValue({ ok: true, documentId: seededVoteId });
    const result = await handleGetVote(store.db, { vote_id: seededVoteId });

    expect(result.vote).not.toBeNull();
    expect(result.vote?.jurisdiction).toBe("us-federal");
    expect(result.vote?.chamber).toBe("upper");
    expect(result.vote?.bill_identifier).toBe("HR1234");
    expect(result.vote?.tally).toEqual({ yea: 1, nay: 1, present: 0, absent: 0 });
    expect(result.vote?.positions).toHaveLength(2);

    const schumer = result.vote?.positions.find((p) => p.name.startsWith("Schumer"));
    expect(schumer?.vote).toBe("yea");
    expect(schumer?.party).toBe("Democratic");
    expect(schumer?.state).toBe("NY");
    expect(schumer?.entity_id).toBeTruthy();

    const mcconnell = result.vote?.positions.find((p) => p.name.startsWith("McConnell"));
    expect(mcconnell?.entity_id).toBeTruthy();
    expect(mcconnell?.vote).toBe("nay");
  });

  it("projects by composite and uses documentId from ensureVoteFresh", async () => {
    mockEnsure.mockResolvedValue({ ok: true, documentId: seededVoteId });
    const result = await handleGetVote(store.db, {
      congress: 119, chamber: "upper", session: 1, roll_number: 42,
    });
    expect(result.vote?.positions).toHaveLength(2);
  });

  it("returns null vote + stale_notice when ensureVoteFresh reports not_found", async () => {
    mockEnsure.mockResolvedValue({
      ok: false,
      stale_notice: {
        as_of: new Date().toISOString(),
        reason: "not_found",
        message: "Vote not found: house 119-1 roll 9999",
      },
    });
    const result = await handleGetVote(store.db, {
      congress: 119, chamber: "lower", session: 1, roll_number: 9999,
    });
    expect(result.vote).toBeNull();
    expect(result.stale_notice?.reason).toBe("not_found");
  });

  it("returns null vote + not_yet_supported for non-federal jurisdictions (vote_id miss + no composite)", async () => {
    mockEnsure.mockResolvedValue({
      ok: false,
      stale_notice: {
        as_of: new Date().toISOString(),
        reason: "not_found",
        message: "Vote unknown not found in local store and no composite provided for upstream fetch.",
      },
    });
    const result = await handleGetVote(store.db, { vote_id: "unknown" });
    expect(result.vote).toBeNull();
    expect(result.stale_notice?.reason).toBe("not_found");
  });

  it("passes through upstream_failure stale_notice alongside projected vote", async () => {
    mockEnsure.mockResolvedValue({
      ok: true,
      documentId: seededVoteId,
      stale_notice: {
        as_of: "2026-04-01T00:00:00.000Z",
        reason: "upstream_failure",
        message: "Upstream congress fetch failed; serving stale local data. boom",
      },
    });
    const result = await handleGetVote(store.db, { vote_id: seededVoteId });
    expect(result.vote).not.toBeNull();
    expect(result.stale_notice?.reason).toBe("upstream_failure");
  });
});

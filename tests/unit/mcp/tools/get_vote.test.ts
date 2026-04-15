import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/federal/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleGetVote } from "../../../../src/federal/tools/get_vote.js";
import { CongressAdapter } from "../../../../src/federal/adapters/congress.js";
import { _resetLimitersForTesting } from "../../../../src/federal/limiters.js";

vi.mock("../../../../src/federal/hydrate_vote.js", async (orig) => {
  const actual = await orig<typeof import("../../../../src/federal/hydrate_vote.js")>();
  return { ...actual, ensureVoteFresh: vi.fn(actual.ensureVoteFresh) };
});
import * as hydrateVoteModule from "../../../../src/federal/hydrate_vote.js";
import { ensureVoteFresh } from "../../../../src/federal/hydrate_vote.js";
const mockEnsure = vi.mocked(ensureVoteFresh);
const realEnsureVoteFresh = (await vi.importActual<typeof hydrateVoteModule>(
  "../../../../src/federal/hydrate_vote.js",
)).ensureVoteFresh;

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
    expect(result.vote?.tally).toEqual({ yea: 1, nay: 1, present: 0, not_voting: 0 });
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

  // F13: race between ensureVoteFresh resolving a documentId and the SELECT
  // returning no row should surface a stale_notice rather than silently
  // returning vote: null.
  it("surfaces a stale_notice when freshness reports ok but the row is missing (race)", async () => {
    mockEnsure.mockResolvedValue({ ok: true, documentId: "ghost-doc-id" });
    const result = await handleGetVote(store.db, { vote_id: "ghost-doc-id" });
    expect(result.vote).toBeNull();
    expect(result.stale_notice?.reason).toBe("not_found");
    expect(result.stale_notice?.message).toContain("race");
  });

  // F2: result fallback uses a distinct sentinel that cannot collide with
  // an upstream literal like "Passed" or "Failed".
  it("falls back to the distinct sentinel `result_missing` when raw.result is absent", async () => {
    upsertDocument(store.db, {
      kind: "vote",
      jurisdiction: "us-federal",
      title: "Vote without result",
      occurred_at: "2026-04-02T00:00:00.000Z",
      source: {
        name: "congress",
        id: "vote-119-senate-43",
        url: "https://www.congress.gov/roll-call-votes/119/senate/43",
      },
      references: [],
      raw: {
        congress: 119,
        chamber: "Senate",
        rollNumber: 43,
        totals: { yea: 0, nay: 0, present: 0, notVoting: 0 },
        positions: [],
      },
    });
    const noResultId = (store.db
      .prepare("SELECT id FROM documents WHERE source_id = ?")
      .get("vote-119-senate-43") as { id: string }).id;
    mockEnsure.mockResolvedValue({ ok: true, documentId: noResultId });

    const result = await handleGetVote(store.db, { vote_id: noResultId });
    expect(result.vote?.result).toBe("result_missing");
  });

  // C9: bioguide-lookup statement is hoisted above the .map() loop. With N
  // positions, db.prepare for the bioguide SELECT must be called exactly
  // once per handleGetVote invocation. Wrap db.prepare to count it.
  it("prepares the bioguide-lookup statement exactly once regardless of N positions", async () => {
    mockEnsure.mockResolvedValue({ ok: true, documentId: seededVoteId });
    const prepareSpy = vi.spyOn(store.db, "prepare");
    await handleGetVote(store.db, { vote_id: seededVoteId });
    const bioguideCalls = prepareSpy.mock.calls.filter((c) =>
      String(c[0]).includes(`json_extract(external_ids, '$."bioguide"')`),
    );
    expect(bioguideCalls).toHaveLength(1);
    prepareSpy.mockRestore();
  });
});

// C5: normalisePosition edge cases. The handler's normalisePosition is a
// defensive guard layered on top of the adapter's normalizeVotePosition,
// which already lowercases + snake-cases. Anything outside the canonical
// triple ("yea" | "nay" | "present") should collapse to "not_voting".
describe("get_vote normalisePosition (defensive guard)", () => {
  let edgeStore: Store;
  let edgeVoteId: string;
  const EDGE_DB = "./data/test-get-vote-edges.db";

  beforeEach(() => {
    if (existsSync(EDGE_DB)) rmSync(EDGE_DB);
    edgeStore = openStore(EDGE_DB);
    seedJurisdictions(edgeStore.db);
    upsertDocument(edgeStore.db, {
      kind: "vote",
      jurisdiction: "us-federal",
      title: "edges",
      occurred_at: "2026-04-03T00:00:00.000Z",
      source: { name: "congress", id: "vote-119-senate-44", url: "x" },
      references: [],
      raw: {
        congress: 119,
        chamber: "Senate",
        rollNumber: 44,
        result: "Passed",
        totals: { yea: 1, nay: 0, present: 1, notVoting: 5 },
        positions: [
          { bioguideId: "B1", name: "Lower Yea", party: null, state: null, position: "yea" },
          { bioguideId: "B2", name: "Capital Yea", party: null, state: null, position: "Yea" },
          { bioguideId: "B3", name: "Capital Aye", party: null, state: null, position: "Aye" },
          { bioguideId: "B4", name: "Capital Present", party: null, state: null, position: "Present" },
          { bioguideId: "B5", name: "Not Voting Spaced", party: null, state: null, position: "Not Voting" },
          { bioguideId: "B6", name: "Empty", party: null, state: null, position: "" },
          { bioguideId: "B7", name: "Excused", party: null, state: null, position: "Excused" },
          { bioguideId: "B8", name: "Unknown", party: null, state: null, position: "unknown_value" },
        ],
      },
    });
    edgeVoteId = (edgeStore.db
      .prepare("SELECT id FROM documents WHERE source_id = ?")
      .get("vote-119-senate-44") as { id: string }).id;
    mockEnsure.mockResolvedValue({ ok: true, documentId: edgeVoteId });
  });
  afterEach(() => edgeStore.close());

  it("keeps lowercase canonical positions", async () => {
    const r = await handleGetVote(edgeStore.db, { vote_id: edgeVoteId });
    expect(r.vote?.positions.find((p) => p.name === "Lower Yea")?.vote).toBe("yea");
  });

  it("collapses non-canonical positions (Yea/Aye/Present/Not Voting/empty/Excused/unknown) to not_voting", async () => {
    const r = await handleGetVote(edgeStore.db, { vote_id: edgeVoteId });
    const get = (n: string) => r.vote?.positions.find((p) => p.name === n)?.vote;
    expect(get("Capital Yea")).toBe("not_voting");
    expect(get("Capital Aye")).toBe("not_voting");
    expect(get("Capital Present")).toBe("not_voting");
    expect(get("Not Voting Spaced")).toBe("not_voting");
    expect(get("Empty")).toBe("not_voting");
    expect(get("Excused")).toBe("not_voting");
    expect(get("Unknown")).toBe("not_voting");
  });
});

// C2: handler ↔ hydrate contract test using the REAL ensureVoteFresh and
// only spying on the upstream HTTP boundary (CongressAdapter.fetchVote).
// Sibling to the projection-only mocked tests above.
describe("get_vote with real ensureVoteFresh (handler ↔ hydrate contract)", () => {
  const REAL_DB = "./data/test-get-vote-real-ensure.db";
  let realStore: Store;

  beforeEach(() => {
    if (existsSync(REAL_DB)) rmSync(REAL_DB);
    realStore = openStore(REAL_DB);
    seedJurisdictions(realStore.db);
    _resetLimitersForTesting();
    process.env.API_DATA_GOV_KEY = "test-key";
    mockEnsure.mockImplementation(realEnsureVoteFresh);
  });
  afterEach(() => {
    realStore.close();
    delete process.env.API_DATA_GOV_KEY;
    vi.restoreAllMocks();
  });

  it("hydrates via real ensureVoteFresh + spied CongressAdapter.fetchVote", async () => {
    const fetchVoteSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchVote")
      .mockImplementation(async function (this: CongressAdapter, db, opts) {
        upsertDocument(db, {
          kind: "vote",
          jurisdiction: "us-federal",
          title: `Vote ${opts.congress}-senate-${opts.roll_number}`,
          occurred_at: "2026-04-04T00:00:00.000Z",
          source: {
            name: "congress",
            id: `vote-${opts.congress}-senate-${opts.roll_number}`,
            url: `https://www.congress.gov/roll-call-votes/${opts.congress}/senate/${opts.roll_number}`,
          },
          references: [],
          raw: {
            congress: opts.congress,
            chamber: "Senate",
            rollNumber: opts.roll_number,
            result: "Passed",
            totals: { yea: 1, nay: 0, present: 0, notVoting: 0 },
            positions: [
              { bioguideId: "Z000001", name: "Real Senator", party: "Independent", state: "VT", position: "yea" },
            ],
          },
        });
        const row = db
          .prepare("SELECT id FROM documents WHERE source_id = ?")
          .get(`vote-${opts.congress}-senate-${opts.roll_number}`) as { id: string };
        return { documentId: row.id };
      });

    const result = await handleGetVote(realStore.db, {
      congress: 119,
      chamber: "upper",
      session: 1,
      roll_number: 99,
    });

    expect(fetchVoteSpy).toHaveBeenCalledOnce();
    expect(result.vote?.positions).toHaveLength(1);
    expect(result.vote?.positions[0].vote).toBe("yea");
  });

  // C3: handler-level TTL — second call within 1h must NOT re-invoke
  // CongressAdapter.fetchVote.
  it("does not re-fetch on a second call within the per-document TTL", async () => {
    const fetchVoteSpy = vi
      .spyOn(CongressAdapter.prototype, "fetchVote")
      .mockImplementation(async function (this: CongressAdapter, db, opts) {
        upsertDocument(db, {
          kind: "vote",
          jurisdiction: "us-federal",
          title: `Vote ${opts.congress}-senate-${opts.roll_number}`,
          occurred_at: "2026-04-04T00:00:00.000Z",
          source: {
            name: "congress",
            id: `vote-${opts.congress}-senate-${opts.roll_number}`,
            url: "x",
          },
          references: [],
          raw: {
            congress: opts.congress,
            chamber: "Senate",
            rollNumber: opts.roll_number,
            result: "Passed",
            totals: { yea: 0, nay: 0, present: 0, notVoting: 0 },
            positions: [],
          },
        });
        const row = db
          .prepare("SELECT id FROM documents WHERE source_id = ?")
          .get(`vote-${opts.congress}-senate-${opts.roll_number}`) as { id: string };
        return { documentId: row.id };
      });

    const args = { congress: 119, chamber: "upper" as const, session: 1 as const, roll_number: 100 };
    const first = await handleGetVote(realStore.db, args);
    expect(first.vote).not.toBeNull();
    await handleGetVote(realStore.db, args);
    await handleGetVote(realStore.db, { vote_id: first.vote!.id });

    expect(fetchVoteSpy).toHaveBeenCalledOnce();
  });
});

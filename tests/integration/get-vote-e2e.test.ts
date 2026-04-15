/**
 * End-to-end integration test for `get_vote` (Phase 9c Task 5).
 *
 * Three scenarios:
 *   1. Cold hydrate by federal composite projects tally + per-member
 *      positions with resolved entity_ids.
 *   2. Second call within the per-document TTL serves from the local
 *      store without re-fetching upstream.
 *   3. Upstream 404 surfaces as `stale_notice.reason === "not_found"`.
 *
 * HTTP is stubbed with `vi.spyOn(global, "fetch")` to match the rest
 * of this codebase (msw is not a project dep). The fixture JSON is
 * loaded from disk and returned as a `Response` from the spy.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/federal/seeds.js";
import { handleGetVote } from "../../src/federal/tools/get_vote.js";
import { _resetLimitersForTesting } from "../../src/federal/limiters.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/congress-vote-detail.json"), "utf-8"),
);

const TEST_DB = "./data/test-get-vote-e2e.db";
let store: Store;

beforeAll(() => {
  process.env.API_DATA_GOV_KEY = "test-key";
});
afterAll(() => {
  delete process.env.API_DATA_GOV_KEY;
});
beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  _resetLimitersForTesting();
});
afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return String(typeof input === "string" ? input : (input as URL | Request).toString());
}

describe("get_vote e2e", () => {
  it("hydrates a federal vote by composite and projects per-member positions", async () => {
    let hitCount = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.includes("/senate-vote/119/1/42")) {
        hitCount += 1;
        return new Response(JSON.stringify(fixture), { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const result = await handleGetVote(store.db, {
      congress: 119,
      chamber: "upper",
      session: 1,
      roll_number: 42,
    });

    expect(hitCount).toBe(1);
    expect(result.vote?.bill_identifier).toBe("HR1234");
    expect(result.vote?.chamber).toBe("upper");
    expect(result.vote?.tally).toEqual({ yea: 52, nay: 47, present: 1, not_voting: 2 });
    expect(result.vote?.positions).toHaveLength(5);
    expect(result.vote?.positions.find((p) => p.name.startsWith("Schumer"))?.vote).toBe("yea");
    expect(result.vote?.positions.every((p) => p.entity_id !== null)).toBe(true);

    const king = result.vote?.positions.find((p) => p.name.startsWith("King"));
    expect(king?.vote).toBe("present");
    expect(king?.party).toBeNull();

    const doe = result.vote?.positions.find((p) => p.name.startsWith("Doe"));
    expect(doe?.vote).toBe("not_voting");
    expect(doe?.state).toBeUndefined();
  });

  it("serves from cache on second call within TTL", async () => {
    let hitCount = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.includes("/senate-vote/119/1/42")) {
        hitCount += 1;
        return new Response(JSON.stringify(fixture), { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const first = await handleGetVote(store.db, {
      congress: 119,
      chamber: "upper",
      session: 1,
      roll_number: 42,
    });
    const voteId = first.vote!.id;

    await handleGetVote(store.db, { vote_id: voteId });
    await handleGetVote(store.db, {
      congress: 119,
      chamber: "upper",
      session: 1,
      roll_number: 42,
    });

    expect(hitCount).toBe(1);
  });

  it("returns not_found stale_notice when upstream 404s", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.includes("/house-vote/119/1/9999")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      return new Response("", { status: 404 });
    });

    const result = await handleGetVote(store.db, {
      congress: 119,
      chamber: "lower",
      session: 1,
      roll_number: 9999,
    });

    expect(result.vote).toBeNull();
    expect(result.stale_notice?.reason).toBe("not_found");
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/federal/seeds.js";
import { OpenStatesAdapter } from "../../../../src/state/adapters/openstates.js";

/** Minimal fixture with 2 bills:
 *  - bill1 ("SB 11"): 2 votes (one date-only, one with sources)
 *  - bill2 ("HB 149"): empty votes array
 */
const FIXTURE = {
  results: [
    {
      id: "ocd-bill/7342e6dd-482e-4ea5-acf8-4cb8e3be29c7",
      session: "892",
      jurisdiction: {
        id: "ocd-jurisdiction/country:us/state:tx/government",
        name: "Texas",
        classification: "state",
      },
      from_organization: {
        id: "ocd-organization/cabf1716-c572-406a-bfdd-1917c11ac629",
        name: "Senate",
        classification: "upper",
      },
      identifier: "SB 11",
      title: "Relating to trafficking.",
      classification: ["bill"],
      subject: [],
      extras: {},
      created_at: "2025-08-18T20:53:35.334763+00:00",
      updated_at: "2026-04-04T06:20:24.862671+00:00",
      openstates_url: "https://openstates.org/tx/bills/892/SB11/",
      first_action_date: "2025-08-15",
      latest_action_date: "2025-09-17",
      latest_action_description: "Effective on.",
      latest_passage_date: "2025-08-28",
      votes: [
        {
          id: "ocd-vote/72ff3868-fd74-43c0-a189-6377c8978c90",
          motion_text: "Senate Rule suspension",
          motion_classification: ["passage", "reading-3"],
          start_date: "2025-08-18",
          result: "pass",
          identifier: "",
          extras: {},
          organization: {
            id: "ocd-organization/cabf1716-c572-406a-bfdd-1917c11ac629",
            name: "Senate",
            classification: "upper",
          },
          votes: [],
          counts: [
            { option: "yes", value: 30 },
            { option: "no", value: 0 },
            { option: "not voting", value: 0 },
          ],
          sources: [
            { url: "https://journals.senate.texas.gov/SJRNL/892/HTML/89S2SJ08-18-F.HTM", note: "" },
          ],
        },
        {
          id: "ocd-vote/a799d36a-ec30-4e86-bc3d-11cd7575c679",
          motion_text: "passage",
          motion_classification: ["passage"],
          start_date: "2025-08-26",
          result: "pass",
          identifier: "",
          extras: {},
          organization: {
            id: "ocd-organization/7890abcd-0001-0001-0001-000000000001",
            name: "House",
            classification: "lower",
          },
          votes: [],
          counts: [
            { option: "yes", value: 136 },
            { option: "no", value: 0 },
            { option: "not voting", value: 1 },
          ],
          // No sources — fallback to bill.openstates_url
          sources: [],
        },
      ],
    },
    {
      id: "ocd-bill/5bb8cda9-6057-4274-b5d6-36fcc2fd6ab3",
      session: "892",
      jurisdiction: {
        id: "ocd-jurisdiction/country:us/state:tx/government",
        name: "Texas",
        classification: "state",
      },
      from_organization: { id: "org-2", name: "House", classification: "lower" },
      identifier: "HB 149",
      title: "Education bill.",
      classification: ["bill"],
      subject: [],
      extras: {},
      created_at: "2025-08-18T20:00:00.000000+00:00",
      updated_at: "2026-04-01T00:00:00.000000+00:00",
      openstates_url: "https://openstates.org/tx/bills/892/HB149/",
      first_action_date: "2025-08-18",
      latest_action_date: "2025-08-27",
      latest_action_description: "Passed.",
      latest_passage_date: "2025-08-27",
      votes: [],
    },
  ],
  pagination: { per_page: 20, page: 1, max_page: 1 },
};

let store: Store;
let adapter: OpenStatesAdapter;

beforeEach(() => {
  store = openStore(":memory:");
  seedJurisdictions(store.db);
  adapter = new OpenStatesAdapter({ apiKey: "test-key" });
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

describe("OpenStatesAdapter.fetchRecentVotes", () => {
  it("upserts vote documents from bills with votes, skips bills with empty votes", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(FIXTURE), { status: 200 }),
    );

    const result = await adapter.fetchRecentVotes(store.db, {
      jurisdiction: "tx",
      updated_since: "2025-08-01",
      limit: 10,
    });

    expect(result.documentsUpserted).toBe(2);

    const voteRows = store.db
      .prepare("SELECT * FROM documents WHERE kind = 'vote' ORDER BY occurred_at")
      .all() as Array<{
      source_name: string;
      source_id: string;
      jurisdiction: string;
      occurred_at: string;
      raw: string;
      source_url: string;
      title: string;
    }>;

    expect(voteRows).toHaveLength(2);

    for (const row of voteRows) {
      expect(row.source_name).toBe("openstates");
      expect(row.jurisdiction).toBe("us-tx");
      // occurred_at must be valid ISO-8601 datetime (normalizeIsoDatetime applied)
      expect(new Date(row.occurred_at).toISOString()).toBe(row.occurred_at);
    }

    expect(voteRows[0].source_id).toBe("ocd-vote/72ff3868-fd74-43c0-a189-6377c8978c90");
    expect(voteRows[1].source_id).toBe("ocd-vote/a799d36a-ec30-4e86-bc3d-11cd7575c679");
  });

  it("raw payload has chamber, result, counts, bill.identifier — no per-member votes array", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(FIXTURE), { status: 200 }),
    );

    await adapter.fetchRecentVotes(store.db, { jurisdiction: "tx" });

    const row = store.db
      .prepare("SELECT raw FROM documents WHERE source_id = ?")
      .get("ocd-vote/72ff3868-fd74-43c0-a189-6377c8978c90") as { raw: string } | undefined;

    expect(row).toBeDefined();
    const raw = JSON.parse(row!.raw) as Record<string, unknown>;
    expect(raw).toHaveProperty("chamber");
    expect(raw).toHaveProperty("result");
    expect(raw).toHaveProperty("counts");
    expect(raw).toHaveProperty("bill");
    expect((raw.bill as Record<string, unknown>).identifier).toBe("SB 11");
    // Per gotcha #5: per-member votes array must NOT be stored
    expect(raw).not.toHaveProperty("votes");
  });

  it("uses vote.sources[0].url when present; falls back to bill.openstates_url when sources is empty", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(FIXTURE), { status: 200 }),
    );

    await adapter.fetchRecentVotes(store.db, { jurisdiction: "tx" });

    const vote1 = store.db
      .prepare("SELECT source_url FROM documents WHERE source_id = ?")
      .get("ocd-vote/72ff3868-fd74-43c0-a189-6377c8978c90") as { source_url: string } | undefined;
    const vote2 = store.db
      .prepare("SELECT source_url FROM documents WHERE source_id = ?")
      .get("ocd-vote/a799d36a-ec30-4e86-bc3d-11cd7575c679") as { source_url: string } | undefined;

    expect(vote1?.source_url).toBe(
      "https://journals.senate.texas.gov/SJRNL/892/HTML/89S2SJ08-18-F.HTM",
    );
    // vote2 has empty sources — should fall back to parent bill's openstates_url
    expect(vote2?.source_url).toBe("https://openstates.org/tx/bills/892/SB11/");
  });

  it("sends correct query params: jurisdiction, sort=updated_desc, include=votes, no Z suffix on updated_since", async () => {
    let capturedUrl: string | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      capturedUrl = typeof input === "string" ? input : String(input);
      return new Response(JSON.stringify({ results: [], pagination: { max_page: 1, page: 1 } }), {
        status: 200,
      });
    });

    await adapter.fetchRecentVotes(store.db, {
      jurisdiction: "tx",
      updated_since: "2025-08-01",
      limit: 10,
    });

    expect(capturedUrl).toBeDefined();
    const url = new URL(capturedUrl!);
    expect(url.searchParams.get("jurisdiction")).toBe("tx");
    expect(url.searchParams.get("sort")).toBe("updated_desc");
    expect(url.searchParams.getAll("include")).toContain("votes");
    expect(url.searchParams.get("updated_since")).toBe("2025-08-01");
    expect(url.searchParams.get("updated_since")).not.toMatch(/Z$/);
  });

  it("produces zero vote documents when all bills have empty votes arrays", async () => {
    const emptyFixture = {
      results: [{ ...FIXTURE.results[1] }],
      pagination: { per_page: 20, page: 1, max_page: 1 },
    };
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(emptyFixture), { status: 200 }),
    );

    const result = await adapter.fetchRecentVotes(store.db, { jurisdiction: "tx" });
    expect(result.documentsUpserted).toBe(0);

    const voteRows = store.db.prepare("SELECT * FROM documents WHERE kind = 'vote'").all();
    expect(voteRows).toHaveLength(0);
  });
});

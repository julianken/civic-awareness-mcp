/**
 * Phase 5 end-to-end integration test.
 *
 * Simulates a merged-Person entity with roles spanning three sources
 * (OpenStates, Congress.gov, OpenFEC) and verifies both Phase 5 tools
 * produce correct output over that graph.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../src/core/store.js";
import { seedJurisdictions } from "../../src/federal/seeds.js";
import { upsertEntity } from "../../src/core/entities.js";
import { upsertDocument } from "../../src/core/documents.js";
import { _resetToolCacheForTesting } from "../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../src/federal/limiters.js";
import { OpenStatesAdapter } from "../../src/state/adapters/openstates.js";
import { CongressAdapter } from "../../src/federal/adapters/congress.js";
import { OpenFecAdapter } from "../../src/federal/adapters/openfec.js";
import { handleEntityConnections } from "../../src/federal/tools/entity_connections.js";
import { handleResolvePerson } from "../../src/federal/tools/resolve_person.js";

const TEST_DB = "./data/test-phase5-e2e.db";
let store: Store;

// The merged Person: state legislator → Member of Congress → FEC candidate.
let personId: string;
// Co-occurring entities
let coSponsorId: string;
let voterColleagueId: string;
let donorId: string;
let pacId: string;

beforeEach(() => {
  _resetToolCacheForTesting();
  _resetLimitersForTesting();
  process.env.OPENSTATES_API_KEY = "test-key";
  process.env.API_DATA_GOV_KEY = "test-key";

  // R15: resolve_person + entity_connections no longer call ensureFresh.
  // Tests that pass a `jurisdiction_hint` or hit entity_connections would
  // otherwise trigger live fetches via the withShapedFetch fanout, so we
  // stub all narrow adapter methods the handlers might invoke.
  vi.spyOn(OpenStatesAdapter.prototype, "searchPeople").mockImplementation(async () => ({
    entitiesUpserted: 0,
  }));
  vi.spyOn(CongressAdapter.prototype, "searchMembers").mockImplementation(async () => ({
    entitiesUpserted: 0,
  }));
  vi.spyOn(OpenFecAdapter.prototype, "searchCandidates").mockImplementation(async () => ({
    entitiesUpserted: 0,
  }));
  vi.spyOn(CongressAdapter.prototype, "fetchMemberSponsoredBills").mockImplementation(async () => ({
    documentsUpserted: 0,
  }));
  vi.spyOn(CongressAdapter.prototype, "fetchMemberCosponsoredBills").mockImplementation(
    async () => ({ documentsUpserted: 0 }),
  );
  vi.spyOn(OpenStatesAdapter.prototype, "fetchBillsBySponsor").mockImplementation(async () => ({
    documentsUpserted: 0,
  }));
  vi.spyOn(OpenFecAdapter.prototype, "fetchContributionsToCandidate").mockImplementation(
    async () => ({ documentsUpserted: 0 }),
  );

  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  // Seed the merged Person with three external IDs and three roles.
  const person = upsertEntity(store.db, {
    kind: "person",
    name: "Margaret H. Callahan",
    aliases: ["Peggy Callahan", "M. Callahan"],
    external_ids: {
      openstates_person: "ocd-person/test-callahan",
      bioguide: "C999999",
      fec_candidate: "H6IL99999",
    },
    metadata: {
      roles: [
        {
          jurisdiction: "us-il",
          role: "state_legislator",
          from: "2010-01-01T00:00:00.000Z",
          to: "2016-11-08T00:00:00.000Z",
        },
        {
          jurisdiction: "us-federal",
          role: "representative",
          from: "2017-01-03T00:00:00.000Z",
          to: null,
        },
        {
          jurisdiction: "us-federal",
          role: "federal_candidate",
          from: "2023-01-01T00:00:00.000Z",
          to: null,
        },
      ],
    },
  }).entity;
  personId = person.id;

  // Co-sponsor on a state bill (OpenStates).
  const coSponsor = upsertEntity(store.db, {
    kind: "person",
    name: "Thomas Benitez",
    external_ids: { openstates_person: "ocd-person/test-benitez" },
  }).entity;
  coSponsorId = coSponsor.id;

  // Colleague on federal votes (Congress).
  const voterColleague = upsertEntity(store.db, {
    kind: "person",
    name: "Lydia Okonkwo",
    external_ids: { bioguide: "O100001" },
    metadata: {
      roles: [
        {
          jurisdiction: "us-federal",
          role: "representative",
          from: "2015-01-03T00:00:00.000Z",
          to: null,
        },
      ],
    },
  }).entity;
  voterColleagueId = voterColleague.id;

  // Individual donor (OpenFEC).
  const donor = upsertEntity(store.db, {
    kind: "person",
    name: "Randolph Alvarez",
  }).entity;
  donorId = donor.id;

  // PAC (OpenFEC).
  const pac = upsertEntity(store.db, {
    kind: "pac",
    name: "Illinois Forward PAC",
    jurisdiction: "us-federal",
    external_ids: { fec_committee: "C00999001" },
  }).entity;
  pacId = pac.id;

  // ── State bills (OpenStates) ─────────────────────────────────────────
  // Callahan co-sponsors two state bills with Benitez.
  upsertDocument(store.db, {
    kind: "bill",
    jurisdiction: "us-il",
    title: "IL HB 1234 — Energy Efficiency Standards",
    occurred_at: "2013-03-15T00:00:00.000Z",
    source: {
      name: "openstates",
      id: "ocd-bill/il-2013-hb1234",
      url: "https://openstates.org/il/bills/il-2013-hb1234/",
    },
    references: [
      { entity_id: personId, role: "sponsor" },
      { entity_id: coSponsorId, role: "cosponsor" },
    ],
  });
  upsertDocument(store.db, {
    kind: "bill",
    jurisdiction: "us-il",
    title: "IL SB 567 — Water Conservation Act",
    occurred_at: "2014-01-20T00:00:00.000Z",
    source: {
      name: "openstates",
      id: "ocd-bill/il-2014-sb567",
      url: "https://openstates.org/il/bills/il-2014-sb567/",
    },
    references: [
      { entity_id: personId, role: "sponsor" },
      { entity_id: coSponsorId, role: "cosponsor" },
    ],
  });

  // ── Federal bills (Congress) ─────────────────────────────────────────
  // Callahan sponsors two federal bills; Okonkwo is a co-sponsor.
  upsertDocument(store.db, {
    kind: "bill",
    jurisdiction: "us-federal",
    title: "HR 4500 — National Infrastructure Renewal Act",
    occurred_at: "2021-06-10T00:00:00.000Z",
    source: {
      name: "congress",
      id: "congress-hr4500-117",
      url: "https://www.congress.gov/bill/117th-congress/house-bill/4500",
    },
    references: [
      { entity_id: personId, role: "sponsor" },
      { entity_id: voterColleagueId, role: "cosponsor" },
    ],
  });
  upsertDocument(store.db, {
    kind: "bill",
    jurisdiction: "us-federal",
    title: "HR 7890 — Clean Water Modernization Act",
    occurred_at: "2022-03-05T00:00:00.000Z",
    source: {
      name: "congress",
      id: "congress-hr7890-117",
      url: "https://www.congress.gov/bill/117th-congress/house-bill/7890",
    },
    references: [
      { entity_id: personId, role: "sponsor" },
      { entity_id: voterColleagueId, role: "cosponsor" },
    ],
  });

  // ── Federal votes (Congress) ─────────────────────────────────────────
  // Callahan and Okonkwo vote together on two roll calls.
  upsertDocument(store.db, {
    kind: "vote",
    jurisdiction: "us-federal",
    title: "Roll Call 312 — HR 4500 Passage",
    occurred_at: "2021-09-30T00:00:00.000Z",
    source: {
      name: "congress",
      id: "congress-vote-117-312",
      url: "https://www.congress.gov/roll-call-votes/117/312",
    },
    references: [
      { entity_id: personId, role: "voter", qualifier: "yea" },
      { entity_id: voterColleagueId, role: "voter", qualifier: "yea" },
    ],
  });
  upsertDocument(store.db, {
    kind: "vote",
    jurisdiction: "us-federal",
    title: "Roll Call 489 — HR 7890 Passage",
    occurred_at: "2022-05-12T00:00:00.000Z",
    source: {
      name: "congress",
      id: "congress-vote-117-489",
      url: "https://www.congress.gov/roll-call-votes/117/489",
    },
    references: [
      { entity_id: personId, role: "voter", qualifier: "yea" },
      { entity_id: voterColleagueId, role: "voter", qualifier: "yea" },
    ],
  });

  // ── Federal contributions (OpenFEC) ──────────────────────────────────
  // Donor contributes to Callahan twice; PAC contributes once separately.
  upsertDocument(store.db, {
    kind: "contribution",
    jurisdiction: "us-federal",
    title: "Contribution: Alvarez → Callahan for Congress (2024-02-10)",
    occurred_at: "2024-02-10T00:00:00.000Z",
    source: {
      name: "openfec",
      id: "fec-sa17-001",
      url: "https://www.fec.gov/data/receipts/?committee_id=C00999001",
    },
    references: [
      { entity_id: donorId, role: "contributor" },
      { entity_id: personId, role: "recipient" },
    ],
  });
  upsertDocument(store.db, {
    kind: "contribution",
    jurisdiction: "us-federal",
    title: "Contribution: Alvarez → Callahan for Congress (2024-03-22)",
    occurred_at: "2024-03-22T00:00:00.000Z",
    source: {
      name: "openfec",
      id: "fec-sa17-002",
      url: "https://www.fec.gov/data/receipts/?committee_id=C00999001",
    },
    references: [
      { entity_id: donorId, role: "contributor" },
      { entity_id: personId, role: "recipient" },
    ],
  });
  upsertDocument(store.db, {
    kind: "contribution",
    jurisdiction: "us-federal",
    title: "Contribution: Illinois Forward PAC → Callahan for Congress (2024-04-01)",
    occurred_at: "2024-04-01T00:00:00.000Z",
    source: {
      name: "openfec",
      id: "fec-sb23-003",
      url: "https://www.fec.gov/data/disbursements/?committee_id=C00999001",
    },
    references: [
      { entity_id: pacId, role: "contributor" },
      { entity_id: personId, role: "recipient" },
    ],
  });
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  delete process.env.OPENSTATES_API_KEY;
  delete process.env.API_DATA_GOV_KEY;
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

describe("entity_connections — 3-source graph (Phase 5 E2E)", () => {
  it("returns edges of kind=bill (state), kind=bill (federal), kind=vote, kind=contribution", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 2,
    });

    expect(result.root.id).toBe(personId);
    expect(result.edges.length).toBeGreaterThanOrEqual(3);

    const allViaKinds = result.edges.flatMap((e) => e.via_kinds);
    expect(allViaKinds).toContain("bill");
    expect(allViaKinds).toContain("vote");
    expect(allViaKinds).toContain("contribution");
  });

  it("connects Callahan ↔ Benitez via state bills", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 2,
    });
    const edge = result.edges.find((e) => e.to === coSponsorId || e.from === coSponsorId);
    expect(edge).toBeDefined();
    expect(edge!.via_kinds).toContain("bill");
    expect(edge!.co_occurrence_count).toBe(2);
  });

  it("connects Callahan ↔ Okonkwo via federal bills AND votes", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 2,
    });
    const edge = result.edges.find((e) => e.to === voterColleagueId || e.from === voterColleagueId);
    expect(edge).toBeDefined();
    expect(edge!.via_kinds).toContain("bill");
    expect(edge!.via_kinds).toContain("vote");
    // 2 shared bills + 2 shared votes = 4 total co-occurring docs
    expect(edge!.co_occurrence_count).toBe(4);
  });

  it("connects Callahan ↔ Alvarez (donor) via contributions", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 2,
    });
    const edge = result.edges.find((e) => e.to === donorId || e.from === donorId);
    expect(edge).toBeDefined();
    expect(edge!.via_kinds).toContain("contribution");
    expect(edge!.co_occurrence_count).toBe(2);
  });

  it("includes all connected entities in nodes (deduped)", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 2,
    });
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).toContain(coSponsorId);
    expect(nodeIds).toContain(voterColleagueId);
    expect(nodeIds).toContain(donorId);
    // No duplicates
    expect(nodeIds.length).toBe(new Set(nodeIds).size);
    // Root not in nodes
    expect(nodeIds).not.toContain(personId);
  });

  it("sample_documents contains at most 3 items per edge", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 1,
    });
    for (const edge of result.edges) {
      expect(edge.sample_documents.length).toBeLessThanOrEqual(3);
    }
  });

  it("includes sources from all three data providers", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 1,
    });
    const sourceNames = result.sources.map((s) => s.name);
    // At minimum congress and openfec docs appear as sample documents
    expect(sourceNames.some((n) => n === "congress" || n === "openstates" || n === "openfec")).toBe(
      true,
    );
  });

  it("depth=2 from Benitez reaches Okonkwo through Callahan", async () => {
    // Benitez → Callahan (state bills), Callahan → Okonkwo (federal)
    const result = await handleEntityConnections(store.db, {
      id: coSponsorId,
      depth: 2,
      min_co_occurrences: 1,
    });
    const nodeIds = result.nodes.map((n) => n.id);
    // At depth=2, Okonkwo should be reachable
    expect(nodeIds).toContain(voterColleagueId);
  });

  it("does not return truncated=true when edges are within cap", async () => {
    const result = await handleEntityConnections(store.db, {
      id: personId,
      depth: 1,
      min_co_occurrences: 1,
    });
    // 4 connections total (Benitez, Okonkwo, Alvarez, PAC) — well under 100
    expect(result.truncated).toBe(false);
  });
});

describe("resolve_person — 3-source graph (Phase 5 E2E)", () => {
  it("finds Callahan by canonical name with confidence=exact", async () => {
    const result = await handleResolvePerson(store.db, {
      name: "Margaret H. Callahan",
    });
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const match = result.matches.find((m) => m.entity_id === personId);
    expect(match).toBeDefined();
    expect(match!.confidence).toBe("exact");
  });

  it("finds Callahan by known alias 'Peggy Callahan' with confidence=alias", async () => {
    const result = await handleResolvePerson(store.db, {
      name: "Peggy Callahan",
    });
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const match = result.matches.find((m) => m.entity_id === personId);
    expect(match).toBeDefined();
    expect(match!.confidence).toBe("alias");
  });

  it("finds Callahan by alias 'M. Callahan' with confidence=alias", async () => {
    const result = await handleResolvePerson(store.db, {
      name: "M. Callahan",
    });
    const match = result.matches.find((m) => m.entity_id === personId);
    expect(match).toBeDefined();
    expect(match!.confidence).toBe("alias");
  });

  it("finds Callahan with fuzzy typo + jurisdiction_hint=us-il", async () => {
    // "Margaret H. Calahan" — one 'l' missing — distance=1
    const result = await handleResolvePerson(store.db, {
      name: "Margaret H. Calahan",
      jurisdiction_hint: "us-il",
    });
    const match = result.matches.find((m) => m.entity_id === personId);
    expect(match).toBeDefined();
    expect(match!.confidence).toBe("fuzzy");
  });

  it("finds Callahan with fuzzy typo + role_hint=representative", async () => {
    const result = await handleResolvePerson(store.db, {
      name: "Margaret H. Calahan",
      role_hint: "representative",
    });
    const match = result.matches.find((m) => m.entity_id === personId);
    expect(match).toBeDefined();
    expect(match!.confidence).toBe("fuzzy");
  });

  it("does NOT find Callahan by fuzzy typo alone (no linking signal)", async () => {
    const result = await handleResolvePerson(store.db, {
      name: "Margaret H. Calahan",
    });
    const fuzzyForCallahan = result.matches.find(
      (m) => m.entity_id === personId && m.confidence === "fuzzy",
    );
    expect(fuzzyForCallahan).toBeUndefined();
  });

  it("disambiguators include all three roles across three jurisdictions", async () => {
    const result = await handleResolvePerson(store.db, {
      name: "Margaret H. Callahan",
    });
    const match = result.matches.find((m) => m.entity_id === personId);
    expect(match).toBeDefined();
    const d = match!.disambiguators.join(" | ");
    expect(d).toContain("us-il");
    expect(d).toContain("us-federal");
    expect(d).toContain("state_legislator");
    expect(d).toContain("representative");
    // The open-ended federal role should show "present"
    expect(d).toContain("present");
  });

  it("exact result sorts before alias result in the same query", async () => {
    // Insert a second entity whose canonical name matches "M. Callahan" exactly.
    // This makes the query "M. Callahan" produce both an exact hit (for the
    // new entity) and an alias hit (for Callahan).
    upsertEntity(store.db, { kind: "person", name: "M. Callahan" });
    const result = await handleResolvePerson(store.db, { name: "M. Callahan" });
    const confidences = result.matches.map((m) => m.confidence);
    const exactIdx = confidences.indexOf("exact");
    const aliasIdx = confidences.indexOf("alias");
    expect(exactIdx).toBeLessThan(aliasIdx);
  });
});

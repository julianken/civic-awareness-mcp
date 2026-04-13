import { describe, it, expect } from "vitest";
import { normalizeName, levenshtein, fuzzyPick } from "../../../src/resolution/fuzzy.js";

describe("normalizeName", () => {
  it("lowercases", () => expect(normalizeName("Jane Doe")).toBe("jane doe"));
  it("strips punct", () => expect(normalizeName("O'Brien, Jr.")).toBe("obrien jr"));
  it("collapses whitespace", () => expect(normalizeName("  Jane    Doe  ")).toBe("jane doe"));
  it("commas as separators", () => expect(normalizeName("Doe, Jane")).toBe("doe jane"));
});

describe("levenshtein", () => {
  it("identical=0", () => expect(levenshtein("abc", "abc")).toBe(0));
  it("sub=1", () => expect(levenshtein("abc", "abd")).toBe(1));
  it("ins=1", () => expect(levenshtein("abc", "abcd")).toBe(1));
  it("different=3", () => expect(levenshtein("abc", "xyz")).toBe(3));
});

describe("fuzzyPick", () => {
  // Under D3b, fuzzyPick requires a positive linking signal and uses
  // Levenshtein ≤ 1. A candidate with no linking signal is never
  // returned even on a distance-0 match.
  const candidates = [
    {
      id: "1",
      name: "Jane Doe",
      external_id_sources: ["openstates_person"],
      aliases: ["Jane A. Doe"],
      role_jurisdictions: ["us-tx"],
    },
    {
      id: "2",
      name: "John Smith",
      external_id_sources: ["bioguide"],
      aliases: [],
      role_jurisdictions: ["us-federal"],
    },
    {
      id: "3",
      name: "Zzz Martin",
      external_id_sources: [],
      aliases: [],
      role_jurisdictions: [],
    },
  ];

  it("unique close match with shared external_id source family links", () => {
    const picked = fuzzyPick(
      "Jane Doe",
      { external_id_sources: ["openstates_person"], middle_name: null, role_jurisdictions: [] },
      candidates,
    );
    expect(picked?.id).toBe("1");
  });

  it("unique close match with role-jurisdiction overlap links", () => {
    const picked = fuzzyPick(
      "Jane Doe",
      { external_id_sources: [], middle_name: null, role_jurisdictions: ["us-tx"] },
      candidates,
    );
    expect(picked?.id).toBe("1");
  });

  it("unique close match with middle name matching an alias links", () => {
    const picked = fuzzyPick(
      "Jane Doe",
      { external_id_sources: [], middle_name: "A", role_jurisdictions: [] },
      candidates,
    );
    expect(picked?.id).toBe("1");
  });

  it("no linking signal returns null even on distance-0 match", () => {
    const picked = fuzzyPick(
      "Jane Doe",
      { external_id_sources: ["fec_candidate"], middle_name: null, role_jurisdictions: ["us-ca"] },
      candidates,
    );
    expect(picked).toBeNull();
  });

  it("distance 2 is over threshold and returns null", () => {
    const picked = fuzzyPick(
      "Jaen Doex",
      { external_id_sources: ["openstates_person"], middle_name: null, role_jurisdictions: [] },
      candidates,
    );
    expect(picked).toBeNull();
  });

  it("runner-up within distance 3 rejects the match (ambiguity guard)", () => {
    // Two candidates both very close to the query — classic ambiguity.
    // Even with a valid linking signal, the result must be null so
    // under-match bias kicks in and a new entity is created instead
    // of merging the wrong one.
    const ambiguousCandidates = [
      {
        id: "a",
        name: "Jane Doe",
        external_id_sources: ["openstates_person"],
        aliases: [],
        role_jurisdictions: ["us-tx"],
      },
      {
        id: "b",
        name: "Jane Dae",
        external_id_sources: ["openstates_person"],
        aliases: [],
        role_jurisdictions: ["us-tx"],
      },
    ];
    const picked = fuzzyPick(
      "Jane Doe",
      { external_id_sources: ["openstates_person"], middle_name: null, role_jurisdictions: [] },
      ambiguousCandidates,
    );
    expect(picked).toBeNull();
  });

  it("normalizes hyphenated and apostrophised names consistently", () => {
    // Documents the chosen punctuation-strip behavior so future edits
    // don't accidentally change it. Hyphens and apostrophes collapse
    // into adjacent tokens — "O'Brien-Smith" → "obriensmith" — which
    // means hyphenated surnames will NOT fuzzy-match against their
    // space-separated equivalents without an alias linking them.
    // Alias-based linking in hasLinkingSignal is the designed
    // mitigation for this trade-off.
    expect(normalizeName("O'Brien-Smith")).toBe("obriensmith");
    expect(normalizeName("Smith-Jones")).not.toBe(normalizeName("Smith Jones"));
  });

  it("no close match returns null", () => {
    // Query is clearly distant from every candidate — tests that
    // best.d > ACCEPT_DISTANCE produces null even with a linking signal.
    const picked = fuzzyPick(
      "Xaver Quixote",
      { external_id_sources: ["openstates_person"], middle_name: null, role_jurisdictions: [] },
      candidates,
    );
    expect(picked).toBeNull();
  });
});

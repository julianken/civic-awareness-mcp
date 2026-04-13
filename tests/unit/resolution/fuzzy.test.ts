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

  it("no close match returns null", () => {
    const picked = fuzzyPick(
      "Zzz Martin",
      { external_id_sources: ["openstates_person"], middle_name: null, role_jurisdictions: [] },
      candidates,
    );
    expect(picked).toBeNull();
  });
});

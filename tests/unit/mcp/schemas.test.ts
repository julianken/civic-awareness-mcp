import { describe, it, expect } from "vitest";
import {
  GetVoteInput,
  RecentBillsInput,
  RecentVotesInput,
  RecentContributionsInput,
  ResolvePersonInput,
  SearchDocumentsInput,
  SearchEntitiesInput,
} from "../../../src/federal/schemas.js";

describe("GetVoteInput", () => {
  it("accepts a vote_id alone", () => {
    const parsed = GetVoteInput.parse({ vote_id: "doc-uuid-abc" });
    expect(parsed.vote_id).toBe("doc-uuid-abc");
  });

  it("accepts the full federal composite", () => {
    const parsed = GetVoteInput.parse({
      congress: 119,
      chamber: "upper",
      session: 1,
      roll_number: 42,
    });
    expect(parsed.congress).toBe(119);
    expect(parsed.roll_number).toBe(42);
  });

  it("rejects empty input", () => {
    expect(() => GetVoteInput.parse({})).toThrow();
  });

  it("rejects a partial composite (missing roll_number)", () => {
    expect(() => GetVoteInput.parse({ congress: 119, chamber: "upper", session: 1 })).toThrow();
  });

  it("rejects session values other than 1 or 2", () => {
    expect(() =>
      GetVoteInput.parse({
        congress: 119,
        chamber: "upper",
        session: 3,
        roll_number: 42,
      }),
    ).toThrow();
  });

  it("rejects empty string for vote_id", () => {
    expect(() => GetVoteInput.parse({ vote_id: "" })).toThrow();
  });
});

describe("optional-string min(1) bounds", () => {
  it("RecentBillsInput rejects empty session", () => {
    expect(() => RecentBillsInput.parse({ session: "" })).toThrow();
  });

  it("RecentVotesInput rejects empty session", () => {
    expect(() => RecentVotesInput.parse({ jurisdiction: "us-federal", session: "" })).toThrow();
  });

  it("RecentVotesInput rejects empty bill_identifier", () => {
    expect(() =>
      RecentVotesInput.parse({ jurisdiction: "us-federal", bill_identifier: "" }),
    ).toThrow();
  });

  it("RecentContributionsInput rejects empty candidate_or_committee", () => {
    expect(() =>
      RecentContributionsInput.parse({
        window: { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" },
        candidate_or_committee: "",
      }),
    ).toThrow();
  });

  it("RecentContributionsInput rejects empty contributor_entity_id", () => {
    expect(() =>
      RecentContributionsInput.parse({
        window: { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" },
        contributor_entity_id: "",
      }),
    ).toThrow();
  });

  it("SearchEntitiesInput rejects empty jurisdiction", () => {
    expect(() => SearchEntitiesInput.parse({ q: "doe", jurisdiction: "" })).toThrow();
  });

  it("SearchEntitiesInput rejects empty had_role", () => {
    expect(() => SearchEntitiesInput.parse({ q: "doe", had_role: "" })).toThrow();
  });

  it("SearchEntitiesInput rejects empty had_jurisdiction", () => {
    expect(() => SearchEntitiesInput.parse({ q: "doe", had_jurisdiction: "" })).toThrow();
  });

  it("SearchDocumentsInput rejects empty jurisdiction", () => {
    expect(() => SearchDocumentsInput.parse({ q: "civic", jurisdiction: "" })).toThrow();
  });

  it("ResolvePersonInput rejects empty jurisdiction_hint", () => {
    expect(() => ResolvePersonInput.parse({ name: "Jane Doe", jurisdiction_hint: "" })).toThrow();
  });

  it("ResolvePersonInput rejects empty role_hint", () => {
    expect(() => ResolvePersonInput.parse({ name: "Jane Doe", role_hint: "" })).toThrow();
  });

  it("ResolvePersonInput rejects empty context", () => {
    expect(() => ResolvePersonInput.parse({ name: "Jane Doe", context: "" })).toThrow();
  });
});

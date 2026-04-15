import { describe, it, expect } from "vitest";
import {
  GetVoteInput,
  ListBillsInput,
  RecentBillsInput,
  RecentVotesInput,
  RecentContributionsInput,
  ResolvePersonInput,
  SearchDocumentsInput,
  SearchEntitiesInput,
} from "../../../src/mcp/schemas.js";

describe("ListBillsInput", () => {
  it("requires jurisdiction", () => {
    expect(() => ListBillsInput.parse({})).toThrow();
  });

  it("accepts jurisdiction alone and applies defaults", () => {
    const parsed = ListBillsInput.parse({ jurisdiction: "us-tx" });
    expect(parsed.jurisdiction).toBe("us-tx");
    expect(parsed.limit).toBe(20);
    expect(parsed.sort).toBe("updated_desc");
    expect(parsed.session).toBeUndefined();
    expect(parsed.chamber).toBeUndefined();
  });

  it("accepts every optional predicate", () => {
    const parsed = ListBillsInput.parse({
      jurisdiction: "us-ca",
      session: "20252026",
      chamber: "upper",
      sponsor_entity_id: "abc-123",
      classification: "bill",
      subject: "Vehicles",
      introduced_since: "2026-01-01",
      introduced_until: "2026-04-01",
      updated_since: "2026-03-01",
      updated_until: "2026-04-10",
      sort: "introduced_desc",
      limit: 50,
    });
    expect(parsed.sponsor_entity_id).toBe("abc-123");
    expect(parsed.sort).toBe("introduced_desc");
    expect(parsed.limit).toBe(50);
  });

  it("rejects chamber values that are not upper/lower", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", chamber: "house" }),
    ).toThrow();
  });

  it("rejects limit < 1", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", limit: 0 }),
    ).toThrow();
  });

  it("rejects unknown sort value", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", sort: "by_title" }),
    ).toThrow();
  });
});

describe("GetVoteInput", () => {
  it("accepts a vote_id alone", () => {
    const parsed = GetVoteInput.parse({ vote_id: "doc-uuid-abc" });
    expect(parsed.vote_id).toBe("doc-uuid-abc");
  });

  it("accepts the full federal composite", () => {
    const parsed = GetVoteInput.parse({
      congress: 119, chamber: "upper", session: 1, roll_number: 42,
    });
    expect(parsed.congress).toBe(119);
    expect(parsed.roll_number).toBe(42);
  });

  it("rejects empty input", () => {
    expect(() => GetVoteInput.parse({})).toThrow();
  });

  it("rejects a partial composite (missing roll_number)", () => {
    expect(() =>
      GetVoteInput.parse({ congress: 119, chamber: "upper", session: 1 }),
    ).toThrow();
  });

  it("rejects session values other than 1 or 2", () => {
    expect(() =>
      GetVoteInput.parse({
        congress: 119, chamber: "upper", session: 3, roll_number: 42,
      }),
    ).toThrow();
  });

  it("rejects empty string for vote_id", () => {
    expect(() => GetVoteInput.parse({ vote_id: "" })).toThrow();
  });
});

describe("optional-string min(1) bounds (A5/B20)", () => {
  it("ListBillsInput rejects empty session", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", session: "" }),
    ).toThrow();
  });

  it("ListBillsInput rejects empty sponsor_entity_id", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", sponsor_entity_id: "" }),
    ).toThrow();
  });

  it("ListBillsInput rejects empty classification", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", classification: "" }),
    ).toThrow();
  });

  it("ListBillsInput rejects empty subject", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", subject: "" }),
    ).toThrow();
  });

  it("ListBillsInput rejects empty introduced_since", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", introduced_since: "" }),
    ).toThrow();
  });

  it("ListBillsInput rejects empty introduced_until", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", introduced_until: "" }),
    ).toThrow();
  });

  it("ListBillsInput rejects empty updated_since", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", updated_since: "" }),
    ).toThrow();
  });

  it("ListBillsInput rejects empty updated_until", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", updated_until: "" }),
    ).toThrow();
  });

  it("RecentBillsInput rejects empty session", () => {
    expect(() =>
      RecentBillsInput.parse({ jurisdiction: "us-tx", session: "" }),
    ).toThrow();
  });

  it("RecentVotesInput rejects empty session", () => {
    expect(() =>
      RecentVotesInput.parse({ jurisdiction: "us-federal", session: "" }),
    ).toThrow();
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
    expect(() =>
      SearchEntitiesInput.parse({ q: "doe", jurisdiction: "" }),
    ).toThrow();
  });

  it("SearchEntitiesInput rejects empty had_role", () => {
    expect(() =>
      SearchEntitiesInput.parse({ q: "doe", had_role: "" }),
    ).toThrow();
  });

  it("SearchEntitiesInput rejects empty had_jurisdiction", () => {
    expect(() =>
      SearchEntitiesInput.parse({ q: "doe", had_jurisdiction: "" }),
    ).toThrow();
  });

  it("SearchDocumentsInput rejects empty jurisdiction", () => {
    expect(() =>
      SearchDocumentsInput.parse({ q: "civic", jurisdiction: "" }),
    ).toThrow();
  });

  it("ResolvePersonInput rejects empty jurisdiction_hint", () => {
    expect(() =>
      ResolvePersonInput.parse({ name: "Jane Doe", jurisdiction_hint: "" }),
    ).toThrow();
  });

  it("ResolvePersonInput rejects empty role_hint", () => {
    expect(() =>
      ResolvePersonInput.parse({ name: "Jane Doe", role_hint: "" }),
    ).toThrow();
  });

  it("ResolvePersonInput rejects empty context", () => {
    expect(() =>
      ResolvePersonInput.parse({ name: "Jane Doe", context: "" }),
    ).toThrow();
  });
});

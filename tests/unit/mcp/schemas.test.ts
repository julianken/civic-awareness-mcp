import { describe, it, expect } from "vitest";
import { GetVoteInput, ListBillsInput } from "../../../src/mcp/schemas.js";

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

  it("rejects limit > 50", () => {
    expect(() =>
      ListBillsInput.parse({ jurisdiction: "us-tx", limit: 51 }),
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
});

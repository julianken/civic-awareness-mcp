import { describe, it, expect } from "vitest";
import { Entity, Document, EntityKind, DocumentKind } from "../../../src/core/types.js";

describe("Entity schema", () => {
  it("parses a valid person entity", () => {
    const parsed = Entity.parse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      kind: "person",
      name: "Jane Doe",
      aliases: ["Doe, Jane"],
      external_ids: { openstates_person: "ocd-person/abc" },
      first_seen_at: "2026-04-12T00:00:00.000Z",
      last_seen_at: "2026-04-12T00:00:00.000Z",
    });
    expect(parsed.name).toBe("Jane Doe");
    expect(parsed.jurisdiction).toBeUndefined();
    expect(parsed.external_ids.openstates_person).toBe("ocd-person/abc");
  });

  it("rejects invalid kind", () => {
    expect(() => Entity.parse({ kind: "alien", id: "x", name: "x" })).toThrow();
  });

  it("fills in defaults", () => {
    const parsed = Entity.parse({
      id: "x", kind: "person", name: "X",
      first_seen_at: "2026-04-12T00:00:00.000Z",
      last_seen_at: "2026-04-12T00:00:00.000Z",
    });
    expect(parsed.aliases).toEqual([]);
    expect(parsed.external_ids).toEqual({});
  });
});

describe("Document schema", () => {
  it("parses a valid bill document", () => {
    const parsed = Document.parse({
      id: "x",
      kind: "bill",
      jurisdiction: "us-federal",
      title: "HR1234",
      occurred_at: "2026-04-01T00:00:00.000Z",
      fetched_at: "2026-04-12T00:00:00.000Z",
      source: { name: "congress", id: "hr-1234-119", url: "https://congress.gov/x" },
    });
    expect(parsed.kind).toBe("bill");
    expect(parsed.references).toEqual([]);
  });
});

describe("Kind enums", () => {
  it("EntityKind includes pac", () => {
    expect(() => EntityKind.parse("pac")).not.toThrow();
  });
  it("DocumentKind includes contribution", () => {
    expect(() => DocumentKind.parse("contribution")).not.toThrow();
  });
});

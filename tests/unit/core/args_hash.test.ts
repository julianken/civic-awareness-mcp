import { describe, it, expect } from "vitest";
import { hashArgs, canonicalizeArgs } from "../../../src/core/args_hash.js";

describe("args_hash", () => {
  describe("canonicalizeArgs", () => {
    it("lowercases + trims + collapses whitespace on string values", () => {
      expect(canonicalizeArgs("resolve_person", { name: "Angus King" }))
        .toBe('resolve_person:{"name":"angus king"}');
      expect(canonicalizeArgs("resolve_person", { name: "angus king" }))
        .toBe('resolve_person:{"name":"angus king"}');
      expect(canonicalizeArgs("resolve_person", { name: "  Angus  King  " }))
        .toBe('resolve_person:{"name":"angus king"}');
    });

    it("drops empty-string and undefined fields", () => {
      expect(canonicalizeArgs("resolve_person", { name: "Angus King", role_hint: "" }))
        .toBe('resolve_person:{"name":"angus king"}');
      expect(canonicalizeArgs("resolve_person", { name: "Angus King", role_hint: undefined }))
        .toBe('resolve_person:{"name":"angus king"}');
    });

    it("sorts object keys in codepoint order", () => {
      const a = canonicalizeArgs("resolve_person", { role_hint: "senator", name: "Angus King" });
      const b = canonicalizeArgs("resolve_person", { name: "Angus King", role_hint: "senator" });
      expect(a).toBe(b);
      expect(a).toBe('resolve_person:{"name":"angus king","role_hint":"senator"}');
    });

    it("normalizes jurisdictions to lowercase", () => {
      expect(canonicalizeArgs("recent_bills", { jurisdiction: "US-TX", days: 7 }))
        .toBe('recent_bills:{"days":7,"jurisdiction":"us-tx"}');
      expect(canonicalizeArgs("recent_bills", { jurisdiction: "us-tx", days: 7.0 }))
        .toBe('recent_bills:{"days":7,"jurisdiction":"us-tx"}');
    });

    it("preserves array order (semantic)", () => {
      const a = canonicalizeArgs("search_civic_documents", { q: "tax", kinds: ["bill", "vote"] });
      const b = canonicalizeArgs("search_civic_documents", { q: "tax", kinds: ["vote", "bill"] });
      expect(a).not.toBe(b);
    });

    it("prefixes with tool name to prevent cross-tool collision", () => {
      const a = canonicalizeArgs("get_entity", { id: "x" });
      const b = canonicalizeArgs("get_bill", { id: "x" });
      expect(a).not.toBe(b);
    });
  });

  describe("hashArgs", () => {
    it("produces 32 hex characters", () => {
      const h = hashArgs("resolve_person", { name: "Angus King" });
      expect(h).toMatch(/^[0-9a-f]{32}$/);
    });

    it("collides identical canonical forms", () => {
      expect(hashArgs("resolve_person", { name: "Angus King" }))
        .toBe(hashArgs("resolve_person", { name: "  angus king  " }));
    });

    it("does not collide distinct inputs", () => {
      expect(hashArgs("resolve_person", { name: "Smith" }))
        .not.toBe(hashArgs("resolve_person", { name: "John Smith" }));
    });
  });
});

import { describe, it, expect } from "vitest";
import { normalizeIsoDatetime } from "../../../src/util/datetime.js";

describe("normalizeIsoDatetime", () => {
  it("collapses microsecond precision + numeric offset to millisecond Z form (OpenStates case)", () => {
    expect(normalizeIsoDatetime("2026-04-04T06:20:24.862671+00:00"))
      .toBe("2026-04-04T06:20:24.862Z");
  });

  it("converts non-UTC offsets to UTC", () => {
    expect(normalizeIsoDatetime("2026-04-04T10:00:00-05:00"))
      .toBe("2026-04-04T15:00:00.000Z");
  });

  it("expands date-only strings to UTC midnight", () => {
    expect(normalizeIsoDatetime("2026-04-04"))
      .toBe("2026-04-04T00:00:00.000Z");
  });

  it("preserves already-canonical input idempotently", () => {
    expect(normalizeIsoDatetime("2026-04-04T10:00:00.000Z"))
      .toBe("2026-04-04T10:00:00.000Z");
  });

  it("normalizes second-precision Z form to millisecond Z form", () => {
    expect(normalizeIsoDatetime("2026-04-04T10:00:00Z"))
      .toBe("2026-04-04T10:00:00.000Z");
  });

  it("throws on unparseable input", () => {
    expect(() => normalizeIsoDatetime("not a date"))
      .toThrow(/Invalid datetime/);
  });

  it("throws on empty string", () => {
    expect(() => normalizeIsoDatetime(""))
      .toThrow(/Invalid datetime/);
  });
});

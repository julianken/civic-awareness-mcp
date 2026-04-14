import { describe, it, expect, beforeEach, vi } from "vitest";
import { DailyBudget } from "../../../src/core/budget.js";

describe("DailyBudget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));
  });

  it("parses env var format", () => {
    const b = new DailyBudget("openstates=450,congress=4500,openfec=900");
    expect(b.remaining("openstates")).toBe(450);
    expect(b.remaining("congress")).toBe(4500);
    expect(b.remaining("openfec")).toBe(900);
  });

  it("check + record decrements remaining", () => {
    const b = new DailyBudget("openstates=10");
    expect(b.check("openstates").allowed).toBe(true);
    b.record("openstates");
    expect(b.remaining("openstates")).toBe(9);
  });

  it("check returns allowed=false when exhausted", () => {
    const b = new DailyBudget("openstates=2");
    b.record("openstates");
    b.record("openstates");
    expect(b.check("openstates").allowed).toBe(false);
  });

  it("resets at UTC day boundary", () => {
    const b = new DailyBudget("openstates=5");
    b.record("openstates");
    b.record("openstates");
    expect(b.remaining("openstates")).toBe(3);
    vi.setSystemTime(new Date("2026-04-14T00:00:01Z"));
    expect(b.remaining("openstates")).toBe(5);
  });

  it("unlimited when env unset", () => {
    const b = new DailyBudget(undefined);
    expect(b.check("openstates").allowed).toBe(true);
    expect(b.remaining("openstates")).toBe(Number.POSITIVE_INFINITY);
  });
});

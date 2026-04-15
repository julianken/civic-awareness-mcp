import { describe, it, expect } from "vitest";
import {
  isHighCostLimit,
  buildConfirmationResponse,
  HIGH_COST_THRESHOLD,
} from "../../../src/mcp/cost_estimate.js";

describe("cost_estimate", () => {
  it("HIGH_COST_THRESHOLD is 500", () => {
    expect(HIGH_COST_THRESHOLD).toBe(500);
  });

  it("isHighCostLimit returns false for limit <= 500", () => {
    expect(isHighCostLimit(1)).toBe(false);
    expect(isHighCostLimit(500)).toBe(false);
  });

  it("isHighCostLimit returns true for limit > 500", () => {
    expect(isHighCostLimit(501)).toBe(true);
    expect(isHighCostLimit(1000)).toBe(true);
  });

  it("buildConfirmationResponse for openstates computes 20-row pages and daily budget", () => {
    const r = buildConfirmationResponse("openstates", 1000);
    expect(r.requires_confirmation).toBe(true);
    expect(r.requested_limit).toBe(1000);
    expect(r.estimated_cost.upstream_calls).toBe(50);
    expect(r.estimated_cost.openstates_daily_budget_pct).toBe(10);
    expect(r.estimated_cost.congress_hourly_budget_pct).toBeUndefined();
    expect(r.estimated_cost.response_tokens_estimate).toBe(150_000);
    expect(r.message).toContain("50 OpenStates requests");
    expect(r.message).toContain("acknowledge_high_cost: true");
  });

  it("buildConfirmationResponse for congress computes 250-row pages and hourly budget", () => {
    const r = buildConfirmationResponse("congress", 1000);
    expect(r.estimated_cost.upstream_calls).toBe(4);
    expect(r.estimated_cost.congress_hourly_budget_pct).toBeCloseTo(0.08, 2);
    expect(r.estimated_cost.openstates_daily_budget_pct).toBeUndefined();
    expect(r.message).toContain("4 Congress.gov requests");
  });

  it("upstream_calls rounds up for non-multiple sizes", () => {
    expect(buildConfirmationResponse("openstates", 501).estimated_cost.upstream_calls).toBe(26);
    expect(buildConfirmationResponse("congress", 501).estimated_cost.upstream_calls).toBe(3);
  });
});

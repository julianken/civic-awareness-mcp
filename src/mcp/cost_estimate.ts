export const HIGH_COST_THRESHOLD = 500;

const OPENSTATES_PAGE_SIZE = 20;
const CONGRESS_PAGE_SIZE = 250;
const OPENSTATES_DAILY_BUDGET = 500;
const CONGRESS_HOURLY_BUDGET = 5000;
const TOKENS_PER_BILL = 150;

export interface CostEstimate {
  upstream_calls: number;
  openstates_daily_budget_pct?: number;
  congress_hourly_budget_pct?: number;
  response_tokens_estimate: number;
}

export interface RequiresConfirmationResponse {
  requires_confirmation: true;
  requested_limit: number;
  estimated_cost: CostEstimate;
  message: string;
}

export function isHighCostLimit(limit: number): boolean {
  return limit > HIGH_COST_THRESHOLD;
}

export function buildConfirmationResponse(
  source: "openstates" | "congress",
  limit: number,
): RequiresConfirmationResponse {
  const isOpenStates = source === "openstates";
  const pageSize = isOpenStates ? OPENSTATES_PAGE_SIZE : CONGRESS_PAGE_SIZE;
  const upstream_calls = Math.ceil(limit / pageSize);
  const estimated_cost: CostEstimate = {
    upstream_calls,
    response_tokens_estimate: limit * TOKENS_PER_BILL,
  };
  if (isOpenStates) {
    estimated_cost.openstates_daily_budget_pct =
      (upstream_calls / OPENSTATES_DAILY_BUDGET) * 100;
  } else {
    estimated_cost.congress_hourly_budget_pct =
      (upstream_calls / CONGRESS_HOURLY_BUDGET) * 100;
  }
  const sourceName = isOpenStates ? "OpenStates" : "Congress.gov";
  const pct = isOpenStates
    ? estimated_cost.openstates_daily_budget_pct
    : estimated_cost.congress_hourly_budget_pct;
  const period = isOpenStates ? "today's" : "this hour's";
  return {
    requires_confirmation: true,
    requested_limit: limit,
    estimated_cost,
    message:
      `This call will issue ${upstream_calls} ${sourceName} requests ` +
      `(~${pct!.toFixed(2)}% of ${period} budget). ` +
      `Re-call with acknowledge_high_cost: true to proceed.`,
  };
}

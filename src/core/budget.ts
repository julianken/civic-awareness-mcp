import type { HydrationSource } from "./sources.js";

export interface BudgetCheck {
  allowed: boolean;
  remaining: number;
}

export class DailyBudget {
  private limits: Map<string, number>;
  private used: Map<string, number>;
  private dayKey: string;

  constructor(envValue: string | undefined) {
    this.limits = new Map();
    this.used = new Map();
    this.dayKey = DailyBudget.dayKeyNow();
    if (!envValue) return;
    for (const pair of envValue.split(",")) {
      const [k, v] = pair.split("=").map((s) => s.trim());
      if (!k || !v) continue;
      const n = Number(v);
      if (Number.isFinite(n)) this.limits.set(k, n);
    }
  }

  check(source: HydrationSource): BudgetCheck {
    this.rollIfNewDay();
    const limit = this.limits.get(source);
    if (limit === undefined) return { allowed: true, remaining: Number.POSITIVE_INFINITY };
    const used = this.used.get(source) ?? 0;
    const remaining = Math.max(0, limit - used);
    return { allowed: remaining > 0, remaining };
  }

  record(source: HydrationSource): void {
    this.rollIfNewDay();
    this.used.set(source, (this.used.get(source) ?? 0) + 1);
  }

  remaining(source: HydrationSource): number {
    return this.check(source).remaining;
  }

  private rollIfNewDay(): void {
    const now = DailyBudget.dayKeyNow();
    if (now !== this.dayKey) {
      this.dayKey = now;
      this.used.clear();
    }
  }

  private static dayKeyNow(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

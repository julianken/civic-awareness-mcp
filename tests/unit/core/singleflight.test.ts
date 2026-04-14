import { describe, it, expect } from "vitest";
import { Singleflight } from "../../../src/core/singleflight.js";

describe("Singleflight", () => {
  it("coalesces concurrent calls on same key", async () => {
    const sf = new Singleflight<string>();
    let runs = 0;
    const fn = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 10));
      return "ok";
    };
    const [a, b, c] = await Promise.all([
      sf.do("k", fn),
      sf.do("k", fn),
      sf.do("k", fn),
    ]);
    expect(runs).toBe(1);
    expect(a).toBe("ok");
    expect(b).toBe("ok");
    expect(c).toBe("ok");
  });

  it("runs separately for different keys", async () => {
    const sf = new Singleflight<string>();
    let runs = 0;
    const fn = async () => {
      runs += 1;
      return "ok";
    };
    await Promise.all([sf.do("k1", fn), sf.do("k2", fn)]);
    expect(runs).toBe(2);
  });

  it("releases key after completion (new call triggers new run)", async () => {
    const sf = new Singleflight<number>();
    let runs = 0;
    const fn = async () => {
      runs += 1;
      return runs;
    };
    await sf.do("k", fn);
    await sf.do("k", fn);
    expect(runs).toBe(2);
  });

  it("propagates errors and releases key", async () => {
    const sf = new Singleflight<number>();
    await expect(sf.do("k", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    const r = await sf.do("k", async () => 42);
    expect(r).toBe(42);
  });
});

import { describe, it, expect } from "vitest";
import { requireEnv, optionalEnv } from "../../../src/util/env.js";

describe("env loaders", () => {
  it("requireEnv throws when missing", () => {
    delete process.env.TEST_VAR;
    expect(() => requireEnv("TEST_VAR")).toThrow(/TEST_VAR/);
  });
  it("requireEnv returns value when present", () => {
    process.env.TEST_VAR = "hello";
    expect(requireEnv("TEST_VAR")).toBe("hello");
  });
  it("optionalEnv returns default", () => {
    delete process.env.TEST_VAR;
    expect(optionalEnv("TEST_VAR", "fallback")).toBe("fallback");
  });
});

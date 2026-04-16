import { describe, it, expect } from "vitest";
import { redactSecrets } from "../../../src/util/redact.js";

describe("redactSecrets", () => {
  it("masks api_key query parameter", () => {
    const url = "https://api.congress.gov/v3/bill?api_key=secret123&format=json";
    expect(redactSecrets(url)).toBe(
      "https://api.congress.gov/v3/bill?api_key=***REDACTED***&format=json",
    );
  });

  it("masks api_key when it's the first query param", () => {
    const url = "https://api.congress.gov/v3/bill?api_key=secret123";
    expect(redactSecrets(url)).toBe("https://api.congress.gov/v3/bill?api_key=***REDACTED***");
  });

  it("masks X-API-KEY header value", () => {
    const msg = "fetch failed with X-API-KEY: my-secret-key";
    expect(redactSecrets(msg)).toContain("***REDACTED***");
    expect(redactSecrets(msg)).not.toContain("my-secret-key");
  });

  it("masks UUIDs", () => {
    const msg = "entity 550e8400-e29b-41d4-a716-446655440000 not found";
    expect(redactSecrets(msg)).toContain("***UUID***");
  });

  it("leaves non-sensitive content untouched", () => {
    const msg = "https://api.congress.gov/v3/bill?congress=119&format=json";
    expect(redactSecrets(msg)).toBe(msg);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { bootstrap } from "../../../src/federal/cli/bootstrap.js";
import { openStore } from "../../../src/core/store.js";

const TEST_DB = "./data/test-bootstrap.db";
afterEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

describe("bootstrap", () => {
  it("creates DB with schema and seeded jurisdictions", async () => {
    await bootstrap({ dbPath: TEST_DB });
    const s = openStore(TEST_DB);
    const c = s.db.prepare("SELECT COUNT(*) as c FROM jurisdictions").get() as { c: number };
    // Keep in sync with seedJurisdictions: us-federal + all 50 states.
    expect(c.c).toBe(51);
    s.close();
  });
});

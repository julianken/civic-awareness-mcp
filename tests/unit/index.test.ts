import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { openStore, type Store } from "../../src/core/store.js";
import { autoBootstrapIfNeeded } from "../../src/federal/index.js";

const TEST_DB = "./data/test-auto-bootstrap.db";

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  mkdirSync("./data", { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

describe("autoBootstrapIfNeeded", () => {
  it("bootstraps when the DB file does not exist", async () => {
    expect(existsSync(TEST_DB)).toBe(false);
    await autoBootstrapIfNeeded(TEST_DB);
    expect(existsSync(TEST_DB)).toBe(true);

    const store: Store = openStore(TEST_DB);
    const count = (
      store.db.prepare("SELECT COUNT(*) AS n FROM jurisdictions").get() as { n: number }
    ).n;
    store.close();
    expect(count).toBeGreaterThan(0);
  });

  it("is a no-op when the DB is already bootstrapped", async () => {
    await autoBootstrapIfNeeded(TEST_DB);
    const store1: Store = openStore(TEST_DB);
    const count1 = (
      store1.db.prepare("SELECT COUNT(*) AS n FROM jurisdictions").get() as { n: number }
    ).n;
    store1.close();

    await autoBootstrapIfNeeded(TEST_DB);
    const store2: Store = openStore(TEST_DB);
    const count2 = (
      store2.db.prepare("SELECT COUNT(*) AS n FROM jurisdictions").get() as { n: number }
    ).n;
    store2.close();

    expect(count2).toBe(count1);
  });
});

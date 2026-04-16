import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvDefaults, findProjectRoot } from "../../../src/util/env-file.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const TEST_KEY = "CIVIC_AWARENESS_ENV_FILE_TEST";
const TEST_KEY_2 = "CIVIC_AWARENESS_ENV_FILE_TEST_2";

let tmpDir: string;
let envPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "env-file-test-"));
  envPath = join(tmpDir, ".env.local");
  delete process.env[TEST_KEY];
  delete process.env[TEST_KEY_2];
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env[TEST_KEY];
  delete process.env[TEST_KEY_2];
});

describe("loadEnvDefaults", () => {
  it("sets keys that are not already in process.env", () => {
    writeFileSync(envPath, `${TEST_KEY}=from-file\n`);
    loadEnvDefaults(envPath);
    expect(process.env[TEST_KEY]).toBe("from-file");
  });

  it("does NOT override existing process.env values — launcher wins", () => {
    process.env[TEST_KEY] = "from-launcher";
    writeFileSync(envPath, `${TEST_KEY}=from-file\n`);
    loadEnvDefaults(envPath);
    expect(process.env[TEST_KEY]).toBe("from-launcher");
  });

  it("skips comment and blank lines", () => {
    writeFileSync(
      envPath,
      `# a comment\n\n${TEST_KEY}=x\n   # indented comment\n${TEST_KEY_2}=y\n`,
    );
    loadEnvDefaults(envPath);
    expect(process.env[TEST_KEY]).toBe("x");
    expect(process.env[TEST_KEY_2]).toBe("y");
  });

  it("strips surrounding single or double quotes from values", () => {
    writeFileSync(envPath, `${TEST_KEY}="quoted"\n${TEST_KEY_2}='single'\n`);
    loadEnvDefaults(envPath);
    expect(process.env[TEST_KEY]).toBe("quoted");
    expect(process.env[TEST_KEY_2]).toBe("single");
  });

  it("is a silent no-op when the file does not exist", () => {
    const missing = join(tmpDir, "nope.env");
    expect(() => loadEnvDefaults(missing)).not.toThrow();
    expect(process.env[TEST_KEY]).toBeUndefined();
  });
});

describe("findProjectRoot", () => {
  it("returns the civic-awareness-mcp repo root when called from inside it", () => {
    const fromSrcUtil = join(repoRoot, "src", "util");
    const root = findProjectRoot(fromSrcUtil);
    expect(root).toBe(repoRoot);
  });

  it("returns undefined when no package.json is reachable", () => {
    expect(findProjectRoot("/")).toBeUndefined();
  });
});

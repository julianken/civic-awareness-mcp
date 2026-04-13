import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load KEY=VALUE pairs from a dotenv-style file into process.env
 * without overriding values that are already set. The caller's
 * environment always wins; the file only supplies defaults for
 * unset keys. Silent no-op if the file does not exist.
 *
 * Semantics are deliberately NOT Node's built-in `--env-file`,
 * which overrides existing values. For an MCP server launched by
 * Claude Desktop or Claude Code, the host passes explicit env via
 * its config block; that must win over any stale file-level key.
 */
export function loadEnvDefaults(path: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    const quoted = /^(["']).*\1$/.test(raw);
    const value = quoted ? raw.slice(1, -1) : raw;
    if (!(key in process.env)) process.env[key] = value;
  }
}

/**
 * Walk upward from a starting directory until a `package.json` is
 * found. Returns the containing directory or `undefined` if the
 * filesystem root is reached without finding one.
 */
export function findProjectRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * From a running script's `import.meta.url`, locate the project
 * root and load `.env.local` from there as defaults. Used by the
 * server and CLI entrypoints so a user's local `.env.local` is
 * respected regardless of the process cwd (Claude Desktop launches
 * the server from `/`, not the repo).
 */
export function loadProjectEnvDefaults(scriptUrl: string): void {
  const scriptDir = dirname(fileURLToPath(scriptUrl));
  const root = findProjectRoot(scriptDir);
  if (!root) return;
  loadEnvDefaults(resolve(root, ".env.local"));
}

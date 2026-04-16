import { createHash } from "node:crypto";

function canonicalize(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("args_hash: non-finite number");
    return v;
  }
  if (typeof v === "string") {
    return v.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  }
  if (Array.isArray(v)) {
    return v.map(canonicalize);
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const cv = canonicalize(obj[k]);
      if (cv === undefined) continue;
      if (typeof cv === "string" && cv === "") continue;
      if (
        typeof cv === "object" &&
        cv !== null &&
        !Array.isArray(cv) &&
        Object.keys(cv).length === 0
      )
        continue;
      out[k] = cv;
    }
    return out;
  }
  throw new Error(`args_hash: unsupported type ${typeof v}`);
}

export function canonicalizeArgs(tool: string, args: unknown): string {
  return `${tool}:${JSON.stringify(canonicalize(args))}`;
}

export function hashArgs(tool: string, args: unknown): string {
  const payload = canonicalizeArgs(tool, args);
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}

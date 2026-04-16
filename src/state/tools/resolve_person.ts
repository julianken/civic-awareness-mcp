import type Database from "better-sqlite3";
import { OpenStatesAdapter } from "../adapters/openstates.js";
import { getLimiter } from "../limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import { normalizeName, levenshtein } from "../../resolution/fuzzy.js";
import { requireEnv } from "../../util/env.js";
import { escapeLike } from "../../util/sql.js";
import { ResolvePersonInput } from "../schemas.js";
import type { StaleNotice } from "../../core/shared.js";

interface PersonRow {
  id: string;
  name: string;
  name_normalized: string;
  aliases: string;
  metadata: string;
}

export interface ResolvePersonMatch {
  entity_id: string;
  name: string;
  confidence: "exact" | "alias" | "fuzzy";
  disambiguators: string[];
}

export interface ResolvePersonResponse {
  matches: ResolvePersonMatch[];
  stale_notice?: StaleNotice;
}

const CONFIDENCE_RANK: Record<"exact" | "alias" | "fuzzy", number> = {
  exact: 0,
  alias: 1,
  fuzzy: 2,
};

function buildDisambiguators(row: PersonRow): string[] {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    return [];
  }
  const roles = metadata.roles;
  if (!Array.isArray(roles) || roles.length === 0) return [];
  return roles.map((r: unknown) => {
    const role = r as { jurisdiction?: string; role?: string; from?: string; to?: string | null };
    const juris = role.jurisdiction ?? "unknown";
    const title = role.role ?? "unknown";
    const from = role.from ? role.from.split("T")[0] : "?";
    const to = role.to ? role.to.split("T")[0] : "present";
    return `${title}, ${juris}, ${from}–${to}`;
  });
}

function hasJurisdictionSignal(row: PersonRow, jurisdictionHint: string | undefined): boolean {
  if (!jurisdictionHint) return false;
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    return false;
  }
  const roles = metadata.roles;
  if (!Array.isArray(roles)) return false;
  return roles.some(
    (r: unknown) => (r as { jurisdiction?: string }).jurisdiction === jurisdictionHint,
  );
}

function hasRoleSignal(row: PersonRow, roleHint: string | undefined): boolean {
  if (!roleHint) return false;
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    return false;
  }
  const roles = metadata.roles;
  if (!Array.isArray(roles)) return false;
  const needle = roleHint.toLowerCase();
  return roles.some((r: unknown) =>
    ((r as { role?: string }).role ?? "").toLowerCase().includes(needle),
  );
}

export async function handleResolvePerson(
  db: Database.Database,
  rawInput: unknown,
): Promise<ResolvePersonResponse> {
  const input = ResolvePersonInput.parse(rawInput);

  // Hydrate via OpenStates only when the caller supplied a jurisdiction hint.
  // Without a hint, go local-only — we don't know which state to target.
  let stale_notice: StaleNotice | undefined;
  if (input.jurisdiction_hint) {
    const ttl = { scope: "full" as const, ms: 24 * 60 * 60 * 1000 };
    const noop = (): void => {};
    const juris = input.jurisdiction_hint;

    const result = await withShapedFetch(
      db,
      {
        source: "openstates",
        endpoint_path: "/people",
        args: { jurisdiction: juris, name: input.name },
        tool: "searchPeople",
      },
      ttl,
      async () => {
        const adapter = new OpenStatesAdapter({
          apiKey: requireEnv("OPENSTATES_API_KEY"),
          rateLimiter: getLimiter("openstates"),
        });
        const r = await adapter.searchPeople(db, {
          jurisdiction: juris,
          name: input.name,
        });
        return { primary_rows_written: r.entitiesUpserted };
      },
      noop,
      () => getLimiter("openstates").peekWaitMs(),
    );

    if (result.stale_notice) stale_notice = result.stale_notice;
  }

  const queryNorm = normalizeName(input.name);
  const best = new Map<string, { row: PersonRow; confidence: "exact" | "alias" | "fuzzy" }>();

  // Step 1: Exact normalized-name match
  const exactRows = db
    .prepare("SELECT * FROM entities WHERE kind = 'person' AND name_normalized = ?")
    .all(queryNorm) as PersonRow[];

  for (const row of exactRows) {
    best.set(row.id, { row, confidence: "exact" });
  }

  // Step 2: Alias match
  const aliasPreFilter = db
    .prepare("SELECT * FROM entities WHERE kind = 'person' AND aliases LIKE ? ESCAPE '\\'")
    .all(`%${escapeLike(input.name)}%`) as PersonRow[];

  for (const row of aliasPreFilter) {
    if (best.has(row.id)) continue;
    let aliases: string[];
    try {
      aliases = JSON.parse(row.aliases) as string[];
    } catch {
      aliases = [];
    }
    const matched = aliases.some((a) => normalizeName(a) === queryNorm);
    if (matched) {
      best.set(row.id, { row, confidence: "alias" });
    }
  }

  // Step 3: Fuzzy match
  const fuzzyCandidateRows = db
    .prepare("SELECT * FROM entities WHERE kind = 'person'")
    .all() as PersonRow[];

  const hintJurisdictions: string[] = input.jurisdiction_hint ? [input.jurisdiction_hint] : [];

  for (const row of fuzzyCandidateRows) {
    if (best.has(row.id)) continue;

    let metadataParsed: Record<string, unknown>;
    try {
      metadataParsed = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadataParsed = {};
    }
    const roles = Array.isArray(metadataParsed.roles) ? metadataParsed.roles : [];
    const roleJurisdictions = roles
      .map((r: unknown) => (r as { jurisdiction?: string }).jurisdiction ?? "")
      .filter(Boolean);

    const dist = levenshtein(queryNorm, row.name_normalized);
    if (dist > 1) continue;

    let hasSignal = false;
    for (const j of hintJurisdictions) {
      if (roleJurisdictions.includes(j)) {
        hasSignal = true;
        break;
      }
    }
    if (!hasSignal && input.role_hint) {
      const needle = input.role_hint.toLowerCase();
      hasSignal = roles.some((r: unknown) =>
        ((r as { role?: string }).role ?? "").toLowerCase().includes(needle),
      );
    }
    if (!hasSignal) continue;

    best.set(row.id, { row, confidence: "fuzzy" });
  }

  const matches: ResolvePersonMatch[] = Array.from(best.values())
    .sort((a, b) => {
      const confDiff = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
      if (confDiff !== 0) return confDiff;
      const aHint =
        (hasJurisdictionSignal(a.row, input.jurisdiction_hint) ? 1 : 0) +
        (hasRoleSignal(a.row, input.role_hint) ? 1 : 0);
      const bHint =
        (hasJurisdictionSignal(b.row, input.jurisdiction_hint) ? 1 : 0) +
        (hasRoleSignal(b.row, input.role_hint) ? 1 : 0);
      if (bHint !== aHint) return bHint - aHint;
      return a.row.name < b.row.name ? -1 : a.row.name > b.row.name ? 1 : 0;
    })
    .map(({ row, confidence }) => ({
      entity_id: row.id,
      name: row.name,
      confidence,
      disambiguators: buildDisambiguators(row),
    }));

  return {
    matches,
    ...(stale_notice ? { stale_notice } : {}),
  };
}

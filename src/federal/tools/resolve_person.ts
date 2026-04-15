import type Database from "better-sqlite3";
import { CongressAdapter } from "../adapters/congress.js";
import { OpenFecAdapter } from "../adapters/openfec.js";
import { OpenStatesAdapter } from "../../state/adapters/openstates.js";
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
  return roles.some(
    (r: unknown) => ((r as { role?: string }).role ?? "").toLowerCase().includes(needle),
  );
}

export async function handleResolvePerson(
  db: Database.Database,
  rawInput: unknown,
): Promise<ResolvePersonResponse> {
  const input = ResolvePersonInput.parse(rawInput);

  // Hydrate via R15 fanout only when the caller supplied a jurisdiction
  // hint. Without a hint we go local-only (historical behaviour — we
  // don't know which source to target). Uses the same canonical tool
  // names as search_entities so cache rows coalesce across the pair.
  let stale_notice: StaleNotice | undefined;
  if (input.jurisdiction_hint) {
    const ttl = { scope: "full" as const, ms: 24 * 60 * 60 * 1000 };
    const noop = (): void => {};
    const calls: Promise<{ stale_notice?: StaleNotice }>[] = [];

    if (input.jurisdiction_hint === "us-federal") {
      calls.push(
        withShapedFetch(
          db,
          {
            source: "congress",
            endpoint_path: "/member",
            args: {},
            tool: "searchMembers",
          },
          ttl,
          async () => {
            const adapter = new CongressAdapter({
              apiKey: requireEnv("API_DATA_GOV_KEY"),
              rateLimiter: getLimiter("congress"),
            });
            const r = await adapter.searchMembers(db);
            return { primary_rows_written: r.entitiesUpserted };
          },
          noop,
          () => getLimiter("congress").peekWaitMs(),
        ),
        withShapedFetch(
          db,
          {
            source: "openfec",
            endpoint_path: "/candidates/search",
            args: { q: input.name },
            tool: "searchCandidates",
          },
          ttl,
          async () => {
            const adapter = new OpenFecAdapter({
              apiKey: requireEnv("API_DATA_GOV_KEY"),
              rateLimiter: getLimiter("openfec"),
            });
            const r = await adapter.searchCandidates(db, { q: input.name });
            return { primary_rows_written: r.entitiesUpserted };
          },
          noop,
          () => getLimiter("openfec").peekWaitMs(),
        ),
      );
    } else {
      const juris = input.jurisdiction_hint;
      calls.push(
        withShapedFetch(
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
        ),
      );
    }

    for (const r of await Promise.all(calls)) {
      if (r.stale_notice && !stale_notice) stale_notice = r.stale_notice;
    }
  }

  const queryNorm = normalizeName(input.name);

  // Map entity_id → best confidence so far.
  const best = new Map<string, { row: PersonRow; confidence: "exact" | "alias" | "fuzzy" }>();

  // ── Step 1: Exact normalized-name match ──────────────────────────────
  const exactRows = db
    .prepare("SELECT * FROM entities WHERE kind = 'person' AND name_normalized = ?")
    .all(queryNorm) as PersonRow[];

  for (const row of exactRows) {
    best.set(row.id, { row, confidence: "exact" });
  }

  // ── Step 2: Alias match ──────────────────────────────────────────────
  // Pre-filter: rows where the raw aliases JSON text contains input.name
  // as a substring (fast). Then re-normalize each alias in JS for
  // correctness.
  const aliasPreFilter = db
    .prepare(
      "SELECT * FROM entities WHERE kind = 'person' AND aliases LIKE ? ESCAPE '\\'",
    )
    .all(`%${escapeLike(input.name)}%`) as PersonRow[];

  for (const row of aliasPreFilter) {
    if (best.has(row.id)) continue; // already matched as exact
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

  // ── Step 3: Fuzzy match ──────────────────────────────────────────────
  // Fetch all person entities for fuzzy distance calculation.
  const fuzzyCandidateRows = db
    .prepare(
      "SELECT * FROM entities WHERE kind = 'person'",
    )
    .all() as PersonRow[];

  // Build UpstreamSignals from hints.
  const hintJurisdictions: string[] = input.jurisdiction_hint
    ? [input.jurisdiction_hint]
    : [];

  for (const row of fuzzyCandidateRows) {
    if (best.has(row.id)) continue; // already matched at higher confidence

    let metadataParsed: Record<string, unknown>;
    try {
      metadataParsed = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadataParsed = {};
    }
    const roles = Array.isArray(metadataParsed.roles) ? metadataParsed.roles : [];
    const roleJurisdictions = roles.map(
      (r: unknown) => (r as { jurisdiction?: string }).jurisdiction ?? "",
    ).filter(Boolean);

    // We deliberately do NOT call fuzzyPick here — that helper picks
    // exactly one candidate and enforces a runner-up distance guard
    // suitable for merge decisions. resolve_person is a query surface,
    // so we surface ALL candidates at distance <= 1 that have a
    // linking signal (jurisdiction_hint or role_hint match).
    const dist = levenshtein(queryNorm, row.name_normalized);
    if (dist > 1) continue;

    // Check for runner-up: any other candidate at distance ≤ 3 with
    // a different normalized name would disqualify. Because we iterate
    // row-by-row, track whether this candidate is the sole dist-≤-1
    // match for its first word. Simplified approach: require linking
    // signal (the primary discriminator in D3b).
    let hasSignal = false;
    for (const j of hintJurisdictions) {
      if (roleJurisdictions.includes(j)) { hasSignal = true; break; }
    }
    if (!hasSignal && input.role_hint) {
      const needle = input.role_hint.toLowerCase();
      hasSignal = roles.some(
        (r: unknown) => ((r as { role?: string }).role ?? "").toLowerCase().includes(needle),
      );
    }
    if (!hasSignal) continue;

    best.set(row.id, { row, confidence: "fuzzy" });
  }

  // ── Rank and format results ─────────────────────────────────────────
  const matches: ResolvePersonMatch[] = Array.from(best.values())
    .sort((a, b) => {
      const confDiff = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
      if (confDiff !== 0) return confDiff;
      // Within same confidence, prefer hint-matching entities.
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

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Entity, type EntityKind } from "./types.js";
import { fuzzyPick, normalizeName, type FuzzyCandidate, type UpstreamSignals } from "../resolution/fuzzy.js";

export interface UpsertInput {
  kind: EntityKind;
  name: string;
  jurisdiction?: string;
  external_ids?: Record<string, string>;
  aliases?: string[];
  metadata?: Record<string, unknown>;
}
export interface UpsertResult { entity: Entity; created: boolean }

interface Row {
  id: string; kind: string; name: string; name_normalized: string;
  jurisdiction: string | null; external_ids: string; aliases: string;
  metadata: string; first_seen_at: string; last_seen_at: string;
}

function rowToEntity(r: Row): Entity {
  return Entity.parse({
    id: r.id, kind: r.kind, name: r.name,
    jurisdiction: r.jurisdiction ?? undefined,
    external_ids: JSON.parse(r.external_ids),
    aliases: JSON.parse(r.aliases),
    metadata: JSON.parse(r.metadata),
    first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at,
  });
}

export function upsertEntity(db: Database.Database, input: UpsertInput): UpsertResult {
  const now = new Date().toISOString();
  const nameNorm = normalizeName(input.name);

  const existing =
    findByExternalIds(db, input.external_ids ?? {}) ??
    findByExactName(db, input.kind, nameNorm, input.jurisdiction) ??
    findByFuzzy(db, input);

  if (existing) {
    const mergedIds = { ...existing.external_ids, ...(input.external_ids ?? {}) };
    const mergedAliases = mergeAliases(existing, input.name);
    const mergedMetadata = mergeMetadata(existing.metadata, input.metadata ?? {});
    db.prepare(
      "UPDATE entities SET external_ids = ?, aliases = ?, metadata = ?, last_seen_at = ? WHERE id = ?",
    ).run(
      JSON.stringify(mergedIds),
      JSON.stringify(mergedAliases),
      JSON.stringify(mergedMetadata),
      now,
      existing.id,
    );
    return {
      entity: { ...existing, external_ids: mergedIds, aliases: mergedAliases, metadata: mergedMetadata, last_seen_at: now },
      created: false,
    };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO entities
     (id, kind, name, name_normalized, jurisdiction, external_ids, aliases, metadata, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.kind, input.name, nameNorm, input.jurisdiction ?? null,
    JSON.stringify(input.external_ids ?? {}),
    JSON.stringify(input.aliases ?? []),
    JSON.stringify(input.metadata ?? {}),
    now, now,
  );
  return {
    entity: {
      id, kind: input.kind, name: input.name,
      aliases: input.aliases ?? [], jurisdiction: input.jurisdiction,
      external_ids: input.external_ids ?? {}, metadata: input.metadata ?? {},
      first_seen_at: now, last_seen_at: now,
    },
    created: true,
  };
}

function findByExternalIds(db: Database.Database, ids: Record<string, string>): Entity | null {
  // Uses json_extract rather than LIKE so that an underscore or percent
  // in a source key (e.g. "openstates_person") is treated as a literal,
  // not a SQL LIKE wildcard. Matches the canonical algorithm in
  // docs/04-entity-schema.md step 1.
  const stmt = db.prepare(
    "SELECT * FROM entities WHERE json_extract(external_ids, ?) = ? LIMIT 1",
  );
  for (const [source, id] of Object.entries(ids)) {
    const row = stmt.get(`$."${source}"`, id) as Row | undefined;
    if (row) return rowToEntity(row);
  }
  return null;
}

function findByExactName(
  db: Database.Database, kind: string, nameNorm: string, j: string | undefined,
): Entity | null {
  // D3b: Person rows are cross-jurisdiction — match on (kind, name)
  // only. Organization/committee/pac/agency rows stay scoped by
  // jurisdiction, so "Ethics Committee" in two states stays distinct.
  const rows = kind === "person"
    ? db
        .prepare(
          `SELECT * FROM entities WHERE kind = 'person' AND name_normalized = ?`,
        )
        .all(nameNorm) as Row[]
    : db
        .prepare(
          `SELECT * FROM entities
           WHERE kind = ? AND name_normalized = ?
             AND ((? IS NOT NULL AND jurisdiction = ?) OR (? IS NULL AND jurisdiction IS NULL))`,
        )
        .all(kind, nameNorm, j ?? null, j ?? null, j ?? null) as Row[];
  return rows.length === 1 ? rowToEntity(rows[0]) : null;
}

function findByFuzzy(db: Database.Database, input: UpsertInput): Entity | null {
  const signals: UpstreamSignals = {
    external_id_sources: Object.keys(input.external_ids ?? {}),
    middle_name: extractMiddleName(input.name),
    role_jurisdictions: rolesJurisdictions(input.metadata ?? {}),
  };
  const haveSignal =
    signals.external_id_sources.length > 0 ||
    signals.middle_name !== null ||
    signals.role_jurisdictions.length > 0;
  if (!haveSignal) return null;

  const q = normalizeName(input.name);
  const rows = db
    .prepare(
      `SELECT * FROM entities WHERE kind = ?
         AND length(name_normalized) BETWEEN ? AND ?`,
    )
    .all(input.kind, Math.max(1, q.length - 1), q.length + 1) as Row[];
  const candidates: (FuzzyCandidate & { row: Row })[] = rows.map((r) => {
    const meta = JSON.parse(r.metadata) as { roles?: RoleEntry[] };
    return {
      id: r.id,
      name: r.name,
      external_id_sources: Object.keys(JSON.parse(r.external_ids)),
      aliases: JSON.parse(r.aliases),
      role_jurisdictions: (meta.roles ?? []).map((x) => x.jurisdiction),
      row: r,
    };
  });
  const picked = fuzzyPick(input.name, signals, candidates);
  return picked ? rowToEntity(picked.row) : null;
}

// Returns the second whitespace token of a 3+ part name as the
// "middle name" signal for fuzzy-resolution linking. Intentionally
// naive: hasLinkingSignal (fuzzy.ts) matches the returned token
// against ALL candidate alias tokens, so multi-middle names like
// "Jane Marie Elizabeth Doe" still link when any of their middle
// tokens overlaps an alias.
function extractMiddleName(full: string): string | null {
  const parts = full.trim().split(/\s+/);
  return parts.length >= 3 ? parts[1] : null;
}

function rolesJurisdictions(metadata: Record<string, unknown>): string[] {
  const roles = metadata.roles as RoleEntry[] | undefined;
  return roles ? roles.map((r) => r.jurisdiction) : [];
}

function mergeAliases(existing: Entity, newName: string): string[] {
  if (newName === existing.name || existing.aliases.includes(newName)) return existing.aliases;
  return [...existing.aliases, newName];
}

interface RoleEntry {
  jurisdiction: string;
  role: string;
  from?: string | null;
  to?: string | null;
}

function mergeMetadata(
  old: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...old };
  for (const [k, v] of Object.entries(incoming)) {
    if (k === "roles") continue;
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  const mergedRoles = mergeRoles(
    (old.roles as RoleEntry[] | undefined) ?? [],
    (incoming.roles as RoleEntry[] | undefined) ?? [],
  );
  if (mergedRoles.length > 0) out.roles = mergedRoles;
  return out;
}

function mergeRoles(old: RoleEntry[], incoming: RoleEntry[]): RoleEntry[] {
  const key = (r: RoleEntry) => `${r.jurisdiction}|${r.role}|${r.from ?? ""}`;
  const seen = new Set(old.map(key));
  const out = [...old];
  for (const r of incoming) {
    if (!seen.has(key(r))) {
      out.push(r);
      seen.add(key(r));
    }
  }
  return out;
}

export function findEntityById(db: Database.Database, id: string): Entity | null {
  const row = db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToEntity(row) : null;
}

export interface ListFilter { kind?: EntityKind; jurisdiction?: string; limit?: number }

export function listEntities(db: Database.Database, f: ListFilter = {}): Entity[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (f.kind) { clauses.push("kind = ?"); params.push(f.kind); }
  if (f.jurisdiction) { clauses.push("jurisdiction = ?"); params.push(f.jurisdiction); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(f.limit ?? 50);
  const rows = db
    .prepare(`SELECT * FROM entities ${where} ORDER BY last_seen_at DESC LIMIT ?`)
    .all(...params) as Row[];
  return rows.map(rowToEntity);
}

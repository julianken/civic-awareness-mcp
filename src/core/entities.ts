import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Entity, type EntityKind } from "./types.js";
import { normalizeName } from "../resolution/fuzzy.js";

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
    findByExactName(db, input.kind, nameNorm, input.jurisdiction);

  if (existing) {
    const mergedIds = { ...existing.external_ids, ...(input.external_ids ?? {}) };
    const mergedAliases = mergeAliases(existing, input.name);
    db.prepare(
      "UPDATE entities SET external_ids = ?, aliases = ?, last_seen_at = ? WHERE id = ?",
    ).run(JSON.stringify(mergedIds), JSON.stringify(mergedAliases), now, existing.id);
    return {
      entity: { ...existing, external_ids: mergedIds, aliases: mergedAliases, last_seen_at: now },
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
  for (const [source, id] of Object.entries(ids)) {
    const pattern = `%"${source}":"${id}"%`;
    const row = db
      .prepare("SELECT * FROM entities WHERE external_ids LIKE ? LIMIT 1")
      .get(pattern) as Row | undefined;
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

function mergeAliases(existing: Entity, newName: string): string[] {
  if (newName === existing.name || existing.aliases.includes(newName)) return existing.aliases;
  return [...existing.aliases, newName];
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

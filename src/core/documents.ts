import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Document, type DocumentKind, type EntityReference } from "./types.js";
import { normalizeIsoDatetime } from "../util/datetime.js";

export interface UpsertDocInput {
  kind: DocumentKind;
  jurisdiction: string;
  title: string;
  summary?: string;
  occurred_at: string;
  source: { name: string; id: string; url: string };
  references?: EntityReference[];
  raw?: Record<string, unknown>;
}
export interface UpsertDocResult {
  document: Document;
  created: boolean;
}

interface DocRow {
  id: string;
  kind: string;
  jurisdiction: string;
  title: string;
  summary: string | null;
  occurred_at: string;
  fetched_at: string;
  source_name: string;
  source_id: string;
  source_url: string;
  raw: string;
}

function rowToDoc(r: DocRow, refs: EntityReference[] = [], actionDate?: string | null): Document {
  const parsed = Document.parse({
    id: r.id,
    kind: r.kind,
    jurisdiction: r.jurisdiction,
    title: r.title,
    summary: r.summary ?? undefined,
    occurred_at: r.occurred_at,
    fetched_at: r.fetched_at,
    source: { name: r.source_name, id: r.source_id, url: r.source_url },
    references: refs,
    raw: JSON.parse(r.raw),
  });
  return actionDate !== undefined ? { ...parsed, action_date: actionDate } : parsed;
}

function writeReferences(db: Database.Database, docId: string, refs: EntityReference[]): void {
  db.prepare("DELETE FROM document_references WHERE document_id = ?").run(docId);
  // `INSERT OR IGNORE` silently drops any (entity_id, role) duplicates
  // for this document. Upstream data (OpenStates bills, OpenFEC filings)
  // occasionally lists the same person twice under the same role, and
  // entity resolution can collapse two distinct sponsor records into
  // one entity. Either produces the same (doc, entity, role) triple;
  // the PK already guarantees uniqueness — we just refuse to crash.
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO document_references (document_id, entity_id, role, qualifier) VALUES (?, ?, ?, ?)",
  );
  for (const ref of refs) stmt.run(docId, ref.entity_id, ref.role, ref.qualifier ?? null);
}

function loadRefs(db: Database.Database, docId: string): EntityReference[] {
  const rows = db
    .prepare("SELECT entity_id, role, qualifier FROM document_references WHERE document_id = ?")
    .all(docId) as Array<{ entity_id: string; role: string; qualifier: string | null }>;
  return rows.map((r) => ({
    entity_id: r.entity_id,
    role: r.role as EntityReference["role"],
    qualifier: r.qualifier ?? undefined,
  }));
}

export function upsertDocument(db: Database.Database, input: UpsertDocInput): UpsertDocResult {
  const now = new Date().toISOString();
  const occurredAt = normalizeIsoDatetime(input.occurred_at);
  const existing = db
    .prepare("SELECT * FROM documents WHERE source_name = ? AND source_id = ?")
    .get(input.source.name, input.source.id) as DocRow | undefined;

  if (existing) {
    // Wrap UPDATE + reference rewrite in one transaction so a crash
    // mid-sequence cannot leave the row updated with stale refs.
    db.transaction(() => {
      db.prepare(
        `UPDATE documents
         SET kind = ?, jurisdiction = ?, title = ?, summary = ?, occurred_at = ?,
             fetched_at = ?, source_url = ?, raw = ?
         WHERE id = ?`,
      ).run(
        input.kind,
        input.jurisdiction,
        input.title,
        input.summary ?? null,
        occurredAt,
        now,
        input.source.url,
        JSON.stringify(input.raw ?? {}),
        existing.id,
      );
      writeReferences(db, existing.id, input.references ?? []);
    })();
    const merged = {
      ...existing,
      kind: input.kind,
      jurisdiction: input.jurisdiction,
      title: input.title,
      summary: input.summary ?? null,
      occurred_at: occurredAt,
      fetched_at: now,
      source_url: input.source.url,
      raw: JSON.stringify(input.raw ?? {}),
    } as DocRow;
    return { document: rowToDoc(merged, input.references ?? []), created: false };
  }

  const id = randomUUID();
  // Wrap INSERT + reference write in one transaction (same rationale).
  db.transaction(() => {
    db.prepare(
      `INSERT INTO documents
       (id, kind, jurisdiction, title, summary, occurred_at, fetched_at,
        source_name, source_id, source_url, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.kind,
      input.jurisdiction,
      input.title,
      input.summary ?? null,
      occurredAt,
      now,
      input.source.name,
      input.source.id,
      input.source.url,
      JSON.stringify(input.raw ?? {}),
    );
    writeReferences(db, id, input.references ?? []);
  })();

  return {
    document: {
      id,
      kind: input.kind,
      jurisdiction: input.jurisdiction,
      title: input.title,
      summary: input.summary,
      occurred_at: occurredAt,
      fetched_at: now,
      source: input.source,
      references: input.references ?? [],
      raw: input.raw ?? {},
    },
    created: true,
  };
}

export interface QueryDocsFilter {
  kind?: DocumentKind;
  kinds?: DocumentKind[];
  jurisdiction?: string;
  from?: string;
  to?: string;
  limit: number;
}

export function queryDocuments(db: Database.Database, f: QueryDocsFilter): Document[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (f.kind) {
    clauses.push("kind = ?");
    params.push(f.kind);
  } else if (f.kinds?.length) {
    const qs = f.kinds.map(() => "?").join(",");
    clauses.push(`kind IN (${qs})`);
    params.push(...f.kinds);
  }
  if (f.jurisdiction && f.jurisdiction !== "*") {
    clauses.push("jurisdiction = ?");
    params.push(f.jurisdiction);
  }
  if (f.from) {
    clauses.push("occurred_at >= ?");
    params.push(f.from);
  }
  if (f.to) {
    clauses.push("occurred_at <= ?");
    params.push(f.to);
  }
  params.push(f.limit);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM documents ${where} ORDER BY occurred_at DESC LIMIT ?`)
    .all(...params) as DocRow[];
  return rows.map((r) => rowToDoc(r, loadRefs(db, r.id)));
}

export function findDocumentsByEntity(
  db: Database.Database,
  entityId: string,
  limit = 50,
): Document[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT d.*,
              json_extract(d.raw, '$.actions[#-1].date') AS action_date
         FROM documents d
         JOIN document_references r ON d.id = r.document_id
         WHERE r.entity_id = ?
         ORDER BY COALESCE(json_extract(d.raw, '$.actions[#-1].date'), d.occurred_at) DESC
         LIMIT ?`,
    )
    .all(entityId, limit) as Array<DocRow & { action_date: string | null }>;
  return rows.map((r) => rowToDoc(r, loadRefs(db, r.id), r.action_date));
}

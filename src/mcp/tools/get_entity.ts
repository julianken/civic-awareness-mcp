import type Database from "better-sqlite3";
import { GetEntityInput } from "../schemas.js";
import { findEntityById } from "../../core/entities.js";
import { findDocumentsByEntity } from "../../core/documents.js";
import type { Entity, Document } from "../../core/types.js";

export interface GetEntityResponse {
  entity: Entity;
  recent_documents: Array<{
    id: string;
    kind: string;
    title: string;
    occurred_at: string;
    source_url: string;
  }>;
  sources: Array<{ name: string; url: string }>;
}

export async function handleGetEntity(
  db: Database.Database,
  rawInput: unknown,
): Promise<GetEntityResponse> {
  const input = GetEntityInput.parse(rawInput);
  const entity = findEntityById(db, input.id);
  if (!entity) throw new Error(`Entity not found: ${input.id}`);

  const docs = findDocumentsByEntity(db, entity.id, 10);
  const sourceKeys = new Map<string, { name: string; jurisdiction: string }>();
  const simplified = docs.map((d: Document) => {
    const key = `${d.source.name}|${d.jurisdiction}`;
    sourceKeys.set(key, { name: d.source.name, jurisdiction: d.jurisdiction });
    return {
      id: d.id,
      kind: d.kind,
      title: d.title,
      occurred_at: d.occurred_at,
      source_url: d.source.url,
    };
  });

  const sources = Array.from(sourceKeys.values()).map(({ name, jurisdiction }) => {
    if (name === "openstates") {
      const stateAbbr = jurisdiction.replace(/^us-/, "");
      return { name, url: `https://openstates.org/${stateAbbr}/` };
    }
    if (name === "congress") {
      return { name, url: "https://www.congress.gov/" };
    }
    return { name, url: "" };
  });

  return {
    entity,
    recent_documents: simplified,
    sources,
  };
}

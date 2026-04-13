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

  const sources: Array<{ name: string; url: string }> = [];

  // Document-level sources (derived from the documents this entity
  // appears in as a reference).
  for (const { name, jurisdiction } of sourceKeys.values()) {
    if (name === "openstates") {
      const stateAbbr = jurisdiction.replace(/^us-/, "");
      sources.push({ name, url: `https://openstates.org/${stateAbbr}/` });
    } else if (name === "congress") {
      sources.push({ name, url: "https://www.congress.gov/" });
    } else if (name === "openfec") {
      sources.push({ name, url: "https://www.fec.gov/" });
    } else {
      sources.push({ name, url: "" });
    }
  }

  // Entity-level FEC URLs — a Person or Organization can be on fec.gov
  // even when none of the currently-referenced documents come from
  // openfec (e.g., a Member of Congress with an fec_candidate ID
  // before any contributions have been ingested).
  if (entity.external_ids.fec_candidate) {
    sources.push({
      name: "openfec",
      url: `https://www.fec.gov/data/candidate/${entity.external_ids.fec_candidate}/`,
    });
  }
  if (entity.external_ids.fec_committee) {
    sources.push({
      name: "openfec",
      url: `https://www.fec.gov/data/committee/${entity.external_ids.fec_committee}/`,
    });
  }

  return {
    entity,
    recent_documents: simplified,
    sources,
  };
}

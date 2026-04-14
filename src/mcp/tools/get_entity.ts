import type Database from "better-sqlite3";
import { GetEntityInput } from "../schemas.js";
import { findEntityById } from "../../core/entities.js";
import { findDocumentsByEntity } from "../../core/documents.js";
import type { Entity, Document } from "../../core/types.js";
import type { StaleNotice } from "../shared.js";
import { ensureFresh, sourcesForFullHydrate } from "../../core/hydrate.js";
import { getLimiter } from "../../core/limiters.js";

export interface GetEntityResponse {
  entity: Entity;
  recent_documents: Array<{
    id: string;
    kind: string;
    title: string;
    occurred_at: string;
    action_date: string | null;
    source_url: string;
  }>;
  sources: Array<{ name: string; url: string }>;
  stale_notice?: StaleNotice;
}

export async function handleGetEntity(
  db: Database.Database,
  rawInput: unknown,
): Promise<GetEntityResponse> {
  const input = GetEntityInput.parse(rawInput);
  const entity = findEntityById(db, input.id);
  if (!entity) throw new Error(`Entity not found: ${input.id}`);

  let stale_notice: StaleNotice | undefined;
  const roles = (entity.metadata?.roles as Array<{ jurisdiction?: string }> | undefined) ?? [];
  const jurisdictions = [...new Set(roles.map((r) => r.jurisdiction).filter(Boolean))] as string[];
  outer: for (const juris of jurisdictions) {
    for (const src of sourcesForFullHydrate(juris)) {
      const r = await ensureFresh(db, src, juris, "full", () => getLimiter(src).peekWaitMs());
      if (r.stale_notice) { stale_notice = r.stale_notice; break outer; }
    }
  }

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
      action_date: d.action_date ?? null,
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

  const response: GetEntityResponse = {
    entity,
    recent_documents: simplified,
    sources,
  };
  if (stale_notice) response.stale_notice = stale_notice;
  return response;
}

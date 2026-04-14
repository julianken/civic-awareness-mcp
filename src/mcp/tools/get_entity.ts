import type Database from "better-sqlite3";
import { CongressAdapter } from "../../adapters/congress.js";
import { OpenFecAdapter } from "../../adapters/openfec.js";
import { OpenStatesAdapter } from "../../adapters/openstates.js";
import { findDocumentsByEntity } from "../../core/documents.js";
import { findEntityById } from "../../core/entities.js";
import { getLimiter } from "../../core/limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import type { Document, Entity } from "../../core/types.js";
import { requireEnv } from "../../util/env.js";
import { GetEntityInput } from "../schemas.js";
import type { StaleNotice } from "../shared.js";

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

  const ttl = { scope: "detail" as const, ms: 24 * 60 * 60 * 1000 };
  const noop = (): void => {};
  const calls: Promise<{ stale_notice?: StaleNotice }>[] = [];

  if (entity.external_ids.bioguide) {
    const bioguide = entity.external_ids.bioguide;
    calls.push(
      withShapedFetch(
        db,
        {
          source: "congress",
          endpoint_path: `/member/${bioguide}`,
          args: { bioguide },
          tool: "fetchMember",
        },
        ttl,
        async () => {
          const adapter = new CongressAdapter({
            apiKey: requireEnv("API_DATA_GOV_KEY"),
            rateLimiter: getLimiter("congress"),
          });
          const r = await adapter.fetchMember(db, bioguide);
          return { primary_rows_written: r.entitiesUpserted };
        },
        noop,
        () => getLimiter("congress").peekWaitMs(),
      ),
    );
  }

  if (entity.external_ids.openstates_person) {
    const ocdId = entity.external_ids.openstates_person;
    calls.push(
      withShapedFetch(
        db,
        {
          source: "openstates",
          endpoint_path: `/people/${ocdId}`,
          args: { ocdId },
          tool: "fetchPerson",
        },
        ttl,
        async () => {
          const adapter = new OpenStatesAdapter({
            apiKey: requireEnv("OPENSTATES_API_KEY"),
            rateLimiter: getLimiter("openstates"),
          });
          const r = await adapter.fetchPerson(db, ocdId);
          return { primary_rows_written: r.entitiesUpserted };
        },
        noop,
        () => getLimiter("openstates").peekWaitMs(),
      ),
    );
  }

  if (entity.external_ids.fec_candidate) {
    const fecId = entity.external_ids.fec_candidate;
    calls.push(
      withShapedFetch(
        db,
        {
          source: "openfec",
          endpoint_path: `/candidate/${fecId}`,
          args: { fecId },
          tool: "fetchCandidate",
        },
        ttl,
        async () => {
          const adapter = new OpenFecAdapter({
            apiKey: requireEnv("API_DATA_GOV_KEY"),
            rateLimiter: getLimiter("openfec"),
          });
          const r = await adapter.fetchCandidate(db, fecId);
          return { primary_rows_written: r.entitiesUpserted };
        },
        noop,
        () => getLimiter("openfec").peekWaitMs(),
      ),
    );
  }

  let stale_notice: StaleNotice | undefined;
  for (const res of await Promise.all(calls)) {
    if (res.stale_notice && !stale_notice) stale_notice = res.stale_notice;
  }

  // Re-read the entity — the fanout may have merged new external IDs
  // or metadata into it (e.g., adding a federal role to a Person
  // previously known only through state-legislature data).
  const refreshedEntity = findEntityById(db, input.id) ?? entity;

  const docs = findDocumentsByEntity(db, refreshedEntity.id, 10);
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
  if (refreshedEntity.external_ids.fec_candidate) {
    sources.push({
      name: "openfec",
      url: `https://www.fec.gov/data/candidate/${refreshedEntity.external_ids.fec_candidate}/`,
    });
  }
  if (refreshedEntity.external_ids.fec_committee) {
    sources.push({
      name: "openfec",
      url: `https://www.fec.gov/data/committee/${refreshedEntity.external_ids.fec_committee}/`,
    });
  }

  const response: GetEntityResponse = {
    entity: refreshedEntity,
    recent_documents: simplified,
    sources,
  };
  if (stale_notice) response.stale_notice = stale_notice;
  return response;
}

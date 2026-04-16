import type Database from "better-sqlite3";
import { OpenStatesAdapter } from "../adapters/openstates.js";
import { findDocumentsByEntity } from "../../core/documents.js";
import { findEntityById } from "../../core/entities.js";
import { getLimiter } from "../limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import type { Document, Entity } from "../../core/types.js";
import { requireEnv } from "../../util/env.js";
import { GetEntityInput } from "../schemas.js";
import type { StaleNotice } from "../../core/shared.js";

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

  let stale_notice: StaleNotice | undefined;
  for (const res of await Promise.all(calls)) {
    if (res.stale_notice && !stale_notice) stale_notice = res.stale_notice;
  }

  // Re-read the entity — the fanout may have merged new external IDs or metadata.
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

  for (const { name, jurisdiction } of sourceKeys.values()) {
    if (name === "openstates") {
      const stateAbbr = jurisdiction.replace(/^us-/, "");
      sources.push({ name, url: `https://openstates.org/${stateAbbr}/` });
    } else {
      sources.push({ name, url: "" });
    }
  }

  // If entity has openstates_person, add a direct profile URL.
  if (refreshedEntity.external_ids.openstates_person) {
    const personId = refreshedEntity.external_ids.openstates_person;
    sources.push({
      name: "openstates",
      url: `https://openstates.org/person/${personId}/`,
    });
  }

  return {
    entity: refreshedEntity,
    recent_documents: simplified,
    sources,
    ...(stale_notice ? { stale_notice } : {}),
  };
}

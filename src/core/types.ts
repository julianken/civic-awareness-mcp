import { z } from "zod";

export const Jurisdiction = z.object({
  id: z.string(),
  level: z.enum(["federal", "state"]),
  name: z.string(),
});
export type Jurisdiction = z.infer<typeof Jurisdiction>;

export const EntityKind = z.enum(["person", "organization", "committee", "pac", "agency"]);
export type EntityKind = z.infer<typeof EntityKind>;

export const ExternalIds = z.record(z.string(), z.string());

export const Entity = z.object({
  id: z.uuid(),
  kind: EntityKind,
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  jurisdiction: z.string().optional(),
  external_ids: ExternalIds.default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
  first_seen_at: z.iso.datetime(),
  last_seen_at: z.iso.datetime(),
});
export type Entity = z.infer<typeof Entity>;

export const ReferenceRole = z.enum([
  "sponsor", "cosponsor", "voter", "contributor",
  "recipient", "subject", "officer", "member",
]);
export type ReferenceRole = z.infer<typeof ReferenceRole>;

export const EntityReference = z.object({
  entity_id: z.uuid(),
  role: ReferenceRole,
  qualifier: z.string().optional(),
});
export type EntityReference = z.infer<typeof EntityReference>;

export const DocumentKind = z.enum([
  "bill", "bill_action", "vote", "contribution", "expenditure",
]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const Document = z.object({
  id: z.uuid(),
  kind: DocumentKind,
  jurisdiction: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  occurred_at: z.iso.datetime(),
  fetched_at: z.iso.datetime(),
  source: z.object({
    name: z.string(),
    id: z.string(),
    url: z.url(),
  }),
  references: z.array(EntityReference).default([]),
  raw: z.record(z.string(), z.unknown()).default({}),
  action_date: z.string().nullable().optional(),
});
export type Document = z.infer<typeof Document>;

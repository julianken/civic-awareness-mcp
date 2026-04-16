import { z } from "zod";

export const RecentBillsInput = z.object({
  // Required. Accepts "us-tx", "us-ca", "*" for all jurisdictions, etc.
  jurisdiction: z.string().min(1),
  days: z.number().int().min(1).max(365).default(7),
  chamber: z.enum(["upper", "lower"]).optional(),
  session: z.string().min(1).optional(),
  // Optional row cap. When set, the handler drops the days-derived
  // `updated_since` upstream filter and returns top-N by
  // OpenStates' native `sort=updated_desc`. Use to query biennial or
  // off-session jurisdictions where the time window is empty.
  limit: z.number().int().min(1).max(500).optional(),
});
export type RecentBillsInput = z.infer<typeof RecentBillsInput>;

export const GetBillInput = z.object({
  jurisdiction: z.string().min(1),
  session: z.string().min(1),
  identifier: z.string().min(1),
});
export type GetBillInput = z.infer<typeof GetBillInput>;

export const ListBillsInput = z.object({
  jurisdiction: z.string().min(1),
  session: z.string().min(1).optional(),
  chamber: z.enum(["upper", "lower"]).optional(),
  sponsor_entity_id: z.string().min(1).optional(),
  classification: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  introduced_since: z.string().min(1).optional(),
  introduced_until: z.string().min(1).optional(),
  updated_since: z.string().min(1).optional(),
  updated_until: z.string().min(1).optional(),
  sort: z
    .enum(["updated_desc", "updated_asc", "introduced_desc", "introduced_asc"])
    .default("updated_desc"),
  limit: z.number().int().min(1).max(500).default(20),
});
export type ListBillsInput = z.infer<typeof ListBillsInput>;

export const SearchDocumentsInput = z.object({
  q: z.string().min(1),
  jurisdiction: z.string().min(1).optional(),
  kinds: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type SearchDocumentsInput = z.infer<typeof SearchDocumentsInput>;

export const SearchEntitiesInput = z.object({
  q: z.string().min(1),
  kind: z.enum(["person", "organization", "committee", "pac", "agency"]).optional(),
  jurisdiction: z.string().min(1).optional(),
  had_role: z.string().min(1).optional(),
  had_jurisdiction: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type SearchEntitiesInput = z.infer<typeof SearchEntitiesInput>;

export const GetEntityInput = z.object({
  entity_id: z.string().min(1),
});
export type GetEntityInput = z.infer<typeof GetEntityInput>;

export const ResolvePersonInput = z.object({
  name: z.string().min(1),
  jurisdiction_hint: z.string().min(1).optional(),
  role_hint: z.string().min(1).optional(),
  context: z.string().min(1).optional(),
});
export type ResolvePersonInput = z.infer<typeof ResolvePersonInput>;

export const EntityConnectionsInput = z.object({
  id: z.string().min(1),
  depth: z.union([z.literal(1), z.literal(2)]).default(1),
  min_co_occurrences: z.number().int().min(1).max(50).default(2),
});
export type EntityConnectionsInput = z.infer<typeof EntityConnectionsInput>;

export const RecentVotesInput = z.object({
  jurisdiction: z.string().min(1),
  days: z.number().int().min(1).max(365).default(7),
  chamber: z.enum(["upper", "lower"]).optional(),
  session: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type RecentVotesInput = z.infer<typeof RecentVotesInput>;

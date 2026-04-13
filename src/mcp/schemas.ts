import { z } from "zod";

export const RecentBillsInput = z.object({
  days: z.number().int().min(1).max(90).default(7),
  // REQUIRED. "us-federal", "us-<state>" (e.g. "us-tx"), or "*" to
  // query across all. No default — the caller must state which
  // jurisdiction they want. See docs/05-tool-surface.md.
  jurisdiction: z.string().min(1),
  chamber: z.enum(["upper", "lower"]).optional(),
  session: z.string().optional(),
});
export type RecentBillsInput = z.infer<typeof RecentBillsInput>;

export const SearchEntitiesInput = z.object({
  q: z.string().min(1),
  kind: z.enum(["person", "organization", "committee", "pac", "agency"]).optional(),
  jurisdiction: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type SearchEntitiesInput = z.infer<typeof SearchEntitiesInput>;

export const GetEntityInput = z.object({
  id: z.string().min(1),
});
export type GetEntityInput = z.infer<typeof GetEntityInput>;

export const SearchDocumentsInput = z.object({
  q: z.string().min(1),
  kinds: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type SearchDocumentsInput = z.infer<typeof SearchDocumentsInput>;

export const RecentVotesInput = z.object({
  jurisdiction: z.string().min(1),
  days: z.number().int().min(1).max(90).default(7),
  chamber: z.enum(["upper", "lower"]).optional(),
  bill_identifier: z.string().optional(),
});
export type RecentVotesInput = z.infer<typeof RecentVotesInput>;

export const RecentContributionsInput = z.object({
  window: z.object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),
  candidate_or_committee: z.string().optional(),
  min_amount: z.number().min(0).optional(),
});
export type RecentContributionsInput = z.infer<typeof RecentContributionsInput>;

export const EntityConnectionsInput = z.object({
  id: z.string().min(1),
  depth: z.union([z.literal(1), z.literal(2)]).default(1),
  min_co_occurrences: z.number().int().min(1).max(50).default(2),
});
export type EntityConnectionsInput = z.infer<typeof EntityConnectionsInput>;

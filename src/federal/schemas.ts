import { z } from "zod";

export const RecentBillsInput = z.object({
  days: z.number().int().min(1).max(365).default(7),
  // us-federal only — jurisdiction is hardcoded for the federal package.
  chamber: z.enum(["upper", "lower"]).optional(),
  session: z.string().min(1).optional(),
  // Optional row cap. When set, the handler drops the days-derived
  // `updated_since` upstream filter and returns top-N by Congress.gov's
  // native `sort=updateDate+desc`. Use to query sessions where the time
  // window is empty. See D12 / R16.
  limit: z.number().int().min(1).max(500).optional(),
});
export type RecentBillsInput = z.infer<typeof RecentBillsInput>;

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
  id: z.string().min(1),
});
export type GetEntityInput = z.infer<typeof GetEntityInput>;

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

export const RecentVotesInput = z.object({
  jurisdiction: z.string().min(1).default("us-federal"),
  days: z.number().int().min(1).max(365).default(7),
  chamber: z.enum(["upper", "lower"]).optional(),
  bill_identifier: z.string().min(1).optional(),
  session: z.string().min(1).optional(),
});
export type RecentVotesInput = z.infer<typeof RecentVotesInput>;

export const RecentContributionsInput = z.object({
  window: z.object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),
  candidate_or_committee: z.string().min(1).optional(),
  min_amount: z.number().min(0).optional(),
  contributor_entity_id: z.string().min(1).optional(),
  side: z.enum(["contributor", "recipient", "either"]).optional(),
});
export type RecentContributionsInput = z.infer<typeof RecentContributionsInput>;

export const EntityConnectionsInput = z.object({
  id: z.string().min(1),
  depth: z.union([z.literal(1), z.literal(2)]).default(1),
  min_co_occurrences: z.number().int().min(1).max(50).default(2),
});
export type EntityConnectionsInput = z.infer<typeof EntityConnectionsInput>;

export const ResolvePersonInput = z.object({
  name: z.string().min(1),
  jurisdiction_hint: z.string().min(1).optional(),
  role_hint: z.string().min(1).optional(),
  context: z.string().min(1).optional(),
});
export type ResolvePersonInput = z.infer<typeof ResolvePersonInput>;

export const GetVoteInput = z
  .object({
    vote_id: z.string().min(1).optional(),
    congress: z.number().int().positive().optional(),
    chamber: z.enum(["upper", "lower"]).optional(),
    session: z.union([z.literal(1), z.literal(2)]).optional(),
    roll_number: z.number().int().positive().optional(),
  })
  .refine(
    (v) =>
      v.vote_id !== undefined ||
      (v.congress !== undefined &&
        v.chamber !== undefined &&
        v.session !== undefined &&
        v.roll_number !== undefined),
    {
      message:
        "Provide either vote_id OR the full composite (congress, chamber, session, roll_number).",
    },
  );
export type GetVoteInput = z.infer<typeof GetVoteInput>;

import { z } from "zod";

export const RecentBillsInput = z.object({
  days: z.number().int().min(1).max(365).default(7),
  // REQUIRED. "us-federal", "us-<state>" (e.g. "us-tx"), or "*" to
  // query across all. No default — the caller must state which
  // jurisdiction they want. See docs/05-tool-surface.md.
  jurisdiction: z.string().min(1),
  chamber: z.enum(["upper", "lower"]).optional(),
  session: z.string().optional(),
  // Optional row cap. When set, the handler drops the days-derived
  // `updated_since` upstream filter and returns top-N by
  // OpenStates' native `sort=updated_desc` / Congress.gov's
  // `sort=updateDate+desc`. Use to query biennial or off-session
  // jurisdictions where the time window is empty. See D12 / R16.
  limit: z.number().int().min(1).max(20).optional(),
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
  jurisdiction: z.string().optional(),
  kinds: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type SearchDocumentsInput = z.infer<typeof SearchDocumentsInput>;

export const RecentVotesInput = z.object({
  jurisdiction: z.string().min(1),
  days: z.number().int().min(1).max(365).default(7),
  chamber: z.enum(["upper", "lower"]).optional(),
  bill_identifier: z.string().optional(),
  session: z.string().optional(),
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

export const ResolvePersonInput = z.object({
  name: z.string().min(1),
  jurisdiction_hint: z.string().optional(),
  role_hint: z.string().optional(),
  context: z.string().optional(),
});
export type ResolvePersonInput = z.infer<typeof ResolvePersonInput>;

export const GetBillInput = z.object({
  jurisdiction: z.string().min(1),
  session: z.string().min(1),
  identifier: z.string().min(1),
});
export type GetBillInput = z.infer<typeof GetBillInput>;

export const ListBillsInput = z.object({
  jurisdiction: z.string().min(1),
  session: z.string().optional(),
  chamber: z.enum(["upper", "lower"]).optional(),
  sponsor_entity_id: z.string().optional(),
  classification: z.string().optional(),
  subject: z.string().optional(),
  introduced_since: z.string().optional(),
  introduced_until: z.string().optional(),
  updated_since: z.string().optional(),
  updated_until: z.string().optional(),
  sort: z
    .enum(["updated_desc", "updated_asc", "introduced_desc", "introduced_asc"])
    .default("updated_desc"),
  limit: z.number().int().min(1).max(50).default(20),
});
export type ListBillsInput = z.infer<typeof ListBillsInput>;

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

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
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type SearchDocumentsInput = z.infer<typeof SearchDocumentsInput>;

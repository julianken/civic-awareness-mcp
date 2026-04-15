import type Database from "better-sqlite3";
import { OpenStatesAdapter } from "../../adapters/openstates.js";
import { queryDocuments } from "../../core/documents.js";
import { findEntityById } from "../../core/entities.js";
import { getLimiter } from "../../core/limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import { requireEnv } from "../../util/env.js";
import { logger } from "../../util/logger.js";
import { ListBillsInput } from "../schemas.js";
import type { StaleNotice } from "../shared.js";
import {
  buildSponsorSummary,
  type BillSummary,
} from "./recent_bills.js";

export interface ListBillsResponse {
  results: BillSummary[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  stale_notice?: StaleNotice;
  empty_reason?: string;
  hint?: string;
}

function introducedDate(raw: Record<string, unknown>): string | undefined {
  const actions = raw.actions as Array<{ date: string }> | undefined;
  return actions?.[0]?.date;
}

function matchesClassification(
  raw: Record<string, unknown>,
  filter: string,
): boolean {
  const c = raw.classification;
  if (Array.isArray(c)) return c.includes(filter);
  if (typeof c === "string") return c === filter;
  return false;
}

function matchesSubject(
  raw: Record<string, unknown>,
  filter: string,
): boolean {
  const subjects = raw.subjects as string[] | undefined;
  return Array.isArray(subjects) && subjects.includes(filter);
}

function compareSort(
  a: { intro?: string; upd: string },
  b: { intro?: string; upd: string },
  sort: "updated_desc" | "updated_asc" | "introduced_desc" | "introduced_asc",
): number {
  if (sort === "updated_desc") return b.upd.localeCompare(a.upd);
  if (sort === "updated_asc") return a.upd.localeCompare(b.upd);
  const ai = a.intro ?? "";
  const bi = b.intro ?? "";
  if (sort === "introduced_desc") return bi.localeCompare(ai);
  return ai.localeCompare(bi);
}

export async function handleListBills(
  db: Database.Database,
  rawInput: unknown,
): Promise<ListBillsResponse> {
  const input = ListBillsInput.parse(rawInput);

  // Federal: defer to future phase; return not_yet_supported.
  if (input.jurisdiction === "us-federal") {
    return {
      results: [],
      total: 0,
      sources: [{ name: "congress", url: "https://www.congress.gov/" }],
      stale_notice: {
        as_of: new Date().toISOString(),
        reason: "not_yet_supported",
        message:
          "list_bills does not yet support us-federal. Congress.gov's bill " +
          "endpoint does not accept the same predicates (sponsor, subject, " +
          "classification). For federal cosponsor queries, use " +
          "entity_connections on the member's entity id.",
      },
    };
  }

  // Map sponsor_entity_id (our UUID) → OCD person id for upstream.
  // If the entity has no openstates_person external id (or does not exist),
  // no upstream query can satisfy the sponsor predicate — short-circuit to
  // an empty response rather than fanning out a broad, unfiltered fetch
  // that the local projection would then reject anyway.
  let sponsorOcd: string | undefined;
  if (input.sponsor_entity_id) {
    const ent = findEntityById(db, input.sponsor_entity_id);
    if (!ent) {
      logger.warn("list_bills: sponsor entity not found", {
        id: input.sponsor_entity_id,
      });
      throw new Error(`sponsor entity not found: ${input.sponsor_entity_id}`);
    }
    const xids = (ent.external_ids ?? {}) as Record<string, string>;
    sponsorOcd = xids.openstates_person;
    if (!sponsorOcd) {
      const stateAbbr = input.jurisdiction.replace(/^us-/, "");
      return {
        results: [],
        total: 0,
        sources: [
          { name: "openstates", url: `https://openstates.org/${stateAbbr}/` },
        ],
        empty_reason: "sponsor_not_linked_to_openstates",
        hint:
          "This entity has no OpenStates person link; no bills can be found " +
          "via this sponsor filter.",
      };
    }
  }

  const projectLocal = (): ListBillsResponse => {
    const docs = queryDocuments(db, {
      kind: "bill",
      jurisdiction: input.jurisdiction,
      limit: 500,
    });

    const filtered = docs.filter((d) => {
      if (input.session) {
        const s = (d.raw as { session?: string }).session;
        if (s !== input.session) return false;
      }
      if (input.chamber) {
        const classification = (d.raw as { from_organization?: { classification?: string } })
          .from_organization?.classification;
        if (classification !== input.chamber) return false;
      }
      if (input.sponsor_entity_id) {
        const refs = d.references;
        const hit = refs.some(
          (r) =>
            r.entity_id === input.sponsor_entity_id &&
            (r.role === "sponsor" || r.role === "cosponsor"),
        );
        if (!hit) return false;
      }
      if (input.classification && !matchesClassification(d.raw, input.classification)) {
        return false;
      }
      if (input.subject && !matchesSubject(d.raw, input.subject)) {
        return false;
      }
      if (input.introduced_since || input.introduced_until) {
        const intro = introducedDate(d.raw);
        if (!intro) return false;
        if (input.introduced_since && intro < input.introduced_since) return false;
        if (input.introduced_until && intro > input.introduced_until) return false;
      }
      if (input.updated_since || input.updated_until) {
        const upd = d.occurred_at;
        if (input.updated_since && upd < input.updated_since) return false;
        if (input.updated_until && upd > input.updated_until) return false;
      }
      return true;
    });

    const sortable = filtered.map((d) => ({
      doc: d,
      intro: introducedDate(d.raw),
      upd: d.occurred_at,
    }));
    sortable.sort((a, b) => compareSort(a, b, input.sort));
    const limited = sortable.slice(0, input.limit);

    const results: BillSummary[] = limited.map(({ doc: d }) => {
      const [identifier, ...titleParts] = d.title.split(" — ");
      const actions =
        (d.raw.actions as Array<{ date: string; description: string }> | undefined) ?? [];
      const latest = actions.length ? actions[actions.length - 1] : null;
      return {
        id: d.id,
        identifier: identifier?.trim() ?? d.title,
        title: titleParts.join(" — ").trim() || d.title,
        latest_action: latest,
        sponsor_summary: buildSponsorSummary(db, d.references),
        source_url: d.source.url,
      };
    });

    const stateAbbr = input.jurisdiction.replace(/^us-/, "");
    return {
      results,
      total: results.length,
      sources: [
        {
          name: "openstates",
          url: `https://openstates.org/${stateAbbr}/`,
        },
      ],
    };
  };

  const fetchAndWrite = async (): Promise<{ primary_rows_written: number }> => {
    const adapter = new OpenStatesAdapter({
      apiKey: requireEnv("OPENSTATES_API_KEY"),
      rateLimiter: getLimiter("openstates"),
    });
    const { documentsUpserted } = await adapter.listBills(db, {
      jurisdiction: input.jurisdiction,
      session: input.session,
      chamber: input.chamber,
      sponsor: sponsorOcd,
      classification: input.classification,
      subject: input.subject,
      introduced_since: input.introduced_since,
      introduced_until: input.introduced_until,
      updated_since: input.updated_since,
      updated_until: input.updated_until,
      sort: input.sort,
      limit: input.limit,
    });
    return { primary_rows_written: documentsUpserted };
  };

  const result = await withShapedFetch(
    db,
    {
      source: "openstates",
      endpoint_path: "/bills/list",
      args: {
        jurisdiction: input.jurisdiction,
        session: input.session,
        chamber: input.chamber,
        sponsor_entity_id: input.sponsor_entity_id,
        classification: input.classification,
        subject: input.subject,
        introduced_since: input.introduced_since,
        introduced_until: input.introduced_until,
        updated_since: input.updated_since,
        updated_until: input.updated_until,
        sort: input.sort,
        limit: input.limit,
      },
      tool: "list_bills",
    },
    { scope: "recent", ms: 60 * 60 * 1000 },
    fetchAndWrite,
    projectLocal,
    () => getLimiter("openstates").peekWaitMs(),
  );

  if (result.stale_notice) {
    return { ...result.value, stale_notice: result.stale_notice };
  }
  return result.value;
}

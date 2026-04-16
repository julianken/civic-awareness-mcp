import type Database from "better-sqlite3";
import { OpenStatesAdapter } from "../adapters/openstates.js";
import { queryDocuments } from "../../core/documents.js";
import { findEntityById } from "../../core/entities.js";
import { getLimiter } from "../limiters.js";
import { withShapedFetch } from "../../core/tool_cache.js";
import type { Document, EntityReference } from "../../core/types.js";
import { requireEnv } from "../../util/env.js";
import { logger } from "../../util/logger.js";
import { RecentBillsInput } from "../schemas.js";
import {
  emptyFeedDiagnostic,
  type EmptyFeedDiagnostic,
  type StaleNotice,
} from "../../core/shared.js";

const MAX_WARN_PER_CALL = 3;

export interface SponsorSummary {
  count: number;
  by_party: Record<string, number>;
  top: Array<{
    entity_id: string;
    name: string;
    party?: string;
    role: "sponsor" | "cosponsor";
  }>;
}

export interface BillSummary {
  id: string;
  identifier: string;
  title: string;
  latest_action: { date: string; description: string } | null;
  sponsor_summary: SponsorSummary;
  source_url: string;
}

export interface RecentBillsResponse {
  results: BillSummary[];
  total: number;
  sources: Array<{ name: string; url: string }>;
  window: { from: string; to: string };
  empty_reason?: EmptyFeedDiagnostic["empty_reason"] | "sponsor_not_linked_to_openstates";
  data_freshness?: EmptyFeedDiagnostic["data_freshness"];
  hint?: string;
  filters_applied?: EmptyFeedDiagnostic["filters_applied"];
  stale_notice?: StaleNotice;
}

export function projectLatestAction(
  raw: Record<string, unknown>,
): { date: string; description: string } | null {
  const actions = raw.actions as Array<Record<string, unknown>> | undefined;
  if (!actions?.length) return null;
  const last = actions[actions.length - 1];
  const date = typeof last.date === "string" ? last.date : null;
  const description = typeof last.description === "string" ? last.description : null;
  if (date === null || description === null) return null;
  return { date, description };
}

export function buildSponsorSummary(
  db: Database.Database,
  refs: EntityReference[],
): SponsorSummary {
  const filtered = refs.filter((r) => r.role === "sponsor" || r.role === "cosponsor");
  if (filtered.length === 0) {
    return { count: 0, by_party: {}, top: [] };
  }
  const allPlaceholders = filtered.map(() => "?").join(",");
  const allRows = db
    .prepare(`SELECT id, name, metadata FROM entities WHERE id IN (${allPlaceholders})`)
    .all(...filtered.map((r) => r.entity_id)) as Array<{
    id: string;
    name: string;
    metadata: string;
  }>;
  const byId = new Map(
    allRows.map((r) => [
      r.id,
      { name: r.name, meta: JSON.parse(r.metadata) as { party?: string } },
    ]),
  );

  const by_party: Record<string, number> = {};
  for (const r of filtered) {
    const e = byId.get(r.entity_id);
    const party = e?.meta.party ?? "unknown";
    by_party[party] = (by_party[party] ?? 0) + 1;
  }

  const TOP_N = 5;
  const primaries = filtered.filter((r) => r.role === "sponsor");
  const cosponsors = filtered.filter((r) => r.role === "cosponsor");
  const topRefs = [...primaries, ...cosponsors].slice(0, TOP_N);

  const top = topRefs.map((r) => {
    const e = byId.get(r.entity_id);
    return {
      entity_id: r.entity_id,
      name: e?.name ?? "Unknown",
      party: e?.meta.party,
      role: r.role as "sponsor" | "cosponsor",
    };
  });

  return { count: filtered.length, by_party, top };
}

function introducedDate(raw: Record<string, unknown>): string | undefined {
  const actions = raw.actions as Array<{ date: string }> | undefined;
  return actions?.[0]?.date;
}

function matchesClassification(raw: Record<string, unknown>, filter: string): boolean {
  const c = raw.classification;
  if (Array.isArray(c)) return c.includes(filter);
  if (typeof c === "string") return c === filter;
  return false;
}

function matchesSubject(raw: Record<string, unknown>, filter: string): boolean {
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

export async function handleRecentBills(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentBillsResponse> {
  const input = RecentBillsInput.parse(rawInput);

  const hasExplicitWindow = !!(
    input.introduced_since ||
    input.introduced_until ||
    input.updated_since ||
    input.updated_until
  );

  const now = new Date();
  const windowFrom = hasExplicitWindow
    ? (input.introduced_since ?? input.updated_since ?? "1970-01-01T00:00:00Z")
    : new Date(now.getTime() - input.days * 86400 * 1000).toISOString();
  const windowTo = hasExplicitWindow
    ? (input.introduced_until ?? input.updated_until ?? now.toISOString())
    : now.toISOString();

  // Resolve sponsor_entity_id → OCD person id. Entity with no
  // openstates_person link can never match server-side — short-circuit
  // before fanning out a broad, unfiltered fetch that would be rejected
  // client-side anyway.
  let sponsorOcd: string | undefined;
  if (input.sponsor_entity_id) {
    const ent = findEntityById(db, input.sponsor_entity_id);
    if (!ent) {
      logger.warn("recent_bills: sponsor entity not found", {
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
        sources: [{ name: "openstates", url: `https://openstates.org/${stateAbbr}/` }],
        window: { from: windowFrom, to: windowTo },
        empty_reason: "sponsor_not_linked_to_openstates",
        hint:
          "This entity has no OpenStates person link; no bills can be found " +
          "via this sponsor filter.",
      };
    }
  }

  const projectLocal = (jurisdiction: string): RecentBillsResponse => {
    const isWildcard = jurisdiction === "*";
    // Headroom so client-side predicates (sponsor/subject/classification/
    // date) don't starve the final limit.
    const ceiling = Math.max(500, (input.limit ?? 20) * 3);

    const docs = hasExplicitWindow
      ? queryDocuments(db, {
          kind: "bill",
          ...(isWildcard ? {} : { jurisdiction }),
          limit: ceiling,
        })
      : input.session
        ? queryDocuments(db, {
            kind: "bill",
            ...(isWildcard ? {} : { jurisdiction }),
            limit: Math.max(100, ceiling),
          })
        : input.limit !== undefined
          ? queryDocuments(db, {
              kind: "bill",
              ...(isWildcard ? {} : { jurisdiction }),
              limit: ceiling,
            })
          : queryDocuments(db, {
              kind: "bill",
              ...(isWildcard ? {} : { jurisdiction }),
              from: windowFrom,
              to: windowTo,
              limit: 50,
            });

    const filtered = docs.filter((d: Document) => {
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
        const hit = d.references.some(
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

    let titleSplitWarns = 0;
    const mapped: BillSummary[] = sortable.map(({ doc: d }) => {
      const [identifier, ...titleParts] = d.title.split(" — ");
      if (titleParts.length === 0 && titleSplitWarns < MAX_WARN_PER_CALL) {
        logger.warn(
          "recent_bills: title missing ' — ' separator; identifier and title duplicated",
          {
            document_id: d.id,
            title: d.title,
          },
        );
        titleSplitWarns++;
      }
      return {
        id: d.id,
        identifier: identifier?.trim() ?? d.title,
        title: titleParts.join(" — ").trim() || d.title,
        latest_action: projectLatestAction(d.raw),
        sponsor_summary: buildSponsorSummary(db, d.references),
        source_url: d.source.url,
      };
    });

    const capped = input.limit !== undefined ? mapped.slice(0, input.limit) : mapped;

    const abbr = isWildcard ? "" : jurisdiction.replace(/^us-/, "");
    const sourceUrl = isWildcard ? "https://openstates.org/" : `https://openstates.org/${abbr}/`;

    const base: RecentBillsResponse = {
      results: capped,
      total: capped.length,
      sources: [{ name: "openstates", url: sourceUrl }],
      window: { from: windowFrom, to: windowTo },
    };
    if (capped.length === 0 && !isWildcard) {
      const filtersApplied: string[] = [];
      if (input.session) filtersApplied.push("session");
      if (input.chamber) filtersApplied.push("chamber");
      if (input.sponsor_entity_id) filtersApplied.push("sponsor_entity_id");
      if (input.classification) filtersApplied.push("classification");
      if (input.subject) filtersApplied.push("subject");
      if (input.introduced_since) filtersApplied.push("introduced_since");
      if (input.introduced_until) filtersApplied.push("introduced_until");
      if (input.updated_since) filtersApplied.push("updated_since");
      if (input.updated_until) filtersApplied.push("updated_until");
      const diag = emptyFeedDiagnostic(db, {
        kind: "bill",
        jurisdiction,
        preFilterCount: docs.length,
        filtersApplied,
      });
      return { ...base, ...diag };
    }
    return base;
  };

  if (input.jurisdiction === "*") {
    return projectLocal("*");
  }

  const jurisdiction = input.jurisdiction;

  const fetchAndWrite = async (): Promise<{ primary_rows_written: number }> => {
    const adapter = new OpenStatesAdapter({
      apiKey: requireEnv("OPENSTATES_API_KEY"),
      rateLimiter: getLimiter("openstates"),
    });
    const stateAbbr = jurisdiction.replace(/^us-/, "");
    // OpenStates v3 rejects trailing `Z` on datetime filters; date-only
    // strings are unaffected by the 19-char slice.
    const stripZ = (s: string | undefined): string | undefined =>
      s === undefined ? undefined : s.slice(0, 19);
    const updatedSinceParam = hasExplicitWindow
      ? stripZ(input.updated_since)
      : input.limit !== undefined
        ? stripZ(new Date(now.getTime() - 365 * 86400 * 1000).toISOString())
        : stripZ(windowFrom);
    const { documentsUpserted } = await adapter.fetchRecentBills(db, {
      jurisdiction: stateAbbr,
      updated_since: updatedSinceParam,
      updated_until: stripZ(input.updated_until),
      introduced_since: stripZ(input.introduced_since),
      introduced_until: stripZ(input.introduced_until),
      session: input.session,
      sponsor: sponsorOcd,
      classification: input.classification,
      subject: input.subject,
      sort: input.sort,
      chamber: input.chamber,
      limit: input.limit,
    });
    return { primary_rows_written: documentsUpserted };
  };

  const result = await withShapedFetch(
    db,
    {
      source: "openstates",
      endpoint_path: "/bills",
      args: {
        jurisdiction,
        days: input.days,
        chamber: input.chamber,
        session: input.session,
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
      tool: "recent_bills",
    },
    { scope: "recent", ms: 60 * 60 * 1000 },
    fetchAndWrite,
    () => projectLocal(jurisdiction),
    () => getLimiter("openstates").peekWaitMs(),
  );

  if (result.stale_notice) {
    return { ...result.value, stale_notice: result.stale_notice };
  }
  return result.value;
}

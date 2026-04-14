import type Database from "better-sqlite3";
import { queryDocuments } from "../../core/documents.js";
import { findEntityById } from "../../core/entities.js";
import type { EntityReference } from "../../core/types.js";
import { RecentBillsInput } from "../schemas.js";
import { emptyFeedDiagnostic, type EmptyFeedDiagnostic } from "../shared.js";

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
  empty_reason?: EmptyFeedDiagnostic["empty_reason"];
  data_freshness?: EmptyFeedDiagnostic["data_freshness"];
  hint?: string;
}

function buildSponsorSummary(
  db: Database.Database,
  refs: EntityReference[],
): SponsorSummary {
  const filtered = refs.filter((r) => r.role === "sponsor" || r.role === "cosponsor");
  if (filtered.length === 0) {
    return { count: 0, by_party: {}, top: [] };
  }
  // Single batched SELECT for all sponsor metadata (by_party aggregate).
  const allPlaceholders = filtered.map(() => "?").join(",");
  const allRows = db
    .prepare(`SELECT id, name, metadata FROM entities WHERE id IN (${allPlaceholders})`)
    .all(...filtered.map((r) => r.entity_id)) as Array<{ id: string; name: string; metadata: string }>;
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

  // Top-N selection: primaries first (capped at 5), then cosponsors fill the rest.
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

/**
 * Returns recently-updated bills for the given jurisdiction.
 * As of Phase 3, also accepts `jurisdiction = "us-federal"` to query
 * federal bills ingested by the Congress.gov adapter.
 *
 * Title format is always "IDENTIFIER — TITLE" — the handler splits on
 * " — " to separate `identifier` from `title` in the response.
 */
export async function handleRecentBills(
  db: Database.Database,
  rawInput: unknown,
): Promise<RecentBillsResponse> {
  const input = RecentBillsInput.parse(rawInput);
  const to = new Date();
  const from = new Date(to.getTime() - input.days * 86400 * 1000);

  const docs = input.session
    ? queryDocuments(db, {
        kind: "bill",
        jurisdiction: input.jurisdiction,
        limit: 100,
      })
    : queryDocuments(db, {
        kind: "bill",
        jurisdiction: input.jurisdiction,
        from: from.toISOString(),
        to: to.toISOString(),
        limit: 50,
      });

  const sessionFiltered = input.session
    ? docs.filter((d) => (d.raw as { session?: string }).session === input.session)
    : docs;

  const filtered = input.chamber
    ? sessionFiltered.filter((d) => {
        const sponsor = d.references.find((r) => r.role === "sponsor");
        if (!sponsor) return false;
        const ent = findEntityById(db, sponsor.entity_id);
        return ent?.metadata.chamber === input.chamber;
      })
    : sessionFiltered;

  const results: BillSummary[] = filtered.map((d) => {
    const [identifier, ...titleParts] = d.title.split(" — ");
    const actions = (d.raw.actions as Array<{ date: string; description: string }> | undefined) ?? [];
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

  // Build source URLs from each document's actual source_name —
  // openstates for state bills, congress for federal, etc. Matches
  // the pattern in get_entity.ts.
  const sourceByName = new Map<string, string>();
  for (const d of filtered) {
    if (sourceByName.has(d.source.name)) continue;
    if (d.source.name === "openstates") {
      const stateAbbr = d.jurisdiction.replace(/^us-/, "");
      const url = d.jurisdiction === "*"
        ? "https://openstates.org/"
        : `https://openstates.org/${stateAbbr}/`;
      sourceByName.set(d.source.name, url);
    } else if (d.source.name === "congress") {
      sourceByName.set(d.source.name, "https://www.congress.gov/");
    } else {
      sourceByName.set(d.source.name, "");
    }
  }

  const base: RecentBillsResponse = {
    results,
    total: results.length,
    sources: Array.from(sourceByName, ([name, url]) => ({ name, url })),
    window: { from: from.toISOString(), to: to.toISOString() },
  };
  if (results.length === 0) {
    const diag = emptyFeedDiagnostic(db, { jurisdiction: input.jurisdiction, kind: "bill" });
    return { ...base, ...diag };
  }
  return base;
}

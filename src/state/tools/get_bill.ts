import type Database from "better-sqlite3";
import { findEntityById } from "../../core/entities.js";
import { STATE_EXTERNAL_ID_PATHS } from "../entities.js";
import { ensureBillFresh } from "../hydrate_bill.js";
import { GetBillInput } from "../schemas.js";
import type { StaleNotice } from "../../core/shared.js";

export interface BillVersion {
  note: string | null;
  date: string | null;
  text_url: string | null;
  media_type: string | null;
}

export interface BillAction {
  date: string;
  description: string;
  classification?: string[];
}

export interface BillSponsor {
  entity_id: string | null;
  name: string;
  party?: string;
  classification: string;
}

export interface RelatedBill {
  identifier?: string;
  session?: string;
  relation?: string;
}

export interface BillDetail {
  id: string;
  jurisdiction: string;
  session: string;
  identifier: string;
  title: string;
  summary: string | null;
  subjects: string[];
  primary_sponsor: BillSponsor | null;
  cosponsors: BillSponsor[];
  actions: BillAction[];
  versions: BillVersion[];
  related_bills: RelatedBill[];
  latest_action: BillAction | null;
  introduced_date: string | null;
  source_url: string;
  fetched_at: string;
}

export interface GetBillResponse {
  bill: BillDetail | null;
  sources: Array<{ name: string; url: string }>;
  stale_notice?: StaleNotice;
}

interface Row {
  id: string;
  jurisdiction: string;
  title: string;
  summary: string | null;
  fetched_at: string;
  source_url: string;
  raw: string;
}

interface RawSponsorship {
  name: string;
  classification: string;
  person?: { id?: string; name?: string; party?: string };
}

interface RawShape {
  session?: string;
  actions?: BillAction[];
  subjects?: string[];
  versions?: Array<{
    note?: string;
    date?: string;
    links?: Array<{ url?: string; media_type?: string }>;
  }>;
  related_bills?: Array<{
    identifier?: string;
    legislative_session?: string;
    relation_type?: string;
  }>;
  sponsorships?: RawSponsorship[];
}

export async function handleGetBill(
  db: Database.Database,
  rawInput: unknown,
): Promise<GetBillResponse> {
  const input = GetBillInput.parse(rawInput);

  const freshness = await ensureBillFresh(db, input);

  const row = db
    .prepare(
      `SELECT id, jurisdiction, title, summary, fetched_at, source_url, raw
         FROM documents
        WHERE source_name = 'openstates' AND kind = 'bill'
          AND jurisdiction = ?
          AND title LIKE ? || ' — %'
          AND json_extract(raw, '$.session') = ?`,
    )
    .get(input.jurisdiction, input.identifier, input.session) as Row | undefined;

  const abbr = input.jurisdiction.replace(/^us-/, "");
  const sources = [
    {
      name: "openstates",
      url:
        input.jurisdiction === "us-federal"
          ? "https://www.congress.gov/"
          : `https://openstates.org/${abbr}/`,
    },
  ];

  if (!row) {
    return {
      bill: null,
      sources,
      ...(freshness.stale_notice ? { stale_notice: freshness.stale_notice } : {}),
    };
  }

  const raw = JSON.parse(row.raw) as RawShape;
  const [, ...titleParts] = row.title.split(" — ");
  const actions = raw.actions ?? [];

  const resolveSponsor = (s: RawSponsorship): BillSponsor => {
    const extId = s.person?.id;
    let entity_id: string | null = null;
    if (extId) {
      const ent = db
        .prepare(
          `SELECT id FROM entities
            WHERE json_extract(external_ids, '${STATE_EXTERNAL_ID_PATHS.openstates_person}') = ?`,
        )
        .get(extId) as { id: string } | undefined;
      entity_id = ent?.id ?? null;
    }
    const meta = entity_id ? findEntityById(db, entity_id)?.metadata : undefined;
    return {
      entity_id,
      name: s.name,
      party: s.person?.party ?? (meta?.party as string | undefined),
      classification: s.classification,
    };
  };

  const sponsorsRaw = raw.sponsorships ?? [];
  const primary = sponsorsRaw.find((s) => s.classification === "primary");
  const cosponsors = sponsorsRaw.filter((s) => s !== primary);

  const bill: BillDetail = {
    id: row.id,
    jurisdiction: row.jurisdiction,
    session: raw.session ?? input.session,
    identifier: input.identifier,
    title: titleParts.join(" — ").trim() || row.title,
    summary: row.summary,
    subjects: raw.subjects ?? [],
    primary_sponsor: primary ? resolveSponsor(primary) : null,
    cosponsors: cosponsors.map(resolveSponsor),
    actions,
    versions: (raw.versions ?? []).map((v) => ({
      note: v.note ?? null,
      date: v.date ?? null,
      text_url: v.links?.[0]?.url ?? null,
      media_type: v.links?.[0]?.media_type ?? null,
    })),
    related_bills: (raw.related_bills ?? []).map((r) => ({
      identifier: r.identifier,
      session: r.legislative_session,
      relation: r.relation_type,
    })),
    latest_action: actions.length ? actions[actions.length - 1] : null,
    introduced_date: actions[0]?.date ?? null,
    source_url: row.source_url,
    fetched_at: row.fetched_at,
  };

  return {
    bill,
    sources,
    ...(freshness.stale_notice ? { stale_notice: freshness.stale_notice } : {}),
  };
}

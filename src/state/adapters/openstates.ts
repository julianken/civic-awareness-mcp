import type Database from "better-sqlite3";
import { rateLimitedFetch, RateLimiter } from "../../util/http.js";
import { upsertEntity } from "../../core/entities.js";
import { upsertDocument } from "../../core/documents.js";
import { logger } from "../../util/logger.js";
import type { Adapter, AdapterOptions, RefreshResult } from "../../core/base.js";

const BASE_URL = "https://v3.openstates.org";

export class BillNotFoundError extends Error {
  constructor(
    public readonly jurisdiction: string,
    public readonly session: string,
    public readonly identifier: string,
  ) {
    super(`Bill ${identifier} not found in ${jurisdiction} ${session}`);
    this.name = "BillNotFoundError";
  }
}

/** "ocd-jurisdiction/country:us/state:tx/government" → "tx".
 *  OpenStates v3 `/bills?jurisdiction=tx` accepts the bare abbr, so
 *  we only need the OCD→abbr direction, not the inverse. */
function extractStateAbbr(ocdId: string | undefined): string | undefined {
  if (!ocdId) return undefined;
  const m = ocdId.match(/state:([a-z]{2})/i);
  return m ? m[1].toLowerCase() : undefined;
}

function mapSort(sort: string): string {
  switch (sort) {
    case "updated_desc":
      return "updated_desc";
    case "updated_asc":
      return "updated_asc";
    case "introduced_desc":
      return "first_action_desc";
    case "introduced_asc":
      return "first_action_asc";
    default:
      return "updated_desc";
  }
}

interface OpenStatesPerson {
  id: string;
  name: string;
  party?: string;
  current_role?: {
    title?: string;
    district?: string;
    org_classification?: string;
  };
  jurisdiction?: { id?: string };
}

interface OpenStatesSponsorship {
  name: string;
  classification: string;
  person?: OpenStatesPerson;
}

export interface OpenStatesBillVersion {
  note?: string;
  date?: string;
  links?: Array<{ url: string; media_type?: string }>;
}

export interface OpenStatesBillDocument {
  note?: string;
  date?: string;
  links?: Array<{ url: string; media_type?: string }>;
}

export interface OpenStatesRelatedBill {
  identifier?: string;
  legislative_session?: string;
  relation_type?: string;
}

export interface OpenStatesVoteCount {
  option: string;
  value: number;
}

export interface OpenStatesVoteOrganization {
  id: string;
  name: string;
  classification: string;
}

export interface OpenStatesVote {
  id: string;
  motion_text: string;
  motion_classification: string[];
  start_date: string;
  result: string;
  identifier: string;
  extras: Record<string, unknown>;
  organization: OpenStatesVoteOrganization;
  votes: unknown[];
  counts: OpenStatesVoteCount[];
  sources: Array<{ url: string; note?: string }>;
}

export interface OpenStatesBillDetail {
  id: string;
  identifier: string;
  title: string;
  session: string;
  updated_at: string;
  openstates_url: string;
  jurisdiction?: { id?: string };
  /** The originating chamber of the bill. OpenStates v3 `/bills`
   *  surfaces this as `from_organization.classification` with values
   *  "lower" | "upper". Used by `fetchRecentBills` for chamber filter. */
  from_organization?: { classification?: string };
  sponsorships?: OpenStatesSponsorship[];
  actions?: Array<{ date: string; description: string; classification?: string[] }>;
  abstracts?: Array<{ abstract: string; note?: string }>;
  subject?: string[];
  versions?: OpenStatesBillVersion[];
  documents?: OpenStatesBillDocument[];
  related_bills?: OpenStatesRelatedBill[];
  votes?: OpenStatesVote[];
}

// Alias kept for backwards compat with the existing fetchAllPages
// code path; the feed endpoint returns a subset of OpenStatesBillDetail.
type OpenStatesBill = OpenStatesBillDetail;

interface Page<T> {
  results: T[];
  pagination: { max_page: number; page: number };
}

export interface OpenStatesAdapterOptions {
  apiKey: string;
  /**
   * Token bucket rate limiter; defaults to 8 requests per 60s (under
   * the 10/min OpenStates free-tier quota). NOTE: OpenStates also
   * enforces a 500-requests-per-day cap on the free tier. Per-minute
   * pacing alone does not protect against the daily cap when we
   * iterate all 50 states; daily-cap safety is the responsibility of
   * the refresh CLI, which must be both resumable and incremental
   * (`--since=<date>`) so a multi-state run can span multiple days.
   */
  rateLimiter?: RateLimiter;
}

export class OpenStatesAdapter implements Adapter {
  readonly name = "openstates";
  private readonly rateLimiter: RateLimiter;

  constructor(private readonly opts: OpenStatesAdapterOptions) {
    this.rateLimiter =
      opts.rateLimiter ?? new RateLimiter({ tokensPerInterval: 8, intervalMs: 60_000 });
  }

  async refresh(options: AdapterOptions & { jurisdiction: string }): Promise<RefreshResult> {
    const stateAbbr = options.jurisdiction.toLowerCase();
    const result: RefreshResult = {
      source: this.name,
      entitiesUpserted: 0,
      documentsUpserted: 0,
      errors: [],
    };
    try {
      const legislators = await this.fetchAllPages<OpenStatesPerson>(
        "/people",
        { jurisdiction: stateAbbr },
        options.maxPages,
        options.deadline,
      );
      for (const p of legislators) {
        this.upsertPerson(options.db, p);
        result.entitiesUpserted += 1;
      }

      const bills = await this.fetchAllPages<OpenStatesBill>(
        "/bills",
        {
          jurisdiction: stateAbbr,
          sort: "updated_desc",
          // OpenStates v3 rejects comma-joined include values with 422;
          // the API expects include as a repeated query param.
          include: ["sponsorships", "abstracts", "actions"],
        },
        options.maxPages,
        options.deadline,
      );
      for (const b of bills) {
        this.upsertBill(options.db, b);
        result.documentsUpserted += 1;
      }
    } catch (err) {
      const msg = String(err);
      logger.error("openstates refresh failed", { error: msg, jurisdiction: stateAbbr });
      result.errors.push(msg);
    }
    return result;
  }

  /** Per-resource hydration for detail tools (R14): refresh() only
   *  covers recently-updated bills, so a bill from an earlier session
   *  must be fetched directly by (jurisdiction, session, identifier). */
  async fetchBill(
    db: Database.Database,
    opts: { jurisdiction: string; session: string; identifier: string },
  ): Promise<void> {
    const abbr = opts.jurisdiction.replace(/^us-/, "").toLowerCase();
    const path = `/bills/${abbr}/${encodeURIComponent(opts.session)}/${encodeURIComponent(opts.identifier)}`;
    const url = new URL(`${BASE_URL}${path}`);
    for (const inc of [
      "sponsorships",
      "abstracts",
      "actions",
      "versions",
      "documents",
      "sources",
      "related_bills",
    ]) {
      url.searchParams.append("include", inc);
    }
    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
      headers: { "X-API-KEY": this.opts.apiKey },
    });
    if (res.status === 404) {
      throw new BillNotFoundError(opts.jurisdiction, opts.session, opts.identifier);
    }
    if (!res.ok) {
      throw new Error(`OpenStates ${path} returned ${res.status}`);
    }
    const body = (await res.json()) as OpenStatesBillDetail;
    this.upsertBill(db, body);
  }

  /** Direct-lookup narrow fetch for R15 `get_entity` — resolves one
   *  Person by its OpenStates OCD ID via `/people/{ocd-id}`. Returns
   *  `entitiesUpserted: 0` on 404 so the handler can fan out across
   *  sources without worrying about which ones carry this entity. */
  async fetchPerson(db: Database.Database, ocdId: string): Promise<{ entitiesUpserted: number }> {
    const url = `${BASE_URL}/people/${encodeURIComponent(ocdId)}`;
    const res = await rateLimitedFetch(url, {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
      headers: { "X-API-KEY": this.opts.apiKey },
    });
    if (res.status === 404) return { entitiesUpserted: 0 };
    if (!res.ok) throw new Error(`OpenStates /people/${ocdId} returned ${res.status}`);
    const body = (await res.json()) as OpenStatesPerson;
    this.upsertPerson(db, body);
    return { entitiesUpserted: 1 };
  }

  /** Narrow per-tool fetch for R15 people search — one page of
   *  `/people` filtered by jurisdiction and/or name. Writes through to
   *  `entities` via `upsertPerson`. Shared endpoint with
   *  `resolve_person` / `search_entities` so cache rows coalesce. */
  async searchPeople(
    db: Database.Database,
    opts: { jurisdiction?: string; name?: string; limit?: number },
  ): Promise<{ entitiesUpserted: number }> {
    const url = new URL(`${BASE_URL}/people`);
    if (opts.jurisdiction) {
      const abbr = opts.jurisdiction.replace(/^us-/, "").toLowerCase();
      url.searchParams.set("jurisdiction", abbr);
    }
    if (opts.name) url.searchParams.set("name", opts.name);
    url.searchParams.set("per_page", String(opts.limit ?? 20));

    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
      headers: { "X-API-KEY": this.opts.apiKey },
    });
    if (!res.ok) throw new Error(`OpenStates /people returned ${res.status}`);
    const body = (await res.json()) as { results?: OpenStatesPerson[] };
    let entitiesUpserted = 0;
    for (const p of body.results ?? []) {
      this.upsertPerson(db, p);
      entitiesUpserted += 1;
    }
    return { entitiesUpserted };
  }

  /** Narrow per-tool fetch for R15 `entity_connections` — one page of
   *  bills sponsored by a given OpenStates person (OCD ID). Writes
   *  through to `documents` via `upsertBill` so results land where
   *  `findConnections` reads. OpenStates v3 `/bills?sponsor=` accepts
   *  the OCD person ID directly; no two-step lookup is needed. */
  async fetchBillsBySponsor(
    db: Database.Database,
    opts: { sponsor: string; jurisdiction: string; limit?: number },
  ): Promise<{ documentsUpserted: number }> {
    const url = new URL(`${BASE_URL}/bills`);
    url.searchParams.set("jurisdiction", opts.jurisdiction);
    url.searchParams.set("sponsor", opts.sponsor);
    url.searchParams.set("sort", "updated_desc");
    url.searchParams.set("per_page", String(opts.limit ?? 20));
    for (const inc of ["sponsorships", "abstracts", "actions"]) {
      url.searchParams.append("include", inc);
    }
    return this.fetchAndUpsertBillsFromUrl(db, url, {
      target: opts.limit,
    });
  }

  /** Narrow per-tool fetch for R15 `recent_bills` — one page of
   *  recently-updated bills for a jurisdiction, with optional
   *  `updated_since` filter, optional chamber filter, and optional
   *  row `limit` (1..20, mapped to OpenStates `per_page`). Writes
   *  through to `documents` via `upsertBill`. Returns telemetry
   *  count for `withShapedFetch`'s primary_rows_written contract. */
  async fetchRecentBills(
    db: Database.Database,
    opts: {
      jurisdiction: string;
      updated_since?: string;
      chamber?: "upper" | "lower";
      limit?: number;
    },
  ): Promise<{ documentsUpserted: number }> {
    const abbr = opts.jurisdiction.replace(/^us-/, "").toLowerCase();
    const url = new URL(`${BASE_URL}/bills`);
    url.searchParams.set("jurisdiction", abbr);
    url.searchParams.set("sort", "updated_desc");
    url.searchParams.set("per_page", String(opts.limit ?? 20));
    if (opts.updated_since) url.searchParams.set("updated_since", opts.updated_since);
    for (const inc of ["sponsorships", "abstracts", "actions"]) {
      url.searchParams.append("include", inc);
    }
    return this.fetchAndUpsertBillsFromUrl(db, url, {
      chamber: opts.chamber,
      target: opts.limit,
    });
  }

  /** Narrow per-tool fetch for R15 `list_bills` — one page of bills
   *  matching a set of structured predicates (session, chamber,
   *  sponsor, classification, subject, date windows). Writes through
   *  to `documents` via `upsertBill`. Uses distinct endpoint_path
   *  `/bills/list` in the shaped-fetch key so cache rows never
   *  collide with `recent_bills` (endpoint_path `/bills`). Note that
   *  OpenStates itself exposes only one `/bills` endpoint — the
   *  `/list` suffix is a cache-key discriminator, not a path the
   *  upstream sees. */
  async listBills(
    db: Database.Database,
    opts: {
      jurisdiction: string;
      session?: string;
      chamber?: "upper" | "lower";
      sponsor?: string;
      classification?: string;
      subject?: string;
      introduced_since?: string;
      introduced_until?: string;
      updated_since?: string;
      updated_until?: string;
      sort: "updated_desc" | "updated_asc" | "introduced_desc" | "introduced_asc";
      limit: number;
    },
  ): Promise<{ documentsUpserted: number }> {
    const abbr = opts.jurisdiction.replace(/^us-/, "").toLowerCase();
    const url = new URL(`${BASE_URL}/bills`);
    url.searchParams.set("jurisdiction", abbr);
    url.searchParams.set("sort", mapSort(opts.sort));
    url.searchParams.set("per_page", String(opts.limit));
    if (opts.session) url.searchParams.set("session", opts.session);
    if (opts.sponsor) url.searchParams.set("sponsor", opts.sponsor);
    if (opts.classification) url.searchParams.set("classification", opts.classification);
    if (opts.subject) url.searchParams.set("subject", opts.subject);
    if (opts.introduced_since) url.searchParams.set("created_since", opts.introduced_since);
    if (opts.introduced_until) url.searchParams.set("created_before", opts.introduced_until);
    if (opts.updated_since) url.searchParams.set("updated_since", opts.updated_since);
    if (opts.updated_until) url.searchParams.set("updated_before", opts.updated_until);
    for (const inc of ["sponsorships", "abstracts", "actions"]) {
      url.searchParams.append("include", inc);
    }
    // chamber is filtered client-side on from_organization.classification
    // to match fetchRecentBills semantics — OpenStates v3 `/bills` does not
    // filter by origin chamber server-side.
    return this.fetchAndUpsertBillsFromUrl(db, url, {
      chamber: opts.chamber,
      target: opts.limit,
    });
  }

  /** Narrow per-tool fetch for R15 `recent_votes` — fetches recently-updated
   *  bills with `include=votes` and flat-maps embedded vote arrays into
   *  `documents` rows (kind="vote"). OpenStates v3 has no standalone votes
   *  feed; this is the approved approach per the upstream research notes. */
  async fetchRecentVotes(
    db: Database.Database,
    opts: {
      jurisdiction: string;
      updated_since?: string;
      limit?: number;
    },
  ): Promise<{ documentsUpserted: number }> {
    const abbr = opts.jurisdiction.replace(/^us-/, "").toLowerCase();
    const url = new URL(`${BASE_URL}/bills`);
    url.searchParams.set("jurisdiction", abbr);
    url.searchParams.set("sort", "updated_desc");
    url.searchParams.set("per_page", String(Math.min(opts.limit ?? 20, 20)));
    if (opts.updated_since) url.searchParams.set("updated_since", opts.updated_since);
    url.searchParams.append("include", "votes");

    url.searchParams.set("page", "1");
    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
      headers: { "X-API-KEY": this.opts.apiKey },
    });
    if (!res.ok) throw new Error(`OpenStates /bills (include=votes) returned ${res.status}`);
    const body = (await res.json()) as {
      results?: OpenStatesBillDetail[];
      pagination?: { max_page?: number; page?: number };
    };

    let documentsUpserted = 0;
    for (const bill of body.results ?? []) {
      const votes = bill.votes ?? [];
      if (votes.length === 0) continue;

      // Ensure the parent bill document exists before writing votes.
      this.upsertBill(db, bill);

      for (const vote of votes) {
        this.upsertVote(db, bill, vote);
        documentsUpserted += 1;
      }
    }
    return { documentsUpserted };
  }

  private upsertVote(
    db: Database.Database,
    bill: OpenStatesBillDetail,
    vote: OpenStatesVote,
  ): void {
    const billStateAbbr = extractStateAbbr(bill.jurisdiction?.id);
    if (!billStateAbbr) {
      logger.warn("openstates vote: parent bill missing jurisdiction — skipping", {
        endpoint: "upsertVote",
        voteId: vote.id,
        billId: bill.id,
      });
      return;
    }
    const jurisdiction = `us-${billStateAbbr}`;
    const sourceUrl = vote.sources[0]?.url ?? bill.openstates_url;

    // Bill reference is stored in raw.bill (not via document_references,
    // which only links documents to entities, not documents to documents).
    upsertDocument(db, {
      kind: "vote",
      jurisdiction,
      title: `${bill.identifier} — ${vote.motion_text}`,
      occurred_at: vote.start_date,
      source: { name: "openstates", id: vote.id, url: sourceUrl },
      raw: {
        chamber: vote.organization.classification,
        result: vote.result,
        motion_text: vote.motion_text,
        motion_classification: vote.motion_classification,
        counts: vote.counts,
        extras: vote.extras,
        bill: {
          id: bill.id,
          identifier: bill.identifier,
          session: bill.session,
          openstates_url: bill.openstates_url,
        },
      },
    });
  }

  /** Shared fetch + write-through loop for the three /bills-shaped
   *  adapter methods. When `target` is set and > 20, loops pages of
   *  per_page=20 until accumulated upserts >= target or the
   *  upstream's pagination.max_page terminates. Does NOT truncate to
   *  exactly `target` — extras land in the local DB cache for future
   *  hits; the handler's local projection enforces the final cap. */
  private async fetchAndUpsertBillsFromUrl(
    db: Database.Database,
    url: URL,
    opts?: { chamber?: "upper" | "lower"; target?: number },
  ): Promise<{ documentsUpserted: number }> {
    const target = opts?.target;
    if (target !== undefined && target > 20) {
      url.searchParams.set("per_page", "20");
    }
    let documentsUpserted = 0;
    let page = 1;
    while (true) {
      url.searchParams.set("page", String(page));
      const res = await rateLimitedFetch(url.toString(), {
        userAgent: "civic-awareness-mcp/0.1.0 (+github)",
        rateLimiter: this.rateLimiter,
        headers: { "X-API-KEY": this.opts.apiKey },
      });
      if (!res.ok) throw new Error(`OpenStates ${url.pathname} returned ${res.status}`);
      const body = (await res.json()) as {
        results?: OpenStatesBill[];
        pagination?: { max_page?: number; page?: number };
      };
      for (const b of body.results ?? []) {
        if (opts?.chamber) {
          const classification = b.from_organization?.classification;
          if (classification && classification !== opts.chamber) {
            logger.debug("openstates chamber filter: skipping bill", {
              billId: b.id,
              identifier: b.identifier,
              from_organization: classification,
              requested: opts.chamber,
            });
            continue;
          }
        }
        try {
          this.upsertBill(db, b);
        } catch (err) {
          logger.warn("openstates upsertBill threw — skipping record", {
            endpoint: "fetchAndUpsertBillsFromUrl",
            billId: b.id,
            identifier: b.identifier,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        documentsUpserted += 1;
      }
      if (target === undefined || target <= 20) break;
      if (documentsUpserted >= target) break;
      const maxPage = body.pagination?.max_page ?? page;
      if (page >= maxPage) break;
      page += 1;
    }
    return { documentsUpserted };
  }

  private async fetchAllPages<T>(
    path: string,
    params: Record<string, string | string[]>,
    maxPages: number | undefined,
    deadline: number | undefined,
  ): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    while (true) {
      if (deadline !== undefined && Date.now() >= deadline) break;
      const url = new URL(`${BASE_URL}${path}`);
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, item);
        } else {
          url.searchParams.set(k, v);
        }
      }
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", "20");

      const res = await rateLimitedFetch(url.toString(), {
        userAgent: "civic-awareness-mcp/0.1.0 (+github)",
        rateLimiter: this.rateLimiter,
        headers: { "X-API-KEY": this.opts.apiKey },
      });
      if (!res.ok) throw new Error(`OpenStates ${path} returned ${res.status}`);
      const body = (await res.json()) as Page<T>;
      all.push(...body.results);
      if (page >= body.pagination.max_page) break;
      if (maxPages && page >= maxPages) break;
      page += 1;
    }
    return all;
  }

  private upsertPerson(
    db: Database.Database,
    p: OpenStatesPerson,
    fallbackStateAbbr?: string,
  ): string {
    const chamber = p.current_role?.org_classification;
    const stateAbbr = extractStateAbbr(p.jurisdiction?.id) ?? fallbackStateAbbr;
    const now = new Date().toISOString();
    const roles = stateAbbr
      ? [
          {
            jurisdiction: `us-${stateAbbr}`,
            role: "state_legislator",
            from: now,
            to: null as string | null,
          },
        ]
      : [];
    const { entity } = upsertEntity(db, {
      kind: "person",
      name: p.name,
      jurisdiction: undefined,
      external_ids: { openstates_person: p.id },
      metadata: {
        party: p.party,
        title: p.current_role?.title,
        district: p.current_role?.district,
        chamber,
        roles,
      },
    });
    return entity.id;
  }

  private upsertBill(db: Database.Database, b: OpenStatesBillDetail): void {
    const billStateAbbr =
      extractStateAbbr(b.jurisdiction?.id) ??
      extractStateAbbr(b.sponsorships?.[0]?.person?.jurisdiction?.id);
    if (!billStateAbbr) {
      // R15: a single malformed record must not abort the
      // surrounding write-through transaction (which would lose every
      // sibling bill in the same batch). Log and skip.
      logger.warn("openstates bill missing jurisdiction — skipping record", {
        endpoint: "upsertBill",
        billId: b.id,
        identifier: b.identifier,
      });
      return;
    }
    const billJurisdiction = `us-${billStateAbbr}`;

    const refs = (b.sponsorships ?? []).map((s) => {
      const personId = s.person
        ? this.upsertPerson(db, s.person, billStateAbbr)
        : upsertEntity(db, { kind: "person", name: s.name, jurisdiction: undefined }).entity.id;
      return {
        entity_id: personId,
        // CA uses "author" for primary sponsor; treat both as "sponsor".
        role: (s.classification === "primary" || s.classification === "author"
          ? "sponsor"
          : "cosponsor") as "sponsor" | "cosponsor",
      };
    });

    const summary = b.abstracts?.[0]?.abstract;
    upsertDocument(db, {
      kind: "bill",
      jurisdiction: billJurisdiction,
      title: `${b.identifier} — ${b.title}`,
      summary,
      occurred_at: b.actions?.at(-1)?.date ?? b.updated_at,
      source: { name: "openstates", id: b.id, url: b.openstates_url },
      references: refs,
      raw: {
        session: b.session,
        from_organization: b.from_organization,
        actions: b.actions ?? [],
        abstracts: b.abstracts ?? [],
        subjects: b.subject ?? [],
        versions: b.versions ?? [],
        documents: b.documents ?? [],
        related_bills: b.related_bills ?? [],
        sponsorships: b.sponsorships ?? [],
      },
    });
  }
}

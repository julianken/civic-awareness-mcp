import type Database from "better-sqlite3";
import { rateLimitedFetch, RateLimiter } from "../util/http.js";
import { upsertEntity } from "../core/entities.js";
import { upsertDocument } from "../core/documents.js";
import { logger } from "../util/logger.js";
import type { Adapter, AdapterOptions, RefreshResult } from "./base.js";

const BASE_URL = "https://api.open.fec.gov/v1";

// ── API types (minimal — only fields we use) ─────────────────────────

interface FecPrincipalCommittee {
  committee_id: string;
  name: string;
}

interface FecCandidate {
  candidate_id: string;
  name: string;           // ALL CAPS, e.g. "SMITH, JOHN R."
  office: string;         // "H" | "S" | "P"
  state?: string;
  district?: string | null;
  party?: string;
  election_years?: number[];
  principal_committees?: FecPrincipalCommittee[];
}

interface FecCommittee {
  committee_id: string;
  name: string;
  committee_type?: string;
  committee_type_full?: string;
  state?: string;
  party?: string;
  candidate_ids?: string[];
}

interface FecScheduleA {
  transaction_id: string;
  committee_id: string;
  contributor_name?: string;
  contributor_city?: string;
  contributor_state?: string;
  contributor_zip?: string;
  contributor_employer?: string;
  contributor_occupation?: string;
  contribution_receipt_amount?: number;
  contribution_receipt_date?: string;
  memo_text?: string | null;
  line_number?: string;
}

interface FecScheduleB {
  transaction_id: string;
  committee_id: string;
  recipient_name?: string;
  recipient_city?: string;
  recipient_state?: string;
  disbursement_amount?: number;
  disbursement_date?: string;
  disbursement_description?: string;
}

interface FecPagination {
  count?: number;
  per_page?: number;
  page?: number;
  pages?: number;
  last_indexes?: {
    last_index?: string;
    last_contribution_receipt_date?: string;
    last_disbursement_date?: string;
  };
}

interface FecPage<T> {
  results?: T[];
  pagination?: FecPagination;
}

export interface OpenFecAdapterOptions {
  apiKey: string;
  /**
   * Which two-year election cycles to fetch. Defaults to [2026, 2024]
   * per the Phase 4 load-bearing sub-decision (current + prior;
   * full history deferred).
   */
  cycles?: number[];
  rateLimiter?: RateLimiter;
}

// ── Normalisation helpers ─────────────────────────────────────────────

/**
 * Convert an FEC office code to a human-readable role string used in
 * metadata.roles[]. Distinct roles per office so that downstream
 * tools can filter "all federal House candidates" vs "all Senate
 * candidates" without re-parsing raw data.
 */
function officeToRole(office: string): string {
  if (office === "H") return "federal_candidate_representative";
  if (office === "S") return "federal_candidate_senator";
  if (office === "P") return "federal_candidate_president";
  return "federal_candidate";
}

/**
 * Map FEC committee_type to our EntityKind. The FEC uses a large set of
 * single-letter codes; we collapse to three buckets:
 * - "H", "S", "P" principal campaign committees → "pac" (candidacy-linked)
 * - "Q", "N" PACs → "pac"
 * - Everything else → "organization"
 */
function committeeKind(type: string): "pac" | "organization" {
  const pac = new Set(["H", "S", "P", "Q", "N", "O", "V", "W"]);
  return pac.has(type.toUpperCase()) ? "pac" : "organization";
}

/** Convert an FEC ALL-CAPS name to Title Case for canonical storage.
 *
 * FEC names arrive as "SMITH, JOHN R." — we Title-Case them so that the
 * normalized form produced by normalizeName() matches Congress.gov's
 * "Smith, John R." (also normalized to "smith john r"). This is the
 * critical step that allows step-3 exact-name matching across sources.
 */
function titleCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Build the human-facing FEC committee URL. */
function committeeUrl(committeeId: string): string {
  return `https://www.fec.gov/data/committee/${committeeId}/`;
}

// ── Adapter ───────────────────────────────────────────────────────────

export class OpenFecAdapter implements Adapter {
  readonly name = "openfec";
  private readonly rateLimiter: RateLimiter;
  private readonly cycles: number[];

  constructor(private readonly opts: OpenFecAdapterOptions) {
    this.rateLimiter =
      opts.rateLimiter ??
      new RateLimiter({ tokensPerInterval: 15, intervalMs: 60_000 });
    this.cycles = opts.cycles ?? [2026, 2024];
  }

  /**
   * Refresh federal campaign finance data from api.open.fec.gov.
   *
   * Order: candidates → committees → schedule_a → schedule_b.
   * Candidates are fetched first so that schedule_a contributions can
   * reference them as recipient committee owners. Committees are fetched
   * second so that contribution Documents have a committee Entity to
   * reference as the recipient.
   */
  async refresh(options: AdapterOptions): Promise<RefreshResult> {
    const result: RefreshResult = {
      source: this.name,
      entitiesUpserted: 0,
      documentsUpserted: 0,
      errors: [],
    };

    try {
      for (const cycle of this.cycles) {
        // 1. Candidates.
        const candidates = await this.fetchPages<FecCandidate>(
          `/candidates/search?election_year=${cycle}&candidate_status=C&per_page=100`,
          options.maxPages,
          options.deadline,
        );
        for (const c of candidates) {
          this.upsertCandidate(options.db, c, cycle);
          result.entitiesUpserted += 1;
        }

        // 2. Committees.
        const committees = await this.fetchPages<FecCommittee>(
          `/committees?cycle=${cycle}&per_page=100`,
          options.maxPages,
          options.deadline,
        );
        for (const c of committees) {
          this.upsertCommittee(options.db, c);
          result.entitiesUpserted += 1;
        }

        // 3. Schedule A (itemized contributions).
        const contribs = await this.fetchSchedule<FecScheduleA>(
          `/schedules/schedule_a?two_year_transaction_period=${cycle}&per_page=100`,
          "last_contribution_receipt_date",
          options.maxPages,
          options.deadline,
        );
        for (const item of contribs) {
          this.upsertContribution(options.db, item);
          result.documentsUpserted += 1;
        }

        // 4. Schedule B (disbursements).
        const disb = await this.fetchSchedule<FecScheduleB>(
          `/schedules/schedule_b?two_year_transaction_period=${cycle}&per_page=100`,
          "last_disbursement_date",
          options.maxPages,
          options.deadline,
        );
        for (const item of disb) {
          this.upsertExpenditure(options.db, item);
          result.documentsUpserted += 1;
        }
      }
    } catch (err) {
      const msg = String(err);
      logger.error("openfec refresh failed", { error: msg });
      result.errors.push(msg);
    }

    return result;
  }

  /**
   * Narrow per-tool fetch for R15 candidate search — one page of
   * `/candidates/search` filtered by the `q` (name) parameter. Writes
   * through to `entities` via `upsertCandidate`. Shared endpoint with
   * `search_entities` / `resolve_person` so cache rows coalesce.
   */
  async searchCandidates(
    db: Database.Database,
    opts: { q: string; limit?: number },
  ): Promise<{ entitiesUpserted: number }> {
    const url = new URL(`${BASE_URL}/candidates/search/`);
    url.searchParams.set("q", opts.q);
    url.searchParams.set("per_page", String(opts.limit ?? 20));
    url.searchParams.set("api_key", this.opts.apiKey);

    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
    });
    if (!res.ok) {
      throw new Error(`OpenFEC /candidates/search returned ${res.status}`);
    }
    const body = (await res.json()) as { results?: FecCandidate[] };
    let entitiesUpserted = 0;
    const cycle = this.cycles[0];
    for (const c of body.results ?? []) {
      this.upsertCandidate(db, c, cycle);
      entitiesUpserted += 1;
    }
    return { entitiesUpserted };
  }

  /**
   * Narrow per-tool fetch for R15 `recent_contributions` — one page of
   * Schedule A using OpenFEC's native `min_date`/`max_date` filters
   * (MM/DD/YYYY format) with optional repeated `committee_id` query
   * params. Caveat: OpenFEC's date filters operate on REPORTING date
   * (form filing), not contribution-receipt date — documented in D3d
   * / docs/03-data-sources.md.
   */
  async fetchRecentContributions(
    db: Database.Database,
    opts: {
      min_date: string;
      max_date?: string;
      committee_ids?: string[];
      limit?: number;
    },
  ): Promise<{ documentsUpserted: number }> {
    const url = new URL(`${BASE_URL}/schedules/schedule_a/`);
    url.searchParams.set("min_date", opts.min_date);
    if (opts.max_date) url.searchParams.set("max_date", opts.max_date);
    for (const id of opts.committee_ids ?? []) {
      url.searchParams.append("committee_id", id);
    }
    url.searchParams.set("per_page", String(opts.limit ?? 100));
    url.searchParams.set("sort", "-contribution_receipt_date");
    url.searchParams.set("api_key", this.opts.apiKey);

    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
    });
    if (!res.ok) {
      throw new Error(`OpenFEC /schedules/schedule_a returned ${res.status}`);
    }
    const body = (await res.json()) as FecPage<FecScheduleA>;

    let documentsUpserted = 0;
    for (const item of body.results ?? []) {
      this.upsertContribution(db, item);
      documentsUpserted += 1;
    }
    return { documentsUpserted };
  }

  // ── Private helpers ────────────────────────────────────────────────

  /**
   * Standard page-number pagination (used by /candidates/search and
   * /committees). Stops when page >= pages or results < per_page.
   */
  private async fetchPages<T>(
    firstPath: string,
    maxPages: number | undefined,
    deadline: number | undefined,
  ): Promise<T[]> {
    const all: T[] = [];
    let page = 1;

    while (true) {
      if (deadline !== undefined && Date.now() >= deadline) break;
      const sep = firstPath.includes("?") ? "&" : "?";
      const url = new URL(`${BASE_URL}${firstPath}${sep}page=${page}&api_key=${this.opts.apiKey}`);

      const res = await rateLimitedFetch(url.toString(), {
        userAgent: "civic-awareness-mcp/0.1.0 (+github)",
        rateLimiter: this.rateLimiter,
      });
      if (!res.ok) throw new Error(`OpenFEC ${firstPath} returned ${res.status}`);
      const body = (await res.json()) as FecPage<T>;
      const results = body.results ?? [];
      all.push(...results);

      const pages = body.pagination?.pages ?? 1;
      if (page >= pages || results.length < (body.pagination?.per_page ?? 100)) break;
      if (maxPages && page >= maxPages) break;
      page += 1;
    }

    return all;
  }

  /**
   * Cursor-based pagination for Schedule A and Schedule B. OpenFEC uses
   * `last_index` + a date cursor key instead of page numbers for these
   * high-volume endpoints. Pass `cursorDateKey` as the field name in
   * `last_indexes` that carries the date component of the cursor.
   */
  private async fetchSchedule<T>(
    firstPath: string,
    cursorDateKey: "last_contribution_receipt_date" | "last_disbursement_date",
    maxPages: number | undefined,
    deadline: number | undefined,
  ): Promise<T[]> {
    const all: T[] = [];
    let path = firstPath;
    let pageCount = 0;

    while (true) {
      if (deadline !== undefined && Date.now() >= deadline) break;
      const sep = path.includes("?") ? "&" : "?";
      const url = new URL(`${BASE_URL}${path}${sep}api_key=${this.opts.apiKey}`);

      const res = await rateLimitedFetch(url.toString(), {
        userAgent: "civic-awareness-mcp/0.1.0 (+github)",
        rateLimiter: this.rateLimiter,
      });
      if (!res.ok) throw new Error(`OpenFEC ${firstPath} returned ${res.status}`);
      const body = (await res.json()) as FecPage<T>;
      const results = body.results ?? [];
      all.push(...results);
      pageCount += 1;

      const lastIndexes = body.pagination?.last_indexes;
      const perPage = body.pagination?.per_page ?? 100;

      // No more pages if fewer results than page size, or no cursor.
      if (
        results.length < perPage ||
        !lastIndexes?.last_index ||
        !lastIndexes?.[cursorDateKey]
      ) {
        break;
      }
      if (maxPages && pageCount >= maxPages) break;

      // Build next cursor path.
      const sep2 = firstPath.includes("?") ? "&" : "?";
      path = `${firstPath}${sep2}last_index=${encodeURIComponent(lastIndexes.last_index)}&${cursorDateKey}=${encodeURIComponent(lastIndexes[cursorDateKey]!)}`;
    }

    return all;
  }

  private upsertCandidate(
    db: Database.Database,
    c: FecCandidate,
    cycle: number,
  ): string {
    const canonicalName = titleCase(c.name);
    const role = officeToRole(c.office);

    const newRole = {
      jurisdiction: "us-federal",
      role,
      from: `${cycle - 1}-01-01T00:00:00.000Z`,
      to: null as string | null,
    };

    const { entity } = upsertEntity(db, {
      kind: "person",
      name: canonicalName,
      jurisdiction: undefined,  // D3b: Persons are cross-jurisdiction
      external_ids: { fec_candidate: c.candidate_id },
      metadata: {
        party: c.party,
        state: c.state,
        office: c.office,
        roles: [newRole],
      },
    });

    return entity.id;
  }

  private upsertCommittee(db: Database.Database, c: FecCommittee): string {
    const kind = committeeKind(c.committee_type ?? "");

    const { entity } = upsertEntity(db, {
      kind,
      name: c.name,
      jurisdiction: "us-federal",
      external_ids: { fec_committee: c.committee_id },
      metadata: {
        committee_type: c.committee_type,
        committee_type_full: c.committee_type_full,
        state: c.state,
        party: c.party,
        candidate_ids: c.candidate_ids ?? [],
      },
    });

    return entity.id;
  }

  private upsertContribution(db: Database.Database, item: FecScheduleA): void {
    if (!item.contribution_receipt_date || !item.contribution_receipt_amount) {
      // Skip malformed rows.
      return;
    }

    // Resolve the recipient committee entity by fec_committee external_id.
    const recipientRow = db
      .prepare(
        "SELECT id FROM entities WHERE json_extract(external_ids, '$.\"fec_committee\"') = ? LIMIT 1",
      )
      .get(item.committee_id) as { id: string } | undefined;

    let recipientId: string;
    if (recipientRow) {
      recipientId = recipientRow.id;
    } else {
      // Committee not yet in store (rare if fetch order is correct).
      // Create a minimal placeholder.
      const { entity } = upsertEntity(db, {
        kind: "pac",
        name: `Committee ${item.committee_id}`,
        jurisdiction: "us-federal",
        external_ids: { fec_committee: item.committee_id },
      });
      recipientId = entity.id;
    }

    // Resolve (or create) the contributor Person entity.
    // No fuzzy matching per D3b — exact normalized-name or create new.
    const contributorName = item.contributor_name
      ? titleCase(item.contributor_name)
      : "Unknown Contributor";
    const { entity: contributor } = upsertEntity(db, {
      kind: "person",
      name: contributorName,
      jurisdiction: undefined,
    });

    const title = `Contribution: ${contributorName} → ${item.committee_id} ($${item.contribution_receipt_amount.toFixed(2)})`;

    upsertDocument(db, {
      kind: "contribution",
      jurisdiction: "us-federal",
      title,
      occurred_at: item.contribution_receipt_date,
      source: {
        name: "openfec",
        id: item.transaction_id,
        url: committeeUrl(item.committee_id),
      },
      references: [
        { entity_id: contributor.id, role: "contributor" as const },
        { entity_id: recipientId, role: "recipient" as const },
      ],
      raw: {
        // Full FEC line item stored for aggregate queries.
        // Address fields are stored here but never exposed by tools.
        transaction_id: item.transaction_id,
        amount: item.contribution_receipt_amount,
        date: item.contribution_receipt_date,
        contributor_name: contributorName,
        contributor_city: item.contributor_city,
        contributor_state: item.contributor_state,
        contributor_zip: item.contributor_zip,
        contributor_employer: item.contributor_employer,
        contributor_occupation: item.contributor_occupation,
        committee_id: item.committee_id,
        line_number: item.line_number,
        memo_text: item.memo_text ?? null,
      },
    });
  }

  private upsertExpenditure(db: Database.Database, item: FecScheduleB): void {
    if (!item.disbursement_date || !item.disbursement_amount) {
      return;
    }

    // The spender is the committee that filed Schedule B.
    const spenderRow = db
      .prepare(
        "SELECT id FROM entities WHERE json_extract(external_ids, '$.\"fec_committee\"') = ? LIMIT 1",
      )
      .get(item.committee_id) as { id: string } | undefined;

    let spenderId: string;
    if (spenderRow) {
      spenderId = spenderRow.id;
    } else {
      const { entity } = upsertEntity(db, {
        kind: "pac",
        name: `Committee ${item.committee_id}`,
        jurisdiction: "us-federal",
        external_ids: { fec_committee: item.committee_id },
      });
      spenderId = entity.id;
    }

    // Recipient is the payee — often a vendor, not a Person.
    const recipientName = item.recipient_name ?? "Unknown Recipient";
    const { entity: recipient } = upsertEntity(db, {
      kind: "organization",
      name: recipientName,
      jurisdiction: "us-federal",
    });

    const title = `Expenditure: ${item.committee_id} → ${recipientName} ($${item.disbursement_amount.toFixed(2)})`;

    upsertDocument(db, {
      kind: "expenditure",
      jurisdiction: "us-federal",
      title,
      occurred_at: item.disbursement_date,
      source: {
        name: "openfec",
        id: item.transaction_id,
        url: committeeUrl(item.committee_id),
      },
      references: [
        { entity_id: spenderId, role: "contributor" as const },
        { entity_id: recipient.id, role: "recipient" as const },
      ],
      raw: {
        transaction_id: item.transaction_id,
        amount: item.disbursement_amount,
        date: item.disbursement_date,
        committee_id: item.committee_id,
        recipient_name: recipientName,
        recipient_city: item.recipient_city,
        recipient_state: item.recipient_state,
        disbursement_description: item.disbursement_description,
      },
    });
  }
}

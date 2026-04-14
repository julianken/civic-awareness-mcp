import type Database from "better-sqlite3";
import { rateLimitedFetch, RateLimiter } from "../util/http.js";
import { upsertEntity } from "../core/entities.js";
import { upsertDocument } from "../core/documents.js";
import { logger } from "../util/logger.js";
import type { Adapter, AdapterOptions, RefreshResult } from "./base.js";

const BASE_URL = "https://v3.openstates.org";

/** "ocd-jurisdiction/country:us/state:tx/government" → "tx".
 *  OpenStates v3 `/bills?jurisdiction=tx` accepts the bare abbr, so
 *  we only need the OCD→abbr direction, not the inverse. */
function extractStateAbbr(ocdId: string | undefined): string | undefined {
  if (!ocdId) return undefined;
  const m = ocdId.match(/state:([a-z]{2})/i);
  return m ? m[1].toLowerCase() : undefined;
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

interface OpenStatesBill {
  id: string;
  identifier: string;
  title: string;
  session: string;
  updated_at: string;
  openstates_url: string;
  jurisdiction?: { id?: string };
  sponsorships?: OpenStatesSponsorship[];
  actions?: Array<{ date: string; description: string }>;
  abstracts?: Array<{ abstract: string }>;
}

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
    this.rateLimiter = opts.rateLimiter
      ?? new RateLimiter({ tokensPerInterval: 8, intervalMs: 60_000 });
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

  private async fetchAllPages<T>(
    path: string,
    params: Record<string, string | string[]>,
    maxPages: number | undefined,
  ): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    while (true) {
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

  private upsertPerson(db: Database.Database, p: OpenStatesPerson): string {
    const chamber = p.current_role?.org_classification;
    const stateAbbr = extractStateAbbr(p.jurisdiction?.id);
    const now = new Date().toISOString();
    const roles = stateAbbr
      ? [{
          jurisdiction: `us-${stateAbbr}`,
          role: "state_legislator",
          from: now,
          to: null as string | null,
        }]
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

  private upsertBill(db: Database.Database, b: OpenStatesBill): void {
    const billStateAbbr =
      extractStateAbbr((b as { jurisdiction?: { id?: string } }).jurisdiction?.id)
      ?? extractStateAbbr(b.sponsorships?.[0]?.person?.jurisdiction?.id);
    if (!billStateAbbr) {
      throw new Error(`Cannot determine state for bill ${b.id}`);
    }
    const billJurisdiction = `us-${billStateAbbr}`;

    const refs = (b.sponsorships ?? []).map((s) => {
      const personId = s.person
        ? this.upsertPerson(db, s.person)
        : upsertEntity(db, { kind: "person", name: s.name, jurisdiction: undefined }).entity.id;
      return {
        entity_id: personId,
        role: (s.classification === "primary" ? "sponsor" : "cosponsor") as
          | "sponsor" | "cosponsor",
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
      raw: { session: b.session, actions: b.actions ?? [] },
    });
  }
}

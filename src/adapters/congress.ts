import type Database from "better-sqlite3";
import { rateLimitedFetch, RateLimiter } from "../util/http.js";
import { upsertEntity } from "../core/entities.js";
import { upsertDocument } from "../core/documents.js";
import { logger } from "../util/logger.js";
import type { Adapter, AdapterOptions, RefreshResult } from "./base.js";

const BASE_URL = "https://api.congress.gov/v3";

// ── API types (minimal — only fields we use) ─────────────────────────

interface CongressMember {
  bioguideId: string;
  name: string;
  partyName?: string;
  state?: string;
  district?: number | null;
  terms?: { item?: Array<{ chamber: string; startYear?: number; endYear?: number | null }> };
}

interface CongressSponsor {
  bioguideId?: string;
  fullName?: string;
}

interface CongressBill {
  congress: number;
  type: string;
  number: string;
  title: string;
  introducedDate?: string;
  updateDate?: string;
  url: string;
  sponsors?: CongressSponsor[];
  latestAction?: { actionDate?: string; text?: string };
}

interface CongressVotePosition {
  member: { bioguideId: string; name: string };
  votePosition: string;  // "Yea" | "Nay" | "Present" | "Not Voting"
}

interface CongressVote {
  congress: number;
  chamber: string;
  rollNumber: number;
  date: string;
  question?: string;
  result?: string;
  bill?: { type: string; number: string };
  positions?: CongressVotePosition[];
  totals?: { yea?: number; nay?: number; present?: number; notVoting?: number };
}

interface PaginatedMembers {
  members?: CongressMember[];
  pagination?: { count?: number; next?: string };
}

interface PaginatedBills {
  bills?: CongressBill[];
  pagination?: { count?: number; next?: string };
}

interface PaginatedVotes {
  votes?: CongressVote[];
  pagination?: { count?: number; next?: string };
}

export interface CongressAdapterOptions {
  apiKey: string;
  /**
   * Which Congresses to fetch. Defaults to [119, 118] per the Phase 3
   * load-bearing sub-decision (current + prior; full history deferred).
   */
  congresses?: number[];
  rateLimiter?: RateLimiter;
}

// ── Normalisation helpers ─────────────────────────────────────────────

/** "HR" + "1234" → "HR1234". Follows Congress.gov bill-type casing. */
function billIdentifier(type: string, number: string): string {
  return `${type.toUpperCase()}${number}`;
}

/** Map Congress.gov "Senate"/"House" → our EntityReference role qualifier. */
function chamberToRole(chamber: string): "senator" | "representative" {
  return chamber.toLowerCase().includes("senate") ? "senator" : "representative";
}

/** Map Congress.gov votePosition string → lowercase qualifier. */
function normalizeVotePosition(pos: string): string {
  const lower = pos.toLowerCase().replace(/\s+/g, "_");
  // Map "not_voting" → "not_voting", "present" → "present", etc.
  if (lower === "yea") return "yea";
  if (lower === "nay") return "nay";
  if (lower === "present") return "present";
  return "not_voting";
}

/** Build a human-facing URL for a bill on congress.gov. */
function billUrl(congress: number, type: string, number: string): string {
  // e.g. https://www.congress.gov/bill/119th-congress/house-bill/1234
  const typeSuffix = type.toLowerCase() === "hr"
    ? "house-bill"
    : type.toLowerCase() === "s"
    ? "senate-bill"
    : `${type.toLowerCase()}-resolution`;
  return `https://www.congress.gov/bill/${congress}th-congress/${typeSuffix}/${number}`;
}

/** Build a human-facing URL for a roll-call vote on congress.gov. */
function voteUrl(congress: number, chamber: string, rollNumber: number): string {
  const ch = chamber.toLowerCase().includes("senate") ? "senate" : "house";
  return `https://www.congress.gov/roll-call-votes/${congress}/${ch}/${rollNumber}`;
}

// ── Adapter ───────────────────────────────────────────────────────────

export class CongressAdapter implements Adapter {
  readonly name = "congress";
  private readonly rateLimiter: RateLimiter;
  private readonly congresses: number[];

  constructor(private readonly opts: CongressAdapterOptions) {
    this.rateLimiter =
      opts.rateLimiter ?? new RateLimiter({ tokensPerInterval: 80, intervalMs: 60_000 });
    this.congresses = opts.congresses ?? [119, 118];
  }

  /**
   * Refresh federal members, bills, and votes from api.congress.gov.
   *
   * Congress.gov does not require a `jurisdiction` parameter (it is
   * always `us-federal`). The `AdapterOptions.jurisdiction` field is
   * ignored if supplied.
   */
  async refresh(options: AdapterOptions): Promise<RefreshResult> {
    const result: RefreshResult = {
      source: this.name,
      entitiesUpserted: 0,
      documentsUpserted: 0,
      errors: [],
    };

    // Each section has its own try/catch so that one endpoint failing
    // (e.g. /vote returning 404 on a lower-tier Congress.gov API key)
    // doesn't lose the work already done by earlier sections.

    // 1. Fetch and upsert all Members first so bills can reference them.
    try {
      for (const congress of this.congresses) {
        const members = await this.fetchAllPages<CongressMember, PaginatedMembers>(
          `/member?congress=${congress}&limit=250`,
          (body) => body.members ?? [],
          (body) => body.pagination?.next,
          options.maxPages,
        );
        for (const m of members) {
          this.upsertMember(options.db, m);
          result.entitiesUpserted += 1;
        }
      }
    } catch (err) {
      const msg = `members: ${String(err)}`;
      logger.error("congress members refresh failed", { error: msg });
      result.errors.push(msg);
    }

    // 2. Fetch bills.
    try {
      for (const congress of this.congresses) {
        const bills = await this.fetchAllPages<CongressBill, PaginatedBills>(
          `/bill?congress=${congress}&limit=250`,
          (body) => body.bills ?? [],
          (body) => body.pagination?.next,
          options.maxPages,
        );
        for (const b of bills) {
          this.upsertBill(options.db, b);
          result.documentsUpserted += 1;
        }
      }
    } catch (err) {
      const msg = `bills: ${String(err)}`;
      logger.error("congress bills refresh failed", { error: msg });
      result.errors.push(msg);
    }

    // 3. Fetch votes (roll calls). Graceful degradation for 404: the
    //    /vote endpoint may not be available on all Congress.gov API
    //    tiers. When that happens we log a warning and continue
    //    without counting it as an error — the rest of the data is
    //    still useful, and the absence of votes is a known limitation
    //    rather than a bug.
    try {
      for (const congress of this.congresses) {
        const votes = await this.fetchAllPages<CongressVote, PaginatedVotes>(
          `/vote?congress=${congress}&limit=250`,
          (body) => body.votes ?? [],
          (body) => body.pagination?.next,
          options.maxPages,
        );
        for (const v of votes) {
          this.upsertVote(options.db, v);
          result.documentsUpserted += 1;
        }
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes("returned 404")) {
        logger.warn(
          "congress /vote endpoint unavailable on this API tier — skipping votes",
          { error: msg },
        );
        // Not pushed to result.errors — graceful degradation.
      } else {
        const tagged = `votes: ${msg}`;
        logger.error("congress votes refresh failed", { error: tagged });
        result.errors.push(tagged);
      }
    }

    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async fetchAllPages<T, B>(
    firstPath: string,
    extract: (body: B) => T[],
    nextUrl: (body: B) => string | undefined,
    maxPages: number | undefined,
  ): Promise<T[]> {
    const all: T[] = [];
    let url: string | undefined = `${BASE_URL}${firstPath}`;
    let page = 0;

    while (url) {
      // Append the API key as a query parameter (Congress.gov convention).
      const reqUrl = new URL(url);
      reqUrl.searchParams.set("api_key", this.opts.apiKey);

      const res = await rateLimitedFetch(reqUrl.toString(), {
        userAgent: "civic-awareness-mcp/0.0.1 (+github)",
        rateLimiter: this.rateLimiter,
      });
      if (!res.ok) throw new Error(`Congress.gov ${firstPath} returned ${res.status}`);
      const body = (await res.json()) as B;
      all.push(...extract(body));
      page += 1;
      if (maxPages && page >= maxPages) break;
      url = nextUrl(body);
    }

    return all;
  }

  private upsertMember(db: Database.Database, m: CongressMember): string {
    // Determine chamber and role from the most recent term.
    const latestTerm = m.terms?.item?.at(-1);
    const chamber = latestTerm?.chamber ?? "unknown";
    const role = chamberToRole(chamber);
    const startYear = latestTerm?.startYear;
    const endYear = latestTerm?.endYear ?? null;

    const newRole = {
      jurisdiction: "us-federal",
      role,
      from: startYear ? `${startYear}-01-03T00:00:00.000Z` : undefined,
      to: endYear ? `${endYear}-01-03T00:00:00.000Z` : null,
    };

    const { entity, created } = upsertEntity(db, {
      kind: "person",
      name: m.name,
      jurisdiction: undefined,  // D3b: Persons are cross-jurisdiction
      external_ids: { bioguide: m.bioguideId },
      metadata: {
        party: m.partyName,
        state: m.state,
        chamber: role,
        roles: [newRole],
      },
    });

    // If the entity already existed (cross-source merge or re-refresh),
    // merge the new role into metadata.roles[] without overwriting any
    // existing roles. upsertEntity only merges external_ids and aliases;
    // we handle metadata.roles[] here explicitly.
    if (!created) {
      const existing = db
        .prepare("SELECT metadata FROM entities WHERE id = ?")
        .get(entity.id) as { metadata: string };
      const meta = JSON.parse(existing.metadata) as { roles?: typeof newRole[] };
      const currentRoles = meta.roles ?? [];
      const alreadyHasFederalRole = currentRoles.some(
        (r) => r.jurisdiction === "us-federal" && r.role === role,
      );
      if (!alreadyHasFederalRole) {
        const updatedRoles = [...currentRoles, newRole];
        const updatedMeta = { ...meta, roles: updatedRoles };
        db.prepare("UPDATE entities SET metadata = ? WHERE id = ?").run(
          JSON.stringify(updatedMeta),
          entity.id,
        );
      }
    }

    return entity.id;
  }

  private upsertBill(db: Database.Database, b: CongressBill): void {
    const identifier = billIdentifier(b.type, b.number);
    const occurred = b.updateDate ?? b.introducedDate ?? new Date().toISOString();
    // Ensure the date is ISO 8601 with time component.
    const occurredAt = occurred.includes("T") ? occurred : `${occurred}T00:00:00.000Z`;
    const humanUrl = billUrl(b.congress, b.type, b.number);

    // Resolve sponsors to entity IDs.
    const refs = (b.sponsors ?? []).map((s) => {
      let entityId: string;
      if (s.bioguideId) {
        // Fast path: sponsor has a bioguide ID — look up by external_id.
        const existing = db
          .prepare(
            "SELECT id FROM entities WHERE json_extract(external_ids, '$.\"bioguide\"') = ? LIMIT 1",
          )
          .get(s.bioguideId) as { id: string } | undefined;
        if (existing) {
          entityId = existing.id;
        } else {
          // Member not yet in store (can happen if members pagination
          // was limited). Create a minimal Person.
          const { entity } = upsertEntity(db, {
            kind: "person",
            name: s.fullName ?? s.bioguideId,
            jurisdiction: undefined,
            external_ids: { bioguide: s.bioguideId },
          });
          entityId = entity.id;
        }
      } else {
        // Bare-name fallback (should be rare with Congress.gov data).
        const { entity } = upsertEntity(db, {
          kind: "person",
          name: s.fullName ?? "Unknown",
          jurisdiction: undefined,
        });
        entityId = entity.id;
      }
      return { entity_id: entityId, role: "sponsor" as const };
    });

    const latestActionDate = b.latestAction?.actionDate;
    const latestActionText = b.latestAction?.text;

    upsertDocument(db, {
      kind: "bill",
      jurisdiction: "us-federal",
      title: `${identifier} — ${b.title}`,
      occurred_at: occurredAt,
      source: {
        name: "congress",
        id: `${b.congress}-${b.type.toLowerCase()}-${b.number}`,
        url: humanUrl,
      },
      references: refs,
      raw: {
        congress: b.congress,
        billType: b.type,
        billNumber: b.number,
        introducedDate: b.introducedDate,
        latestAction: latestActionDate
          ? { date: latestActionDate, description: latestActionText ?? "" }
          : null,
      },
    });
  }

  private upsertVote(db: Database.Database, v: CongressVote): void {
    const occurred = v.date.includes("T") ? v.date : `${v.date}T00:00:00.000Z`;
    const billId = v.bill ? billIdentifier(v.bill.type, v.bill.number) : "unknown";
    const title = `Vote ${v.congress}-${v.chamber}-${v.rollNumber}: ${billId} — ${v.question ?? ""}`;
    const humanUrl = voteUrl(v.congress, v.chamber, v.rollNumber);

    // Each voter is an EntityReference with role='voter' and
    // qualifier equal to the normalised vote position.
    // We wrap this in a transaction because we may create/lookup many
    // Person entities before calling upsertDocument. Without a
    // transaction, a crash mid-loop would leave orphaned entity rows
    // that have no corresponding document reference.
    //
    // NOTE: upsertDocument itself is already wrapped in db.transaction;
    // SQLite supports nested transactions via savepoints when using
    // better-sqlite3, but we don't need nesting here — the member
    // upserts below are pure INSERTs/SELECTs and do not need the same
    // atomicity as the document write. We therefore collect refs first,
    // then call upsertDocument (which handles its own transaction).
    const refs = (v.positions ?? []).map((pos) => {
      const qualifier = normalizeVotePosition(pos.votePosition);
      const existing = db
        .prepare(
          "SELECT id FROM entities WHERE json_extract(external_ids, '$.\"bioguide\"') = ? LIMIT 1",
        )
        .get(pos.member.bioguideId) as { id: string } | undefined;
      let entityId: string;
      if (existing) {
        entityId = existing.id;
      } else {
        const { entity } = upsertEntity(db, {
          kind: "person",
          name: pos.member.name,
          jurisdiction: undefined,
          external_ids: { bioguide: pos.member.bioguideId },
        });
        entityId = entity.id;
      }
      return { entity_id: entityId, role: "voter" as const, qualifier };
    });

    upsertDocument(db, {
      kind: "vote",
      jurisdiction: "us-federal",
      title,
      occurred_at: occurred,
      source: {
        name: "congress",
        id: `vote-${v.congress}-${v.chamber.toLowerCase()}-${v.rollNumber}`,
        url: humanUrl,
      },
      references: refs,
      raw: {
        congress: v.congress,
        chamber: v.chamber,
        rollNumber: v.rollNumber,
        question: v.question,
        result: v.result,
        bill: v.bill ?? null,
        totals: v.totals ?? {},
      },
    });
  }
}

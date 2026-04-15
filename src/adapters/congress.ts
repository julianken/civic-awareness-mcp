import type Database from "better-sqlite3";
import { rateLimitedFetch, RateLimiter } from "../util/http.js";
import { upsertEntity } from "../core/entities.js";
import { upsertDocument } from "../core/documents.js";
import { logger } from "../util/logger.js";
import type { Adapter, AdapterOptions, RefreshResult } from "./base.js";

export class VoteNotFoundError extends Error {
  constructor(
    public readonly congress: number,
    public readonly chamber: "upper" | "lower",
    public readonly session: number,
    public readonly rollNumber: number,
  ) {
    const ch = chamber === "upper" ? "senate" : "house";
    super(
      `Vote not found: ${ch} ${congress}-${session} roll ${rollNumber}`,
    );
    this.name = "VoteNotFoundError";
  }
}

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
  member: {
    bioguideId: string;
    name: string;
    partyName?: string;
    state?: string;
  };
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
          options.deadline,
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
          options.deadline,
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
          options.deadline,
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

  /**
   * Narrow per-tool fetch for R15 `recent_bills` — one page of
   * recently-updated bills with `fromDateTime` filter. Write-through
   * via existing `upsertBill`. Returns telemetry count.
   *
   * Uses only the current Congress (`this.congresses[0]`) — prior
   * congresses are bulk-loaded via `pnpm refresh`. Optional chamber
   * filter is applied client-side by bill-type prefix (`"S"` → upper/
   * Senate; everything else → lower/House).
   */
  async fetchRecentBills(
    db: Database.Database,
    opts: { fromDateTime: string; chamber?: "upper" | "lower"; limit?: number },
  ): Promise<{ documentsUpserted: number }> {
    const congress = this.congresses[0];
    const url = new URL(`${BASE_URL}/bill`);
    url.searchParams.set("congress", String(congress));
    url.searchParams.set("fromDateTime", opts.fromDateTime.replace(/\.\d{3}Z$/, "Z"));
    url.searchParams.set("sort", "updateDate+desc");
    url.searchParams.set("limit", String(opts.limit ?? 250));
    url.searchParams.set("api_key", this.opts.apiKey);
    url.searchParams.set("format", "json");

    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
    });
    if (!res.ok) throw new Error(`Congress.gov /bill returned ${res.status}`);
    const body = (await res.json()) as { bills?: CongressBill[] };

    const chamberMatch = (billType: string): boolean => {
      if (!opts.chamber) return true;
      const senate = billType.toUpperCase().startsWith("S");
      return opts.chamber === "upper" ? senate : !senate;
    };

    let documentsUpserted = 0;
    for (const b of body.bills ?? []) {
      if (!chamberMatch(b.type)) continue;
      this.upsertBill(db, b);
      documentsUpserted += 1;
    }
    return { documentsUpserted };
  }

  /**
   * Direct-lookup narrow fetch for R15 `get_entity` — resolves one
   * Member by bioguide via `/member/{bioguideId}`. Returns
   * `entitiesUpserted: 0` on 404 (or an empty body) so the handler
   * can fan out across sources without knowing in advance which one
   * carries the entity. Reuses `upsertMember` for write-through.
   */
  async fetchMember(
    db: Database.Database,
    bioguideId: string,
  ): Promise<{ entitiesUpserted: number }> {
    const url = new URL(`${BASE_URL}/member/${bioguideId}`);
    url.searchParams.set("api_key", this.opts.apiKey);
    url.searchParams.set("format", "json");
    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
    });
    if (res.status === 404) return { entitiesUpserted: 0 };
    if (!res.ok) {
      throw new Error(`Congress.gov /member/${bioguideId} returned ${res.status}`);
    }
    const body = (await res.json()) as { member?: CongressMember };
    if (!body.member) return { entitiesUpserted: 0 };
    this.upsertMember(db, body.member);
    return { entitiesUpserted: 1 };
  }

  /**
   * Narrow per-tool fetch for R15 member search — one page of
   * `/member?congress=N` for the current Congress. Congress.gov has no
   * name-search endpoint, so this refreshes the full ~250-member page
   * and relies on the local SQL projection to filter. Shared endpoint
   * with `search_entities` / `resolve_person` (federal fanout) so
   * cache rows coalesce under R15's endpoint-keyed fetch_log.
   */
  async searchMembers(
    db: Database.Database,
    opts: { limit?: number } = {},
  ): Promise<{ entitiesUpserted: number }> {
    const congress = this.congresses[0];
    const url = new URL(`${BASE_URL}/member`);
    url.searchParams.set("congress", String(congress));
    url.searchParams.set("limit", String(opts.limit ?? 250));
    url.searchParams.set("api_key", this.opts.apiKey);
    url.searchParams.set("format", "json");

    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
    });
    if (!res.ok) throw new Error(`Congress.gov /member returned ${res.status}`);
    const body = (await res.json()) as { members?: CongressMember[] };
    let entitiesUpserted = 0;
    for (const m of body.members ?? []) {
      this.upsertMember(db, m);
      entitiesUpserted += 1;
    }
    return { entitiesUpserted };
  }

  /**
   * Narrow per-tool fetch for R15 `entity_connections` — one page of
   * bills this member sponsored, via
   * `/member/{bioguideId}/sponsored-legislation`. Reuses existing
   * `upsertBill` write-through so the results project into the same
   * documents table `findConnections` reads. Returns `documentsUpserted:
   * 0` on 404 so the fanout handler can tolerate an unknown bioguide
   * without aborting sibling adapters.
   */
  async fetchMemberSponsoredBills(
    db: Database.Database,
    bioguideId: string,
    opts: { limit?: number } = {},
  ): Promise<{ documentsUpserted: number }> {
    const url = new URL(`${BASE_URL}/member/${bioguideId}/sponsored-legislation`);
    url.searchParams.set("limit", String(opts.limit ?? 250));
    url.searchParams.set("api_key", this.opts.apiKey);
    url.searchParams.set("format", "json");
    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
    });
    if (res.status === 404) return { documentsUpserted: 0 };
    if (!res.ok) {
      throw new Error(`Congress.gov /member/${bioguideId}/sponsored-legislation returned ${res.status}`);
    }
    const body = (await res.json()) as { sponsoredLegislation?: CongressBill[] };
    let documentsUpserted = 0;
    for (const b of body.sponsoredLegislation ?? []) {
      this.upsertBill(db, b);
      documentsUpserted += 1;
    }
    return { documentsUpserted };
  }

  /**
   * Narrow per-tool fetch for R15 `entity_connections` — one page of
   * bills this member cosponsored, via
   * `/member/{bioguideId}/cosponsored-legislation`. Mirrors
   * `fetchMemberSponsoredBills` but reads the `cosponsoredLegislation`
   * response field instead.
   */
  async fetchMemberCosponsoredBills(
    db: Database.Database,
    bioguideId: string,
    opts: { limit?: number } = {},
  ): Promise<{ documentsUpserted: number }> {
    const url = new URL(`${BASE_URL}/member/${bioguideId}/cosponsored-legislation`);
    url.searchParams.set("limit", String(opts.limit ?? 250));
    url.searchParams.set("api_key", this.opts.apiKey);
    url.searchParams.set("format", "json");
    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
    });
    if (res.status === 404) return { documentsUpserted: 0 };
    if (!res.ok) {
      throw new Error(`Congress.gov /member/${bioguideId}/cosponsored-legislation returned ${res.status}`);
    }
    const body = (await res.json()) as { cosponsoredLegislation?: CongressBill[] };
    let documentsUpserted = 0;
    for (const b of body.cosponsoredLegislation ?? []) {
      this.upsertBill(db, b);
      documentsUpserted += 1;
    }
    return { documentsUpserted };
  }

  /**
   * Narrow per-tool fetch for R15 `recent_votes` — one page of recent
   * roll-call votes for the current Congress with optional chamber
   * filter. On 404 (free Congress.gov tier does not expose `/vote`),
   * returns `{ documentsUpserted: 0, degraded: true }` rather than
   * throwing, matching `refresh()`'s existing graceful-degradation
   * behavior.
   */
  async fetchRecentVotes(
    db: Database.Database,
    opts: { chamber?: "upper" | "lower"; limit?: number } = {},
  ): Promise<{ documentsUpserted: number; degraded?: boolean }> {
    const congress = this.congresses[0];
    const url = new URL(`${BASE_URL}/vote`);
    url.searchParams.set("congress", String(congress));
    url.searchParams.set("sort", "updateDate+desc");
    url.searchParams.set("limit", String(opts.limit ?? 250));
    url.searchParams.set("api_key", this.opts.apiKey);
    url.searchParams.set("format", "json");

    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
    });
    if (res.status === 404) {
      logger.warn("congress /vote 404 — free tier limitation; skipping", {
        url: url.toString(),
      });
      return { documentsUpserted: 0, degraded: true };
    }
    if (!res.ok) throw new Error(`Congress.gov /vote returned ${res.status}`);
    const body = (await res.json()) as { votes?: CongressVote[] };

    const chamberMatch = (chamber: string): boolean => {
      if (!opts.chamber) return true;
      const senate = chamber.toLowerCase().includes("senate");
      return opts.chamber === "upper" ? senate : !senate;
    };

    let documentsUpserted = 0;
    for (const v of body.votes ?? []) {
      if (!chamberMatch(v.chamber)) continue;
      this.upsertVote(db, v);
      documentsUpserted += 1;
    }
    return { documentsUpserted };
  }

  /** Fetches a single roll-call vote by composite
   *  `(congress, chamber, session, roll_number)` with full member
   *  positions and upserts it. Used by `get_vote` (R14 per-document
   *  TTL). The Congress.gov endpoint is
   *  `/senate-vote/{congress}/{session}/{roll}` or
   *  `/house-vote/{congress}/{session}/{roll}`. */
  async fetchVote(
    db: Database.Database,
    opts: {
      congress: number;
      chamber: "upper" | "lower";
      session: 1 | 2;
      roll_number: number;
    },
  ): Promise<{ documentId: string }> {
    const chamberSlug = opts.chamber === "upper" ? "senate-vote" : "house-vote";
    const path = `/${chamberSlug}/${opts.congress}/${opts.session}/${opts.roll_number}`;
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set("api_key", this.opts.apiKey);
    url.searchParams.set("format", "json");

    const res = await rateLimitedFetch(url.toString(), {
      userAgent: "civic-awareness-mcp/0.1.0 (+github)",
      rateLimiter: this.rateLimiter,
    });
    if (res.status === 404) {
      throw new VoteNotFoundError(
        opts.congress, opts.chamber, opts.session, opts.roll_number,
      );
    }
    if (!res.ok) {
      throw new Error(`Congress.gov ${path} returned ${res.status}`);
    }

    interface VoteDetailResponse {
      voteInformation?: {
        congress: number;
        chamber: string;
        rollNumber: number;
        date: string;
        question?: string;
        result?: string;
        bill?: { type: string; number: string };
        totals?: { yea?: number; nay?: number; present?: number; notVoting?: number };
        members?: {
          item?: Array<{
            bioguideId: string;
            name: string;
            partyName?: string;
            state?: string;
            votePosition: string;
          }>;
        };
      };
    }
    const body = (await res.json()) as VoteDetailResponse;
    const info = body.voteInformation;
    if (!info) {
      throw new Error(`Congress.gov ${path} returned no voteInformation`);
    }

    const vote: CongressVote = {
      congress: info.congress,
      chamber: info.chamber,
      rollNumber: info.rollNumber,
      date: info.date,
      question: info.question,
      result: info.result,
      bill: info.bill,
      totals: info.totals,
      positions: (info.members?.item ?? []).map((m) => ({
        member: {
          bioguideId: m.bioguideId,
          name: m.name,
          partyName: m.partyName,
          state: m.state,
        },
        votePosition: m.votePosition,
      })),
    };
    this.upsertVote(db, vote);

    const sourceId = `vote-${info.congress}-${info.chamber.toLowerCase()}-${info.rollNumber}`;
    const row = db
      .prepare("SELECT id FROM documents WHERE source_id = ?")
      .get(sourceId) as { id: string } | undefined;
    if (!row) {
      throw new Error(`fetchVote upsert failed to produce document row for ${sourceId}`);
    }
    return { documentId: row.id };
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async fetchAllPages<T, B>(
    firstPath: string,
    extract: (body: B) => T[],
    nextUrl: (body: B) => string | undefined,
    maxPages: number | undefined,
    deadline: number | undefined,
  ): Promise<T[]> {
    const all: T[] = [];
    let url: string | undefined = `${BASE_URL}${firstPath}`;
    let page = 0;

    while (url) {
      if (deadline !== undefined && Date.now() >= deadline) break;
      // Append the API key as a query parameter (Congress.gov convention).
      const reqUrl = new URL(url);
      reqUrl.searchParams.set("api_key", this.opts.apiKey);
      reqUrl.searchParams.set("format", "json");

      const res = await rateLimitedFetch(reqUrl.toString(), {
        userAgent: "civic-awareness-mcp/0.1.0 (+github)",
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

    const { entity } = upsertEntity(db, {
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

    return entity.id;
  }

  private upsertBill(db: Database.Database, b: CongressBill): void {
    const identifier = billIdentifier(b.type, b.number);
    const occurredAt = b.updateDate ?? b.introducedDate ?? new Date().toISOString();
    const humanUrl = billUrl(b.congress, b.type, b.number);

    const entityByBioguide = db.prepare(
      "SELECT id FROM entities WHERE json_extract(external_ids, '$.\"bioguide\"') = ? LIMIT 1",
    );

    // Resolve sponsors to entity IDs.
    const refs = (b.sponsors ?? []).map((s) => {
      let entityId: string;
      if (s.bioguideId) {
        // Fast path: sponsor has a bioguide ID — look up by external_id.
        const existing = entityByBioguide.get(s.bioguideId) as { id: string } | undefined;
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

    const voters = (v.positions ?? []).map((pos) => {
      const position = normalizeVotePosition(pos.votePosition);
      const { entity } = upsertEntity(db, {
        kind: "person",
        name: pos.member.name,
        jurisdiction: undefined,
        external_ids: { bioguide: pos.member.bioguideId },
        metadata: {
          party: pos.member.partyName,
          state: pos.member.state,
        },
      });
      return {
        positionRow: {
          bioguideId: pos.member.bioguideId,
          name: pos.member.name,
          party: pos.member.partyName ?? null,
          state: pos.member.state ?? null,
          position,
        },
        ref: { entity_id: entity.id, role: "voter" as const, qualifier: position },
      };
    });
    const positions = voters.map((x) => x.positionRow);
    const refs = voters.map((x) => x.ref);

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
        positions,
      },
    });
  }
}

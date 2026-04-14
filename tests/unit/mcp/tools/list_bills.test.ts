import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { upsertFetchLog } from "../../../../src/core/fetch_log.js";
import { hashArgs } from "../../../../src/core/args_hash.js";
import { _resetToolCacheForTesting } from "../../../../src/core/tool_cache.js";
import { _resetLimitersForTesting } from "../../../../src/core/limiters.js";
import { OpenStatesAdapter } from "../../../../src/adapters/openstates.js";
import { handleListBills } from "../../../../src/mcp/tools/list_bills.js";

const TEST_DB = "./data/test-tool-list-bills.db";
let store: Store;

function seedFetchLogFresh(args: Record<string, unknown>): void {
  upsertFetchLog(store.db, {
    source: "openstates",
    endpoint_path: "/bills/list",
    args_hash: hashArgs("list_bills", args),
    scope: "recent",
    fetched_at: new Date().toISOString(),
    last_rowcount: 1,
  });
}

beforeEach(() => {
  _resetToolCacheForTesting();
  _resetLimitersForTesting();
  process.env.OPENSTATES_API_KEY = "test-key";
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});
afterEach(() => {
  store.close();
  delete process.env.OPENSTATES_API_KEY;
});

function defaultArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jurisdiction: "us-tx",
    session: undefined,
    chamber: undefined,
    sponsor_entity_id: undefined,
    classification: undefined,
    subject: undefined,
    introduced_since: undefined,
    introduced_until: undefined,
    updated_since: undefined,
    updated_until: undefined,
    sort: "updated_desc",
    limit: 20,
    ...over,
  };
}

describe("list_bills tool — R15 hydration", () => {
  it("calls OpenStatesAdapter.listBills on a cache miss", async () => {
    const spy = vi
      .spyOn(OpenStatesAdapter.prototype, "listBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(res.stale_notice).toBeUndefined();
    spy.mockRestore();
  });

  it("does NOT call adapter on a second call within TTL (cache hit)", async () => {
    const spy = vi
      .spyOn(OpenStatesAdapter.prototype, "listBills")
      .mockImplementation(async () => ({ documentsUpserted: 0 }));

    await handleListBills(store.db, { jurisdiction: "us-tx" });
    await handleListBills(store.db, { jurisdiction: "us-tx" });

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("us-federal returns stale_notice with reason=not_yet_supported", async () => {
    const res = await handleListBills(store.db, {
      jurisdiction: "us-federal",
    });
    expect(res.results).toHaveLength(0);
    expect(res.stale_notice?.reason).toBe("not_yet_supported");
  });
});

describe("list_bills tool — local projection (TTL-hit)", () => {
  it("filters by sponsor_entity_id", async () => {
    const { entity: sponsor } = upsertEntity(store.db, {
      kind: "person", name: "Alpha Sponsor",
      external_ids: { openstates_person: "ocd-person/aaa" },
      metadata: {},
    });
    const { entity: other } = upsertEntity(store.db, {
      kind: "person", name: "Zeta Otherly",
      external_ids: { openstates_person: "ocd-person/bbb" },
      metadata: {},
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB1 — by A",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "1", url: "https://ex/1" },
      references: [{ entity_id: sponsor.id, role: "sponsor" }],
      raw: { actions: [] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB2 — by B",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "2", url: "https://ex/2" },
      references: [{ entity_id: other.id, role: "sponsor" }],
      raw: { actions: [] },
    });

    seedFetchLogFresh(defaultArgs({ sponsor_entity_id: sponsor.id }));
    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
      sponsor_entity_id: sponsor.id,
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].identifier).toBe("HB1");
  });

  it("filters by classification via raw.classification", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB1 — bill",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "c1", url: "https://ex/c1" },
      raw: { classification: ["bill"], actions: [] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HR1 — resolution",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "c2", url: "https://ex/c2" },
      raw: { classification: ["resolution"], actions: [] },
    });

    seedFetchLogFresh(defaultArgs({ classification: "resolution" }));
    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
      classification: "resolution",
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].identifier).toBe("HR1");
  });

  it("filters by subject via raw.subjects[]", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB1 — vehicles",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "s1", url: "https://ex/s1" },
      raw: { subjects: ["Vehicles", "Repossession"], actions: [] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB2 — other",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "s2", url: "https://ex/s2" },
      raw: { subjects: ["Education"], actions: [] },
    });

    seedFetchLogFresh(defaultArgs({ subject: "Vehicles" }));
    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
      subject: "Vehicles",
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].identifier).toBe("HB1");
  });

  it("filters by introduced_since/until using raw.actions[0].date", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB1 — jan",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "i1", url: "https://ex/i1" },
      raw: { actions: [{ date: "2026-01-10", description: "Introduced" }] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB2 — mar",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "i2", url: "https://ex/i2" },
      raw: { actions: [{ date: "2026-03-10", description: "Introduced" }] },
    });

    seedFetchLogFresh(
      defaultArgs({ introduced_since: "2026-02-01", introduced_until: "2026-04-01" }),
    );
    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
      introduced_since: "2026-02-01",
      introduced_until: "2026-04-01",
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].identifier).toBe("HB2");
  });

  it("sorts by introduced_asc", async () => {
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB1 — late",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "o1", url: "https://ex/o1" },
      raw: { actions: [{ date: "2026-03-10", description: "Introduced" }] },
    });
    upsertDocument(store.db, {
      kind: "bill", jurisdiction: "us-tx", title: "HB2 — early",
      occurred_at: "2026-04-10T00:00:00Z",
      source: { name: "openstates", id: "o2", url: "https://ex/o2" },
      raw: { actions: [{ date: "2026-01-10", description: "Introduced" }] },
    });

    seedFetchLogFresh(defaultArgs({ sort: "introduced_asc" }));
    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
      sort: "introduced_asc",
    });
    expect(res.results.map((r) => r.identifier)).toEqual(["HB2", "HB1"]);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      upsertDocument(store.db, {
        kind: "bill", jurisdiction: "us-tx", title: `HB${i} — t`,
        occurred_at: `2026-04-${10 + i}T00:00:00Z`,
        source: { name: "openstates", id: `L${i}`, url: `https://ex/${i}` },
        raw: { actions: [] },
      });
    }

    seedFetchLogFresh(defaultArgs({ limit: 3 }));
    const res = await handleListBills(store.db, {
      jurisdiction: "us-tx",
      limit: 3,
    });
    expect(res.results).toHaveLength(3);
  });
});

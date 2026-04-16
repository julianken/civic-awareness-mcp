import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/federal/seeds.js";
import { upsertDocument } from "../../../src/core/documents.js";
import { ensureBillFresh } from "../../../src/state/hydrate_bill.js";
import { OpenStatesAdapter } from "../../../src/state/adapters/openstates.js";

const TEST_DB = "./data/test-hydrate-bill.db";
let store: Store;
let fetchBillSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
  process.env.OPENSTATES_API_KEY = "test-key";
  fetchBillSpy = vi.spyOn(OpenStatesAdapter.prototype, "fetchBill").mockResolvedValue(undefined);
});

afterEach(() => {
  store.close();
  fetchBillSpy.mockRestore();
  delete process.env.OPENSTATES_API_KEY;
});

describe("ensureBillFresh", () => {
  it("fetches upstream when the bill is missing", async () => {
    await ensureBillFresh(store.db, {
      jurisdiction: "us-ca",
      session: "20252026",
      identifier: "SB 1338",
    });
    expect(fetchBillSpy).toHaveBeenCalledOnce();
  });

  it("skips upstream when fetched_at is < 1h old", async () => {
    upsertDocument(store.db, {
      kind: "bill",
      jurisdiction: "us-ca",
      title: "SB 1338 — Vehicles: repossession.",
      occurred_at: "2026-04-09T00:00:00Z",
      source: {
        name: "openstates",
        id: "ocd-bill/abc",
        url: "https://openstates.org/ca/bills/20252026/SB1338/",
      },
      raw: { session: "20252026" },
    });
    await ensureBillFresh(store.db, {
      jurisdiction: "us-ca",
      session: "20252026",
      identifier: "SB 1338",
    });
    expect(fetchBillSpy).not.toHaveBeenCalled();
  });

  it("refetches when fetched_at is > 1h old", async () => {
    upsertDocument(store.db, {
      kind: "bill",
      jurisdiction: "us-ca",
      title: "SB 1338 — Vehicles: repossession.",
      occurred_at: "2026-04-09T00:00:00Z",
      source: {
        name: "openstates",
        id: "ocd-bill/abc",
        url: "https://openstates.org/ca/bills/20252026/SB1338/",
      },
      raw: { session: "20252026" },
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    store.db
      .prepare("UPDATE documents SET fetched_at = ? WHERE source_id = ?")
      .run(twoHoursAgo, "ocd-bill/abc");
    await ensureBillFresh(store.db, {
      jurisdiction: "us-ca",
      session: "20252026",
      identifier: "SB 1338",
    });
    expect(fetchBillSpy).toHaveBeenCalledOnce();
  });

  it("returns stale_notice on upstream failure when local row exists", async () => {
    upsertDocument(store.db, {
      kind: "bill",
      jurisdiction: "us-ca",
      title: "SB 1338 — Vehicles: repossession.",
      occurred_at: "2026-04-09T00:00:00Z",
      source: {
        name: "openstates",
        id: "ocd-bill/abc",
        url: "https://openstates.org/ca/bills/20252026/SB1338/",
      },
      raw: { session: "20252026" },
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    store.db
      .prepare("UPDATE documents SET fetched_at = ? WHERE source_id = ?")
      .run(twoHoursAgo, "ocd-bill/abc");
    fetchBillSpy.mockRejectedValueOnce(new Error("boom"));
    const result = await ensureBillFresh(store.db, {
      jurisdiction: "us-ca",
      session: "20252026",
      identifier: "SB 1338",
    });
    expect(result.stale_notice?.reason).toBe("upstream_failure");
  });

  it("returns not_found when upstream throws BillNotFoundError", async () => {
    const { BillNotFoundError } = await import("../../../src/state/adapters/openstates.js");
    fetchBillSpy.mockRejectedValueOnce(new BillNotFoundError("us-ca", "20252026", "ZZ 9999"));
    const result = await ensureBillFresh(store.db, {
      jurisdiction: "us-ca",
      session: "20252026",
      identifier: "ZZ 9999",
    });
    expect(result.ok).toBe(false);
    expect(result.stale_notice?.reason).toBe("not_found");
  });

  it("returns not_yet_supported for us-federal", async () => {
    const result = await ensureBillFresh(store.db, {
      jurisdiction: "us-federal",
      session: "118",
      identifier: "HR 1",
    });
    expect(result.ok).toBe(false);
    expect(result.stale_notice?.reason).toBe("not_yet_supported");
    expect(fetchBillSpy).not.toHaveBeenCalled();
  });
});

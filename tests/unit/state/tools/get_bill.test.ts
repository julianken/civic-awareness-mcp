import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/federal/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { upsertDocument } from "../../../../src/core/documents.js";
import { handleGetBill } from "../../../../src/state/tools/get_bill.js";

vi.mock("../../../../src/state/hydrate_bill.js", async (orig) => {
  const actual = await orig<typeof import("../../../../src/state/hydrate_bill.js")>();
  return { ...actual, ensureBillFresh: vi.fn() };
});
import { ensureBillFresh } from "../../../../src/state/hydrate_bill.js";
const mockEnsure = vi.mocked(ensureBillFresh);

const TEST_DB = "./data/test-state-get-bill.db";
let store: Store;

beforeEach(() => {
  mockEnsure.mockReset();
  mockEnsure.mockResolvedValue({ ok: true });
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);

  const { entity: jones } = upsertEntity(store.db, {
    kind: "person",
    name: "Brian Jones",
    jurisdiction: undefined,
    external_ids: { openstates_person: "ocd-person/xyz" },
    metadata: { party: "Republican", district: "40", chamber: "upper" },
  });

  upsertDocument(store.db, {
    kind: "bill",
    jurisdiction: "us-ca",
    title: "SB 1338 — Vehicles: repossession.",
    summary: "Existing law prohibits interference...",
    occurred_at: "2026-04-09T00:00:00Z",
    source: {
      name: "openstates",
      id: "ocd-bill/abc",
      url: "https://openstates.org/ca/bills/20252026/SB1338/",
    },
    references: [{ entity_id: jones.id, role: "sponsor" }],
    raw: {
      session: "20252026",
      actions: [
        { date: "2026-02-20", description: "Introduced." },
        { date: "2026-04-09", description: "Set for hearing April 14." },
      ],
      abstracts: [{ abstract: "Existing law prohibits interference..." }],
      subjects: ["Vehicles", "Repossession"],
      versions: [
        {
          note: "Introduced",
          date: "2026-02-20",
          links: [
            { url: "https://leginfo.legislature.ca.gov/xyz.pdf", media_type: "application/pdf" },
          ],
        },
      ],
      documents: [],
      related_bills: [],
      sponsorships: [
        {
          name: "Brian Jones",
          classification: "primary",
          person: { id: "ocd-person/xyz", name: "Brian Jones", party: "Republican" },
        },
      ],
    },
  });
});
afterEach(() => store.close());

describe("get_bill tool (state)", () => {
  it("returns full bill detail with entity-linked primary sponsor", async () => {
    const result = await handleGetBill(store.db, {
      jurisdiction: "us-ca",
      session: "20252026",
      identifier: "SB 1338",
    });
    expect(result.bill?.identifier).toBe("SB 1338");
    expect(result.bill?.title).toBe("Vehicles: repossession.");
    expect(result.bill?.subjects).toEqual(["Vehicles", "Repossession"]);
    expect(result.bill?.primary_sponsor?.name).toBe("Brian Jones");
    expect(result.bill?.primary_sponsor?.entity_id).toBeDefined();
    expect(result.bill?.versions).toHaveLength(1);
    expect(result.bill?.versions[0].text_url).toMatch(/leginfo\.legislature\.ca\.gov/);
    expect(result.bill?.actions).toHaveLength(2);
  });

  it("returns null bill + stale_notice when ensureBillFresh reports not_found", async () => {
    mockEnsure.mockResolvedValueOnce({
      ok: false,
      stale_notice: {
        as_of: new Date().toISOString(),
        reason: "not_found",
        message: "Bill ZZ 9999 not found in us-ca 20252026",
      },
    });
    const result = await handleGetBill(store.db, {
      jurisdiction: "us-ca",
      session: "20252026",
      identifier: "ZZ 9999",
    });
    expect(result.bill).toBeNull();
    expect(result.stale_notice?.reason).toBe("not_found");
  });
});

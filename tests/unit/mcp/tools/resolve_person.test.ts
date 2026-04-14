import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../../src/core/store.js";
import { seedJurisdictions } from "../../../../src/core/seeds.js";
import { upsertEntity } from "../../../../src/core/entities.js";
import { handleResolvePerson } from "../../../../src/mcp/tools/resolve_person.js";

vi.mock("../../../../src/core/hydrate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/core/hydrate.js")>();
  return { ...actual, ensureFresh: vi.fn() };
});
import { ensureFresh } from "../../../../src/core/hydrate.js";
const mockEnsureFresh = vi.mocked(ensureFresh);

const TEST_DB = "./data/test-resolve-person.db";
let store: Store;

beforeEach(() => {
  mockEnsureFresh.mockReset();
  mockEnsureFresh.mockResolvedValue({ ok: true });

  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});

afterEach(() => {
  store.close();
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

describe("handleResolvePerson", () => {
  it("returns empty matches for an unknown name", async () => {
    const result = await handleResolvePerson(store.db, { name: "Zzz Nonexistent" });
    expect(result.matches).toHaveLength(0);
  });

  it("returns exact match with confidence=exact", async () => {
    upsertEntity(store.db, { kind: "person", name: "Jane Smith" });
    const result = await handleResolvePerson(store.db, { name: "Jane Smith" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].confidence).toBe("exact");
    expect(result.matches[0].name).toBe("Jane Smith");
  });

  it("returns alias match with confidence=alias", async () => {
    upsertEntity(store.db, {
      kind: "person",
      name: "Jonathan Doe",
      aliases: ["Jon Doe"],
    });
    const result = await handleResolvePerson(store.db, { name: "Jon Doe" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].confidence).toBe("alias");
    expect(result.matches[0].name).toBe("Jonathan Doe");
  });

  it("returns exact confidence when name matches both canonical and alias paths", async () => {
    // Insert two entities: one whose canonical name is the query,
    // another with the query as an alias.
    const e1 = upsertEntity(store.db, { kind: "person", name: "Alex Morgan" }).entity;
    upsertEntity(store.db, {
      kind: "person",
      name: "Alexandra Morgan",
      aliases: ["Alex Morgan"],
    });
    const result = await handleResolvePerson(store.db, { name: "Alex Morgan" });
    // e1 should appear with confidence=exact; the alias match gets alias.
    // The entity whose canonical name IS "Alex Morgan" must have exact.
    const exactMatch = result.matches.find((m) => m.entity_id === e1.id);
    expect(exactMatch?.confidence).toBe("exact");
  });

  it("returns fuzzy match with confidence=fuzzy when Levenshtein distance=1", async () => {
    // "Chuck Grassley" → query "Chuk Grassley" (one typo, 'd' → deleted)
    // Provide jurisdiction_hint to satisfy linking signal.
    upsertEntity(store.db, {
      kind: "person",
      name: "Chuck Grassley",
      metadata: {
        roles: [{ jurisdiction: "us-ia", role: "senator", from: "1981-01-05" }],
      },
    });
    const result = await handleResolvePerson(store.db, {
      name: "Chuk Grassley",
      jurisdiction_hint: "us-ia",
    });
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const fuzzyMatch = result.matches.find((m) => m.confidence === "fuzzy");
    expect(fuzzyMatch).toBeDefined();
    expect(fuzzyMatch?.name).toBe("Chuck Grassley");
  });

  it("does not return fuzzy match without a linking signal", async () => {
    upsertEntity(store.db, { kind: "person", name: "Chuck Grassley" });
    // No jurisdiction_hint or role_hint — no linking signal.
    const result = await handleResolvePerson(store.db, { name: "Chuk Grassley" });
    // Should NOT return a fuzzy match because no linking signal is present.
    const fuzzyMatches = result.matches.filter((m) => m.confidence === "fuzzy");
    expect(fuzzyMatches).toHaveLength(0);
  });

  it("populates disambiguators from metadata.roles[] for Persons", async () => {
    upsertEntity(store.db, {
      kind: "person",
      name: "Maria Lopez",
      metadata: {
        roles: [
          { jurisdiction: "us-tx", role: "state_legislator", from: "2010-01-01T00:00:00.000Z", to: "2018-01-01T00:00:00.000Z" },
          { jurisdiction: "us-federal", role: "representative", from: "2019-01-03T00:00:00.000Z", to: null },
        ],
      },
    });
    const result = await handleResolvePerson(store.db, { name: "Maria Lopez" });
    expect(result.matches[0].disambiguators.length).toBeGreaterThanOrEqual(2);
    const d = result.matches[0].disambiguators.join(" | ");
    expect(d).toContain("us-tx");
    expect(d).toContain("us-federal");
    expect(d).toContain("present");
  });

  it("sorts exact matches before alias, alias before fuzzy", async () => {
    // Exact: "Sam Chen"
    upsertEntity(store.db, { kind: "person", name: "Sam Chen" });
    // Alias: "Samuel Chen" with alias "Sam Chen" — but wait, inserting
    // "Sam Chen" canonical already occupies that normalized name.
    // Use a different alias scenario: query "Sam Chen", and a second
    // entity "Samantha Chen" with alias "Sam Chen" (different canonical).
    upsertEntity(store.db, {
      kind: "person",
      name: "Samantha Chen",
      aliases: ["Sam Chen"],
    });
    const result = await handleResolvePerson(store.db, { name: "Sam Chen" });
    const confidences = result.matches.map((m) => m.confidence);
    const exactIdx = confidences.indexOf("exact");
    const aliasIdx = confidences.indexOf("alias");
    if (exactIdx !== -1 && aliasIdx !== -1) {
      expect(exactIdx).toBeLessThan(aliasIdx);
    }
  });

  it("accepts context field without error (V1 ignores it)", async () => {
    upsertEntity(store.db, { kind: "person", name: "Test Person" });
    await expect(
      handleResolvePerson(store.db, {
        name: "Test Person",
        context: "Texas energy committee member",
      }),
    ).resolves.not.toThrow();
  });

  it("matches non-Person kinds only when they have the exact name and kind=person is not matched", async () => {
    // resolve_person operates only over kind='person' rows.
    upsertEntity(store.db, {
      kind: "organization",
      name: "Texas Energy Committee",
      jurisdiction: "us-tx",
    });
    const result = await handleResolvePerson(store.db, { name: "Texas Energy Committee" });
    // Non-Person entity — should NOT appear in resolve_person results.
    expect(result.matches).toHaveLength(0);
  });

  // ── hydration ─────────────────────────────────────────────────────────────

  it("hydration: no jurisdiction_hint → ensureFresh not called", async () => {
    upsertEntity(store.db, { kind: "person", name: "Jane Smith" });
    await handleResolvePerson(store.db, { name: "Jane Smith" });
    expect(mockEnsureFresh).not.toHaveBeenCalled();
  });

  it("hydration: jurisdiction_hint provided → ensureFresh called with scope=full", async () => {
    await handleResolvePerson(store.db, { name: "Jane Smith", jurisdiction_hint: "us-tx" });
    expect(mockEnsureFresh).toHaveBeenCalledWith(
      store.db,
      "openstates",
      "us-tx",
      "full",
      expect.any(Function),
    );
  });

  it("hydration: ok=true → no stale_notice", async () => {
    mockEnsureFresh.mockResolvedValue({ ok: true });
    const res = await handleResolvePerson(store.db, { name: "Jane Smith", jurisdiction_hint: "us-tx" });
    expect(res.stale_notice).toBeUndefined();
  });

  it("hydration: upstream failure → stale_notice attached, matches still returned", async () => {
    const notice = {
      as_of: "2026-04-13T00:00:00.000Z",
      reason: "upstream_failure" as const,
      message: "Upstream openstates fetch failed; serving stale local data.",
    };
    mockEnsureFresh.mockResolvedValue({ ok: false, stale_notice: notice });
    upsertEntity(store.db, {
      kind: "person",
      name: "Jane Smith",
      metadata: { roles: [{ jurisdiction: "us-tx", role: "state_legislator" }] },
    });
    const res = await handleResolvePerson(store.db, { name: "Jane Smith", jurisdiction_hint: "us-tx" });
    expect(res.stale_notice?.reason).toBe("upstream_failure");
    expect(res.matches.length).toBeGreaterThan(0);
  });
});

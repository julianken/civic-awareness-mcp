import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/core/store.js";
import { seedJurisdictions } from "../../../src/core/seeds.js";
import { upsertEntity, findEntityById, listEntities } from "../../../src/core/entities.js";

const TEST_DB = "./data/test-entities.db";
let store: Store;
beforeEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  store = openStore(TEST_DB);
  seedJurisdictions(store.db);
});
afterEach(() => store.close());

describe("upsertEntity", () => {
  it("inserts new when no match (Person — no jurisdiction)", () => {
    const r = upsertEntity(store.db, {
      kind: "person", name: "Jane Doe",
      external_ids: { openstates_person: "ocd-person/abc" },
    });
    expect(r.created).toBe(true);
    expect(r.entity.jurisdiction).toBeUndefined();
    expect(r.entity.external_ids.openstates_person).toBe("ocd-person/abc");
  });

  it("matches by external_id", () => {
    const first = upsertEntity(store.db, {
      kind: "person", name: "Jane Doe",
      external_ids: { openstates_person: "ocd-person/abc" },
    });
    const second = upsertEntity(store.db, {
      kind: "person", name: "J. Doe",
      external_ids: { openstates_person: "ocd-person/abc" },
    });
    expect(second.created).toBe(false);
    expect(second.entity.id).toBe(first.entity.id);
    expect(second.entity.aliases).toContain("J. Doe");
  });

  it("matches Person by exact normalized name across jurisdictions (D3b)", () => {
    const first = upsertEntity(store.db, { kind: "person", name: "Jane Doe" });
    const second = upsertEntity(store.db, { kind: "person", name: "Jane  Doe" });
    expect(second.created).toBe(false);
    expect(second.entity.id).toBe(first.entity.id);
  });

  it("Organization exact-name match is still scoped to jurisdiction", () => {
    const a = upsertEntity(store.db, {
      kind: "organization", name: "Ethics Committee", jurisdiction: "us-tx",
    });
    const b = upsertEntity(store.db, {
      kind: "organization", name: "Ethics Committee", jurisdiction: "us-ca",
    });
    expect(b.created).toBe(true);
    expect(b.entity.id).not.toBe(a.entity.id);
  });

  it("does not cross kinds", () => {
    const a = upsertEntity(store.db, { kind: "person", name: "ACME" });
    const b = upsertEntity(store.db, {
      kind: "organization", name: "ACME", jurisdiction: "us-federal",
    });
    expect(b.created).toBe(true);
    expect(b.entity.id).not.toBe(a.entity.id);
  });
});

describe("findEntityById and listEntities", () => {
  it("findEntityById returns null for missing", () => {
    expect(findEntityById(store.db, "nope")).toBeNull();
  });
  it("listEntities filters by kind", () => {
    upsertEntity(store.db, { kind: "person", name: "Jane" });
    upsertEntity(store.db, {
      kind: "organization", name: "ACME", jurisdiction: "us-federal",
    });
    expect(listEntities(store.db, { kind: "person" })).toHaveLength(1);
  });
});

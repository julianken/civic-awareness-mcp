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

describe("upsertEntity — metadata merge", () => {
  it("prefers non-null new over non-null old on scalar fields", () => {
    upsertEntity(store.db, {
      kind: "person", name: "Joan Huffman",
      external_ids: { openstates_person: "ocd-person/hf" },
      metadata: { party: "Republican" },
    });
    const r = upsertEntity(store.db, {
      kind: "person", name: "Joan Huffman",
      external_ids: { openstates_person: "ocd-person/hf" },
      metadata: { party: "Republican", title: "Senator", district: "17", chamber: "upper" },
    });
    expect(r.created).toBe(false);
    expect(r.entity.metadata).toMatchObject({
      party: "Republican", title: "Senator", district: "17", chamber: "upper",
    });
  });

  it("keeps existing non-null when new is null/undefined", () => {
    upsertEntity(store.db, {
      kind: "person", name: "Brandon Creighton",
      external_ids: { openstates_person: "ocd-person/bc" },
      metadata: { party: "Republican", district: "4", chamber: "upper" },
    });
    const r = upsertEntity(store.db, {
      kind: "person", name: "Brandon Creighton",
      external_ids: { openstates_person: "ocd-person/bc" },
      metadata: { party: "Republican" },
    });
    expect(r.entity.metadata).toMatchObject({
      party: "Republican", district: "4", chamber: "upper",
    });
  });
});

describe("upsertEntity — roles merge", () => {
  it("appends new role entries keyed on (jurisdiction, role, from)", () => {
    upsertEntity(store.db, {
      kind: "person", name: "Senator X",
      external_ids: { bioguide: "X000001" },
      metadata: { roles: [{ jurisdiction: "us-tx", role: "state_legislator", from: "2010-01-01T00:00:00Z", to: null }] },
    });
    const r = upsertEntity(store.db, {
      kind: "person", name: "Senator X",
      external_ids: { bioguide: "X000001" },
      metadata: { roles: [{ jurisdiction: "us-federal", role: "senator", from: "2020-01-03T00:00:00Z", to: null }] },
    });
    expect(r.entity.metadata.roles).toHaveLength(2);
    expect(r.entity.metadata.roles).toEqual([
      { jurisdiction: "us-tx",      role: "state_legislator", from: "2010-01-01T00:00:00Z", to: null },
      { jurisdiction: "us-federal", role: "senator",          from: "2020-01-03T00:00:00Z", to: null },
    ]);
  });

  it("does not duplicate when the same role is seen again", () => {
    const role = { jurisdiction: "us-federal", role: "senator", from: "2020-01-03T00:00:00Z", to: null };
    upsertEntity(store.db, {
      kind: "person", name: "Senator X",
      external_ids: { bioguide: "X000001" },
      metadata: { roles: [role] },
    });
    const r = upsertEntity(store.db, {
      kind: "person", name: "Senator X",
      external_ids: { bioguide: "X000001" },
      metadata: { roles: [role] },
    });
    expect(r.entity.metadata.roles).toHaveLength(1);
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

# 04 — Entity Schema

> This is the **single most load-bearing design decision** in the
> project. Every adapter writes into it; every tool reads from it.
> The schema below is finalized per decision D3 in
> `docs/06-open-decisions.md` (confirmed 2026-04-12). Under R11's
> scope pivot, Person entities are **cross-jurisdiction** in V1 — a
> single Person row holds all roles across all jurisdictions,
> disambiguated by external IDs and role history rather than by a
> jurisdiction partition.

## Core types (TypeScript / zod)

The following types live in `src/core/types.ts` and are the source of
truth. This file is a copy for reference.

```ts
import { z } from "zod";

// ─── Identity ────────────────────────────────────────────────────────

export const Jurisdiction = z.object({
  /** "us-federal" for Congress; "us-<state>" for state legislatures */
  id: z.string(),
  level: z.enum(["federal", "state"]),
  name: z.string(),
});
export type Jurisdiction = z.infer<typeof Jurisdiction>;

// ─── Entities (people and organizations) ─────────────────────────────

export const EntityKind = z.enum([
  "person",
  "organization",
  "committee",       // Legislative committees
  "pac",             // Political action committees
  "agency",          // Executive branch agencies
]);

export const ExternalIds = z.record(z.string(), z.string());
// Example: { openstates_person: "ocd-person/abc", bioguide: "H001234",
//            fec_candidate: "H0AZ01234" }

/**
 * For Person entities, metadata.roles[] records role history across
 * jurisdictions. Other metadata keys are source-specific.
 *
 * Example for a Senator who was previously a state AG and state
 * legislator:
 *   {
 *     roles: [
 *       { jurisdiction: "us-mo", role: "state_legislator",
 *         from: "2003-01-01", to: "2007-01-01" },
 *       { jurisdiction: "us-mo", role: "attorney_general",
 *         from: "2017-01-01", to: "2019-01-03" },
 *       { jurisdiction: "us-federal", role: "senator",
 *         from: "2019-01-03", to: null }
 *     ]
 *   }
 */
export const PersonRole = z.object({
  jurisdiction: z.string(),
  role: z.string(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().nullable().optional(),
});

export const Entity = z.object({
  id: z.string().uuid(),
  kind: EntityKind,
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  /** For Organizations/committees/PACs: their home jurisdiction. For
   *  Persons: omitted — use metadata.roles[] to track per-role
   *  jurisdictions across a career. */
  jurisdiction: z.string().optional(),
  external_ids: ExternalIds.default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
  // Timestamps
  first_seen_at: z.string().datetime(),
  last_seen_at: z.string().datetime(),
});
export type Entity = z.infer<typeof Entity>;

// ─── References ──────────────────────────────────────────────────────

export const ReferenceRole = z.enum([
  "sponsor",         // Bill sponsor
  "cosponsor",
  "voter",
  "contributor",     // Campaign finance
  "recipient",
  "subject",         // Mentioned in a document
  "officer",         // Of an organization
  "member",          // Committee member
]);

export const EntityReference = z.object({
  entity_id: z.string().uuid(),
  role: ReferenceRole,
  /** Position, district, party, or other role-specific qualifier */
  qualifier: z.string().optional(),
});
export type EntityReference = z.infer<typeof EntityReference>;

// ─── Documents (events in the civic event stream) ────────────────────

export const DocumentKind = z.enum([
  "bill",
  "bill_action",
  "vote",
  "contribution",
  "expenditure",
]);

export const Document = z.object({
  id: z.string().uuid(),
  kind: DocumentKind,
  jurisdiction: z.string(),      // Jurisdiction.id — always present on Documents
  title: z.string(),
  summary: z.string().optional(),
  /** ISO 8601. The canonical "when did this happen" date. */
  occurred_at: z.string().datetime(),
  /** When we last pulled it from upstream */
  fetched_at: z.string().datetime(),
  source: z.object({
    name: z.string(),            // "openstates", "congress", "openfec"
    id: z.string(),              // stable upstream ID
    url: z.string().url(),       // canonical human-facing URL
  }),
  references: z.array(EntityReference).default([]),
  /** Source-specific payload, for tools that want to surface raw fields */
  raw: z.record(z.string(), z.unknown()).default({}),
});
export type Document = z.infer<typeof Document>;
```

Note: `DocumentKind` is narrower under R11's scope pivot — the former
`meeting`, `matter`, `incident`, `budget_line`, `filing`, and
`lobbyist_registration` kinds are gone because their source adapters
are out of V1/V2. If a future `civic-awareness-municipal-mcp` picks
up municipal scope, those kinds come back.

## SQLite schema

```sql
CREATE TABLE jurisdictions (
  id           TEXT PRIMARY KEY,         -- "us-federal", "us-az", ...
  level        TEXT NOT NULL CHECK (level IN ('federal','state')),
  name         TEXT NOT NULL
);

CREATE TABLE entities (
  id              TEXT PRIMARY KEY,       -- UUID
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  name_normalized TEXT NOT NULL,          -- lowercased, punct-stripped, collapsed
  jurisdiction    TEXT REFERENCES jurisdictions(id),   -- NULL for Person
  external_ids    TEXT NOT NULL DEFAULT '{}',  -- JSON
  aliases         TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  metadata        TEXT NOT NULL DEFAULT '{}',  -- JSON (includes roles[] for Persons)
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);
CREATE INDEX idx_entities_name_norm ON entities(name_normalized);
CREATE INDEX idx_entities_kind      ON entities(kind);
-- Jurisdiction index is still useful for Organization queries, but
-- MUST NOT appear in any UNIQUE constraint that includes Person rows:
CREATE INDEX idx_entities_juris     ON entities(jurisdiction);
-- Fast lookup by any external ID without a separate table:
CREATE INDEX idx_entities_ext_ids   ON entities(external_ids);

CREATE TABLE documents (
  id              TEXT PRIMARY KEY,       -- UUID
  kind            TEXT NOT NULL,
  jurisdiction    TEXT NOT NULL REFERENCES jurisdictions(id),
  title           TEXT NOT NULL,
  summary         TEXT,
  occurred_at     TEXT NOT NULL,
  fetched_at      TEXT NOT NULL,
  source_name     TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  source_url      TEXT NOT NULL,
  raw             TEXT NOT NULL DEFAULT '{}',
  UNIQUE (source_name, source_id)
);
CREATE INDEX idx_documents_occurred    ON documents(occurred_at DESC);
CREATE INDEX idx_documents_kind_juris  ON documents(kind, jurisdiction, occurred_at DESC);

CREATE TABLE document_references (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id    TEXT NOT NULL REFERENCES entities(id)  ON DELETE CASCADE,
  role         TEXT NOT NULL,
  qualifier    TEXT,
  PRIMARY KEY (document_id, entity_id, role)
);
CREATE INDEX idx_docrefs_entity ON document_references(entity_id, role);
```

**Schema invariants (enforced in code, not in SQL):**
- For `entities.kind = 'person'`, `entities.jurisdiction` is NULL.
  Per-jurisdiction history lives in `metadata.roles[]`.
- For `entities.kind IN ('organization','committee','pac','agency')`,
  `entities.jurisdiction` SHOULD be set (a committee belongs to one
  jurisdiction).

## Resolution rules (V1, per D3 — confirmed 2026-04-12)

Single entry point: `upsertByExternalIdOrFuzzy(adapterInput) → Entity`.

```
Given: { kind, name, external_ids, aliases?, roles? (for persons) }

1. External-ID match (always first, always wins):
   For each (source, id) in external_ids:
     SELECT * FROM entities
     WHERE json_extract(external_ids, '$."<source>"') = ?
     (external_ids are globally unique per source)
     If found: merge and return.

2. Compute name_normalized:
     lowercase → strip punctuation → collapse whitespace → trim

3. Exact normalized-name match (cross-jurisdiction for Persons):
     SELECT * FROM entities
     WHERE name_normalized = ? AND kind = ?

   Tiebreaker if more than one candidate:
     a. If the upstream input has a middle name/initial and exactly
        one candidate's full normalized name (including middle)
        matches: merge with that one.
     b. If exactly one candidate already has an external_id from the
        same source family as the upstream input (e.g., both have an
        `openstates_person` ID, even if specific IDs differ):
        merge with that one.
     c. Otherwise: create new (under-match). Two entities for the
        same person is a bug we can live with; merging two distinct
        people is a correctness failure we cannot.

   Also match against each row's `aliases` as if it were `name_normalized`
   (D3a — aliases participate in exact match).

4. Fuzzy match (only for kind='person'):
     Enumerate candidates where name_normalized shares the same first
     word (no jurisdiction filter under R11). Compute Levenshtein
     distance on the full normalized name.

     Require ALL of:
       (a) Exactly one candidate at distance ≤ 1
           (tightened from ≤ 2 per D3b to compensate for nationwide
            collision risk — "Michael Brown" has hundreds of matches)
       (b) No other candidate at distance ≤ 3
       (c) At least one positive linking signal:
           - Candidate shares an external_id source family with the
             upstream record
           - Upstream name exactly matches one of the candidate's
             aliases (middle name/initial included if present)
           - Upstream record's associated document's jurisdiction
             already appears in the candidate's metadata.roles[]

     If all three hold: merge and return.
     Otherwise: create new (under-match).

5. Create new entity and return it.
```

**Merging semantics** (when a prior row is matched):
- Add new `external_ids` that weren't present.
- Append new `aliases` (if the upstream name differs from the
  canonical `name` and isn't already an alias).
- Append new `roles[]` entries to `metadata.roles[]` for Persons.
- Update `last_seen_at`.
- **Never overwrite** an existing `name` — the first-seen canonical
  name wins to keep the record stable across refreshes.

## Why these rules

The tension is between two failure modes:
- **Over-match** (merging two distinct people into one) is a
  correctness failure. Tool responses become actively wrong.
- **Under-match** (splitting one person into two rows) is a recall
  failure. Tool responses become incomplete, but every returned row
  is still correctly sourced.

We prefer under-match. The fuzzy tiebreakers (step 4c) exist to
prevent over-match specifically for common names, where name-only
matching would be catastrophic under the US-wide scope.

The cost of under-match is real — a Senator who was once a state
legislator might appear as two separate Person rows until an adapter
run supplies a linking external_id. That's acceptable; the graph
becomes less connected, but no tool returns a factually wrong answer.
A future `merge_entities` admin tool can reconcile known splits
manually once V1 is stable.

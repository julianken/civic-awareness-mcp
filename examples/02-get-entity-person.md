# Example 2 — `get_entity` on a cross-jurisdiction Person

The entity graph's headline: one `Person` row holds a sitting Senator's state-legislature career **and** their federal role, linked by external IDs. This example is illustrative and uses synthetic IDs, but the shape matches what `get_entity` actually returns.

## Request

```json
{ "id": "person:bioguide=S000148" }
```

The `id` shorthand `"person:bioguide=S000148"` is resolved to the internal UUID; alternatively you can pass the UUID directly.

## Response

```json
{
  "id": "person-7a4b11d2-9c8e-4f73-a1b5-e0fd22c91488",
  "kind": "person",
  "name": "Charles E. Schumer",
  "aliases": ["Chuck Schumer"],
  "jurisdiction": null,
  "external_ids": {
    "bioguide": "S000148",
    "openstates_person": "ocd-person/c23a1f80-...",
    "fec_candidate": "S8NY00082"
  },
  "metadata": {
    "roles": [
      {
        "jurisdiction": "us-ny",
        "role": "state_legislator",
        "from": "1975-01-01",
        "to": "1981-01-03"
      },
      {
        "jurisdiction": "us-federal",
        "role": "representative",
        "from": "1981-01-03",
        "to": "1999-01-03"
      },
      {
        "jurisdiction": "us-federal",
        "role": "senator",
        "from": "1999-01-03",
        "to": null
      }
    ]
  },
  "first_seen_at": "2026-03-14T06:02:17.331Z",
  "last_seen_at":  "2026-04-13T09:35:42.104Z",
  "recent_documents": [
    {
      "id": "bill-01J9A...",
      "kind": "bill",
      "title": "A bill to amend the Internal Revenue Code ...",
      "jurisdiction": "us-federal",
      "occurred_at": "2026-04-11",
      "source_url": "https://www.congress.gov/bill/119th-congress/senate-bill/1789"
    },
    {
      "id": "contribution-01J9B...",
      "kind": "contribution",
      "title": "Schedule A receipt from individual contributor",
      "jurisdiction": "us-federal",
      "occurred_at": "2026-04-09",
      "source_url": "https://api.open.fec.gov/v1/schedules/schedule_a/..."
    }
  ]
}
```

## What this demonstrates

### `jurisdiction` is `null` on the Person row ([D3b](../docs/06-open-decisions.md))

A sitting Senator had three distinct roles across two jurisdictions (`us-ny` → `us-federal`). Before D3b, each role produced a separate entity. Now all role history lives in `metadata.roles[]` on one entity, and the top-level `jurisdiction` field is reserved for Organizations / Committees / PACs (which have exactly one home jurisdiction).

### External IDs link the three sources

- `bioguide` — Congress.gov's canonical Member ID
- `openstates_person` — the entity's earlier state-legislature record in OpenStates
- `fec_candidate` — the federal campaign's FEC filing ID

The refresh job joined these records at ingest time, using the resolution algorithm in [`docs/04-entity-schema.md`](../docs/04-entity-schema.md). The LLM never has to know the three sources existed — it queries one entity and gets the whole career.

### `recent_documents` is mixed-kind

The 10 most recent `document_references` pointing at this entity, sorted by `occurred_at`. That's a bill (where the Senator was a sponsor) and a contribution (where they were a recipient) in one list — because both are `Document`s referencing the same `Entity` in the normalized store.

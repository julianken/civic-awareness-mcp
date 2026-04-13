# Example 3 — `entity_connections` at depth 2

A two-hop graph walk from a Member of Congress out through the entities they co-occur with on bills, votes, and contributions. Co-occurrence is document-level: if two entities appear on the same `Document`, an edge exists between them, weighted by `co_occurrence_count`.

## Request

```json
{
  "id": "person-7a4b11d2-9c8e-4f73-a1b5-e0fd22c91488",
  "depth": 2,
  "min_co_occurrences": 5
}
```

## Response (heavily trimmed)

```json
{
  "root": {
    "id": "person-7a4b11d2-...",
    "kind": "person",
    "name": "Charles E. Schumer",
    "roles_seen": ["sponsor", "voter", "recipient"],
    "jurisdictions_active_in": ["us-ny", "us-federal"],
    "last_seen_at": "2026-04-13T09:35:42.104Z"
  },
  "edges": [
    {
      "from": "person-7a4b11d2-...",
      "to": "organization-f91c...",
      "via_kinds": ["contribution"],
      "co_occurrence_count": 142,
      "sample_documents": [
        {
          "id": "contribution-01J8...",
          "title": "Schedule A receipt, 2026 Q1",
          "occurred_at": "2026-03-28",
          "source_url": "https://api.open.fec.gov/v1/schedules/schedule_a/..."
        }
      ]
    },
    {
      "from": "person-7a4b11d2-...",
      "to": "committee-a41b...",
      "via_kinds": ["member"],
      "co_occurrence_count": 87,
      "sample_documents": []
    },
    {
      "from": "person-7a4b11d2-...",
      "to": "person-2f9c...",
      "via_kinds": ["cosponsor", "voter"],
      "co_occurrence_count": 38,
      "sample_documents": [
        {
          "id": "bill-01J7...",
          "title": "A bill to reauthorize the Violence Against Women Act ...",
          "occurred_at": "2026-03-15",
          "source_url": "https://www.congress.gov/bill/119th-congress/senate-bill/1102"
        }
      ]
    },
    {
      "from": "person-2f9c...",
      "to": "organization-8b3d...",
      "via_kinds": ["contribution"],
      "co_occurrence_count": 61,
      "sample_documents": []
    }
  ],
  "nodes": [
    {
      "id": "organization-f91c...",
      "kind": "organization",
      "name": "Acme Realtors PAC",
      "roles_seen": ["contributor"],
      "jurisdictions_active_in": ["us-federal"],
      "last_seen_at": "2026-04-11T..."
    },
    {
      "id": "committee-a41b...",
      "kind": "committee",
      "name": "Senate Committee on the Judiciary",
      "roles_seen": ["member"],
      "jurisdictions_active_in": ["us-federal"],
      "last_seen_at": "2026-04-10T..."
    },
    {
      "id": "person-2f9c...",
      "kind": "person",
      "name": "Kirsten E. Gillibrand",
      "roles_seen": ["cosponsor", "voter", "recipient"],
      "jurisdictions_active_in": ["us-federal"],
      "last_seen_at": "2026-04-12T..."
    }
  ],
  "sources": [
    { "name": "congress.gov", "url": "https://api.congress.gov/v3" },
    { "name": "openfec",      "url": "https://api.open.fec.gov/v1" }
  ]
}
```

## What this demonstrates

### Depth 2 walks second-order relationships

The edge from `person-2f9c...` (a different Senator) to `organization-8b3d...` is depth-2: the two Senators co-sponsored a bill together, and the second Senator received contributions from a third organization. The LLM can now reason about shared donor bases without the tool returning every individual contribution.

### `via_kinds` tells the LLM what an edge is

A single edge can have multiple `via_kinds` — here the Schumer↔Gillibrand edge reflects both co-sponsorship and shared floor votes. The LLM can use this to answer "are they connected primarily via committee work or legislation?"

### `min_co_occurrences` controls noise

Federal bills often attract 50+ cosponsors; at `min_co_occurrences: 1` the graph would include every Member who ever signed anything together. The tool's default is 2; this example uses 5 to surface only durable relationships.

### No PII

Individual contributor addresses / employers / occupations are stored in `documents.raw` during refresh but are **never emitted through any tool**. Only aggregated institutional contributors (PACs, committees, candidates) appear in `nodes`.

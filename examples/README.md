# Examples

Concrete request/response fixtures for three of the eight tools, illustrating the two tool families (feed + entity) and the cross-jurisdiction Person model.

| File | Tool | Shows |
|---|---|---|
| [`01-recent-votes.md`](./01-recent-votes.md) | `recent_votes` | A federal roll-call feed with yea/nay/present/absent tallies and provenance |
| [`02-get-entity-person.md`](./02-get-entity-person.md) | `get_entity` | A sitting Senator's full cross-jurisdiction history — state-legislature → federal roles in one record (the [D3b invariant](../docs/06-open-decisions.md)) |
| [`03-entity-connections-depth2.md`](./03-entity-connections-depth2.md) | `entity_connections` | A depth-2 graph walk from a Member of Congress out through co-sponsored bills and shared committee memberships |

> **Note**: These are illustrative fixtures. Entity IDs, document IDs, and specific numeric values are synthetic. The shapes match what the tools actually return; see [`src/mcp/tools/`](../src/mcp/tools/) for the live implementations and [`docs/05-tool-surface.md`](../docs/05-tool-surface.md) for the complete input/output schemas.

## The shared response shape

All feed tools return:

```ts
{
  results: T[];
  total: number;                              // total matches; may exceed results.length
  sources: { name: string; url: string }[];   // provenance citations the LLM can surface
  window?: { from: string; to: string };      // for time-bounded queries
}
```

Entity tools vary — see each example.

# federal-mcp tool surface

All tools read/write-through to a local SQLite store as a TTL cache.

## Feeds

- `recent_bills` — recently-updated federal bills
- `recent_votes` — recent federal roll-call votes
- `recent_contributions` — recent federal itemized contributions
- `search_civic_documents` — title search across cached federal documents

## Entities

- `search_entities` — name search across Congress.gov + OpenFEC entities
- `get_entity` — entity detail + recent related documents
- `resolve_person` — disambiguate a person name
- `entity_connections` — co-occurrence graph

## Details

- `get_vote` — roll-call vote detail

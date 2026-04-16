# state-mcp tool surface

All tools read/write-through to a local SQLite store as a TTL cache.

## Feeds

- `recent_bills` — state legislative bills via OpenStates; defaults to recently-updated, plus optional filters for session, chamber, sponsor, classification, subject, and date ranges
- `recent_votes` — recent state roll-call votes (embedded in bill responses via OpenStates `include=votes`)
- `search_civic_documents` — title search across cached state documents

## Entities

- `search_entities` — name search across OpenStates entities
- `get_entity` — entity detail + recent related documents
- `resolve_person` — disambiguate a person name across state legislators
- `entity_connections` — co-occurrence graph via shared bill sponsorship

## Details

- `get_bill` — full state bill detail including actions, versions, sponsors, subjects

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE jurisdictions (
  id    TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('federal','state')),
  name  TEXT NOT NULL
);

-- NOTE: No UNIQUE constraint on (kind, jurisdiction, name_normalized)
-- or similar that would include Person rows. Under D3b, Persons are
-- cross-jurisdiction (jurisdiction is NULL) and two legitimate Persons
-- with the same normalized name must coexist until a linking signal
-- merges them. See docs/04-entity-schema.md, "Schema invariants".
CREATE TABLE entities (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  jurisdiction    TEXT REFERENCES jurisdictions(id),
  external_ids    TEXT NOT NULL DEFAULT '{}',
  aliases         TEXT NOT NULL DEFAULT '[]',
  metadata        TEXT NOT NULL DEFAULT '{}',
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);
CREATE INDEX idx_entities_name_norm ON entities(name_normalized);
CREATE INDEX idx_entities_kind      ON entities(kind);
CREATE INDEX idx_entities_juris     ON entities(jurisdiction);

CREATE TABLE documents (
  id              TEXT PRIMARY KEY,
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
CREATE INDEX idx_documents_occurred   ON documents(occurred_at DESC);
CREATE INDEX idx_documents_kind_juris ON documents(kind, jurisdiction, occurred_at DESC);

CREATE TABLE document_references (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id    TEXT NOT NULL REFERENCES entities(id)  ON DELETE CASCADE,
  role         TEXT NOT NULL,
  qualifier    TEXT,
  PRIMARY KEY (document_id, entity_id, role)
);
CREATE INDEX idx_docrefs_entity ON document_references(entity_id, role);

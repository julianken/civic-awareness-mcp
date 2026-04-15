CREATE TABLE IF NOT EXISTS jurisdictions (
  id    TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('federal','state')),
  name  TEXT NOT NULL
);

-- NOTE: No UNIQUE constraint on (kind, jurisdiction, name_normalized)
-- for Person rows. Persons are cross-jurisdiction (jurisdiction NULL)
-- and two legitimate Persons with the same normalized name coexist
-- until a linking signal merges them.
CREATE TABLE IF NOT EXISTS entities (
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
CREATE INDEX IF NOT EXISTS idx_entities_name_norm ON entities(name_normalized);
CREATE INDEX IF NOT EXISTS idx_entities_kind      ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_juris     ON entities(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_entities_ext_ids   ON entities(external_ids);

CREATE TABLE IF NOT EXISTS documents (
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
CREATE INDEX IF NOT EXISTS idx_documents_occurred   ON documents(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_kind_juris ON documents(kind, jurisdiction, occurred_at DESC);

CREATE TABLE IF NOT EXISTS document_references (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id    TEXT NOT NULL REFERENCES entities(id)  ON DELETE CASCADE,
  role         TEXT NOT NULL,
  qualifier    TEXT,
  PRIMARY KEY (document_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS idx_docrefs_entity ON document_references(entity_id, role);

CREATE TABLE IF NOT EXISTS fetch_log (
  source        TEXT NOT NULL,
  endpoint_path TEXT NOT NULL,
  args_hash     TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('recent', 'full', 'detail')),
  fetched_at    TEXT NOT NULL,
  last_rowcount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, endpoint_path, args_hash)
);
CREATE INDEX IF NOT EXISTS idx_fetch_log_fetched_at ON fetch_log(fetched_at);

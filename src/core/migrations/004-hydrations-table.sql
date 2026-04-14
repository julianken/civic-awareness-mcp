CREATE TABLE IF NOT EXISTS hydrations (
  source TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('recent', 'full')),
  last_fetched_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial')),
  PRIMARY KEY (source, jurisdiction, scope)
);

CREATE INDEX IF NOT EXISTS idx_hydrations_source_last
  ON hydrations(source, last_fetched_at);

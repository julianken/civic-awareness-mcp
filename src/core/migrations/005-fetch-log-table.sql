CREATE TABLE IF NOT EXISTS fetch_log (
  source TEXT NOT NULL,
  endpoint_path TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('recent', 'full', 'detail')),
  fetched_at TEXT NOT NULL,
  last_rowcount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, endpoint_path, args_hash)
);

CREATE INDEX IF NOT EXISTS idx_fetch_log_fetched_at
  ON fetch_log(fetched_at);

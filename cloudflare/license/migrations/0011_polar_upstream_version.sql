CREATE TABLE service_state (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  checked_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

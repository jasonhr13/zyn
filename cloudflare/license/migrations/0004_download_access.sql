CREATE TABLE download_access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX download_access_user_idx
  ON download_access_tokens(user_id, consumed_at, expires_at);

CREATE TABLE download_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX download_sessions_user_idx
  ON download_sessions(user_id, revoked_at, expires_at);
CREATE INDEX download_sessions_hash_idx ON download_sessions(session_hash);

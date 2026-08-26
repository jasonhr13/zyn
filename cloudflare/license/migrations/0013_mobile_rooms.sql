PRAGMA foreign_keys = ON;

CREATE TABLE mobile_rooms (
  room_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  license_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX mobile_rooms_user_idx ON mobile_rooms(user_id, revoked_at, expires_at);
CREATE INDEX mobile_rooms_token_idx ON mobile_rooms(token_hash);

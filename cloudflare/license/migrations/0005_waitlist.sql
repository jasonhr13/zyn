CREATE TABLE waitlist_entries (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  invited_at INTEGER,
  user_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX waitlist_status_idx ON waitlist_entries(invited_at, created_at DESC);
CREATE INDEX waitlist_user_idx ON waitlist_entries(user_id);

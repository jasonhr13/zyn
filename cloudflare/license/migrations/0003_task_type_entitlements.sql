CREATE TABLE task_types (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  enabled_for_all INTEGER NOT NULL DEFAULT 0 CHECK (enabled_for_all IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO task_types (key, label, enabled_for_all, created_at, updated_at) VALUES
  ('pokemoncenter', 'Pokémon Center', 0, unixepoch('subsec') * 1000, unixepoch('subsec') * 1000),
  ('round1', 'Round1', 0, unixepoch('subsec') * 1000, unixepoch('subsec') * 1000);

CREATE TABLE user_task_type_access (
  user_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, task_type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (task_type) REFERENCES task_types(key) ON DELETE CASCADE
);

CREATE INDEX user_task_type_access_user_idx ON user_task_type_access(user_id);

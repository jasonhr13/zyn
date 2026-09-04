PRAGMA foreign_keys = ON;

ALTER TABLE analytics_events ADD COLUMN account TEXT NOT NULL DEFAULT '';
ALTER TABLE analytics_events ADD COLUMN profile TEXT NOT NULL DEFAULT '';

CREATE INDEX analytics_events_user_account_idx
  ON analytics_events(user_id, account COLLATE NOCASE);
CREATE INDEX analytics_events_user_profile_idx
  ON analytics_events(user_id, profile COLLATE NOCASE);

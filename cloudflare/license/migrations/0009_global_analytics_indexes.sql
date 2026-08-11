CREATE INDEX analytics_events_time_idx
  ON analytics_events(occurred_at DESC);

CREATE INDEX analytics_events_type_time_idx
  ON analytics_events(event_type, occurred_at DESC);

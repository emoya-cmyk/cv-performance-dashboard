CREATE TABLE IF NOT EXISTS campaign_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  event_date TEXT NOT NULL,
  label      TEXT NOT NULL,
  note       TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_campaign_events_client_date
  ON campaign_events (client_id, event_date);

CREATE TABLE IF NOT EXISTS campaign_events (
  id          SERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  event_date  DATE NOT NULL,
  label       TEXT NOT NULL,
  note        TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaign_events_client_date
  ON campaign_events (client_id, event_date DESC);

CREATE TABLE IF NOT EXISTS fired_alerts (
  id          SERIAL PRIMARY KEY,
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  severity    TEXT,
  title       TEXT,
  body        TEXT,
  client_id   TEXT,
  client_name TEXT,
  metric      TEXT,
  value       TEXT,
  channel     TEXT
);

CREATE INDEX IF NOT EXISTS idx_fired_alerts_fired_at
  ON fired_alerts (fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_fired_alerts_client_id
  ON fired_alerts (client_id);

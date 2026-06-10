CREATE TABLE IF NOT EXISTS client_goal_history (
  id             SERIAL PRIMARY KEY,
  client_id      TEXT NOT NULL,
  month          DATE NOT NULL,
  revenue_target NUMERIC,
  leads_target   INTEGER,
  jobs_target    INTEGER,
  changed_by     INTEGER,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cgh_client_month
  ON client_goal_history (client_id, month, changed_at DESC);

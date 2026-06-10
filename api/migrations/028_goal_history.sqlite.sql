CREATE TABLE IF NOT EXISTS client_goal_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id      TEXT NOT NULL,
  month          TEXT NOT NULL,
  revenue_target REAL,
  leads_target   INTEGER,
  jobs_target    INTEGER,
  changed_by     INTEGER,
  changed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cgh_client_month
  ON client_goal_history (client_id, month, changed_at DESC);

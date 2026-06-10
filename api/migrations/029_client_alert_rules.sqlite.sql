CREATE TABLE IF NOT EXISTS client_alert_rules (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id          TEXT NOT NULL UNIQUE,
  revenue_drop_warn  REAL NOT NULL DEFAULT 0.20,
  revenue_drop_crit  REAL NOT NULL DEFAULT 0.40,
  leads_drop_warn    REAL NOT NULL DEFAULT 0.20,
  leads_drop_crit    REAL NOT NULL DEFAULT 0.40,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

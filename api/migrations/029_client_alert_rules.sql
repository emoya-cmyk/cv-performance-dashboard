CREATE TABLE IF NOT EXISTS client_alert_rules (
  id                 SERIAL PRIMARY KEY,
  client_id          TEXT NOT NULL UNIQUE,
  revenue_drop_warn  NUMERIC NOT NULL DEFAULT 0.20,
  revenue_drop_crit  NUMERIC NOT NULL DEFAULT 0.40,
  leads_drop_warn    NUMERIC NOT NULL DEFAULT 0.20,
  leads_drop_crit    NUMERIC NOT NULL DEFAULT 0.40,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

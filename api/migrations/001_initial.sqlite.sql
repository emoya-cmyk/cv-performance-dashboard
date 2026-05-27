-- SQLite version of the schema (used when DATABASE_URL is not set)
-- =========================================================

-- users
CREATE TABLE IF NOT EXISTS users (
  id            TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'agency' CHECK (role IN ('agency','client')),
  client_id     TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- clients
CREATE TABLE IF NOT EXISTS clients (
  id                TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  name              TEXT    NOT NULL,
  location          TEXT,
  industry          TEXT,
  status            TEXT    NOT NULL DEFAULT 'active',
  ghl_location_id   TEXT    UNIQUE,
  hubspot_portal_id TEXT,
  digest_email      TEXT,
  digest_enabled    INTEGER NOT NULL DEFAULT 0,
  unsubscribe_token TEXT    NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- agency_settings (single row, id=1)
CREATE TABLE IF NOT EXISTS agency_settings (
  id           INTEGER PRIMARY KEY DEFAULT 1,
  agency_name  TEXT    NOT NULL DEFAULT '10X Performance',
  accent_hex   TEXT    NOT NULL DEFAULT '#e53935',
  logo_url     TEXT,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO agency_settings (id) VALUES (1);

-- weekly_reports
CREATE TABLE IF NOT EXISTS weekly_reports (
  id                    TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  client_id             TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  week_start            TEXT    NOT NULL,
  ads_spend             REAL,
  ads_impressions       INTEGER,
  ads_clicks            INTEGER,
  ads_leads             INTEGER,
  ads_roas              REAL,
  lsa_spend             REAL,
  lsa_impressions       INTEGER,
  lsa_calls             INTEGER,
  lsa_booked_jobs       INTEGER,
  meta_spend            REAL,
  meta_impressions      INTEGER,
  meta_clicks           INTEGER,
  meta_leads            INTEGER,
  meta_roas             REAL,
  gbp_views             INTEGER,
  gbp_searches          INTEGER,
  gbp_calls             INTEGER,
  gbp_directions        INTEGER,
  gbp_website_clicks    INTEGER,
  ga4_sessions          INTEGER,
  ga4_new_users         INTEGER,
  ga4_organic_sessions  INTEGER,
  ga4_paid_sessions     INTEGER,
  ga4_direct_sessions   INTEGER,
  ga4_conversions       INTEGER,
  ga4_engagement_rate   REAL,
  raw_leads             INTEGER,
  mql                   INTEGER,
  sql_count             INTEGER,
  closed_won            INTEGER,
  projected_revenue     REAL,
  avg_ticket            REAL,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_weekly_reports_client_week
  ON weekly_reports (client_id, week_start DESC);

-- client_connections
CREATE TABLE IF NOT EXISTS client_connections (
  id             TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  client_id      TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel        TEXT    NOT NULL,
  credentials    TEXT    NOT NULL DEFAULT '{}',
  is_active      INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_error     TEXT,
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, channel)
);

-- sync_runs
CREATE TABLE IF NOT EXISTS sync_runs (
  id           TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  client_id    TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel      TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','error')),
  rows_written INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  started_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_client
  ON sync_runs (client_id, started_at DESC);

-- campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id           TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  client_id    TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  external_id  TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  channel      TEXT    NOT NULL,
  status       TEXT,
  spend        REAL,
  impressions  INTEGER,
  clicks       INTEGER,
  leads        INTEGER,
  revenue      REAL,
  week_start   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, external_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_client_week
  ON campaigns (client_id, week_start DESC);

-- client_goals
CREATE TABLE IF NOT EXISTS client_goals (
  id             TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  client_id      TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  month          TEXT    NOT NULL,
  revenue_target REAL,
  leads_target   INTEGER,
  jobs_target    INTEGER,
  created_by     TEXT    REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, month)
);

-- client_updates
CREATE TABLE IF NOT EXISTS client_updates (
  id          TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  client_id   TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  week_start  TEXT    NOT NULL,
  this_week   TEXT,
  next_week   TEXT,
  status      TEXT    NOT NULL DEFAULT 'on_track' CHECK (status IN ('on_track','monitoring','adjusted')),
  created_by  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, week_start)
);

-- report_shares
CREATE TABLE IF NOT EXISTS report_shares (
  id           TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  client_id    TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token        TEXT    NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
  created_by   TEXT    REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TEXT,
  revoked_at   TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_report_shares_token ON report_shares (token);

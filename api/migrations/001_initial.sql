-- ============================================================
-- Performance Dashboard — initial schema
-- Run via: npm run migrate  (in api/)
-- Safe to re-run: all statements use IF NOT EXISTS / ON CONFLICT
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'agency' CHECK (role IN ('agency', 'client')),
  client_id     UUID,                         -- set for role=client users
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── clients ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT        NOT NULL,
  location            TEXT,
  industry            TEXT,
  status              TEXT        NOT NULL DEFAULT 'active',
  ghl_location_id     TEXT        UNIQUE,
  hubspot_portal_id   TEXT,
  digest_email        TEXT,
  digest_enabled      BOOLEAN     NOT NULL DEFAULT false,
  unsubscribe_token   UUID        NOT NULL DEFAULT gen_random_uuid(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- FK from users → clients (added after clients table exists)
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS; guard via catalog lookup so re-runs are idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_client') THEN
    ALTER TABLE users
      ADD CONSTRAINT fk_users_client
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── agency_settings ────────────────────────────────────────────────────────
-- Single-row table (id = 1 always)
CREATE TABLE IF NOT EXISTS agency_settings (
  id           INT         PRIMARY KEY DEFAULT 1,
  agency_name  TEXT        NOT NULL DEFAULT '10X Performance',
  accent_hex   TEXT        NOT NULL DEFAULT '#e53935',
  logo_url     TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Seed default row if absent
INSERT INTO agency_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── weekly_reports ─────────────────────────────────────────────────────────
-- One row per (client, week). Connectors upsert here on each sync.
CREATE TABLE IF NOT EXISTS weekly_reports (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  week_start            DATE        NOT NULL,         -- always a Monday
  -- Google Ads
  ads_spend             NUMERIC(12,2),
  ads_impressions       BIGINT,
  ads_clicks            BIGINT,
  ads_leads             INT,
  ads_roas              NUMERIC(8,2),
  -- LSA (Local Services Ads — same Google connection)
  lsa_spend             NUMERIC(12,2),
  lsa_impressions       BIGINT,
  lsa_calls             INT,
  lsa_booked_jobs       INT,
  -- Meta Ads
  meta_spend            NUMERIC(12,2),
  meta_impressions      BIGINT,
  meta_clicks           BIGINT,
  meta_leads            INT,
  meta_roas             NUMERIC(8,2),
  -- Google Business Profile
  gbp_views             BIGINT,
  gbp_searches          BIGINT,
  gbp_calls             INT,
  gbp_directions        INT,
  gbp_website_clicks    INT,
  -- Google Analytics 4
  ga4_sessions          BIGINT,
  ga4_new_users         BIGINT,
  ga4_organic_sessions  BIGINT,
  ga4_paid_sessions     BIGINT,
  ga4_direct_sessions   BIGINT,
  ga4_conversions       INT,
  ga4_engagement_rate   NUMERIC(5,2),
  -- CRM / funnel (from GHL or manual upload)
  raw_leads             INT,
  mql                   INT,
  sql_count             INT,
  closed_won            INT,
  projected_revenue     NUMERIC(14,2),
  avg_ticket            NUMERIC(10,2),
  -- housekeeping
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_weekly_reports_client_week
  ON weekly_reports (client_id, week_start DESC);

-- ── client_connections ─────────────────────────────────────────────────────
-- API credentials per channel, encrypted at rest via DB-level or app-level
CREATE TABLE IF NOT EXISTS client_connections (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel        TEXT        NOT NULL,   -- google_ads | meta | ghl | gbp | ga4
  credentials    JSONB       NOT NULL DEFAULT '{}',
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  last_synced_at TIMESTAMPTZ,
  last_error     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, channel)
);

-- ── sync_runs ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_runs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel      TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'error')),
  rows_written INT         NOT NULL DEFAULT 0,
  error        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_client
  ON sync_runs (client_id, started_at DESC);

-- ── campaigns ─────────────────────────────────────────────────────────────
-- Per-campaign weekly rows (upserted by connectors or CSV upload)
CREATE TABLE IF NOT EXISTS campaigns (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  external_id  TEXT        NOT NULL,    -- platform-assigned campaign ID
  name         TEXT        NOT NULL,
  channel      TEXT        NOT NULL,    -- google_ads | meta | lsa
  status       TEXT,                    -- active | paused | ended
  spend        NUMERIC(12,2),
  impressions  BIGINT,
  clicks       BIGINT,
  leads        INT,
  revenue      NUMERIC(14,2),
  week_start   DATE        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, external_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_client_week
  ON campaigns (client_id, week_start DESC);

-- ── client_goals ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_goals (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  month          DATE        NOT NULL,   -- first day of the month
  revenue_target NUMERIC(14,2),
  leads_target   INT,
  jobs_target    INT,
  created_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, month)
);

-- ── client_updates ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_updates (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  week_start  DATE        NOT NULL,
  this_week   TEXT,
  next_week   TEXT,
  status      TEXT        NOT NULL DEFAULT 'on_track'
                          CHECK (status IN ('on_track', 'monitoring', 'adjusted')),
  created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, week_start)
);

-- ── report_shares ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_shares (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token       UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  access_count INT        NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_report_shares_token
  ON report_shares (token);

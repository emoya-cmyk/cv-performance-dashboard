-- ── Tier 1 schema additions ─────────────────────────────────────────────────
-- Safe to re-run (IF NOT EXISTS / DO UPDATE semantics throughout)

-- Monthly goals per client
CREATE TABLE IF NOT EXISTS client_goals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
  month           DATE NOT NULL,
  revenue_target  NUMERIC(12,2),
  leads_target    INTEGER,
  jobs_target     INTEGER,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (client_id, month)
);

-- Agency-written weekly updates shown in client view
CREATE TABLE IF NOT EXISTS client_updates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  week_start  DATE NOT NULL,
  this_week   TEXT,
  next_week   TEXT,
  status      TEXT DEFAULT 'on_track' CHECK (status IN ('on_track','monitoring','adjusted')),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (client_id, week_start)
);

-- Campaign-level performance (Google Ads / Meta / LSA)
CREATE TABLE IF NOT EXISTS campaigns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('google_ads','meta','lsa','gbp')),
  name        TEXT NOT NULL,
  status      TEXT DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  week_start  DATE NOT NULL,
  spend       NUMERIC(10,2) DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  clicks      INTEGER DEFAULT 0,
  leads       INTEGER DEFAULT 0,
  revenue     NUMERIC(12,2) DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (client_id, external_id, week_start)
);

-- Lead source breakdown columns (extends weekly_reports)
ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS google_ads_leads INTEGER DEFAULT 0;
ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS lsa_leads        INTEGER DEFAULT 0;
ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS meta_leads       INTEGER DEFAULT 0;
ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS gbp_leads        INTEGER DEFAULT 0;
ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS organic_leads    INTEGER DEFAULT 0;
ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS appointments     INTEGER DEFAULT 0;

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_client_goals_client_month   ON client_goals(client_id, month);
CREATE INDEX IF NOT EXISTS idx_client_updates_client_week  ON client_updates(client_id, week_start);
CREATE INDEX IF NOT EXISTS idx_campaigns_client_week       ON campaigns(client_id, week_start);

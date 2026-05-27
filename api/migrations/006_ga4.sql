-- GA4 website analytics columns on weekly_reports
-- Safe to run multiple times (IF NOT EXISTS / DO NOTHING pattern)

ALTER TABLE weekly_reports
  ADD COLUMN IF NOT EXISTS ga4_sessions          INTEGER   DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ga4_new_users         INTEGER   DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ga4_organic_sessions  INTEGER   DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ga4_paid_sessions     INTEGER   DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ga4_direct_sessions   INTEGER   DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ga4_conversions       INTEGER   DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ga4_engagement_rate   DECIMAL(5,2) DEFAULT 0;

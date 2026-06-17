-- Phase 4 — alert execution: make fired_alerts idempotent (SQLite variant).
--
-- See 033_fired_alerts_dedup.sql for rationale. SQLite has no IF NOT EXISTS on
-- ALTER TABLE ADD COLUMN; the migration runner swallows the "duplicate column"
-- error, so this is safe to re-run.
ALTER TABLE fired_alerts ADD COLUMN dedup_key TEXT;

-- NULLs are DISTINCT in a SQLite UNIQUE index, so legacy NULL-key rows coexist
-- while every keyed alert dedups; a plain index is a valid ON CONFLICT target.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fired_alerts_dedup_key
  ON fired_alerts (dedup_key);

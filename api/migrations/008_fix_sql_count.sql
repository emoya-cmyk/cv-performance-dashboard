-- ============================================================
-- 008 — Reconcile the sql → sql_count column split  (Postgres)
-- ------------------------------------------------------------
-- Older builds of 001_initial.sql defined the SQL-qualified-lead
-- column as `sql`, while every reader/writer (metrics.js,
-- reports.js, the connectors, the frontend) expects `sql_count`.
-- 001_initial.sql now defines `sql_count` directly, so a FRESH
-- database needs nothing here. This migration only fixes a
-- database that was already created on the old schema.
--
-- Idempotent + guarded: does nothing on fresh DBs or on re-run.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'weekly_reports' AND column_name = 'sql'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'weekly_reports' AND column_name = 'sql_count'
  ) THEN
    ALTER TABLE weekly_reports RENAME COLUMN sql TO sql_count;
  END IF;
END $$;

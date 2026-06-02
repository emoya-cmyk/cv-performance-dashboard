-- ============================================================
-- 016 (SQLite) — recovery outcome stamp sibling.
-- ------------------------------------------------------------
-- Mirrors 016_recovery_outcome.sql with SQLite-native types and no
-- IF NOT EXISTS on ALTER (SQLite has none). The migration runner runs the
-- whole file via conn.exec() and swallows "duplicate column" on re-run, so
-- this is safe to apply every boot. The .sqlite.sql sibling is MANDATORY:
-- the plain .sql `recovered_at TIMESTAMPTZ` statement is skipped by the
-- SQLite runner (it filters PG-only TIMESTAMPTZ), so without this file that
-- column would never be created under SQLite.
--   TIMESTAMPTZ → TEXT
-- ============================================================

ALTER TABLE insights ADD COLUMN recovery_reason TEXT;
ALTER TABLE insights ADD COLUMN recovered_at    TEXT;

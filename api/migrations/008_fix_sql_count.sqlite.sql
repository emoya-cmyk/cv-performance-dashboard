-- 008 (SQLite) — no-op.
-- SQLite already defines weekly_reports.sql_count (see 001_initial.sqlite.sql),
-- so there is nothing to reconcile. This explicit sibling exists only so the
-- SQLite migration runner does not try to parse the Postgres DO/$$ block in
-- 008_fix_sql_count.sql.
SELECT 1;

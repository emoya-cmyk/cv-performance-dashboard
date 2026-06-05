-- ── 009 (SQLite-only): weekly_reports lead-source + appointments columns ──────
-- WHY THIS FILE EXISTS:
--   002_tier1.sql adds these columns with Postgres-only `ALTER TABLE ... ADD COLUMN
--   IF NOT EXISTS ...` syntax. SQLite does NOT support `ADD COLUMN IF NOT EXISTS`,
--   so on the SQLite adapter (db-sqlite.js) every one of those statements throws a
--   syntax error, fails the `'already exists'/'duplicate column'` filter, and is
--   warned-and-skipped. Result: the columns never landed on SQLite — `appointments`
--   (and the four lead-source counters) were silently absent, 500-ing any metrics
--   query that SUMs them. Postgres is unaffected (002 applies there); the PG migrate
--   runner ignores *.sqlite.sql files, so this file is SQLite-only by design.
--
-- ORDERING / IDEMPOTENCY NOTES (read before editing):
--   * db-sqlite.js runs a *.sqlite.sql file as ONE conn.exec(); better-sqlite3 stops
--     at the FIRST statement that throws. The migrate() catch only swallows
--     'already exists' / 'duplicate column' — but the abort still drops every
--     statement AFTER the thrower. So:
--   * meta_leads is intentionally OMITTED — it already exists in the 001 base CREATE.
--     Including it would throw "duplicate column" on the very first run and abort the
--     five real columns below.
--   * On re-run (columns already present) the first ALTER throws "duplicate column",
--     which the catch swallows — harmless; the columns are already there.
ALTER TABLE weekly_reports ADD COLUMN google_ads_leads INTEGER DEFAULT 0;
ALTER TABLE weekly_reports ADD COLUMN lsa_leads        INTEGER DEFAULT 0;
ALTER TABLE weekly_reports ADD COLUMN gbp_leads        INTEGER DEFAULT 0;
ALTER TABLE weekly_reports ADD COLUMN organic_leads    INTEGER DEFAULT 0;
ALTER TABLE weekly_reports ADD COLUMN appointments     INTEGER DEFAULT 0;

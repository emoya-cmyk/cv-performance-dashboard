-- Phase 4 — alert execution: make fired_alerts idempotent.
--
-- The eval→fire loop runs on every heartbeat/cron tick, so it must not re-fire
-- the same rule for the same client/metric/period. We add a natural dedup key
-- (client_id : metric : period) and a UNIQUE index so a second evaluation in the
-- same window is a no-op insert (ON CONFLICT DO NOTHING).
--
-- Existing rows have a NULL dedup_key. NULLs are DISTINCT in a UNIQUE index on
-- both Postgres and SQLite, so a plain (non-partial) unique index lets unlimited
-- legacy NULL rows coexist while still deduping every keyed alert — and, unlike a
-- partial index, it is a valid ON CONFLICT (dedup_key) target.
ALTER TABLE fired_alerts ADD COLUMN IF NOT EXISTS dedup_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_fired_alerts_dedup_key
  ON fired_alerts (dedup_key);

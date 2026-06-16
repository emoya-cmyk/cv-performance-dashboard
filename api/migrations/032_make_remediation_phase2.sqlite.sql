-- SQLite mirror of 032_make_remediation_phase2.sql. The migration runner
-- swallows "duplicate column" so the ADD COLUMN is safe to re-run.

CREATE TABLE IF NOT EXISTS make_scenario_confidence (
  scenario_id  TEXT    PRIMARY KEY,
  confidence   REAL    NOT NULL DEFAULT 0.5,
  frozen       INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE make_remediation_log ADD COLUMN batched_notified INTEGER DEFAULT 0;

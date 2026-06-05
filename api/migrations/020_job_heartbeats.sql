-- ============================================================
-- 020 — Autonomy-loop heartbeat ledger  (Postgres)
-- ------------------------------------------------------------
-- The self-healing engine (scheduler.js + lib/heartbeat.js) runs FOUR scheduled
-- job-classes — sync (6h), watchdog (15m), insights (daily), digest (weekly) — and
-- until now each one only console.log'd. Nothing was persisted, so the tool could
-- not answer the single most important operational question an agency or executive
-- asks of an "autonomous" system: *is the engine actually alive and on-cadence, or
-- has it silently been dead for days?*
--
-- Existing tables don't answer it:
--   • health_score_history (017) is PER-CLIENT triage score — not engine liveness.
--   • sync_runs (001) is PER-(client,channel) sync attempts — the watchdog, the
--     nightly insights sweep, and the weekly digest leave NO trace anywhere.
--
-- This table is that missing ledger. Each job-class writes ONE row when it finishes
-- a run (success | partial | error), with how long it took and a small PII-free
-- JSON summary of counts. The read side (lib/opsHealth.assessOps) takes the latest
-- row per job, compares its age to that job's expected cadence, and grades each as
-- live | overdue | stale | never — so "the engine is alive and on time" becomes a
-- provable, surfaced fact instead of an act of faith. Overdue-detection is itself a
-- self-healing signal: the loop can see its OWN heartbeat has stopped.
--
--   job          — 'sync' | 'watchdog' | 'insights' | 'digest' (the job-class).
--   status       — 'success' | 'partial' | 'error' (the run's own outcome).
--   ran_at       — when the run finished; the read side measures age from this.
--   duration_ms  — wall-clock of the run, for a "typical runtime" readout.
--   detail       — JSON string of run counts (e.g. {"healed":2,"scanned":11}).
--                  NEVER client PII — only aggregate machine counters. TEXT (not
--                  JSONB) so the same JSON.stringify write path serves both dialects
--                  with no per-driver casting; the reader JSON.parses it in JS.
--
-- Append-only audit trail: one row per run. The (job, ran_at DESC) index serves the
-- only read — "latest run per job" + a trailing window for heal counts. Idempotent:
-- CREATE … IF NOT EXISTS, safe to re-run on every boot.
-- ============================================================

CREATE TABLE IF NOT EXISTS job_heartbeats (
  id          BIGSERIAL   PRIMARY KEY,
  job         TEXT        NOT NULL,
  status      TEXT        NOT NULL,
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  duration_ms INTEGER,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS job_heartbeats_job_time
  ON job_heartbeats (job, ran_at DESC);

-- ============================================================
-- 017 — Per-sweep health-score history  (Postgres)
-- ------------------------------------------------------------
-- intel-v4 (5b). Every other intelligence layer is REACTIVE: lib/health.js scores
-- where a client stands TODAY off the CURRENT active findings — a strict point-in-
-- time computation with no memory. lib/trajectory.js can look that health FORWARD
-- and warn "this one is still green but sliding toward at_risk in three weeks" — but
-- only given a SERIES of past scores to project. Nothing persisted that series:
-- health was recomputed from the live feed each read and thrown away. This table is
-- the missing memory. After each nightly sweep the engine writes one row per client
-- (the score it just computed), so trajectory finally has a past to read.
--
-- Cold-start is honest by construction: a fresh install has no history, so the
-- early-warning layer no-ops and the portfolio renders exactly as before; it
-- SHARPENS the longer the tool runs — the self-improving mandate made literal.
--
--   client_id  — FK to clients, CASCADE so a removed client's history goes with it.
--   scored_at  — the sweep timestamp; every client in one sweep shares it (clean
--                series alignment), so ORDER BY scored_at is a true sweep ordering.
--   score      — the 0–100 health score (lib/health.scoreClient) at that sweep.
--   band       — the band label (healthy|watch|at_risk|critical) at that sweep,
--                stored alongside so a reader needn't recompute the cutoffs.
--
-- Append-only: one row per (client, sweep). The read side (getPortfolioTrajectory)
-- takes the trailing N per client, so the table simply accretes an audit trail; the
-- (client_id, scored_at) index serves exactly that trailing-window read.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS; safe to re-run on every boot.
-- ============================================================

CREATE TABLE IF NOT EXISTS health_score_history (
  id         BIGSERIAL   PRIMARY KEY,
  client_id  UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  scored_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  score      INTEGER     NOT NULL,
  band       TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS health_score_history_client_time
  ON health_score_history (client_id, scored_at);

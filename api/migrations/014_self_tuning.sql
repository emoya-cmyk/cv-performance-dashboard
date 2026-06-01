-- ============================================================
-- 014 — Self-tuning loop: forecast_grades + metric_calibration  (Postgres)
-- ------------------------------------------------------------
-- The self-IMPROVING half of the intelligence engine. 013 gave each client a
-- self-calibrating sense of "normal"; this lets the engine grade its OWN forward
-- projections against reality and re-tune itself from the result — no operator in
-- the loop, the data does the tuning.
--
--   forecast_grades — an append-once ledger of every month-end projection the
--     engine published, the naive run-rate it had to beat, and (once the month
--     closes) the realized actual. From those three we derive the model error,
--     the naive error, the signed bias, and a model-beat-naive flag. This is the
--     honest scoreboard: a projection is locked in with real forward lead time
--     (insert-once per client/metric/month), never back-filled after the fact.
--
--   metric_calibration — the readback the engine consumes on the next sweep:
--     per-(client, metric) forecast warn/crit gates plus a projection bias-
--     correction factor, derived from that client's realized track record
--     (lib/selftune.js). A trustworthy track record earns tighter gates; a noisy
--     one earns wider gates; a persistent over/under-projection bias is corrected
--     automatically. Below a minimum sample count the row is neutral (a no-op).
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout; safe to re-run on every boot.
-- ============================================================

-- ── forecast_grades ─ append-once projection ledger, graded once month closes ─
CREATE TABLE IF NOT EXISTS forecast_grades (
  id                  BIGSERIAL   PRIMARY KEY,
  client_id           UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  metric              TEXT        NOT NULL,
  month               DATE        NOT NULL,                 -- first day of the projected month
  as_of               DATE,                                 -- day the projection was locked in (lead time)
  projected_total     NUMERIC,                              -- published (bias-corrected) Holt landing
  naive_projected     NUMERIC,                              -- naive MTD run-rate — the baseline it must beat
  target              NUMERIC,                              -- the month's goal at projection time
  actual_total        NUMERIC,                              -- realized month total (NULL = not yet graded)
  abs_pct_error       NUMERIC,                              -- |projected - actual| / |actual|
  naive_abs_pct_error NUMERIC,                              -- |naive - actual| / |actual|
  bias                NUMERIC,                              -- (projected - actual) / actual, signed (+ = over)
  model_won           BOOLEAN,                              -- did Holt beat (or tie) naive? NULL if ungradeable
  graded_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (client_id, metric, month)                         -- insert-once arbiter
);

CREATE INDEX IF NOT EXISTS ix_fcgrades_due        ON forecast_grades (client_id, month);
CREATE INDEX IF NOT EXISTS ix_fcgrades_scoreboard ON forecast_grades (client_id, metric);

-- ── metric_calibration ─ per-client/metric learned gates + bias correction ────
CREATE TABLE IF NOT EXISTS metric_calibration (
  client_id   UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  metric      TEXT        NOT NULL,
  grain       TEXT        NOT NULL DEFAULT 'month',
  warn_ratio  NUMERIC,                                      -- forecast warning gate (projected pct-of-goal)
  crit_ratio  NUMERIC,                                      -- forecast critical gate (projected pct-of-goal)
  bias_factor NUMERIC     NOT NULL DEFAULT 1,               -- multiply raw projection → bias-corrected landing
  trust       NUMERIC,                                      -- 0..1 confidence behind the gates
  mape        NUMERIC,                                      -- realized mean abs pct error (fraction, not %)
  samples     INTEGER     NOT NULL DEFAULT 0,               -- graded months behind the calibration
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, metric, grain)
);

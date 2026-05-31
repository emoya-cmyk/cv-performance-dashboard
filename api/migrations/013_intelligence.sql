-- ============================================================
-- 013 — Intelligence layer v2: metric_baselines + insights  (Postgres)
-- ------------------------------------------------------------
-- Foundation for the autonomous, self-calibrating intelligence engine.
--
--   metric_baselines — a cached, per-(client, metric) rolling statistical
--     profile (median / MAD / mean / σ / trend / EWMA). Replaces the hard-coded
--     "flag any ±15%" constant: "unusual" is now measured against each client's
--     OWN history. Recomputed by the nightly sweep; the PK is the upsert arbiter.
--
--   insights — the persisted, deduped insight feed that powers the dashboard for
--     clients, agencies, and internal users alike. One row per distinct finding
--     (anomaly / trend / pacing / forecast / mix_shift / recommendation),
--     idempotent on `fingerprint` so re-running a sweep refreshes a finding in
--     place instead of piling up duplicates. `evidence` is a numbers-only pack so
--     any narrative can be re-verified against the figures that produced it —
--     the same grounding guarantee the recap layer already enforces.
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout; safe to re-run on every boot.
-- ============================================================

-- ── metric_baselines ─ per-client/metric rolling statistical profile ─────────
CREATE TABLE IF NOT EXISTS metric_baselines (
  client_id   UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  metric      TEXT        NOT NULL,
  grain       TEXT        NOT NULL DEFAULT 'week',   -- week | month
  n           INTEGER     NOT NULL DEFAULT 0,        -- history points behind the band
  mean        NUMERIC,
  std         NUMERIC,
  median      NUMERIC,
  mad         NUMERIC,                               -- median absolute deviation
  robust_std  NUMERIC,                               -- 1.4826 * mad (σ-scaled), σ fallback
  slope       NUMERIC,                               -- least-squares trend per period
  ewma        NUMERIC,                               -- exponentially-weighted level
  latest      NUMERIC,                               -- most recent observed value
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, metric, grain)
);

-- ── insights ─ persisted, deduped, lifecycle-tracked finding feed ────────────
CREATE TABLE IF NOT EXISTS insights (
  id           BIGSERIAL   PRIMARY KEY,
  client_id    UUID        REFERENCES clients(id) ON DELETE CASCADE,  -- NULL = portfolio scope
  scope        TEXT        NOT NULL DEFAULT 'client',                 -- client | portfolio
  kind         TEXT        NOT NULL,                                  -- anomaly | trend | pacing | forecast | mix_shift | recommendation
  metric       TEXT,                                                  -- revenue | leads | spend | roas | cpl | close_rate | jobs | ...
  severity     TEXT        NOT NULL DEFAULT 'info',                   -- info | warning | critical
  direction    TEXT,                                                  -- up | down | flat
  score        NUMERIC     NOT NULL DEFAULT 0,                        -- ranking score (|z|, pacing gap, …)
  title        TEXT        NOT NULL,
  detail       TEXT,                                                  -- grounded narrative or deterministic template
  evidence     JSONB       NOT NULL DEFAULT '{}',                     -- numbers-only pack for audit / re-verify
  fingerprint  TEXT        NOT NULL UNIQUE,                           -- dedupe key + ON CONFLICT arbiter
  period_start DATE,                                                  -- the week/period the finding is about
  status       TEXT        NOT NULL DEFAULT 'open',                   -- open | acknowledged | resolved | expired
  model        TEXT,                                                  -- model id that wrote detail, or 'template'
  grounded     BOOLEAN     NOT NULL DEFAULT false,                    -- did detail pass the grounding verifier
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_insights_client ON insights (client_id, status);
CREATE INDEX IF NOT EXISTS ix_insights_open   ON insights (status, severity, score);
CREATE INDEX IF NOT EXISTS ix_insights_period ON insights (period_start);

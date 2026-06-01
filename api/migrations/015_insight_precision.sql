-- ============================================================
-- 015 — Precision loop: insight_precision  (Postgres)
-- ------------------------------------------------------------
-- The SECOND self-improving organ (014 was the first). 014's metric_calibration
-- learns how ACCURATE the engine's forecasts are and re-tunes the forecast gates.
-- This learns something complementary and entirely free: how USEFUL each KIND of
-- finding has proven to a given client. The signal costs nobody a survey — it is
-- the insight LIFECYCLE itself. A human who acknowledges or resolves a finding
-- engaged with it; one that auto-expires untouched was ignored. lib/precision.js
-- rolls that history into a per-signature CONFIDENCE (Beta-Bernoulli shrunk toward
-- the client's own base rate) and a feed-rank WEIGHT, so an alert type a client
-- repeatedly acts on rises and one they always ignore sinks — with ZERO hand-tuned
-- threshold. That is the "self-improving" the product goal asks for: the
-- intelligence layer reads its own audience and sharpens itself.
--
--   insight_precision — per-(client, signature) learned usefulness. `signature` is
--     `kind::metric` (metric '*' for metric-less kinds like data_health) — the grain
--     a client's taste is learned at. engaged/ignored/n are the raw decided tallies;
--     confidence is the posterior mean in [0,1]; band is its discrete label; weight
--     is the [0.6,1.4] feed multiplier the ranker nudges score by WITHIN a severity
--     tier (the consumer exempts data_health + critical so keystones never sink).
--
-- Mirror of metric_calibration's shape + ON CONFLICT upsert so the same persistence
-- discipline (idempotent, derived-not-authored, neutral below evidence) carries over.
-- A client with no decided history simply has no rows here → the feed reads a neutral
-- 1.0 weight → ranking is byte-identical to before the loop existed.
--
-- Idempotent: CREATE ... IF NOT EXISTS; safe to re-run on every boot.
-- ============================================================

CREATE TABLE IF NOT EXISTS insight_precision (
  client_id   UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  signature   TEXT        NOT NULL,                 -- `${kind}::${metric || '*'}`
  kind        TEXT        NOT NULL,
  metric      TEXT,                                 -- NULL for metric-less kinds (data_health)
  engaged     INTEGER     NOT NULL DEFAULT 0,       -- decided + acknowledged/resolved
  ignored     INTEGER     NOT NULL DEFAULT 0,       -- decided + auto-expired untouched
  n           INTEGER     NOT NULL DEFAULT 0,       -- engaged + ignored (the denominator)
  confidence  NUMERIC,                              -- Beta-Bernoulli posterior mean, [0,1]
  band        TEXT,                                 -- 'low' | 'medium' | 'high'
  weight      NUMERIC     NOT NULL DEFAULT 1,       -- feed-rank multiplier, [0.6,1.4] (1 = neutral)
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, signature)
);

-- ============================================================
-- 012 — ai_recaps: persisted weekly grounded narrative per client  (Postgres)
-- ------------------------------------------------------------
-- Sprint 1 of the Grounded AI layer. Stores ONE recap per (client, week):
-- a plain-English narrative grounded strictly in a deterministic evidence
-- pack (see api/lib/evidence.js). The LLM only narrates the pack — code
-- computes every number, so the model never calculates or sees raw rows it
-- could misread. evidence_pack is persisted for audit / re-verification.
--
--   model    = the model id that produced recap_text, or 'template' for the
--              no-key / verifier-failure deterministic fallback.
--   grounded = did recap_text pass the grounding verifier (every number
--              traceable to the evidence pack). The template fallback is
--              trivially grounded = true.
--
-- Idempotent: PRIMARY KEY (client_id, week_start) is the ON CONFLICT arbiter
-- for the upsert in api/lib/recap.js, so re-generating a week overwrites in
-- place. CREATE ... IF NOT EXISTS so the whole file is safe to re-run on boot.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_recaps (
  client_id     UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  week_start    DATE        NOT NULL,
  model         TEXT,
  evidence_pack JSONB       NOT NULL DEFAULT '{}',
  recap_text    TEXT,
  grounded      BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, week_start)
);

CREATE INDEX IF NOT EXISTS ix_ai_recaps_week
  ON ai_recaps (week_start);

-- ============================================================
-- 018 — ai_briefs: persisted daily grounded "morning brief" per scope  (Postgres)
-- ------------------------------------------------------------
-- The daily analog of ai_recaps (012). Where a recap narrates a completed
-- WEEK for one client, a brief narrates a single DAY's pulse — and a brief can
-- be written for either audience:
--   * a client morning brief   (one client's pulse),               or
--   * the agency portfolio brief (the whole book's pulse).
--
-- Because the portfolio brief has no single client, the table is keyed on a
-- text `scope_key`, NOT on client_id:
--   scope_key = the client id            (audience='client'),  or
--             = the literal '__portfolio__' sentinel (audience='agency').
--   as_of     = the calendar day the brief narrates (the pulse's as_of).
-- client_id is a reference-only FK that is NULL for the portfolio brief, so it
-- can never be part of the key. Like ai_recaps, the LLM only narrates a
-- deterministic evidence pack (see api/lib/pulseBrief.js) — code computes every
-- number — and `pack` is persisted for audit / re-verification.
--
--   model    = the model id that produced brief_text, or 'template' for the
--              no-key / verifier-failure deterministic fallback.
--   grounded = did brief_text pass the grounding verifier (every number
--              traceable to the pack). The template fallback is trivially true.
--
-- Idempotent: PRIMARY KEY (scope_key, as_of) is the ON CONFLICT arbiter for the
-- upsert in api/lib/brief.js, so re-generating a day overwrites in place.
-- CREATE ... IF NOT EXISTS so the whole file is safe to re-run on boot.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_briefs (
  scope_key   TEXT        NOT NULL,
  as_of       DATE        NOT NULL,
  audience    TEXT        NOT NULL DEFAULT 'client',
  client_id   UUID        REFERENCES clients(id) ON DELETE CASCADE,
  model       TEXT,
  pack        JSONB       NOT NULL DEFAULT '{}',
  brief_text  TEXT,
  grounded    BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope_key, as_of)
);

CREATE INDEX IF NOT EXISTS ix_ai_briefs_as_of
  ON ai_briefs (as_of);

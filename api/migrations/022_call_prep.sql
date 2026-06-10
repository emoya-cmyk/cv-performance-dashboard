-- 022: AI call prep talking points
-- Stores structured talking-point packs per (client, week) so the LLM is
-- called at most once per client-week and the result is replayable.

CREATE TABLE IF NOT EXISTS ai_call_preps (
  id          SERIAL      PRIMARY KEY,
  client_id   UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  week_start  DATE        NOT NULL,
  call_prep   JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_ai_call_preps_client_week
  ON ai_call_preps(client_id, week_start DESC);

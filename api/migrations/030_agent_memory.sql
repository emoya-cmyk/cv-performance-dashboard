CREATE TABLE IF NOT EXISTS agent_memory (
  id            SERIAL       PRIMARY KEY,
  client_id     TEXT,                                   -- NULL = agency-wide
  kind          TEXT         NOT NULL,
  content       TEXT         NOT NULL,
  source        TEXT         NOT NULL,                  -- policy|user|fact|derived|ai|history
  authority     INTEGER      NOT NULL,                  -- precedence tier (derived from source)
  confidence    NUMERIC      NOT NULL DEFAULT 1.0,
  evidence_ref  TEXT,                                   -- pointer to grounding facts, or NULL
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- last reinforced (decay anchor)
  expires_at    TIMESTAMPTZ,                            -- hard TTL; NULL = never expires
  forgotten_at  TIMESTAMPTZ                             -- soft-delete; NULL = live
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory (client_id, kind, created_at);

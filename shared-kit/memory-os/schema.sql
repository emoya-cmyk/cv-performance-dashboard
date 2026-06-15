-- @emoya-cmyk/memory-os — Postgres schema.
CREATE TABLE IF NOT EXISTS agent_memory (
  id            SERIAL       PRIMARY KEY,
  client_id     TEXT,                                   -- NULL = agency-wide
  kind          TEXT         NOT NULL,
  content       TEXT         NOT NULL,
  source        TEXT         NOT NULL,                  -- policy|user|fact|derived|ai|history
  authority     INTEGER      NOT NULL,
  confidence    NUMERIC      NOT NULL DEFAULT 1.0,
  evidence_ref  TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    TIMESTAMPTZ,
  forgotten_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory (client_id, kind, created_at);

CREATE TABLE IF NOT EXISTS agent_memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     TEXT,                                   -- NULL = agency-wide
  kind          TEXT    NOT NULL,
  content       TEXT    NOT NULL,
  source        TEXT    NOT NULL,                       -- policy|user|fact|derived|ai|history
  authority     INTEGER NOT NULL,                       -- precedence tier (derived from source)
  confidence    REAL    NOT NULL DEFAULT 1.0,
  evidence_ref  TEXT,                                   -- pointer to grounding facts, or NULL
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),  -- last reinforced (decay anchor)
  expires_at    TEXT,                                   -- hard TTL; NULL = never expires
  forgotten_at  TEXT                                    -- soft-delete; NULL = live
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory (client_id, kind, created_at);

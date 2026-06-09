-- 022: AI call prep talking points (SQLite)

CREATE TABLE IF NOT EXISTS ai_call_preps (
  id          INTEGER  PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT     NOT NULL,
  week_start  TEXT     NOT NULL,
  call_prep   TEXT     NOT NULL DEFAULT '{}',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(client_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_ai_call_preps_client_week
  ON ai_call_preps(client_id, week_start);

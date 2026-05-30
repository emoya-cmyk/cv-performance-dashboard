-- ============================================================
-- 010 (SQLite) — atomic grain siblings for dim_channel, dim_entity, fact_metric.
-- ------------------------------------------------------------
-- Mirrors 010_atomic_grain.sql with SQLite-native types (no BIGSERIAL/UUID/
-- JSONB/SMALLINT/DATE). The SQLite migration runner uses THIS file instead of
-- the Postgres 010 and executes it whole via conn.exec().
--   UUID      → TEXT        DATE   → TEXT (ISO 'YYYY-MM-DD')
--   BIGSERIAL → INTEGER PK  JSONB  → TEXT (JSON string)
--   SMALLINT  → INTEGER     NUMERIC→ NUMERIC affinity
-- The COALESCE(entity_id,0) unique index works identically in SQLite, so the
-- ingest upsert can target the same ON CONFLICT grain on both backends.
-- ============================================================

CREATE TABLE IF NOT EXISTS dim_channel (
  id       INTEGER PRIMARY KEY,
  key      TEXT    UNIQUE NOT NULL,
  label    TEXT    NOT NULL,
  category TEXT
);

CREATE TABLE IF NOT EXISTS dim_entity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel_id  INTEGER NOT NULL REFERENCES dim_channel(id),
  entity_type TEXT    NOT NULL,
  external_id TEXT    NOT NULL,
  parent_id   INTEGER REFERENCES dim_entity(id),
  name        TEXT,
  status      TEXT,
  attrs       TEXT    NOT NULL DEFAULT '{}',
  UNIQUE (client_id, channel_id, entity_type, external_id)
);

CREATE INDEX IF NOT EXISTS ix_entity_client_channel
  ON dim_entity (client_id, channel_id);

CREATE TABLE IF NOT EXISTS fact_metric (
  client_id    TEXT    NOT NULL,
  date         TEXT    NOT NULL,
  channel_id   INTEGER NOT NULL REFERENCES dim_channel(id),
  entity_id    INTEGER REFERENCES dim_entity(id),
  metric_key   TEXT    NOT NULL,
  metric_value NUMERIC NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fact_grain
  ON fact_metric (client_id, date, channel_id, COALESCE(entity_id, 0), metric_key);
CREATE INDEX IF NOT EXISTS ix_fact_client_date
  ON fact_metric (client_id, date);
CREATE INDEX IF NOT EXISTS ix_fact_client_metric
  ON fact_metric (client_id, metric_key, date);
CREATE INDEX IF NOT EXISTS ix_fact_entity
  ON fact_metric (entity_id);

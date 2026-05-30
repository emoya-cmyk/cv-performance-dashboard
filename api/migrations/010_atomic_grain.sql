-- ============================================================
-- 010 — Atomic grain: dim_channel, dim_entity, fact_metric  (Postgres)
-- ------------------------------------------------------------
-- Phase 0 of the analytical rebuild. Stops discarding granularity at
-- ingest: connectors now land daily, entity-level, tidy facts here.
-- weekly_reports stays alive as a DERIVED rollup (see api/lib/rollup.js),
-- so metrics.js and the current frontend keep working untouched.
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout. The Postgres runner
-- executes this whole file in one implicit transaction on every boot,
-- so every statement must be safe to re-run. dim_channel is seeded in 011.
-- ============================================================

-- ── dim_channel ─ static channel dimension (seeded in 011) ──────────────────
CREATE TABLE IF NOT EXISTS dim_channel (
  id       SMALLINT PRIMARY KEY,
  key      TEXT     UNIQUE NOT NULL,   -- google_ads, meta, lsa, gbp, ga4, ghl, organic
  label    TEXT     NOT NULL,
  category TEXT                        -- paid | local | crm | organic
);

-- ── dim_entity ─ account / campaign / ad_group / ad / keyword hierarchy ─────
CREATE TABLE IF NOT EXISTS dim_entity (
  id          BIGSERIAL PRIMARY KEY,
  client_id   UUID     NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel_id  SMALLINT NOT NULL REFERENCES dim_channel(id),
  entity_type TEXT     NOT NULL,       -- account | campaign | ad_group | ad | keyword
  external_id TEXT     NOT NULL,       -- platform-assigned id
  parent_id   BIGINT   REFERENCES dim_entity(id),
  name        TEXT,
  status      TEXT,
  attrs       JSONB    NOT NULL DEFAULT '{}',  -- geo, device, service_type, …
  UNIQUE (client_id, channel_id, entity_type, external_id)
);

CREATE INDEX IF NOT EXISTS ix_entity_client_channel
  ON dim_entity (client_id, channel_id);

-- ── fact_metric ─ atomic tidy/long fact. New metric = new ROW, no migration ─
-- entity_id NULL = channel/account grain.
-- NOTE: Postgres forbids expressions in a table PRIMARY KEY, so the grain's
-- uniqueness (which must treat NULL entity_id as a single "account" bucket)
-- is enforced by a UNIQUE INDEX on COALESCE(entity_id,0). That index is also
-- the ON CONFLICT arbiter the ingest upsert infers against.
CREATE TABLE IF NOT EXISTS fact_metric (
  client_id    UUID     NOT NULL,
  date         DATE     NOT NULL,
  channel_id   SMALLINT NOT NULL REFERENCES dim_channel(id),
  entity_id    BIGINT   REFERENCES dim_entity(id),
  metric_key   TEXT     NOT NULL,
  metric_value NUMERIC  NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fact_grain
  ON fact_metric (client_id, date, channel_id, COALESCE(entity_id, 0), metric_key);
CREATE INDEX IF NOT EXISTS ix_fact_client_date
  ON fact_metric (client_id, date);
CREATE INDEX IF NOT EXISTS ix_fact_client_metric
  ON fact_metric (client_id, metric_key, date);
CREATE INDEX IF NOT EXISTS ix_fact_entity
  ON fact_metric (entity_id);
-- When volume warrants: PARTITION BY RANGE (date) monthly + per-month indexes.

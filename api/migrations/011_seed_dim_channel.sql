-- ============================================================
-- 011 — Seed dim_channel (Postgres)
-- ------------------------------------------------------------
-- Static channel rows referenced by dim_entity.channel_id and fact_metric.
-- The id values are STABLE and code-referenced (api/lib/facts.js CHANNEL_ID),
-- so never renumber them — only append new channels with a fresh id.
--
-- Single ON CONFLICT statement → safe to re-run. SQLite uses the explicit
-- 011_seed_dim_channel.sqlite.sql sibling instead: the plain-.sql splitter
-- drops a single comment-prefixed statement, which would skip this seed.
-- ============================================================
INSERT INTO dim_channel (id, key, label, category) VALUES
  (1, 'google_ads', 'Google Ads',               'paid'),
  (2, 'meta',       'Meta Ads',                  'paid'),
  (3, 'lsa',        'Local Services Ads',        'local'),
  (4, 'gbp',        'Google Business Profile',   'local'),
  (5, 'ga4',        'Google Analytics 4',        'organic'),
  (6, 'ghl',        'GHL CRM',                   'crm'),
  (7, 'organic',    'Organic',                   'organic')
ON CONFLICT (id) DO NOTHING;

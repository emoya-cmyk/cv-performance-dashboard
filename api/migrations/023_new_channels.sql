-- ============================================================
-- 023 — Seed additional channels (Postgres)
-- ------------------------------------------------------------
-- Appends CallRail, HouseCall Pro, Bing Ads, YouTube to dim_channel.
-- IDs 1-7 are locked (011_seed_dim_channel). Never renumber; only append.
-- ON CONFLICT DO NOTHING → safe to re-run.
-- ============================================================
INSERT INTO dim_channel (id, key, label, category) VALUES
  (8,  'callrail',     'CallRail',             'tracking'),
  (9,  'housecallpro', 'HouseCall Pro',         'crm'),
  (10, 'bing_ads',     'Microsoft / Bing Ads',  'paid'),
  (11, 'youtube',      'YouTube Ads',           'paid')
ON CONFLICT (id) DO NOTHING;

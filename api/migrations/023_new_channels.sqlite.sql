-- 023 — Seed additional channels (SQLite)
INSERT OR IGNORE INTO dim_channel (id, key, label, category) VALUES
  (8,  'callrail',     'CallRail',             'tracking'),
  (9,  'housecallpro', 'HouseCall Pro',         'crm'),
  (10, 'bing_ads',     'Microsoft / Bing Ads',  'paid'),
  (11, 'youtube',      'YouTube Ads',           'paid');

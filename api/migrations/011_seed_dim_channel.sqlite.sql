-- 011 (SQLite) — seed dim_channel.
-- Required as an explicit sibling: the SQLite runner's plain-.sql splitter
-- drops any chunk whose trimmed text starts with '--', and the Postgres 011 is
-- a single INSERT preceded by a comment block (one chunk) → it would be skipped
-- and dim_channel left empty. conn.exec() here runs the file whole, comments OK.
-- Keep ids in sync with 011_seed_dim_channel.sql and api/lib/facts.js CHANNEL_ID.
INSERT INTO dim_channel (id, key, label, category) VALUES
  (1, 'google_ads', 'Google Ads',               'paid'),
  (2, 'meta',       'Meta Ads',                  'paid'),
  (3, 'lsa',        'Local Services Ads',        'local'),
  (4, 'gbp',        'Google Business Profile',   'local'),
  (5, 'ga4',        'Google Analytics 4',        'organic'),
  (6, 'ghl',        'GHL CRM',                   'crm'),
  (7, 'organic',    'Organic',                   'organic')
ON CONFLICT (id) DO NOTHING;

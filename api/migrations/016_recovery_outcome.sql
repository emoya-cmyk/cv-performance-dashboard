-- ============================================================
-- 016 — Recovery outcome stamp on insights  (Postgres)
-- ------------------------------------------------------------
-- intel-v4 (3b). expireStale() closes a finding the moment its condition stops
-- holding, but "stopped holding" hides two opposite stories (see lib/outcomes.js):
--   • RECOVERED — the metric climbed back to baseline, the dark channel reconnected.
--     The finding did its job; the problem is GONE. A win.
--   • LAPSED    — the finding merely aged out with no proof the problem improved.
-- The precision loop (deriveAndPersistPrecision) read EVERY expiry as "ignored,"
-- so a correct finding whose problem then got fixed was counted AGAINST that kind's
-- confidence — exactly backwards. markRecoveries() now classifies each about-to-
-- expire finding and stamps the genuine wins with status='recovered', recording
-- WHY here so 3c can surface "here's what we fixed" to all three audiences.
--
--   recovery_reason — the verdict reason from classifyRecovery()
--     ('metric_returned_to_baseline' | 'channel_reconnected'); NULL for every
--     finding that simply expired.
--   recovered_at    — when the sweep recorded the recovery; NULL unless recovered.
--
-- Both nullable + additive: a finding that never recovers is byte-identical to
-- before this migration. status itself has no CHECK constraint (013) so the new
-- 'recovered' value needs no constraint change — only these two stamp columns.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; safe to re-run on every boot.
-- ============================================================

ALTER TABLE insights ADD COLUMN IF NOT EXISTS recovery_reason TEXT;
ALTER TABLE insights ADD COLUMN IF NOT EXISTS recovered_at    TIMESTAMPTZ;

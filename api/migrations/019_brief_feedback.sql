-- ============================================================
-- 019 — brief_feedback: the consumer's own vote on their morning brief  (Postgres)
-- ------------------------------------------------------------
-- intel-v8 layer 18 — the dashboard's FIRST outward-facing loop. Layers 10-17 are
-- all inward self-governance (does the narrator still write? are leads holding up?
-- is the lead policy stable / governed / audited / remediated?). NONE of them ever
-- asks the one question only the reader can answer: did the human find the brief
-- USEFUL? This table captures exactly that — one 👍/👎 per client per morning —
-- and lib/briefEngagement.js rolls it into a helpful_rate the agency can learn from.
--
--   client_id — the CONSUMER who voted. A client only ever rates their OWN morning
--     brief, so the row is keyed by the client, never by a free-text scope: there is
--     no consumer behind the agency portfolio brief, so it is never voted on here.
--   as_of     — the calendar day of the brief that was rated (the brief's own as_of).
--   signal    — 'helpful' | 'not_helpful'. The write route validates the value and
--     lib/briefEngagement.js treats any other token as an ignored non-vote, so a bad
--     value can never inflate either side of the rate — defence-in-depth, no CHECK.
--
-- PRIMARY KEY (client_id, as_of) is the ON CONFLICT arbiter for the upsert in
-- lib/briefEngagementEngine.js: one vote per client per day, and re-voting (👍→👎 or
-- back) OVERWRITES in place — the reversible-upsert the layer needs, never a pile-up.
-- Mirrors the (scope_key, as_of) discipline of ai_briefs (018): idempotent, derived
-- from a single human action, keyed so a re-submit is a correction, not a duplicate.
--
-- PRIVACY INVARIANT (load-bearing): the AGGREGATE over this table (helpful_rate,
-- per-client grades, trend, churn board) is AGENCY-ONLY. A client may read back ONLY
-- their own row ({ as_of, signal }); they never see another client's vote nor any
-- rollup. lib/briefEngagement.narrateBriefEngagement returns '' for audience 'client'
-- UNCONDITIONALLY, and the routes enforce the same boundary — DB shape + lib + route
-- are three independent guards on the same rule.
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout; safe to re-run on every boot.
-- ============================================================

CREATE TABLE IF NOT EXISTS brief_feedback (
  client_id   UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  as_of       DATE        NOT NULL,
  signal      TEXT        NOT NULL,                  -- 'helpful' | 'not_helpful'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, as_of)
);

-- The agency rollup scans a trailing window across ALL clients (WHERE as_of BETWEEN …),
-- so index the day; the PK already serves the per-client own-vote read.
CREATE INDEX IF NOT EXISTS ix_brief_feedback_as_of
  ON brief_feedback (as_of);

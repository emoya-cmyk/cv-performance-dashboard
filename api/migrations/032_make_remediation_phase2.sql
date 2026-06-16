-- Make.com Remediation Phase 2/3 follow-ups.
--   • make_scenario_confidence — the Wilson-score store deltas are applied to (FR-9)
--   • make_remediation_log.batched_notified — dedup flag for the Tier 1 30-min
--     Slack digest so an event is summarised exactly once (FR-8)

CREATE TABLE IF NOT EXISTS make_scenario_confidence (
  scenario_id  TEXT PRIMARY KEY,
  confidence   DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  frozen       BOOLEAN NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE make_remediation_log ADD COLUMN IF NOT EXISTS batched_notified BOOLEAN DEFAULT false;

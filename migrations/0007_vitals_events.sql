-- Migration 0007: vitals event stream.
-- Move weekly_vitals from per-week upsert (PK=(user_id,iso_week)) to an event log.
-- Each vitals submission becomes a new row in vitals_events.
-- weekly_vitals retained as read-only legacy (no longer written by app code).

CREATE TABLE IF NOT EXISTS vitals_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  measured_at   INTEGER NOT NULL,                -- epoch ms, submission time
  iso_week      TEXT    NOT NULL,                -- derived cache for week-level aggregations
  heart_rate    INTEGER,
  bp_systolic   INTEGER,
  bp_diastolic  INTEGER,
  height_cm     REAL,
  source        TEXT    NOT NULL DEFAULT 'manual', -- 'manual' | 'legacy_weekly' | future 'device'
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vitals_events_user_time ON vitals_events(user_id, measured_at);
CREATE INDEX IF NOT EXISTS idx_vitals_events_user_week ON vitals_events(user_id, iso_week);

-- Backfill existing weekly_vitals rows as the first event point per week.
-- Idempotent guard: skip if vitals_events already has rows tagged legacy_weekly.
INSERT INTO vitals_events (user_id, measured_at, iso_week, heart_rate, bp_systolic, bp_diastolic, height_cm, source, created_at)
SELECT wv.user_id, wv.measured_at, wv.iso_week, wv.heart_rate, wv.bp_systolic, wv.bp_diastolic, wv.height_cm, 'legacy_weekly', wv.measured_at
FROM weekly_vitals wv
WHERE NOT EXISTS (
  SELECT 1 FROM vitals_events ve
  WHERE ve.user_id = wv.user_id AND ve.iso_week = wv.iso_week AND ve.source = 'legacy_weekly'
);

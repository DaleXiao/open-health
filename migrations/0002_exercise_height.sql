-- Migration 0002: exercise log + weekly height calibration.
-- 1. Exercise log table (one entry per user per day)
CREATE TABLE IF NOT EXISTS daily_exercise (
  user_id    INTEGER NOT NULL,
  date       TEXT    NOT NULL,   -- YYYY-MM-DD
  kind       TEXT    NOT NULL,   -- exercise option id
  note       TEXT,               -- optional / required when kind='other'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 2. Allow weekly height calibration (height_cm on vitals row)
ALTER TABLE weekly_vitals ADD COLUMN height_cm REAL;

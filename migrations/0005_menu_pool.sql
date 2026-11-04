-- Migration 0005: pooled menu shuffle.
CREATE TABLE IF NOT EXISTS menu_pool (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  iso_week   TEXT    NOT NULL,
  day        TEXT    NOT NULL,
  meal       TEXT    NOT NULL,
  batch_no   INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  content    TEXT    NOT NULL,
  image_url  TEXT,
  consumed   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, iso_week, day, meal, batch_no, seq),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_menu_pool_next
  ON menu_pool(user_id, iso_week, day, meal, consumed, batch_no, seq);

ALTER TABLE menu_jobs ADD COLUMN menu_pool_id INTEGER REFERENCES menu_pool(id);

-- Backfill current ready menu_jobs as already-consumed pool entries, then point jobs to them.
INSERT OR IGNORE INTO menu_pool (user_id, iso_week, day, meal, batch_no, seq, content, image_url, consumed, created_at)
SELECT user_id, iso_week, day, meal, 1, 0, content_json, image_url, 1, COALESCE(finished_at, started_at, unixepoch() * 1000)
FROM menu_jobs
WHERE content_json IS NOT NULL;

UPDATE menu_jobs
SET menu_pool_id = (
  SELECT p.id FROM menu_pool p
  WHERE p.user_id = menu_jobs.user_id
    AND p.iso_week = menu_jobs.iso_week
    AND p.day = menu_jobs.day
    AND p.meal = menu_jobs.meal
    AND p.batch_no = 1
    AND p.seq = 0
  LIMIT 1
)
WHERE menu_pool_id IS NULL AND content_json IS NOT NULL;

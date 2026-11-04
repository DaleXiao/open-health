-- Migration 0003: async menu job queue + per-meal content.
CREATE TABLE IF NOT EXISTS menu_jobs (
  user_id      INTEGER NOT NULL,
  iso_week     TEXT    NOT NULL,  -- YYYY-Www
  day          TEXT    NOT NULL,  -- Mon|Tue|Wed|Thu|Fri|Sat|Sun
  meal         TEXT    NOT NULL,  -- breakfast|lunch|dinner|snack
  status       TEXT    NOT NULL DEFAULT 'pending',  -- pending|running|ready|failed
  attempt      INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER,
  finished_at  INTEGER,
  error        TEXT,
  content_json TEXT,  -- {name, description, ingredients[], kcal, rationale}
  image_url    TEXT,  -- /menu-img/<key>.webp or null
  PRIMARY KEY (user_id, iso_week, day, meal),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_menu_jobs_pending
  ON menu_jobs(status, started_at)
  WHERE status IN ('pending', 'failed');

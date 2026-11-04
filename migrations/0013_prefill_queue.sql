-- Migration 0013: per-(user, iso_week) prefill continuation queue.
--
-- Replaces the old "per-minute cron scans menu_jobs.status='empty'" model.
-- Entries are written by:
--   (a) nightlyPrefillGuard     — when prefillPoolWeek returns 'partial'
--                                 with remainingDeficits > 0
--   (b) shuffleMealJob          — when the pool is exhausted, so the
--                                 slot can refill within minutes instead
--                                 of waiting for the next 03:00 guard
--
-- A separate `*/10 * * * *` cron drains rows whose next_run_at ≤ now, calls
-- prefillPoolWeek slice (CHUNK_OUTER = MAX_SLOTS_PER_TICK), and either
-- DELETEs the row on full completion or bumps next_run_at + attempts on
-- partial. UNIQUE(user_id, iso_week) makes (a) and (b) collapse — a second
-- enqueue while an entry is pending is a no-op.
--
-- Apply:
--   wrangler d1 execute health_db --remote --file=migrations/0013_prefill_queue.sql

CREATE TABLE IF NOT EXISTS prefill_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  iso_week     TEXT    NOT NULL,
  enqueued_at  INTEGER NOT NULL,
  next_run_at  INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  UNIQUE(user_id, iso_week)
);

CREATE INDEX IF NOT EXISTS idx_prefill_queue_next_run
  ON prefill_queue(next_run_at);

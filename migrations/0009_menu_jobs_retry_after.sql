-- Migration 0009: retry backoff for menu_jobs.
-- Adds retry_after (ms epoch). When a job fails, processOneJob writes:
--   attempt=1 → retry_after = now + 5 minutes
--   attempt=2 → retry_after = now + 15 minutes
-- The picker filters out rows whose retry_after is in the future, so a
-- single transient dashscope blip no longer burns all 3 attempts inside
-- a few cron ticks.
-- NULL means "no backoff scheduled" (fresh row or successfully recovered).

ALTER TABLE menu_jobs ADD COLUMN retry_after INTEGER;

-- Picker index extended to cover retry_after for cheap range filtering.
DROP INDEX IF EXISTS idx_menu_jobs_pending;
CREATE INDEX IF NOT EXISTS idx_menu_jobs_pending
  ON menu_jobs(status, retry_after, started_at)
  WHERE status IN ('pending', 'failed');

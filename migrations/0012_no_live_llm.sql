-- Migration 0012: remove live LLM calls entirely — menu_jobs status simplifies
-- to a ready/empty two-state model.
--
-- Run BEFORE the new worker rolls out (or simultaneously — both states are
-- understood by the new code path; the old code path tolerated 'empty' via the
-- generic non-'ready' branch).
--
--   wrangler d1 execute health_db --remote --file=migrations/0012_no_live_llm.sql

-- (1) Normalize statuses: pending / running / failed all become 'empty'.
--     'empty' = pool is empty, waiting for background prefill to top it up;
--     the frontend shows a gray "this meal is being regenerated" placeholder.
--     There is no "retry" concept anymore — refillSlotsIfDeficit keeps refilling
--     until the pool is full and never gives up on a single slot.
UPDATE menu_jobs SET status='empty' WHERE status IN ('pending', 'running', 'failed');

-- (2) Clear leftover error / retry_after / attempt values: these fields are no
--     longer written. Columns are kept for audit / rollback, but menu_jobs rows
--     only read status + content_json + image_url + menu_pool_id.
UPDATE menu_jobs SET error=NULL, retry_after=NULL, attempt=0, started_at=NULL, finished_at=NULL
 WHERE status='empty';

-- (3) The old pending/failed partial index is no longer used by the cron path
--     (the per-minute drain loop was removed); drop it to save D1 write
--     amplification.
DROP INDEX IF EXISTS idx_menu_jobs_pending;

-- (4) Add a lightweight index for the empty state: the refill scan for
--     "which slots need topping up" filters WHERE status='empty'.
CREATE INDEX IF NOT EXISTS idx_menu_jobs_empty
  ON menu_jobs(user_id, iso_week, status)
  WHERE status='empty';

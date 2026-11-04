-- Migration 0014: existing-data repair for blob-less menu_jobs pointers.
--
-- Repoint every `status='ready'` menu_jobs row that currently points at a
-- blob-less menu_pool row (a seq>=1 candidate — only seq=0 rows carry
-- `image_blob`) back to its slot's seq=0 blob holder. Before this fix
-- those meals rendered the grey "image lost" placeholder and logged
-- lost_pool_image on every /menu/img hit.
--
-- The code fix (shuffleMealJob / flipEmptyJobsToReady now filter
-- `image_blob IS NOT NULL`) stops NEW bad pointers; this migration cleans the
-- backlog that was already stranded on seq>=1 rows before deploy.
--
-- The /menu/img seq=0 fallback already makes these meals DISPLAY correctly
-- the moment the code lands, so this migration is the data-correctness /
-- "stop logging lost_pool_image" half rather than a user-visible prerequisite.
--
-- Run AFTER deploying the code fix (so flips/shuffles can't re-create the
-- condition between this UPDATE and the new build going live).
-- Manual cmd:
--   wrangler d1 execute health_db --remote --file=migrations/0014_repoint_blobless_jobs.sql
--
-- Idempotent: re-running is a no-op once every ready job already points at a
-- blob-bearing row (the WHERE clause selects nothing).
--
-- `consumed` semantics preserved: the seq>=1 rows we point AWAY from keep
-- consumed=1 ("already-consumed rows are never served again" invariant
-- intact); the seq=0 target is marked consumed=1 because the slot is now
-- actively showing it.

-- ── Step 1: mark the chosen seq=0 blob holders consumed (the latest batch's
--    seq=0 row for each affected slot). Done first so Step 2's correlated
--    subquery and this UPDATE agree on the same target row.
UPDATE menu_pool
SET consumed = 1
WHERE seq = 0
  AND image_blob IS NOT NULL
  AND id IN (
    -- latest-batch seq=0 blob holder for each slot that currently has a
    -- ready job stranded on a blob-less pool row
    SELECT (
      SELECT p0.id FROM menu_pool p0
      WHERE p0.user_id = j.user_id AND p0.iso_week = j.iso_week
        AND p0.day = j.day AND p0.meal = j.meal
        AND p0.seq = 0 AND p0.image_blob IS NOT NULL
      ORDER BY p0.batch_no DESC LIMIT 1
    )
    FROM menu_jobs j
    JOIN menu_pool pcur ON pcur.id = j.menu_pool_id
    WHERE j.status = 'ready'
      AND pcur.image_blob IS NULL
  );

-- ── Step 2: repoint the stranded ready jobs to that seq=0 row and sync their
--    cached content_json / image_url to match. Only touches jobs whose current
--    pool row has no blob AND whose slot actually has a seq=0 blob holder.
UPDATE menu_jobs
SET menu_pool_id = (
      SELECT p0.id FROM menu_pool p0
      WHERE p0.user_id = menu_jobs.user_id AND p0.iso_week = menu_jobs.iso_week
        AND p0.day = menu_jobs.day AND p0.meal = menu_jobs.meal
        AND p0.seq = 0 AND p0.image_blob IS NOT NULL
      ORDER BY p0.batch_no DESC LIMIT 1
    ),
    content_json = (
      SELECT p0.content FROM menu_pool p0
      WHERE p0.user_id = menu_jobs.user_id AND p0.iso_week = menu_jobs.iso_week
        AND p0.day = menu_jobs.day AND p0.meal = menu_jobs.meal
        AND p0.seq = 0 AND p0.image_blob IS NOT NULL
      ORDER BY p0.batch_no DESC LIMIT 1
    ),
    image_url = (
      SELECT p0.image_url FROM menu_pool p0
      WHERE p0.user_id = menu_jobs.user_id AND p0.iso_week = menu_jobs.iso_week
        AND p0.day = menu_jobs.day AND p0.meal = menu_jobs.meal
        AND p0.seq = 0 AND p0.image_blob IS NOT NULL
      ORDER BY p0.batch_no DESC LIMIT 1
    )
WHERE status = 'ready'
  AND menu_pool_id IN (SELECT id FROM menu_pool WHERE image_blob IS NULL)
  AND EXISTS (
      SELECT 1 FROM menu_pool p0
      WHERE p0.user_id = menu_jobs.user_id AND p0.iso_week = menu_jobs.iso_week
        AND p0.day = menu_jobs.day AND p0.meal = menu_jobs.meal
        AND p0.seq = 0 AND p0.image_blob IS NOT NULL
    );

-- Migration 0011: clean up dead inventory.
-- Run AFTER deploying the inline-blob invariant (blobs persisted at INSERT)
-- so new INSERTs are clean.
-- Manual cmd:
--   wrangler d1 execute health_db --remote --file=migrations/0011_dead_inventory_cleanup.sql

-- (a) Mark menu_pool rows with NULL image_blob as consumed=1 (not deleted — kept for audit).
-- These are alternates / failed async-blob seq0 rows INSERTed before the inline-blob
-- invariant landed; if a user shuffles onto one they see a broken image.
-- Marking consumed=1 makes shuffleMealJob skip them and triggers
-- refillSlotsIfDeficit to regenerate.
UPDATE menu_pool SET consumed=1 WHERE image_blob IS NULL AND consumed=0;

-- (b) For menu_jobs rows that are ready but whose image_url points at a dashscope
-- temp URL, clear image_url.
-- Do NOT flip them to pending: users who already shuffled onto these results
-- would get a worse experience. The frontend fetches images via
-- menu_pool_id → /menu/img/:pool_id; the image_url field is effectively audit-only.
UPDATE menu_jobs SET image_url=NULL WHERE status='ready' AND image_url LIKE 'https://dashscope%';

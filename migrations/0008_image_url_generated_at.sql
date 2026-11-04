-- Migration 0008: track when image_url was last (re)generated.
-- Used by the one-shot regen-images-for-users script to skip rows recently
-- refreshed (--resume), and by future image-blob backfill heuristics.
-- INTEGER ms epoch. NULL means "never tracked" (legacy rows).
-- Rollback: drop column requires new migration; no data loss if reverted.

ALTER TABLE menu_pool ADD COLUMN image_url_generated_at INTEGER;

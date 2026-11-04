-- Migration 0006: add image blob columns to menu_pool.
-- Allows storing 200×200 webp thumbnails in D1 instead of relying on
-- Dashscope temporary URLs (which expire after ~24h).
-- image_url is retained for debug and fallback.
-- Rollback: not supported in D1 natively; revert by dropping columns
--           (requires a new migration to recreate the table without them).

ALTER TABLE menu_pool ADD COLUMN image_blob    BLOB;
ALTER TABLE menu_pool ADD COLUMN image_thumb_w INTEGER DEFAULT 200;
ALTER TABLE menu_pool ADD COLUMN image_thumb_h INTEGER DEFAULT 200;
ALTER TABLE menu_pool ADD COLUMN image_format  TEXT    DEFAULT 'webp';

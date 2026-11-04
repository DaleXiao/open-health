-- Migration 0004: async first-time menu pre-generation — track per-user seed state.
-- menu_seed_state:
--   NULL                  -- user has not logged first weight + height yet; menu hidden in the UI
--   'awaiting_first'      -- first weight + height logged; waiting for the next 03:00 tick in the user's tz
--   'seeded'              -- already seeded; follows the regular weekly Sunday 03:00 cadence afterwards
-- awaiting_since_ms       -- timestamp of entering awaiting_first; the cron seeds when
--                            now > awaiting_since_ms AND it is 03:00 in the user's tz
ALTER TABLE users ADD COLUMN menu_seed_state TEXT;
ALTER TABLE users ADD COLUMN awaiting_since_ms INTEGER;

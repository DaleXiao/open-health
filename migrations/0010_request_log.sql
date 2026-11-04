-- Migration 0010: request_log for observability.
-- Captures /log/* endpoint outcomes (5xx in particular) so admins can
-- diagnose silent failures without grepping wrangler tail.
--
-- Also used by LLM 401-burst alerting (kind='llm_401_burst')
-- via the same path/error columns.
CREATE TABLE IF NOT EXISTS request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  path TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER,
  duration_ms INTEGER,
  error TEXT,
  ua TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_log_ts ON request_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_request_log_status ON request_log(status, ts DESC);

-- D1 advisory lock for dashboard-triggered drain.
-- (user_id, until_ms) — INSERT OR UPDATE WHERE until_ms<excluded to acquire.
CREATE TABLE IF NOT EXISTS drain_lock (
  user_id INTEGER PRIMARY KEY,
  until_ms BIGINT NOT NULL
);

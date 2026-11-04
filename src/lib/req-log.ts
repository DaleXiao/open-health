// request_log helper.
//
// Writes a single request_log row asynchronously via ctx.waitUntil so the
// request response is never blocked by D1 latency. Failure to write the log
// is swallowed (we never want telemetry to break the user-facing path), but
// surfaced via console.warn so wrangler tail still shows it.

import type { D1Database, ExecutionContext } from '@cloudflare/workers-types';

export interface RequestLogEntry {
  user_id?: number | null;
  path: string;
  method: string;
  status: number;
  duration_ms?: number | null;
  error?: string | null;
  ua?: string | null;
  // Optional override; defaults to Date.now() at write time.
  ts?: number;
}

/**
 * Schedule a request_log insert on ctx.waitUntil so the response can flush
 * immediately. Callers should pass the Hono execution context.
 *
 * If ctx is undefined (e.g. unit tests, scheduled handlers that don't care),
 * the insert is fire-and-forget on the current microtask queue.
 */
export function logRequest(
  db: D1Database,
  ctx: ExecutionContext | undefined,
  entry: RequestLogEntry,
): void {
  const ts = entry.ts ?? Date.now();
  const task = (async () => {
    try {
      await db.prepare(
        `INSERT INTO request_log (user_id, path, method, status, duration_ms, error, ua, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        entry.user_id ?? null,
        entry.path,
        entry.method,
        entry.status,
        entry.duration_ms ?? null,
        entry.error ? entry.error.slice(0, 1000) : null,
        entry.ua ? entry.ua.slice(0, 300) : null,
        ts,
      ).run();
    } catch (err) {
      console.warn('[req-log] insert failed', (err as Error)?.message);
    }
  })();
  if (ctx) ctx.waitUntil(task);
}

// Role boundary: even a valid admin token can never query the health data tables.
// Wraps D1 with a role-aware guard: any read/write touching the health
// data tables (daily_weight, weekly_vitals, weekly_menu) throws if the
// caller is admin. Routes also keep their own role checks; this is the
// belt-and-braces second layer.
//
// SQL inspection is conservative: we only allow admin to touch the
// `users` table. Anything else throws. This catches accidental future
// admin handlers reaching for health data.

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

const HEALTH_TABLES = ['daily_weight', 'daily_exercise', 'weekly_vitals', 'vitals_events', 'weekly_menu', 'menu_jobs', 'menu_pool'];

export class AdminAccessViolation extends Error {
  constructor(table: string) {
    super(`admin role is not permitted to query health data table: ${table}`);
    this.name = 'AdminAccessViolation';
  }
}

export function inspectQueryForAdmin(sql: string): string | null {
  const lower = sql.toLowerCase();
  for (const t of HEALTH_TABLES) {
    // Match as a whole word (preceded by space, comma, paren, or start).
    const re = new RegExp(`(^|[\\s,(])${t}([\\s,)]|$)`);
    if (re.test(lower)) return t;
  }
  return null;
}

export function guardedDB(db: D1Database, role: 'user' | 'admin'): D1Database {
  if (role !== 'admin') return db;
  // Admin: wrap prepare() so any SQL touching health tables throws before reaching D1.
  const wrapped: D1Database = {
    ...db,
    prepare(sql: string): D1PreparedStatement {
      const tbl = inspectQueryForAdmin(sql);
      if (tbl) throw new AdminAccessViolation(tbl);
      return db.prepare(sql);
    },
  } as D1Database;
  // exec() and batch() also need guarding.
  wrapped.exec = async (sql: string) => {
    const tbl = inspectQueryForAdmin(sql);
    if (tbl) throw new AdminAccessViolation(tbl);
    return db.exec(sql);
  };
  wrapped.batch = async <T = unknown>(statements: D1PreparedStatement[]) => db.batch<T>(statements);
  return wrapped;
}

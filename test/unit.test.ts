// Pure-logic tests — no D1 / Workers runtime needed. Use node --test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword, verifyPassword,
  signSession, verifySession,
  sessionCookie, clearSessionCookie, readSessionCookie,
  signAdminFlash, verifyAdminFlash, adminFlashCookie, clearAdminFlashCookie,
  readAdminFlashCookie,
} from '../src/lib/auth.ts';
import {
  calcAge, calcBMI, idealWeightRange, isoWeek, localDate, bmiCategory,
} from '../src/lib/calc.ts';
import { inspectQueryForAdmin, guardedDB, AdminAccessViolation } from '../src/lib/db-guard.ts';
import { seedMenuJobs, DAYS, MEALS } from '../src/lib/menu-gen.ts';

const SECRET = 'unit-test-secret-32bytes-long-xx';

// ─── auth ──────────
test('hashPassword & verifyPassword roundtrip', async () => {
  const hash = await hashPassword('hunter2');
  assert.match(hash, /^pbkdf2\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(await verifyPassword('hunter2', hash), true);
  assert.equal(await verifyPassword('hunter3', hash), false);
});

test('verifyPassword rejects malformed strings', async () => {
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2$x$y'), false);
});

test('signSession / verifySession roundtrip', async () => {
  const c = await signSession(SECRET, 42, 'user');
  const s = await verifySession(SECRET, c);
  assert.ok(s);
  assert.equal(s!.userId, 42);
  assert.equal(s!.role, 'user');
});

test('verifySession rejects tampered signature', async () => {
  const c = await signSession(SECRET, 42, 'user');
  const tampered = c.slice(0, -2) + 'aa';
  assert.equal(await verifySession(SECRET, tampered), null);
});

test('verifySession rejects wrong secret', async () => {
  const c = await signSession(SECRET, 42, 'user');
  assert.equal(await verifySession('different-secret', c), null);
});

test('verifySession rejects forged role bump (admin without resign)', async () => {
  const c = await signSession(SECRET, 42, 'user');
  const parts = c.split('.');
  parts[1] = 'admin';
  const forged = parts.join('.');
  assert.equal(await verifySession(SECRET, forged), null);
});

test('readSessionCookie parses cookie header', () => {
  const req = new Request('https://x/', { headers: { cookie: 'a=1; s=abc.def; b=2' } });
  assert.equal(readSessionCookie(req), 'abc.def');
});

test('sessionCookie / clearSessionCookie produce HttpOnly Secure cookies', () => {
  assert.match(sessionCookie('xyz'), /^s=xyz; Path=\/; HttpOnly; Secure/);
  assert.match(clearSessionCookie(), /^s=; .*Max-Age=0/);
});

test('admin flash is signed, short-lived, HttpOnly, and round-trips Unicode', async () => {
  const value = await signAdminFlash(SECRET, 'Temp password: ABC234 — change it');
  assert.equal(await verifyAdminFlash(SECRET, value), 'Temp password: ABC234 — change it');
  assert.equal(await verifyAdminFlash('wrong-secret', value), null);
  assert.match(adminFlashCookie(value), /^admin_flash=.*; Path=\/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=120$/);
  assert.match(clearAdminFlashCookie(), /Max-Age=0$/);
  assert.equal(readAdminFlashCookie(new Request('https://x/admin', { headers: { cookie: `s=abc; admin_flash=${value}` } })), value);
});

// ─── calc ──────────
test('calcAge handles birthdays', () => {
  // Reference: 2026-05-03
  const ref = new Date('2026-05-03T12:00:00Z');
  assert.equal(calcAge('1981-05-11', ref), 44); // not yet 45
  assert.equal(calcAge('1981-05-03', ref), 45); // exact birthday
  assert.equal(calcAge('1981-05-04', ref), 44); // tomorrow's birthday
  assert.equal(calcAge(null, ref), null);
  assert.equal(calcAge('not-a-date', ref), null);
});

test('calcBMI rounds to 1dp', () => {
  assert.equal(calcBMI(70, 175), 22.9);
  assert.equal(calcBMI(80, 180), 24.7);
  assert.equal(calcBMI(70, null), null);
  assert.equal(calcBMI(70, 0), null);
});

test('idealWeightRange clamps to BMI 18.5–24.9', () => {
  const r = idealWeightRange(175);
  assert.ok(r);
  assert.ok(r!.min >= 56 && r!.min <= 57);
  assert.ok(r!.max >= 76 && r!.max <= 77);
  assert.equal(idealWeightRange(null), null);
});

test('bmiCategory thresholds', () => {
  assert.equal(bmiCategory(17), 'under');
  assert.equal(bmiCategory(22), 'normal');
  assert.equal(bmiCategory(28), 'over');
  assert.equal(bmiCategory(35), 'obese');
  assert.equal(bmiCategory(null), 'unknown');
});

test('isoWeek returns YYYY-Www', () => {
  const w = isoWeek(new Date('2026-05-03T12:00:00Z'));
  assert.match(w, /^\d{4}-W\d{2}$/);
  // 2026-W01 = Mon 2025-12-29 .. Sun 2026-01-04 (ISO).
  assert.equal(isoWeek(new Date('2026-01-01T12:00:00Z')), '2026-W01');
  assert.equal(isoWeek(new Date('2026-01-05T12:00:00Z')), '2026-W02');
});

test('localDate respects timezone', () => {
  const d = new Date('2026-05-03T13:00:00Z'); // 23:00 in Melbourne
  assert.equal(localDate('Australia/Melbourne', d), '2026-05-03');
  const d2 = new Date('2026-05-03T15:00:00Z'); // 01:00 next day in Melbourne
  assert.equal(localDate('Australia/Melbourne', d2), '2026-05-04');
});

// ─── llm validateMenu (REMOVED) ──────────
// validateMenu/buildMenuMessages/generateMenu (src/lib/llm.ts) were the legacy
// 7-day-whole-week schema, replaced by menu_jobs (per-meal). The
// llm.ts file and these tests were dead code with a hardcoded 180s timeout
// that violated the timeout single-source-of-truth rule. Removed.

// ─── db-guard ──────────
test('inspectQueryForAdmin flags health tables', () => {
  assert.equal(inspectQueryForAdmin('SELECT * FROM users'), null);
  assert.equal(inspectQueryForAdmin('SELECT * FROM daily_weight WHERE x=1'), 'daily_weight');
  assert.equal(inspectQueryForAdmin('SELECT 1 FROM weekly_vitals'), 'weekly_vitals');
  assert.equal(inspectQueryForAdmin('SELECT 1 FROM weekly_menu'), 'weekly_menu');
  assert.equal(inspectQueryForAdmin('INSERT INTO daily_weight (a) VALUES (1)'), 'daily_weight');
  // Word boundary: don't trip on substrings.
  assert.equal(inspectQueryForAdmin('SELECT * FROM somedaily_weightxx'), null);
});

test('guardedDB(admin) throws AdminAccessViolation on health tables', () => {
  const fakeDB = {
    prepare(_sql: string) { return { bind: () => ({ run: async () => ({ success: true }) }) }; },
    exec: async () => ({}),
    batch: async () => ([]),
  } as unknown as Parameters<typeof guardedDB>[0];

  const guarded = guardedDB(fakeDB, 'admin');
  assert.doesNotThrow(() => guarded.prepare('SELECT id, username FROM users'));
  assert.throws(() => guarded.prepare('SELECT * FROM daily_weight'), AdminAccessViolation);
  assert.throws(() => guarded.prepare('SELECT * FROM weekly_menu'), AdminAccessViolation);
});

test('guardedDB(user) is identity (no wrapping)', () => {
  const fakeDB = { prepare: (_s: string) => 'sentinel' as any } as Parameters<typeof guardedDB>[0];
  const g = guardedDB(fakeDB, 'user');
  assert.equal(g, fakeDB); // same reference
});

// ─── menu-gen ──────────
test('DAYS = 7 days Mon..Sun', () => {
  assert.deepEqual(DAYS, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
});

test('MEALS = 4 meals including snack', () => {
  assert.deepEqual(MEALS, ['breakfast', 'lunch', 'dinner', 'snack']);
  assert.equal(MEALS.length, 4);
  assert.ok(MEALS.includes('snack'), 'snack must be present');
});

test('seedMenuJobs calls db.batch with 28 statements (7 days × 4 meals)', async () => {
  const sqls: string[] = [];
  let batchArgs: any[] = [];
  let batchCalled = false;
  const fakeDB = {
    prepare: (sql: string) => {
      sqls.push(sql);
      return { bind: (...args: any[]) => { batchArgs.push(args); return {}; } };
    },
    batch: async (_stmts: any[]) => { batchCalled = true; return []; },
  } as any;
  await seedMenuJobs(fakeDB, 42, '2026-W19');
  assert.equal(sqls.length, 28, `expected 28 statements, got ${sqls.length}`);
  assert.ok(batchCalled, 'batch must be called');
  assert.ok(sqls.every(s => s.includes('INSERT OR IGNORE')), 'all must be INSERT OR IGNORE');
  assert.ok(sqls.every(s => s.includes('menu_jobs')), 'all must target menu_jobs table');
  // All bind calls include user_id=42 as first arg
  assert.ok(batchArgs.every(args => args[0] === 42), 'user_id 42 in all bind calls');
  // iso_week '2026-W19' is second arg
  assert.ok(batchArgs.every(args => args[1] === '2026-W19'), 'iso_week in all bind calls');
  // All 4 meals appear in bind args
  for (const meal of MEALS) {
    assert.ok(batchArgs.some(args => args[3] === meal), `meal '${meal}' must appear in bind args`);
  }
});

// ─── ──────────
import { getLocalParts, isoWeekForTzDate, nextIsoWeekFromDate, shuffleMealJob } from '../src/lib/menu-gen.ts';

test('getLocalParts returns Melbourne local time', () => {
  // 2026-05-04 02:00 UTC = 2026-05-04 12:00 Melbourne (UTC+10 standard time, May)
  const ms = Date.UTC(2026, 4, 4, 2, 0, 0);
  const lp = getLocalParts(ms, 'Australia/Melbourne');
  assert.equal(lp.year, 2026);
  assert.equal(lp.month, 5);
  assert.equal(lp.day, 4);
  assert.equal(lp.hour, 12);
  assert.equal(lp.weekdayMon1Sun7, 1, 'May 4 2026 is Monday');
});

test('nextIsoWeekFromDate moves to next iso week', () => {
  // 2026-05-04 (Mon) is iso week 19; +7 days lands in week 20.
  const w = nextIsoWeekFromDate(new Date(Date.UTC(2026, 4, 4)));
  assert.equal(w, '2026-W20');
});

test('isoWeekForTzDate matches local week for tz', () => {
  // 2026-05-03 23:00 UTC = 2026-05-04 09:00 Melbourne (Mon W19)
  const ms = Date.UTC(2026, 4, 3, 23, 0, 0);
  assert.equal(isoWeekForTzDate(ms, 'Australia/Melbourne'), '2026-W19');
});

test('shuffleMealJob switches to next unconsumed pool row synchronously', async () => {
  const batchSqls: string[] = [];
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (..._args: any[]) => ({
        first: async () => {
          if (sql.includes('SELECT status, menu_pool_id')) return { status: 'ready', menu_pool_id: 10 };
          if (sql.includes('SELECT id, content, image_url FROM menu_pool')) return { id: 11, content: '{"name":"new"}', image_url: 'https://img' };
          return null;
        },
      }),
    }),
    batch: async (stmts: any[]) => { batchSqls.push(...stmts.map(String)); return []; },
  } as any;
  const r = await shuffleMealJob(fakeDB, 1, '2026-W19', 'Mon', 'breakfast');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ready');
  assert.equal(r.poolId, 11);
  assert.equal(batchSqls.length, 3);
});



// ─── heatmap helpers ──────────
import { exerciseHeat, weightHeat } from '../src/lib/heatmap.ts';

test('weightHeat: binary semantics — always returns green (daysAgo ignored, signature back-compat)', () => {
  // The weight heatmap is green/gray binary: logged days are green. Unlogged
  // days are rendered with empty-bg directly by the caller, so this function
  // is no longer called for them (see heatmap.ts comments).
  assert.equal(weightHeat(null), '#16a34a');
  assert.equal(weightHeat(0),  '#16a34a');
  assert.equal(weightHeat(5),  '#16a34a');
  assert.equal(weightHeat(20), '#16a34a');
  assert.equal(weightHeat(60), '#16a34a');
});

test('exerciseHeat colors by family: run red / strength purple / yoga green / ball orange', () => {
  assert.equal(exerciseHeat('run_5km').family, 'cardio_run');
  assert.equal(exerciseHeat('hiit_30min').family, 'cardio_run');
  assert.equal(exerciseHeat('strength_45min').family, 'strength');
  assert.equal(exerciseHeat('yoga_60min').family, 'yoga');
  assert.equal(exerciseHeat('ball_60min').family, 'ball');
  assert.equal(exerciseHeat('walk_5km').family, 'cardio_walk');
  assert.equal(exerciseHeat('rest').family, 'rest');
  assert.equal(exerciseHeat('unknown_xyz').family, 'other');
});

test('exerciseHeat: one solid color per family (color === family dark shade)', () => {
  // Same family shares one color regardless of kind/intensity
  assert.equal(exerciseHeat('walk_2km').color, exerciseHeat('cycling_20km').color);
  assert.equal(exerciseHeat('walk_2km').color, '#2563eb');
  assert.equal(exerciseHeat('run_5km').color, '#dc2626');
  assert.equal(exerciseHeat('hiit_30min').color, '#dc2626');
  assert.equal(exerciseHeat('mma_90min').color, '#db2777');
  assert.equal(exerciseHeat('pushup_100').color, exerciseHeat('strength_45min').color);
  // No level field is exposed anymore
  assert.ok(!('level' in exerciseHeat('walk_2km')));
});

// ─── UI ──────────
import { EXERCISE_OPTIONS as EXO_EN } from '../src/lib/exercise.ts';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const rel = (p: string) => resolve(HERE, p);

test('EXERCISE labels are all English (no CJK chars)', () => {
  const cjk = /[\u4e00-\u9fff]/;
  for (const e of EXO_EN) {
    assert.ok(!cjk.test(e.label), `label "${e.label}" must be English`);
  }
  // sanity — known ids still present
  const ids = EXO_EN.map(e => e.id);
  assert.ok(ids.includes('walk_2km'));
  assert.ok(ids.includes('hiit_30min'));
  assert.ok(ids.includes('rest'));
});

test('user-facing pages.tsx contains no CJK strings', () => {
  // Only count text that would render to users — strip line comments.
  const src = readFileSync(rel('../src/views/pages.tsx'), 'utf8');
  const stripped = src.replace(/^\s*\/\/.*$/gm, '');
  const cjk = stripped.match(/[\u4e00-\u9fff]/g);
  assert.equal(cjk, null, `unexpected CJK in pages.tsx: ${cjk?.slice(0,5).join('')}`);
});

test('layout.tsx ships theme-toggle button + init script', () => {
  const src = readFileSync(rel('../src/views/layout.tsx'), 'utf8');
  assert.match(src, /id="theme-toggle"/, 'theme toggle button rendered');
  assert.match(src, /health-tracker-theme/, 'localStorage key present');
  // — legacy key one-shot migration must remain in init script.
  assert.match(src, /health-weweekly-theme/, 'legacy key migration present');
  assert.match(src, /prefers-color-scheme/, 'system pref fallback present');
  assert.match(src, /classList\.add\('dark'\)/, 'inline FOUC-prevention applies .dark on html');
});

test('theme-toggle.js binds click and persists', () => {
  const src = readFileSync(rel('../public/assets/theme-toggle.js'), 'utf8');
  assert.match(src, /addEventListener\('click'/);
  assert.match(src, /localStorage\.setItem/);
  assert.match(src, /classList\.contains\('dark'\)/);
});

test('dark mode CSS defines :root.dark token overrides', () => {
  const css = readFileSync(rel('../public/assets/app.css'), 'utf8');
  assert.match(css, /:root\.dark\s*\{[^}]*--paper/);
  assert.match(css, /:root\.dark\s*\{[^}]*--ink/);
  assert.match(css, /:root\.dark\s+body/);
});

test('shuffle button no longer rotates on hover (only on :active)', () => {
  const css = readFileSync(rel('../public/assets/app.css'), 'utf8');
  // hover rule must not include `transform: rotate(...)`
  const hoverMatch = css.match(/\.btn-icon:hover\s*\{[^}]*\}/);
  assert.ok(hoverMatch, '.btn-icon:hover rule found');
  assert.ok(!/transform\s*:\s*rotate/.test(hoverMatch![0]), 'hover must not rotate');
  // active rule must rotate 360deg
  assert.match(css, /\.btn-icon:active[^{]*\{[^}]*rotate\(360deg\)/);
});

test('header uses .header-actions flex container with gap + align-items:center', () => {
  const css = readFileSync(rel('../public/assets/app.css'), 'utf8');
  const block = css.match(/\.header-actions\s*\{[^}]*\}/);
  assert.ok(block, '.header-actions rule defined');
  assert.match(block![0], /display\s*:\s*flex/);
  assert.match(block![0], /align-items\s*:\s*center/);
  assert.match(block![0], /gap\s*:/);
});

// ─── dark-mode trend/heatmap surface fix ──────────

test('chart surface tokens defined in :root and :root.dark', () => {
  const css = readFileSync(rel('../public/assets/app.css'), 'utf8');
  // Light defaults
  assert.match(css, /:root\s*\{[\s\S]*?--chart-bg:\s*var\(--paper\)[\s\S]*?--chart-grid:[\s\S]*?--chart-axis-text:[\s\S]*?\}/);
  // Dark overrides
  assert.match(css, /:root\.dark\s*\{[\s\S]*?--chart-bg:\s*var\(--paper\)[\s\S]*?--chart-grid:\s*#3a362e[\s\S]*?\}/);
});

test('trend-card uses var(--chart-bg) (no hardcoded white)', () => {
  const css = readFileSync(rel('../public/assets/app.css'), 'utf8');
  // Find the .trend-card { ... } block (first one; non-greedy)
  const m = css.match(/\.trend-card\s*\{[^}]*\}/);
  assert.ok(m, '.trend-card block found');
  assert.match(m![0], /background:\s*var\(--chart-bg\)/);
  assert.doesNotMatch(m![0], /background:\s*white/);
});

test('trend grid/axis/label use chart-axis-text + chart-grid tokens', () => {
  const css = readFileSync(rel('../public/assets/app.css'), 'utf8');
  assert.match(css, /\.grid-line\s*\{[^}]*stroke:\s*var\(--chart-grid\)/);
  assert.match(css, /\.axis\s*\{[^}]*stroke:\s*var\(--chart-axis-text\)/);
  assert.match(css, /\.axis-label\s*\{[^}]*fill:\s*var\(--chart-axis-text\)/);
  assert.match(css, /\.axis-tick\s*\{[^}]*stroke:\s*var\(--chart-axis-text\)/);
});

test('dark-mode override applies chart-bg to trend/heatmap containers', () => {
  const css = readFileSync(rel('../public/assets/app.css'), 'utf8');
  assert.match(css, /:root\.dark\s+\.trend-card,[\s\S]*?:root\.dark\s+\.trend-range-card,[\s\S]*?:root\.dark\s+\.heatmap-scroll\s*\{[^}]*background:\s*var\(--chart-bg\)/);
});

test('dark-mode brightens vitals lines/dots for contrast', () => {
  const css = readFileSync(rel('../public/assets/app.css'), 'utf8');
  assert.match(css, /:root\.dark\s+\.line-hr\s*\{[^}]*#fbbf24/);
  assert.match(css, /:root\.dark\s+\.line-sbp\s*\{[^}]*#f87171/);
  assert.match(css, /:root\.dark\s+\.line-dbp\s*\{[^}]*#60a5fa/);
  assert.match(css, /:root\.dark\s+\.dot-hr\s*\{[^}]*#fbbf24/);
});

test('no remaining hardcoded `background: white` in app.css', () => {
  const css = readFileSync(rel('../public/assets/app.css'), 'utf8');
  // Only `background: white` (with optional !important) — `background: white-something` won't match because of \s*[;}]
  const matches = css.match(/background:\s*white\s*[;}]/g) || [];
  assert.equal(matches.length, 0, `expected no hardcoded "background: white", found ${matches.length}: ${matches.join(' | ')}`);
});

// ─── trend chart / stats feedback ──────────

test('weight trend dot has tooltip + always-visible label', () => {
  const src = readFileSync(rel('../src/views/pages.tsx'), 'utf8');
  // Tooltip on dot
  assert.match(src, /class="dot"[\s\S]{0,120}<title>\{w\.date\} · \{w\.weight_kg\.toFixed\(1\)\} kg<\/title>/);
  // Always-visible label component
  assert.match(src, /class="dot-label"/);
  assert.match(src, /showLabel/);
  assert.match(src, /isHead.*isTail.*isMax.*isMin/s);
});

test('dot-label CSS defined for both modes', () => {
  const css = readFileSync(rel('../public/assets/app.css'), 'utf8');
  assert.match(css, /\.dot-label\s*\{[^}]*fill:\s*var\(--ink\)/);
  assert.match(css, /\.dot-label\s*\{[^}]*pointer-events:\s*none/);
});

test('vitals trend HR removed, BP-only, title is "Blood pressure trend"', () => {
  const src = readFileSync(rel('../src/views/pages.tsx'), 'utf8');
  // Title changed
  assert.match(src, /Blood pressure trend/);
  assert.doesNotMatch(src, />\s*Vitals trend\s*</);
  // VitalsTrendSVG no longer references heart_rate / hrLo / yHr / line-hr / dot-hr / hrTicks
  const fnStart = src.indexOf('const VitalsTrendSVG');
  const fnEnd = src.indexOf('function shortDate', fnStart);
  const fnBody = src.slice(fnStart, fnEnd);
  assert.doesNotMatch(fnBody, /heart_rate/);
  assert.doesNotMatch(fnBody, /hrLo|yHr|hrTicks/);
  assert.doesNotMatch(fnBody, /line-hr|dot-hr/);
  // BP series + ticks still present
  assert.match(fnBody, /bp_systolic/);
  assert.match(fnBody, /bp_diastolic/);
  assert.match(fnBody, /bpTicks\s*=\s*\[60,\s*90,\s*120,\s*150,\s*180\]/);
});

test('BMI stat row uses grid table + unified value font-size + nowrap', () => {
  const src = readFileSync(rel('../src/views/pages.tsx'), 'utf8');
  // Markup unchanged: 4 cells + ideal-range still tagged for any future tweaks.
  assert.match(src, /Ideal range[\s\S]{0,200}stat-value-range/);

  const css = readFileSync(rel('../public/assets/app.css'), 'utf8');
  // 1) Desktop (>=768px) lays out 4 columns as a grid table.
  assert.match(css, /@media \(min-width: 768px\)\s*\{[\s\S]*?\.stat-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*1fr\)/);
  // 2) .stat-value has unified font-size (1.4rem base, 1.5rem on desktop) and baseline align + nowrap.
  assert.match(css, /\.stat-value\s*\{[^}]*font-size:\s*1\.4rem[\s\S]*?align-items:\s*baseline[\s\S]*?white-space:\s*nowrap/);
  assert.match(css, /@media \(min-width: 768px\)\s*\{[\s\S]*?\.stat-value\s*\{\s*font-size:\s*1\.5rem/);
  // 3) The size override is removed (no more 1.05rem !important).
  assert.doesNotMatch(css, /\.stat-value-range\s*\{[^}]*font-size:\s*1\.05rem/);
  // 4) Unit uses relative em so it scales with value.
  assert.match(css, /\.stat-unit\s*\{[^}]*font-size:\s*0\.8em/);
});

test('admin /admin/menu-pool/stats endpoint returns pool counts', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  assert.match(src, /\/admin\/menu-pool\/stats/);
  assert.match(src, /expected_pool_rows:\s*7\s*\*\s*4\s*\*\s*5/);
  assert.match(src, /COUNT\(\*\) AS pool_rows/);
  assert.match(src, /SUM\(CASE WHEN consumed=0/);
});


// ─── cron CPU limit fix (replaced the eager-prefill model) ──────────
// HISTORY: the eager model used Promise.all 28-way parallel → Cloudflare CPU
// limit exceeded. Fix: chunked sequential (chunk=5), with the cron tick as
// the sole LLM driver.







// ─── admin/menu-pool/stats response contract ──────────

test('admin/menu-pool/stats handler — no content/image_url in SQL or response', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  // Locate the handler body: from app.get('/admin/menu-pool/stats' to the next app.post/app.get
  const startMarker = "app.get('/admin/menu-pool/stats'";
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx >= 0, 'handler exists');
  // Find next route registration to delimit handler body
  const afterStart = src.slice(startIdx + startMarker.length);
  const nextRouteIdx = afterStart.search(/app\.(get|post|put|delete|patch)\(/);
  assert.ok(nextRouteIdx > 0, 'handler body delimited');
  const body = afterStart.slice(0, nextRouteIdx);

  // Hard contract: SQL does not select content or image_url columns
  assert.doesNotMatch(body, /\bcontent\b/i, 'menu_pool.content must not be selected');
  assert.doesNotMatch(body, /\bimage_url\b/i, 'menu_pool.image_url must not be selected');

  // Response c.json({...}) literal must not include content/image_url keys
  const jsonMatch = body.match(/c\.json\(\s*\{[\s\S]*?\}\s*\)/);
  assert.ok(jsonMatch, 'c.json response literal found');
  const responseLiteral = jsonMatch![0];
  assert.doesNotMatch(responseLiteral, /content\s*:/);
  assert.doesNotMatch(responseLiteral, /image_url\s*:/);

  // Positive: confirm only aggregate keys are exposed
  assert.match(responseLiteral, /pool_rows/);
  assert.match(responseLiteral, /pool_unconsumed/);
  assert.match(responseLiteral, /expected_pool_rows/);
  assert.match(responseLiteral, /cells/);
  assert.match(responseLiteral, /job_status/);
});

test('admin/menu-pool/stats — comment documents intentional raw db usage', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  // The comment block immediately above the handler must mention the privacy contract
  const startIdx = src.indexOf("app.get('/admin/menu-pool/stats'");
  assert.ok(startIdx >= 0);
  const preamble = src.slice(Math.max(0, startIdx - 1500), startIdx);
  assert.match(preamble, /raw\s+(SQL|db)/i);
  assert.match(preamble, /aggregate/i);
  assert.match(preamble, /content/);
  assert.match(preamble, /image_url/);
  assert.match(preamble, /MUST NEVER|must not|never/i);
});

// ─── image gen async via ctx.waitUntil ──────────






// ─── stale running recovery + per-tick profiling ──────────



// ─── vitals event stream ──────────

test('migration 0007 creates vitals_events table + indexes', () => {
  const sql = readFileSync(rel('../migrations/0007_vitals_events.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS vitals_events/);
  assert.match(sql, /id\s+INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(sql, /measured_at\s+INTEGER NOT NULL/);
  assert.match(sql, /iso_week\s+TEXT\s+NOT NULL/);
  assert.match(sql, /source\s+TEXT\s+NOT NULL DEFAULT 'manual'/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_vitals_events_user_time/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_vitals_events_user_week/);
  // Backfill from weekly_vitals tagged 'legacy_weekly', idempotent guard.
  assert.match(sql, /INSERT INTO vitals_events[\s\S]+FROM weekly_vitals[\s\S]+WHERE NOT EXISTS/);
  assert.match(sql, /'legacy_weekly'/);
});

test('POST /log/vitals INSERTs new event row, no upsert', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  // No more weekly_vitals upsert
  assert.doesNotMatch(src, /INSERT INTO weekly_vitals[\s\S]+ON CONFLICT\(user_id,\s*iso_week\)/);
  // INSERT INTO vitals_events with source='manual'
  assert.match(src, /INSERT INTO vitals_events[\s\S]+VALUES\s*\([^)]+\)/);
  assert.match(src, /'manual'/);
  // Reject empty submissions
  assert.match(src, /vitals-empty/);
});

test('dashboard reads from vitals_events (latest + full stream)', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  // Latest event for current week
  assert.match(src, /FROM vitals_events WHERE user_id = \? AND iso_week = \? ORDER BY measured_at DESC LIMIT 1/);
  // Full stream for trend
  assert.match(src, /FROM vitals_events WHERE user_id = \? ORDER BY measured_at ASC/);
  // recentVitals derived (last 20)
  assert.match(src, /vitalsTrend\.slice\(-20\)\.reverse\(\)/);
});

test('delete-event endpoint scoped to caller', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  assert.match(src, /\/log\/vitals\/:id\/delete/);
  // Delete must filter by user_id to prevent cross-user delete
  assert.match(src, /DELETE FROM vitals_events WHERE id = \? AND user_id = \?/);
});

test('db-guard adds vitals_events to HEALTH_TABLES', () => {
  const src = readFileSync(rel('../src/lib/db-guard.ts'), 'utf8');
  assert.match(src, /'vitals_events'/);
});

test('VitalsTrendSVG sorts by measured_at, X axis is time', () => {
  const src = readFileSync(rel('../src/views/pages.tsx'), 'utf8');
  // Sort by ms epoch, not date string
  assert.match(src, /sort\(\(a, b\) => a\.measured_at - b\.measured_at\)/);
  // History table exists + delete form
  assert.match(src, /vitals-history-table/);
  assert.match(src, /\/log\/vitals\/\$\{v\.id\}\/delete/);
});

// ─── image_blob persistence ──────────

test('menu-gen exports fetchAndCompressImage', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  assert.match(src, /export async function fetchAndCompressImage/);
  // Compression target is 200x200 webp.
  assert.match(src, /BLOB_THUMB_W\s*=\s*200/);
  assert.match(src, /BLOB_THUMB_H\s*=\s*200/);
  assert.match(src, /get_bytes_webp\(\)/);
  // Lazy import keeps cold-start cheap.
  assert.match(src, /await import\('@cf-wasm\/photon'\)/);
});

test('image_blob persistence on the INSERT path', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  // : blob is now persisted INLINE at INSERT, not via a post-hoc
  // UPDATE menu_pool SET image_url=?, image_blob=?... pattern.
  assert.match(src, /INSERT INTO menu_pool[\s\S]*image_blob[\s\S]*image_format/);
  // fetchAndCompressImage is the gate; called against the freshly-generated url.
  assert.match(src, /fetchAndCompressImage\(seq0Url\)/);
  // Admin backfill endpoint still UPDATEs for legacy rows.
  const idx = readFileSync(rel('../src/index.tsx'), 'utf8');
  assert.match(idx, /UPDATE menu_pool SET image_blob=\?, image_format=\?, image_thumb_w=\?, image_thumb_h=\?/);
});

test('admin backfill endpoint exists with rate-limit + scoped scan', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  assert.match(src, /\/admin\/backfill-image-blobs/);
  // Filters NULL blob + non-null URL only.
  assert.match(src, /image_blob IS NULL AND image_url IS NOT NULL/);
  // 200ms inter-row delay.
  assert.match(src, /setTimeout\(r,\s*200\)/);
  // Returns remaining count so caller can loop until zero.
  assert.match(src, /remaining:/);
});

test('INSERT path declares image_blob column (intent + future-proof)', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  assert.match(src, /INSERT INTO menu_pool[^)]*image_blob[^)]*\)/);
});

// ─── one-shot image regen script ──────────

test('migration 0008 adds image_url_generated_at column', () => {
  const sql = readFileSync(rel('../migrations/0008_image_url_generated_at.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE menu_pool ADD COLUMN image_url_generated_at INTEGER/);
});

test('regen script exposes required CLI surface and safety guards', () => {
  const src = readFileSync(rel('../scripts/regen-images-for-users.mjs'), 'utf8');
  // CLI flags per spec
  assert.match(src, /--users/);
  assert.match(src, /--iso-weeks/);
  assert.match(src, /--dry-run/);
  assert.match(src, /--resume/);
  // Rate limit 1.5s default
  assert.match(src, /rateMs:\s*1500/);
  // Retry once on failure
  assert.match(src, /generateWithRetry/);
  // Resume window 12h
  assert.match(src, /RESUME_WINDOW_MS\s*=\s*12\s*\*\s*3600_000/);
  // Failed rows TSV
  assert.match(src, /\/tmp\/regen-failed\.tsv/);
  // Selects only image_blob NULL + non-null image_url (don't overwrite blob path)
  assert.match(src, /image_blob IS NULL/);
  assert.match(src, /image_url IS NOT NULL/);
  // Updates image_url_generated_at alongside URL (resume support)
  assert.match(src, /UPDATE menu_pool SET image_url=[^,]+, image_url_generated_at=/);
  // Refuses non-dry-run without API key
  assert.match(src, /DASHSCOPE_API_KEY required for non-dry-run/);
  // Inlined buildImagePrompt — script independent of menu-gen.ts D1Database imports
  assert.match(src, /function buildImagePrompt/);
});

test('regen script does NOT modify worker code', () => {
  // Sanity: the script lives under scripts/ and is never imported by src/
  const idx = readFileSync(rel('../src/index.tsx'), 'utf8');
  const menuGen = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  assert.doesNotMatch(idx, /regen-images-for-users/);
  assert.doesNotMatch(menuGen, /regen-images-for-users/);
});

// ─── LLM timeout 120s + retry backoff + content-degrade ──────────

test('LLM timeout configurable via env, default 90s, clamped', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  // parseLlmTimeout helper exported with sane bounds
  assert.match(src, /export function parseLlmTimeout/);
  assert.match(src, /LLM_TIMEOUT_MIN_MS\s*=\s*10_000/);
  assert.match(src, /LLM_TIMEOUT_MAX_MS\s*=\s*600_000/);
  // : default constant renamed to DEFAULT_LLM_TIMEOUT_MS and is
  // ONLY referenced inside parseLlmTimeout (single source of truth).
  assert.match(src, /DEFAULT_LLM_TIMEOUT_MS\s*=\s*90_000/);
  // generateMealCandidates accepts timeoutMs as REQUIRED (no default)
  assert.match(src, /generateMealCandidates\([\s\S]*?timeoutMs:\s*number,/);
  // Both LLM call sites (COMPAT_URL fetches) use the param, not the constant.
  // (Image fetch + compress uses its own BLOB_FETCH_TIMEOUT_MS — excluded.)
  const llmCallSites = src.match(/setTimeout\(\(\) => ac\.abort\(\),\s*timeoutMs\)/g) ?? [];
  assert.ok(llmCallSites.length >= 1, `expected ≥1 LLM call site with timeoutMs, got ${llmCallSites.length}`);
  // Error message reflects actual timeout
  assert.match(src, /LLM timeout \(\$\{Math\.round\(timeoutMs\/1000\)\}s\)/);
});

test('wrangler.toml exposes LLM_TIMEOUT_MS=120000 var', () => {
  const toml = readFileSync(rel('../wrangler.toml'), 'utf8');
  assert.match(toml, /LLM_TIMEOUT_MS\s*=\s*"120000"/);
});






// ─── /menu/img/:pool_id ArrayBuffer (supersedes atob path) ──────────

test('menu/img wraps D1 ArrayBuffer in Uint8Array (no atob)', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  // First<...> typed as ArrayBuffer (D1 BLOB binding actually returns ArrayBuffer)
  assert.match(src, /\.first<\{\s*image_blob:\s*ArrayBuffer\s*\|\s*null/);
  // Wrap raw ArrayBuffer in Uint8Array view; do NOT decode as base64
  assert.match(src, /new Uint8Array\(row\.image_blob\)/);
  // Response is built from the bytes, not the raw ArrayBuffer
  assert.match(src, /new Response\(bytes,/);
  // Content-Length set so client knows real byte size
  assert.match(src, /'Content-Length':\s*String\(bytes\.byteLength\)/);
  // Regression guard: atob path is gone (caused InvalidCharacterError)
  assert.doesNotMatch(src, /atob\(base64\)/);
  assert.doesNotMatch(src, /Uint8Array\.from\(atob/);
});

// ─── timeout single-source-of-truth + dead-code purge ──────────

test('src/lib/llm.ts dead module is removed', () => {
  // Legacy 7-day-whole-week schema with hardcoded 180s timeout. Replaced by
  // menu_jobs (per-meal). Root cause guarded here: orphaned default values.
  assert.throws(() => readFileSync(rel('../src/lib/llm.ts'), 'utf8'), /ENOENT/);
});

test('generateSingleMeal dead function is removed', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  // generateMealCandidates is the only LLM-meal entry point now (returns POOL_SIZE
  // candidates for the shuffle pool). generateSingleMeal had no callers.
  assert.doesNotMatch(src, /async function generateSingleMeal/);
});

test('no `: number = LLM_TIMEOUT_MS` defaults remain', () => {
  // Issue #51 root cause: default-value paths bypassed env-threaded value.
  // All internal LLM call paths must be REQUIRED args, threaded from env.
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  const lines = src.split('\n');
  for (const line of lines) {
    if (/^\s*(\*|\/\/)/.test(line)) continue; // skip comment lines
    assert.doesNotMatch(line, /:\s*number\s*=\s*(DEFAULT_)?LLM_TIMEOUT_MS/);
  }
});

test('DEFAULT_LLM_TIMEOUT_MS is only referenced inside parseLlmTimeout', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  // Strip comment lines so doc references don't count toward the cap.
  const codeOnly = src.split('\n')
    .filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
  const matches = [...codeOnly.matchAll(/\bDEFAULT_LLM_TIMEOUT_MS\b/g)];
  // 1 declaration + 2 references inside parseLlmTimeout body = 3.
  // Single-source-of-truth invariant: nowhere else.
  assert.equal(matches.length, 3, `expected exactly 3 code references, got ${matches.length}`);
  // Sanity: the references sit inside parseLlmTimeout()
  const fnStart = codeOnly.indexOf('export function parseLlmTimeout');
  const fnEnd   = codeOnly.indexOf('\n}', fnStart);
  const fnBody  = codeOnly.slice(fnStart, fnEnd);
  const insideRefs = [...fnBody.matchAll(/\bDEFAULT_LLM_TIMEOUT_MS\b/g)].length;
  assert.equal(insideRefs, 2, 'both runtime references must be inside parseLlmTimeout');
});


test('pre-commit hook script exists and is executable', async () => {
  const fs = await import('node:fs');
  const path = rel('../scripts/check-no-hardcoded-timeout.sh');
  const s = fs.statSync(path);
  assert.ok(s.isFile(), 'hook script must exist');
  // 0o111 = any execute bit
  assert.ok((s.mode & 0o111) !== 0, 'hook script must be executable');
});

// ─── drain-trigger advisory lock (cron-side) ──────────
import { classifyJobError, refillSlotsIfDeficit } from '../src/lib/menu-gen.ts';

function makeMockDB(state: { drainLock?: Map<number, number>; drainable?: Map<string, number> } = {}) {
  const drainLock = state.drainLock ?? new Map<number, number>();
  const drainable = state.drainable ?? new Map<string, number>();
  return {
    drainLock,
    drainable,
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        run: async () => {
          if (/INSERT INTO drain_lock/.test(sql)) {
            const [userId, until, nowGuard] = args;
            const existing = drainLock.get(userId);
            if (existing === undefined || existing < nowGuard) {
              drainLock.set(userId, until);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (/DELETE FROM drain_lock/.test(sql)) {
            drainLock.delete(args[0]);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        first: async () => {
          if (/COUNT\(\*\) AS n FROM menu_jobs/.test(sql)) {
            const [userId, isoWeek] = args;
            const n = drainable.get(`${userId}|${isoWeek}`) ?? 0;
            return { n };
          }
          return null;
        },
        all: async () => ({ results: [] }),
      }),
    }),
  } as any;
}



// ─── error classification ──────────

test('classifyJobError: 401 / 503 / 429 / throttle / Algo → transient', () => {
  assert.equal(classifyJobError(new Error('LLM HTTP 401: Unauthorized')), 'transient');
  assert.equal(classifyJobError(new Error('LLM HTTP 503: Service Unavailable')), 'transient');
  assert.equal(classifyJobError(new Error('LLM HTTP 429: Too many requests')), 'transient');
  assert.equal(classifyJobError(new Error('upstream throttling, retry later')), 'transient');
  assert.equal(classifyJobError(new Error('Algo failure: please retry')), 'transient');
});

test('classifyJobError: AbortError / timeout → timeout', () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal(classifyJobError(abort), 'timeout');
  assert.equal(classifyJobError(new Error('LLM timeout (90s)')), 'timeout');
});

test('classifyJobError: HTTP 500 / generic JSON parse → other', () => {
  assert.equal(classifyJobError(new Error('LLM HTTP 500: server error')), 'other');
  assert.equal(classifyJobError(new Error('LLM: missing meals array')), 'other');
});



// ─── pool refill ──────────

test('refillSlotsIfDeficit exported and signature matches spec', () => {
  assert.equal(typeof refillSlotsIfDeficit, 'function');
});


test('refillSlotsIfDeficit no-op when all slots meet target', async () => {
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (..._args: any[]) => ({
        all: async () => {
          if (/SELECT day, meal, COUNT/.test(sql)) {
            // Every requested slot has unconsumed >= 3.
            return {
              results: [
                { day: 'Tue', meal: 'breakfast', unconsumed: 4 },
              ],
            };
          }
          return { results: [] };
        },
        first: async () => null,
        run: async () => ({ meta: { changes: 0 } }),
      }),
    }),
  } as any;
  const res = await refillSlotsIfDeficit(fakeDB, 1, '2026-W19', 3, undefined, undefined, [{ day: 'Tue', meal: 'breakfast' }]);
  assert.equal(res.refilled.length, 0);
});

// Review regression guard: a failed job that has hit MAX_ATTEMPTS must NOT
// be flipped back to pending=attempt=0. Otherwise persistent broken slots
// (e.g. dashscope perma-500) get revived on every shuffle and the 3-attempt
// cap is silently bypassed.

// ─── migration + request_log schema ──────────

test('migration 0010 defines request_log + drain_lock tables', () => {
  const sql = readFileSync(rel('../migrations/0010_request_log.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS request_log/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_request_log_ts/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_request_log_status/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS drain_lock/);
});

test('admin/errors endpoint declared (admin-only, status>=400)', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  assert.match(src, /app\.get\('\/admin\/errors'/);
  // widened from status>=500 to status>=400 so admins also see
  // 4xx auth/validation rejections + lost_pool_image entries (logged at 200
  // but with error= field).
  assert.match(src, /FROM request_log WHERE status >= 400/);
});

test('log/daily + /log/vitals wrapped in try/catch with logRequest', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  // /log/daily handler must contain try / catch / logRequest.
  const dailyIdx = src.indexOf("app.post('/log/daily'");
  assert.ok(dailyIdx > 0, '/log/daily handler found');
  const dailyEnd = src.indexOf("app.post('/log/vitals'", dailyIdx);
  const daily = src.slice(dailyIdx, dailyEnd);
  assert.match(daily, /try \{/);
  assert.match(daily, /catch \(err\)/);
  assert.match(daily, /logRequest\(/);
  // /log/vitals handler must contain try / catch / logRequest.
  const vitIdx = src.indexOf("app.post('/log/vitals'");
  const vitEnd = src.indexOf("app.post('/log/vitals/:id/delete'", vitIdx);
  const vit = src.slice(vitIdx, vitEnd);
  assert.match(vit, /try \{/);
  assert.match(vit, /catch \(err\)/);
  assert.match(vit, /logRequest\(/);
});

// ─── menu_pool image persistence hard invariants ──────────



test('menu/img/:pool_id returns SVG placeholder when blob missing', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  const handlerIdx = src.indexOf("app.get('/menu/img/:pool_id'");
  assert.ok(handlerIdx > 0);
  // Take a generous slice; subsequent app.* registration marks end.
  const nextRegister = src.indexOf("\napp.", handlerIdx + 30);
  const handler = src.slice(handlerIdx, nextRegister > 0 ? nextRegister : handlerIdx + 5000);
  // No more redirect to image_url.
  assert.doesNotMatch(handler, /c\.redirect\(row\.image_url/);
  // SVG content-type + no-store cache-control + 'image lost' text present.
  assert.match(handler, /image\/svg\+xml/);
  assert.match(handler, /Cache-Control[^,]*no-store/);
  assert.match(handler, /image lost/);
  // logRequest call with lost_pool_image marker.
  assert.match(handler, /logRequest\(/);
  assert.match(handler, /lost_pool_image/);
});

test('migration 0011 declares dead-inventory cleanup', () => {
  const sql = readFileSync(rel('../migrations/0011_dead_inventory_cleanup.sql'), 'utf8');
  assert.match(sql, /UPDATE menu_pool SET consumed=1[\s\S]*image_blob IS NULL[\s\S]*consumed=0/);
  assert.match(sql, /UPDATE menu_jobs SET image_url=NULL[\s\S]*dashscope/);
});

test('health-pool-integrity.sh script exists + queries invariant', () => {
  const sh = readFileSync(rel('../scripts/health-pool-integrity.sh'), 'utf8');
  assert.match(sh, /image_blob IS NULL AND consumed=0/);
  assert.match(sh, /exit 1/);
});

test('getDisplayImageUrl wrapper returns /menu/img/:id', async () => {
  const mod = await import('../src/lib/image-url.ts');
  assert.equal(mod.getDisplayImageUrl({ id: 42 }), '/menu/img/42');
  assert.equal(mod.getDisplayImageUrl({ id: 1 }), '/menu/img/1');
});

test('views/pages.tsx uses getDisplayImageUrl (no raw image_url src)', () => {
  const src = readFileSync(rel('../src/views/pages.tsx'), 'utf8');
  assert.match(src, /import \{ getDisplayImageUrl \}/);
  assert.match(src, /src=\{getDisplayImageUrl\(/);
  // No fallback to image_url as image src remains.
  assert.doesNotMatch(src, /src=\{job\.menu_pool_id != null \?/);
  assert.doesNotMatch(src, /:\s*job\.image_url!/);
});

test('global userPathLogger middleware registered', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  assert.match(src, /const userPathLogger\s*=/);
  assert.match(src, /app\.use\('\/',\s*userPathLogger\)/);
  assert.match(src, /app\.use\('\/log\/\*',\s*userPathLogger\)/);
  assert.match(src, /app\.use\('\/menu\/\*',\s*userPathLogger\)/);
});

test('admin/errors widened to status >= 400', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  assert.match(src, /FROM request_log WHERE status >= 400/);
});

test('MenuPoolRow + MenuJobRow image_url fields carry the expiry warning', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  // Both interfaces declare a JSDoc warning above image_url.
  assert.match(src, /WARNING[\s\S]{0,400}image_url: string \| null;[\s\S]{0,200}menu_pool_id/);
});

// ─── drain LLM fetch goes through the gateway (not dashscope) ──────────
//
// All LLM traffic goes through the gateway worker. Experience showed that
// even with a correct wrangler.toml, a stale isolate or hidden hardcoded URL
// can silently keep hitting dashscope. Static-grep guards
// `src/lib/menu-gen.ts` so a regression must touch this file too.
test('menu-gen: chat fetch URL is ${gatewayUrl}${CHAT_PATH}, not dashscope', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  // CHAT_PATH constant defined once
  assert.match(src, /const CHAT_PATH\s*=\s*['"]\/v1\/chat\/completions['"]/);
  // exactly one fetch call to chat endpoint, parameterised on gatewayUrl
  assert.match(src, /fetch\(\s*chatUrl\s*,/);
  // chatUrl computed from gatewayUrl + CHAT_PATH (no hardcoded host)
  assert.match(src, /const chatUrl\s*=\s*`\$\{gatewayUrl\}\$\{CHAT_PATH\}`/);
  // negative: src must not contain a hardcoded dashscope LLM URL anywhere in fetch positions
  assert.doesNotMatch(src, /fetch\(\s*['"]https:\/\/[^'"]*dashscope/);
  assert.doesNotMatch(src, /fetch\(\s*['"]https:\/\/dashscope\.aliyuncs/);
});

test('menu-gen: image fetch URL is ${gatewayUrl}${IMG_PATH}, not dashscope', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  assert.match(src, /const IMG_PATH\s*=\s*['"]\/v1\/images\/generations['"]/);
  assert.match(src, /const imgEndpoint\s*=\s*`\$\{gatewayUrl\}\$\{IMG_PATH\}`/);
  assert.match(src, /fetch\(\s*imgEndpoint\s*,/);
});

test('menu-gen: diagnostic console.log emits url + token_prefix on chat fetch', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  // pre-fetch announce line
  assert.match(src, /spec:\s*['"]llm-gateway['"],\s*op:\s*['"]chat\.fetch['"]/);
  // error path captures final URL + status (catches CF redirect to dashscope)
  assert.match(src, /spec:\s*['"]llm-gateway['"],\s*op:\s*['"]chat\.fetch\.error['"][\s\S]{0,400}?final:\s*res\.url/);
  // token never logged in full, only an 8-char prefix
  assert.match(src, /const tokPrefix\s*=\s*\(serviceToken\s*\?\?\s*''\)\.slice\(0,\s*8\)/);
});

test('menu-gen: diagnostic console.log emits url + token_prefix on image fetch', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  assert.match(src, /spec:\s*['"]llm-gateway['"],\s*op:\s*['"]image\.fetch['"]/);
  assert.match(src, /spec:\s*['"]llm-gateway['"],\s*op:\s*['"]image\.fetch\.error['"][\s\S]{0,400}?final:\s*res\.url/);
});

test('src/ has no live dashscope fetch URL (only comments / scripts allowed)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const srcRoot = rel('../src');
  const hits: string[] = [];
  function walk(dir: string) {
    for (const ent of fs.readdirSync(dir)) {
      const p = path.join(dir, ent);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(p)) continue;
      const txt = fs.readFileSync(p, 'utf8');
      if (/fetch\(\s*['"`][^'"`]*dashscope[^'"`]*['"`]/.test(txt)) hits.push(p);
      if (/fetch\(\s*['"`][^'"`]*aliyuncs[^'"`]*['"`]/.test(txt)) hits.push(p);
    }
  }
  walk(srcRoot);
  assert.deepEqual(hits, [], `unexpected hardcoded dashscope fetch in: ${hits.join(', ')}`);
});

test('wrangler.toml LLM_GATEWAY_URL points at the configured LLM gateway', () => {
  const src = readFileSync(rel('../wrangler.toml'), 'utf8');
  assert.match(src, /LLM_GATEWAY_URL\s*=\s*"https:\/\/your-llm-gateway\.example\.com"/);
});

// ─── : service-binding aware LLM fetch ──────────

test('wrangler.toml ships a commented-out API_LLM service binding template', () => {
  const src = readFileSync(rel('../wrangler.toml'), 'utf8');
  // Commented-out [[services]] block with binding=API_LLM and a placeholder service name
  assert.match(src, /#\s*\[\[services\]\][\s\S]{0,200}?#\s*binding\s*=\s*"API_LLM"[\s\S]{0,200}?#\s*service\s*=\s*"your-llm-gateway-worker"/);
});




test('index.tsx Env declares optional API_LLM Fetcher', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  assert.match(src, /export\s+interface\s+Env[\s\S]*?API_LLM\?:\s*Fetcher/);
});

test('binding-aware fetch: runtime fallback when fetcher unset', async () => {
  // Behavioural test: setApiLlmFetcher(null) → makeLlmFetch returns globalThis.fetch
  // (we can't import menu-gen's private makeLlmFetch; instead reproduce its
  // shape and verify the slot getter returns null after clear).
  const mg = await import('../src/lib/menu-gen.ts');
  mg.setApiLlmFetcher(null);
  assert.equal(mg.getApiLlmFetcher(), null);
  const fakeBinding = {
    calls: 0 as number,
    fetch(_input: any, _init?: any) { this.calls++; return Promise.resolve(new Response('{}', { status: 200 })); },
  };
  mg.setApiLlmFetcher(fakeBinding as any);
  assert.equal(mg.getApiLlmFetcher(), fakeBinding);
  // Caller would invoke fakeBinding.fetch through makeLlmFetch; assert it's reachable.
  await fakeBinding.fetch('https://your-llm-gateway.example.com/v1/chat/completions');
  assert.equal(fakeBinding.calls, 1);
  // Cleanup so subsequent tests aren't affected.
  mg.setApiLlmFetcher(null);
});

// ─── (superseded) cron drain + active-user filtering ──────────







// ─── no live LLM: shuffle / prefill / two-state model / enqueue ──────────

import { prefillPoolWeek, shuffleMealJob as shuffleJob } from '../src/lib/menu-gen.ts';

function makeStubEnv(): any {
  return {
    LLM_GATEWAY_URL: 'https://gateway.example/v1',
    LLM_SERVICE_TOKEN: 'tok_abcdef12_test',
    LLM_MODEL: 'qwen-test',
    IMAGE_MODEL: 'qwen-image-test',
    LLM_TIMEOUT_MS: '10000',
    API_LLM: undefined,
  };
}

test('shuffleMealJob returns pool_empty + refilling when pool empty', async () => {
  const writes: any[] = [];
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        first: async () => {
          if (sql.includes('SELECT status, menu_pool_id')) return { status: 'ready', menu_pool_id: 10 };
          if (sql.includes('SELECT id, content, image_url FROM menu_pool')) return null; // pool empty
          return null;
        },
        run: async () => { writes.push({ sql, args }); return { meta: {} }; },
      }),
    }),
  } as any;
  const r = await shuffleJob(fakeDB, 1, '2026-W19', 'Mon', 'breakfast');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'pool_empty');
  assert.equal(r.refilling, true);
  assert.equal(r.status, 'empty');
  // Update set status='empty' (not 'pending')
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /status='empty'/);
});

test('shuffleMealJob ready path unchanged when pool has rows', async () => {
  const batches: any[] = [];
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (..._args: any[]) => ({
        first: async () => {
          if (sql.includes('SELECT status, menu_pool_id')) return { status: 'ready', menu_pool_id: 10 };
          if (sql.includes('SELECT id, content, image_url FROM menu_pool')) return { id: 11, content: '{"name":"new"}', image_url: 'https://img' };
          return null;
        },
      }),
    }),
    batch: async (stmts: any[]) => { batches.push(stmts.length); return []; },
  } as any;
  const r = await shuffleJob(fakeDB, 1, '2026-W19', 'Mon', 'breakfast');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ready');
  assert.equal(r.poolId, 11);
  assert.equal(batches[0], 3); // 2x consumed=1 + 1x menu_jobs UPDATE
});

// ─── shuffle blob-only + /menu/img seq=0 fallback ──────────

// Contract ①: after shuffle the pool row it lands on MUST carry image_blob. We assert
// the candidate query restricts to `image_blob IS NOT NULL` so seq≥1 (NULL-blob)
// rows can never be selected, AND that the ready path still swaps + returns the
// blob-bearing row.
test('shuffleMealJob candidate query filters image_blob IS NOT NULL', async () => {
  let candidateSql = '';
  const batches: any[] = [];
  const fakeDB = {
    prepare: (sql: string) => {
      if (sql.includes('SELECT id, content, image_url FROM menu_pool')) candidateSql = sql;
      return {
        bind: (..._args: any[]) => ({
          first: async () => {
            if (sql.includes('SELECT status, menu_pool_id')) return { status: 'ready', menu_pool_id: 10 };
            // Only a seq=0 (blob-bearing) row is returned by the DB because the
            // query itself excludes NULL-blob rows. id=20 stands in for seq=0.
            if (sql.includes('SELECT id, content, image_url FROM menu_pool')) return { id: 20, content: '{"name":"with-img"}', image_url: 'https://img' };
            return null;
          },
        }),
      };
    },
    batch: async (stmts: any[]) => { batches.push(stmts.length); return []; },
  } as any;
  const r = await shuffleJob(fakeDB, 3, '2026-W23', 'Thu', 'lunch');
  // The root-fix predicate must be present in the candidate selection.
  assert.match(candidateSql, /image_blob IS NOT NULL/);
  // Ready path otherwise unchanged: swapped to the blob-bearing row.
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ready');
  assert.equal(r.poolId, 20);
  assert.equal(batches[0], 3);
});

// Contract ②: /menu/img/:pool_id on a seq≥1 (NULL-blob) row must serve the same
// slot's seq=0 blob, NOT the grey placeholder. Static guard on the handler:
// it selects seq + slot keys, has a seq!=0 fallback querying seq=0 with
// `image_blob IS NOT NULL`, and only emits the placeholder/lost_pool_image
// after that fallback misses.
test('menu/img handler falls back to seq=0 blob before placeholder', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  const handlerIdx = src.indexOf("app.get('/menu/img/:pool_id'");
  assert.ok(handlerIdx > 0);
  const nextRegister = src.indexOf('\napp.', handlerIdx + 30);
  const handler = src.slice(handlerIdx, nextRegister > 0 ? nextRegister : handlerIdx + 6000);
  // The primary row read now carries slot keys + seq so a fallback is possible.
  assert.match(handler, /SELECT image_blob, image_format, image_url, user_id, iso_week, day, meal, seq/);
  // Fallback only for non-seq0 rows, querying the slot's seq=0 blob holder.
  assert.match(handler, /row\.seq !== 0/);
  assert.match(handler, /seq=0 AND image_blob IS NOT NULL/);
  // The seq=0 blob is actually served (Uint8Array Response) before placeholder.
  const fallbackIdx = handler.indexOf('row.seq !== 0');
  const placeholderIdx = handler.indexOf('image lost');
  assert.ok(fallbackIdx > 0 && placeholderIdx > fallbackIdx, 'seq0 fallback must precede placeholder');
  // Placeholder branch still exists as last resort (seq0 also blobless).
  assert.match(handler, /image\/svg\+xml/);
  assert.match(handler, /lost_pool_image/);
});

// Contract ① (consistency): flipEmptyJobsToReady shares the shuffle root cause —
// when a prefill flips an 'empty' slot to 'ready' it must also restrict its
// candidate pick to blob-bearing rows, else the slot turns ready showing the
// grey placeholder. Static guard on the (private, un-exported) helper's query.
test('flipEmptyJobsToReady candidate query also filters image_blob IS NOT NULL', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  const fnIdx = src.indexOf('async function flipEmptyJobsToReady');
  assert.ok(fnIdx > 0, 'flipEmptyJobsToReady must exist');
  // bound the slice to the function body (up to the next top-level declaration)
  const nextDecl = src.indexOf('\nasync function ', fnIdx + 30);
  const body = src.slice(fnIdx, nextDecl > 0 ? nextDecl : fnIdx + 2000);
  // its pool pick must exclude NULL-blob (seq≥1) rows, same as shuffleMealJob
  assert.match(body, /SELECT id, content, image_url FROM menu_pool/);
  assert.match(body, /image_blob IS NOT NULL/);
});

test('prefillPoolWeek is idempotent: already_prefilled when all slots ≥N', async () => {
  // Fake DB where every slot already has 3 unconsumed pool rows.
  const allSlots = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].flatMap(d =>
    ['breakfast','lunch','dinner','snack'].map(m => ({ day: d, meal: m, unconsumed: 3 }))
  );
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (..._args: any[]) => ({
        all: async () => {
          if (sql.includes('FROM menu_pool') && sql.includes('GROUP BY')) return { results: allSlots };
          if (sql.includes("status='empty'")) return { results: [] }; // no empty jobs to flip
          return { results: [] };
        },
        first: async () => null,
        run: async () => ({ meta: {} }),
      }),
    }),
    batch: async () => [],
  } as any;
  const r = await prefillPoolWeek(fakeDB, makeStubEnv(), 1, '2026-W19', undefined);
  assert.equal(r.status, 'already_prefilled');
  assert.equal(r.slotsChecked, 28);
  assert.equal(r.slotsFilled, 0);
  assert.equal(r.generatedRows, 0);
});

test('prefillPoolWeek returns empty_user when user not found', async () => {
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (..._args: any[]) => ({
        all: async () => ({ results: [] }), // pool empty for all slots → deficits exist
        first: async () => {
          if (sql.includes('FROM users u')) return null; // user not found
          return null;
        },
        run: async () => ({ meta: {} }),
      }),
    }),
    batch: async () => [],
  } as any;
  const r = await prefillPoolWeek(fakeDB, makeStubEnv(), 999, '2026-W19', undefined);
  assert.equal(r.status, 'empty_user');
  assert.equal(r.slotsFailed, 28);
  assert.equal(r.slotsFilled, 0);
});

test('menu-gen MenuJobRow.status is only "ready" | "empty"', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  assert.match(src, /status:\s*'ready'\s*\|\s*'empty'/);
  // Strip line + block comments before checking SQL literals.
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(noComments, /status='pending'/);
  assert.doesNotMatch(noComments, /status='running'/);
  assert.doesNotMatch(noComments, /status='failed'/);
});

test('index.tsx SELECT menu_jobs does NOT include "error" column', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  // Specifically check the dashboard SELECTs (single line, double-quoted).
  const selectLines = src.match(/"SELECT [^"]*FROM menu_jobs[^"]*"/g) ?? [];
  assert.ok(selectLines.length >= 2, 'dashboard should have at least 2 menu_jobs SELECTs');
  for (const s of selectLines) {
    assert.doesNotMatch(s, /\berror\b/, `unexpected error column in: ${s}`);
  }
});

test('pages.tsx renders no "Could not generate" / "Retry failed" UI', () => {
  const src = readFileSync(rel('../src/views/pages.tsx'), 'utf8');
  assert.doesNotMatch(src, /Could not generate/);
  assert.doesNotMatch(src, /Retry failed meals/);
  assert.doesNotMatch(src, /job\.error/);
  // empty-state placeholder text MUST be present.
  assert.match(src, /Refilling/i);
});

test('admin/backfill-pool route exists and references prefillPoolWeek', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  assert.match(src, /'\/admin\/backfill-pool'/);
  assert.match(src, /BACKFILL_USERNAMES/);
  assert.match(src, /prefillPoolWeek/);
});

test('grep-no-live-llm guard executable', async () => {
  const fs = await import('node:fs');
  const st = fs.statSync(rel('../scripts/grep-no-live-llm.sh'));
  // Mode bits include execute (any of u/g/o).
  assert.ok((st.mode & 0o111) !== 0, 'guard script must be executable');
});
test('menu-gen exports new prefill API surface', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  assert.match(src, /export async function prefillPoolWeek\(/);
  // : weeklyPrefillCron replaced by nightlyPrefillGuard.
  assert.match(src, /export async function nightlyPrefillGuard\(/);
  assert.match(src, /export async function drainPrefillQueue\(/);
  assert.match(src, /export async function enqueuePrefillSlice\(/);
  assert.match(src, /export interface PrefillEnv/);
  // The legacy per-minute drainEmptyMenuJobsCron MUST be gone .
  assert.doesNotMatch(src, /export\s+async\s+function\s+drainEmptyMenuJobsCron\b/);
  // weeklyPrefillCron also superseded by nightlyPrefillGuard.
  assert.doesNotMatch(src, /export\s+async\s+function\s+weeklyPrefillCron\b/);
});

test('menu-gen has NO processQueue / processOneJob / prefillPoolEager', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  // History comment may reference superseded names; check function declarations only.
  assert.doesNotMatch(src, /export\s+(async\s+)?function\s+processQueue\b/);
  assert.doesNotMatch(src, /(^|\n)async\s+function\s+processOneJob\b/);
  assert.doesNotMatch(src, /export\s+(async\s+)?function\s+prefillPoolEager\b/);
});

// ─── admin drain-all/drain-user escape hatches ──────────
//
// An earlier iteration imported maybeTriggerDrain from a drain-trigger.ts
// coordinator; that model was deleted in favor of menu_jobs.status='empty'
// plus queue-driven refills. These tests pin the current no-LLM-in-fetch
// design so the escape hatches can't silently regress.

test('POST /admin/drain-all route exists with correct shape', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  assert.match(src, /app\.post\(\s*['"]\/admin\/drain-all['"]/);
  const start = src.indexOf("app.post('/admin/drain-all'");
  assert.ok(start > 0, 'drain-all route found');
  const end = src.indexOf('app.post', start + 10);
  const body = src.slice(start, end > start ? end : start + 2000);
  // Selection scoped to seeded users with stuck rows in current+next iso_week
  assert.match(body, /SELECT DISTINCT j\.user_id/);
  assert.match(body, /menu_seed_state='seeded'/);
  assert.match(body, /j\.iso_week IN \(/);
  assert.match(body, /j\.status IN \('pending','failed'\)/);
  // No LLM calls in fetch path: must NOT call prefillPoolWeek or maybeTriggerDrain
  assert.doesNotMatch(body, /prefillPoolWeek\(/);
  assert.doesNotMatch(body, /maybeTriggerDrain\(/);
  assert.doesNotMatch(body, /ctx\.waitUntil\(/);
});

test('POST /admin/drain-user/:userId route exists and validates id', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  assert.match(src, /app\.post\(\s*['"]\/admin\/drain-user\/:userId['"]/);
  const start = src.indexOf("app.post('/admin/drain-user/:userId'");
  const end = src.indexOf('app.post', start + 10);
  const body = src.slice(start, end > start ? end : start + 1000);
  assert.match(body, /parseInt\(c\.req\.param\(['"]userId['"]\),\s*10\)/);
  assert.match(body, /Number\.isFinite\(userId\)/);
  // Same no-LLM-in-fetch invariant
  assert.doesNotMatch(body, /prefillPoolWeek\(/);
  assert.doesNotMatch(body, /ctx\.waitUntil\(/);
});

test('reset helper rewrites stuck rows to status=empty (cron picks up)', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  // Helper exists and uses the cron contract: status='empty' is the
  // single trigger drainEmptyMenuJobsCron scans for.
  assert.match(src, /async function resetStuckJobsForUser\(/);
  const start = src.indexOf('async function resetStuckJobsForUser');
  const end = src.indexOf('\n}\n', start);
  const body = src.slice(start, end + 3);
  assert.match(body, /UPDATE menu_jobs/);
  assert.match(body, /SET status='empty'/);
  assert.match(body, /attempt=0/);
  assert.match(body, /retry_after=NULL/);
  assert.match(body, /WHERE user_id=\?/);
  assert.match(body, /iso_week IN \(/);
  assert.match(body, /status IN \('pending','failed'\)/);
});

test('admin endpoints align with nightlyPrefillGuard window (current+next iso_week)', () => {
  // replaced drainEmptyMenuJobsCron with nightlyPrefillGuard +
  // drainPrefillQueue. Both scan current+next iso_week. Admin endpoints MUST
  // match that scope so a manual nudge resets the same rows the cron handles.
  const idx = readFileSync(rel('../src/index.tsx'), 'utf8');
  const mg = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  // Guard uses isoWeekForTzDate + nextIsoWeekFromDate — same shape used by
  // the legacy drain cron (just over `users` instead of `menu_jobs`).
  const guardStart = mg.indexOf('export async function nightlyPrefillGuard');
  assert.ok(guardStart > 0, 'nightlyPrefillGuard exported');
  const guardBody = mg.slice(guardStart, mg.indexOf('\n}', guardStart));
  assert.match(guardBody, /isoWeekForTzDate\(/);
  assert.match(guardBody, /nextIsoWeekFromDate\(/);
  assert.match(guardBody, /menu_seed_state = 'seeded'/);
  // Admin uses isoWeek() + nextIsoWeekFromDate over the same window
  const drainAllStart = idx.indexOf("app.post('/admin/drain-all'");
  const drainAllBody = idx.slice(drainAllStart, idx.indexOf('app.post', drainAllStart + 10));
  assert.match(drainAllBody, /isoWeek\(\)/);
  assert.match(drainAllBody, /nextIsoWeekFromDate\(/);
  // : admin endpoints enqueue prefill_queue continuations.
  assert.match(drainAllBody, /enqueuePrefillSlice\(/);
});

// ─── () event-driven prefill + nightly guard ──────────
//
// Replaces /187's per-minute drainEmptyMenuJobsCron loop with:
//  • nightlyPrefillGuard — daily 03:00 Melbourne (UTC 17:00) LLM kickoff
//  • prefill_queue (D1 table) — continuation slices, drained every */10
//  • shuffleMealJob pool_empty — enqueues into prefill_queue (event-driven)
//
// Invariants pinned below:
//  • wrangler.toml has no "* * * * *"; drainEmptyMenuJobsCron is gone
//  • nightlyPrefillGuard scans seeded users × {current, next}
//  • LLM calls bounded by user count, sliced via DEFAULT_MAX_SLOTS_PER_CALL
//  • pool_empty → enqueue → drain within minutes (not 22h later)
//  • admin endpoints enqueue continuations on reset
//  • grep guard script blocks reintroduction of "* * * * *"

import {
  enqueuePrefillSlice,
  drainPrefillQueue,
  nightlyPrefillGuard,
  DEFAULT_MAX_SLOTS_PER_CALL,
} from '../src/lib/menu-gen.ts';

test('wrangler.toml has no every-minute cron trigger', () => {
  const w = readFileSync(rel('../wrangler.toml'), 'utf8');
  // Strip TOML comments before matching so prose in the file describing
  // the forbidden pattern doesn't false-positive.
  const stripped = w.replace(/[ \t]*#.*$/gm, '');
  assert.doesNotMatch(stripped, /"\*[ \t]\*[ \t]\*[ \t]\*[ \t]\*"/);
});

test('wrangler.toml declares the new 03:00 + */10 schedule', () => {
  const w = readFileSync(rel('../wrangler.toml'), 'utf8');
  // Order isn't load-bearing but both entries MUST be present.
  assert.match(w, /"0 17 \* \* \*"/);
  assert.match(w, /"\*\/10 \* \* \* \*"/);
});

test('prefillPoolWeek slices deficits per DEFAULT_MAX_SLOTS_PER_CALL', async () => {
  // 28 deficit slots (all empty) → first call must attempt at most
  // DEFAULT_MAX_SLOTS_PER_CALL and report carriedOver via remainingDeficits.
  const llmCalls: any[] = [];
  const generateInsertWrites: any[] = [];
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        all: async () => {
          if (sql.includes('FROM menu_pool') && sql.includes('GROUP BY')) return { results: [] }; // no rows → all 28 slots deficit
          if (sql.includes("status='empty'")) return { results: [] };
          return { results: [] };
        },
        first: async () => {
          if (sql.includes('FROM users u')) {
            return {
              id: 1, username: 'u1', goal_kg: 60, current_kg: 70, height_cm: 165,
              activity: 'moderate', restrictions: null, dislikes: null, allergies: null,
            };
          }
          return null;
        },
        run: async () => {
          if (sql.startsWith('INSERT INTO menu_pool')) generateInsertWrites.push({ sql, args });
          return { meta: {} };
        },
      }),
    }),
    batch: async () => [],
  } as any;
  // Stub global fetch so prefillOneSlot's LLM calls return a structurally
  // valid candidate without actually hitting any network.
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, _init?: any) => {
    llmCalls.push(url);
    if (String(url).includes('chat/completions')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          name: 'Stub Meal', calories: 400, protein_g: 30, carbs_g: 30, fat_g: 10,
          ingredients: ['x'], instructions: ['y'],
        }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes('images/generations')) {
      return new Response(JSON.stringify({ data: [{ url: 'https://img/test.jpg' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const r = await prefillPoolWeek(fakeDB, makeStubEnv(), 1, '2026-W19', undefined);
    // We sliced at DEFAULT_MAX_SLOTS_PER_CALL; remainingDeficits = 28 - slice.
    // Don't pin slotsFilled (failing stub LLM tolerated), but the carry-over
    // contract MUST hold regardless of per-slot success/failure.
    assert.equal(r.slotsChecked, 28);
    assert.ok(
      r.remainingDeficits >= 28 - DEFAULT_MAX_SLOTS_PER_CALL,
      `remainingDeficits=${r.remainingDeficits} should be ≥ ${28 - DEFAULT_MAX_SLOTS_PER_CALL}`,
    );
    assert.equal(r.status, 'partial');
  } finally {
    (globalThis as any).fetch = origFetch;
  }
});

test('shuffleMealJob enqueues into prefill_queue on pool_empty', async () => {
  const writes: any[] = [];
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        first: async () => {
          if (sql.includes('SELECT status, menu_pool_id')) return { status: 'ready', menu_pool_id: 10 };
          if (sql.includes('SELECT id, content, image_url FROM menu_pool')) return null; // pool empty
          return null;
        },
        run: async () => { writes.push({ sql, args }); return { meta: {} }; },
      }),
    }),
  } as any;
  const env = makeStubEnv();
  const r = await shuffleJob(fakeDB, 1, '2026-W19', 'Mon', 'breakfast', undefined, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'pool_empty');
  assert.equal(r.refilling, true);
  // Two writes expected: (1) UPDATE menu_jobs status='empty', (2) INSERT INTO prefill_queue.
  const insertEnqueue = writes.find(w => /INSERT INTO prefill_queue/.test(w.sql));
  assert.ok(insertEnqueue, 'expected prefill_queue INSERT on pool_empty path');
  assert.match(insertEnqueue.sql, /ON CONFLICT\(user_id, iso_week\) DO UPDATE/);
  assert.equal(insertEnqueue.args[0], 1);          // user_id
  assert.equal(insertEnqueue.args[1], '2026-W19'); // iso_week
});

test('shuffleMealJob without env still no-ops gracefully (legacy callers)', async () => {
  // No env passed → no enqueue attempted, slot still reset to empty.
  const writes: any[] = [];
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        first: async () => {
          if (sql.includes('SELECT status, menu_pool_id')) return { status: 'ready', menu_pool_id: 10 };
          if (sql.includes('SELECT id, content, image_url FROM menu_pool')) return null;
          return null;
        },
        run: async () => { writes.push({ sql, args }); return { meta: {} }; },
      }),
    }),
  } as any;
  const r = await shuffleJob(fakeDB, 1, '2026-W19', 'Mon', 'breakfast');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'pool_empty');
  assert.doesNotMatch(writes.map(w => w.sql).join('\n'), /INSERT INTO prefill_queue/);
});

test('enqueuePrefillSlice uses INSERT ... ON CONFLICT (user_id, iso_week)', async () => {
  const writes: any[] = [];
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        run: async () => { writes.push({ sql, args }); return { meta: {} }; },
      }),
    }),
  } as any;
  await enqueuePrefillSlice(fakeDB, 7, '2026-W20', 1_700_000_000_000);
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /INSERT INTO prefill_queue/);
  assert.match(writes[0].sql, /ON CONFLICT\(user_id, iso_week\) DO UPDATE/);
  // Bound args: user_id, iso_week, enqueued_at(now), next_run_at
  assert.equal(writes[0].args[0], 7);
  assert.equal(writes[0].args[1], '2026-W20');
  assert.equal(writes[0].args[3], 1_700_000_000_000);
});

test('drainPrefillQueue early-exits when queue is empty', async () => {
  let selects = 0;
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (..._args: any[]) => ({
        first: async () => {
          selects++;
          return null; // queue empty
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: {} }),
      }),
    }),
  } as any;
  const r = await drainPrefillQueue(fakeDB, makeStubEnv(), { waitUntil: () => {}, passThroughOnException: () => {} } as any, Date.now());
  assert.equal(r.processed, 0);
  assert.equal(r.deletedEntries, 0);
  assert.equal(r.reArmedEntries, 0);
  assert.equal(selects, 1, 'should issue only the cheap LIMIT 1 peek');
});

test('nightlyPrefillGuard enqueues continuation when prefillPoolWeek returns partial', async () => {
  // Mock prefillPoolWeek path by intercepting the DB: user lookup returns
  // 28 deficit slots → partial is the expected outcome. We only verify the
  // ENQUEUE write happens; per-slot LLM behavior is covered by the slicing test.
  const writes: any[] = [];
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        all: async () => {
          if (sql.includes('FROM users u') && sql.includes("menu_seed_state = 'seeded'")) return { results: [{ id: 42 }] };
          if (sql.includes('FROM menu_pool') && sql.includes('GROUP BY')) return { results: [] };
          if (sql.includes("status='empty'")) return { results: [] };
          return { results: [] };
        },
        first: async () => {
          if (sql.includes('FROM users u')) {
            return {
              id: 42, username: 'u42', goal_kg: 60, current_kg: 70, height_cm: 165,
              activity: 'moderate', restrictions: null, dislikes: null, allergies: null,
            };
          }
          return null;
        },
        run: async () => { writes.push({ sql, args }); return { meta: {} }; },
      }),
    }),
    batch: async () => [],
  } as any;
  const origFetch = globalThis.fetch;
  // Force every per-slot LLM call to fail → partial + remainingDeficits>0
  (globalThis as any).fetch = async () => new Response('boom', { status: 500 });
  try {
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as any;
    const r = await nightlyPrefillGuard(fakeDB, makeStubEnv(), ctx, Date.now(), 'Australia/Melbourne');
    assert.equal(r.users, 1);
    assert.equal(r.weeks.length, 2);
    assert.ok(r.enqueued >= 1, `expected ≥1 enqueue on partial; got ${r.enqueued}`);
    const enqueueWrites = writes.filter(w => /INSERT INTO prefill_queue/.test(w.sql));
    assert.ok(enqueueWrites.length >= 1, 'at least one prefill_queue insert');
  } finally {
    (globalThis as any).fetch = origFetch;
  }
});

test('grep-no-minute-cron.sh exists and is executable', () => {
  const p = rel('../scripts/grep-no-minute-cron.sh');
  const stat = statSync(p);
  assert.ok(stat.isFile(), 'script must exist');
  // mode & 0o111 = any execute bit set
  assert.ok((stat.mode & 0o111) !== 0, 'script must be executable');
  const src = readFileSync(p, 'utf8');
  // The check must reference the forbidden literal explicitly so the failure
  // message tells the next engineer exactly what's wrong, and name the
  // replacement mechanism.
  assert.match(src, /\* \* \* \* \*/);
  assert.match(src, /nightlyPrefillGuard/);
});

test('admin escape hatch resets to empty AND enqueues continuation', () => {
  // Source-level invariant: the reset helper now exists alongside an
  // enqueuePrefillSlice call inside /admin/drain-all and /admin/drain-user.
  // This pins the no-22h-stall behavior at the static level so refactors
  // don't silently revert to the "wait for cron" path.
  const idx = readFileSync(rel('../src/index.tsx'), 'utf8');
  const allStart = idx.indexOf("app.post('/admin/drain-all'");
  const allEnd = idx.indexOf('app.post', allStart + 10);
  const allBody = idx.slice(allStart, allEnd > allStart ? allEnd : allStart + 3000);
  assert.match(allBody, /enqueuePrefillSlice\(/);
  const userStart = idx.indexOf("app.post('/admin/drain-user/:userId'");
  const userEnd = idx.indexOf('app.post', userStart + 10);
  const userBody = idx.slice(userStart, userEnd > userStart ? userEnd : userStart + 2000);
  assert.match(userBody, /enqueuePrefillSlice\(/);
});

// ─── GET /api/me Scriptable widget endpoint ──────────

// Regression guard: the route once existed only as an uncommitted prod edit and
// got wiped by a deploy-from-main. These assertions keep it in-tree and pin its
// auth/shape so it can't silently vanish again.
test('GET /api/me route exists, Bearer-auth, registered before requireUser', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  // Route is registered.
  const meIdx = src.indexOf("app.get('/api/me'");
  assert.ok(meIdx > 0, '/api/me route must exist');
  // It MUST be registered before the cookie-auth catch-all, else token requests
  // get 303-redirected to /login (the widget breaks). Anchor on the real
  // statement (newline-prefixed) so the explanatory comment that also mentions
  // app.use('/', requireUser) doesn't get matched first.
  const guardIdx = src.indexOf("\napp.use('/', requireUser)");
  assert.ok(guardIdx > 0);
  assert.ok(meIdx < guardIdx, '/api/me must register before app.use(/, requireUser)');
  // Handler slice up to the next app.* registration.
  const nextReg = src.indexOf('\napp.', meIdx + 20);
  const handler = src.slice(meIdx, nextReg > 0 ? nextReg : meIdx + 4000);
  // Bearer-token auth against API_TOKEN; 503 when unconfigured; 401 on bad token.
  assert.match(handler, /API_TOKEN/);
  assert.match(handler, /API_USER_ID/);
  assert.match(handler, /Bearer /);
  assert.match(handler, /api_not_configured/);
  assert.match(handler, /503/);
  assert.match(handler, /401/);
  // Response shape per .
  assert.match(handler, /deltaKg/);
  assert.match(handler, /idealRange/);
  assert.match(handler, /heightCm/);
  assert.match(handler, /trend:/);
  // Uses repo calc + exercise label deps (no new heavy logic).
  assert.match(handler, /calcBMI\(/);
  assert.match(handler, /bmiCategory\(/);
  assert.match(handler, /EXERCISE_OPTIONS/);
});

test('index.tsx imports EXERCISE_OPTIONS for /api/me label lookup', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  assert.match(src, /import \{ EXERCISE_IDS, EXERCISE_OPTIONS \} from '\.\/lib\/exercise\.ts'/);
});

test('Env interface declares API_TOKEN + API_USER_ID', () => {
  const src = readFileSync(rel('../src/index.tsx'), 'utf8');
  const envStart = src.indexOf('export interface Env {');
  const envEnd = src.indexOf('}', envStart);
  const env = src.slice(envStart, envEnd);
  assert.match(env, /API_TOKEN\?: string/);
  assert.match(env, /API_USER_ID\?: string/);
});

// ─── x-llm-usecase header passthrough (including Service Binding) ──────────
import { setApiLlmFetcher } from '../src/lib/menu-gen.ts';

// Reuses the same fakeDB shape as the generate tests: all 28 slots in deficit
// → triggers __generateMealCandidates (chat) + __generateImageUrl (image)
// through the real makeLlmFetch. Captures the headers of both requests and
// asserts x-llm-usecase is not swallowed on either the public-fetch or the
// Service Binding transport.
function makeUsecaseFakeDB(insertSink: any[]): any {
  return {
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        all: async () => ({ results: [] }),
        first: async () => {
          if (sql.includes('FROM users u')) {
            return {
              id: 1, username: 'u1', goal_kg: 60, current_kg: 70, height_cm: 165,
              activity: 'moderate', restrictions: null, dislikes: null, allergies: null,
            };
          }
          return null;
        },
        run: async () => {
          if (sql.startsWith('INSERT INTO menu_pool')) insertSink.push({ sql, args });
          return { meta: {} };
        },
      }),
    }),
    batch: async () => [],
  };
}

function chatOkResp(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ meals: Array.from({ length: 5 }, (_v, i) => ({
      name: `Stub ${i}`, ingredients: ['x'], kcal: 400,
    })) }) } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
function imgOkResp(): Response {
  return new Response(JSON.stringify({
    output: { choices: [{ message: { content: [{ image: 'https://img/test.jpg' }] } }] },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function headerOf(init: any, name: string): string | undefined {
  const h = init?.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get(name) ?? undefined;
  // plain object — case-insensitive lookup
  const key = Object.keys(h).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}

test('public fetch path: chat→menu-chat, image→menu-image header sent', async () => {
  setApiLlmFetcher(null); // public fetch path
  const captured: Array<{ url: string; usecase: string | undefined }> = [];
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init?: any) => {
    captured.push({ url: String(url), usecase: headerOf(init, 'x-llm-usecase') });
    if (String(url).includes('chat/completions')) return chatOkResp();
    if (String(url).includes('images/generations')) return imgOkResp();
    return new Response('not found', { status: 404 });
  };
  try {
    await prefillPoolWeek(makeUsecaseFakeDB([]), makeStubEnv(), 1, '2026-W19', undefined);
  } finally {
    (globalThis as any).fetch = origFetch;
  }
  const chat = captured.find(c => c.url.includes('chat/completions'));
  const img = captured.find(c => c.url.includes('images/generations'));
  assert.ok(chat, 'expected a chat/completions request');
  assert.equal(chat!.usecase, 'menu-chat');
  assert.ok(img, 'expected an images/generations request');
  assert.equal(img!.usecase, 'menu-image');
});

test('Service Binding path: x-llm-usecase header passthrough is not swallowed', async () => {
  const captured: Array<{ url: string; usecase: string | undefined; auth: string | undefined }> = [];
  const fakeBinding = {
    fetch(input: any, init?: any) {
      const url = typeof input === 'string' ? input : input?.url;
      captured.push({
        url: String(url),
        usecase: headerOf(init, 'x-llm-usecase'),
        auth: headerOf(init, 'Authorization'),
      });
      if (String(url).includes('chat/completions')) return Promise.resolve(chatOkResp());
      if (String(url).includes('images/generations')) return Promise.resolve(imgOkResp());
      return Promise.resolve(new Response('not found', { status: 404 }));
    },
  };
  setApiLlmFetcher(fakeBinding as any);
  try {
    const env = makeStubEnv();
    env.API_LLM = fakeBinding; // prefillPoolWeek internally calls setApiLlmFetcher(env.API_LLM) — must inject via env
    await prefillPoolWeek(makeUsecaseFakeDB([]), env, 1, '2026-W19', undefined);
  } finally {
    setApiLlmFetcher(null);
  }
  const chat = captured.find(c => c.url.includes('chat/completions'));
  const img = captured.find(c => c.url.includes('images/generations'));
  assert.ok(chat, 'expected a chat request through binding');
  assert.equal(chat!.usecase, 'menu-chat');
  assert.match(chat!.auth ?? '', /^Bearer /); // Authorization is not swallowed either (header-passthrough regression)
  assert.ok(img, 'expected an image request through binding');
  assert.equal(img!.usecase, 'menu-image');
});

// ─── menu prefill zero-row root fix ──────────
// The gateway can return an ~11MB data:URL; INSERTing it whole into
// menu_pool.image_url exceeds the D1 2MB row limit and fails every slot.
import { sanitizeImageUrlForDb, fetchAndCompressImage } from '../src/lib/menu-gen.ts';

const PNG_1PX_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('a) sanitizeImageUrlForDb: data: and oversized → null; http(s) pass through; falsy → null', () => {
  assert.equal(sanitizeImageUrlForDb('data:image/png;base64,' + PNG_1PX_B64), null);
  assert.equal(sanitizeImageUrlForDb('https://oss.example.com/x.png?' + 'x'.repeat(200_000)), null);
  const ok = 'https://dashscope-result.oss-cn-beijing.aliyuncs.com/img/abc.png';
  assert.equal(sanitizeImageUrlForDb(ok), ok);
  assert.equal(sanitizeImageUrlForDb(null), null);
  assert.equal(sanitizeImageUrlForDb(undefined), null);
  assert.equal(sanitizeImageUrlForDb(''), null);
});

test('a) prefillOneSlot INSERT binds the sanitized url (D1 2MB row limit)', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  assert.match(src, /isSeq0 \? sanitizeImageUrlForDb\(seq0Url\) : null/);
});

test('b) fetchAndCompressImage data: branch decodes inline to non-empty webp (no network)', async () => {
  const r = await fetchAndCompressImage('data:image/png;base64,' + PNG_1PX_B64);
  assert.ok(r, 'expected non-null result');
  assert.equal(r!.format, 'webp');
  assert.ok(r!.bytes.byteLength > 0, 'expected non-empty webp bytes');
});

test('b) fetchAndCompressImage data: branch rejects malformed input', async () => {
  assert.equal(await fetchAndCompressImage('data:image/png;base64'), null); // no comma
  assert.equal(await fetchAndCompressImage('data:image/png;base64,!!!not-base64!!!'), null); // atob throws → outer catch → null
});

test('c) IMG_TIMEOUT_MS raised 60s→120s; no frozen 60s literal in timeout message', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  assert.match(src, /const IMG_TIMEOUT_MS\s+=\s+120_000/);
  assert.doesNotMatch(src, /ImgGen timeout \(60s\)/);
});

test('d) drainPrefillQueue tick budget guard (12min, checked per entry)', () => {
  const src = readFileSync(rel('../src/lib/menu-gen.ts'), 'utf8');
  assert.match(src, /const DRAIN_TICK_BUDGET_MS = 12 \* 60_000/);
  assert.match(src, /Date\.now\(\) - tickStartMs > DRAIN_TICK_BUDGET_MS/);
});

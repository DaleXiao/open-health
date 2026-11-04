// health.openclawd — Cloudflare Workers, Hono, D1.

import { Hono } from 'hono';
import type { D1Database, Fetcher, ScheduledEvent, ExecutionContext } from '@cloudflare/workers-types';

import {
  hashPassword, verifyPassword, signSession, verifySession,
  sessionCookie, clearSessionCookie, readSessionCookie,
  signAdminFlash, verifyAdminFlash, adminFlashCookie,
  clearAdminFlashCookie, readAdminFlashCookie,
} from './lib/auth.ts';
import { calcAge, calcBMI, idealWeightRange, isoWeek, localDate, bmiCategory, weekdayMelbourne } from './lib/calc.ts';
import { EXERCISE_IDS, EXERCISE_OPTIONS } from './lib/exercise.ts';
import { seedMenuJobs, scheduledWeeklyRenewTzAware, processAwaitingFirstSeeds, seedMenuJobsMultiWeek, nextIsoWeekFromDate, shuffleMealJob, fetchAndCompressImage, refillSlotsIfDeficit, isoWeekForTzDate, prefillPoolWeek, nightlyPrefillGuard, drainPrefillQueue, enqueuePrefillSlice, getLocalParts, DAYS, MEALS, type MenuJobRow, type PrefillEnv } from './lib/menu-gen.ts';
import { logRequest } from './lib/req-log.ts';

import { LoginView, RegisterView } from './views/auth.tsx';
import { Dashboard, AdminView } from './views/pages.tsx';
import { guardedDB } from './lib/db-guard.ts';
import { SettingsView } from './views/settings.tsx';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // Service binding to the LLM gateway worker (same account, same zone).
  // Optional so wrangler dev / unit tests without binding still type-check;
  // menu-gen.ts falls back to public LLM_GATEWAY_URL when undefined.
  API_LLM?: Fetcher;
  SESSION_SECRET: string;
  // No direct dashscope key on this worker; LLM/image calls go through the
  // gateway (LLM_GATEWAY_URL / API_LLM binding).
  LLM_GATEWAY_URL: string;
  LLM_SERVICE_TOKEN: string;
  LLM_MODEL: string;
  IMAGE_MODEL: string;
  // Optional override (string per wrangler vars convention).
  LLM_TIMEOUT_MS?: string;
  DEFAULT_TZ: string;
  ADMIN_BOOTSTRAP_USERNAME?: string;
  ADMIN_BOOTSTRAP_PASSWORD?: string;
  // Bearer-token auth for the read-only Scriptable widget endpoint
  // GET /api/me. Optional so wrangler dev / tests without the secrets still
  // type-check; the route returns 503 api_not_configured when either is unset.
  API_TOKEN?: string;
  API_USER_ID?: string;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: 'user' | 'admin';
  birthday: string | null;
  gender: 'M' | 'F' | 'other' | null;
  height_cm: number | null;
  menu_seed_state: 'awaiting_first' | 'seeded' | null;
  awaiting_since_ms: number | null;
  created_at: number;
  updated_at: number;
}

type AppVars = { user: UserRow; db: D1Database };

function isoWeekStartDate(iso: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(iso);
  if (!m) return new Date().toISOString().slice(0, 10);
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

const app = new Hono<{ Bindings: Env; Variables: AppVars }>();

app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    c.header('Strict-Transport-Security', 'max-age=86400');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('X-Frame-Options', 'SAMEORIGIN');
    return c.redirect(url.toString(), 308);
  }
  await next();
  c.header('Strict-Transport-Security', 'max-age=86400');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'SAMEORIGIN');
});

// ─── Static assets ───
app.get('/assets/*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.get('/favicon.png', (c) => c.env.ASSETS.fetch(c.req.raw));
app.get('/logo.png', (c) => c.env.ASSETS.fetch(c.req.raw));

// Menu images are stored directly as dashscope temporary URLs; no R2/menu-img route.

// ─── Bootstrap admin if users table empty (idempotent) ───
async function maybeBootstrap(env: Env): Promise<void> {
  if (!env.ADMIN_BOOTSTRAP_USERNAME || !env.ADMIN_BOOTSTRAP_PASSWORD) return;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  if (row && row.n > 0) return;
  const now = Date.now();
  const hash = await hashPassword(env.ADMIN_BOOTSTRAP_PASSWORD);
  await env.DB.prepare(
    'INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(env.ADMIN_BOOTSTRAP_USERNAME, hash, 'admin', now, now).run();
}

// ─── Auth middleware ───
async function loadUser(c: Parameters<Parameters<typeof app.use>[1]>[0]): Promise<UserRow | null> {
  const env = c.env as Env;
  const raw = readSessionCookie(c.req.raw);
  const sess = await verifySession(env.SESSION_SECRET, raw);
  if (!sess) return null;
  return await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(sess.userId).first<UserRow>() ?? null;
}

const requireUser = async (c: any, next: () => Promise<void>) => {
  const u = await loadUser(c);
  if (!u) return c.redirect('/login', 303);
  if (u.role !== 'user') return c.redirect('/admin', 303);
  c.set('user', u);
  await next();
};

const requireAdmin = async (c: any, next: () => Promise<void>) => {
  const u = await loadUser(c);
  if (!u) return c.redirect('/login', 303);
  if (u.role !== 'admin') return c.text('Forbidden', 403);
  c.set('user', u);
  // Role boundary — wrap D1 so any accidental read of health
  // tables from an admin handler throws AdminAccessViolation.
  c.set('db', guardedDB(c.env.DB, 'admin'));
  await next();
};

// Settings: any logged-in role (user or admin).
const requireLoggedIn = async (c: any, next: () => Promise<void>) => {
  const u = await loadUser(c);
  if (!u) return c.redirect('/login', 303);
  c.set('user', u);
  c.set('db', c.env.DB as D1Database);
  await next();
};

// ─── Public routes ───

app.get('/login', async (c) => {
  await maybeBootstrap(c.env);
  return c.html(<LoginView error={c.req.query('error') ?? undefined} notice={c.req.query('ok') === 'pw_changed' ? 'Password updated — please sign in with your new password.' : undefined} />);
});

app.post('/login', async (c) => {
  await maybeBootstrap(c.env);
  const form = await c.req.formData();
  const username = String(form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!username || !password) return c.html(<LoginView error="Username and password required." />, 400);
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<UserRow>();
  if (!u || !(await verifyPassword(password, u.password_hash))) {
    return c.html(<LoginView error="Wrong username or password." />, 401);
  }
  const cookie = await signSession(c.env.SESSION_SECRET, u.id, u.role);
  c.header('Set-Cookie', sessionCookie(cookie));
  return c.redirect(u.role === 'admin' ? '/admin' : '/', 303);
});

app.post('/logout', (c) => {
  c.header('Set-Cookie', clearSessionCookie());
  return c.redirect('/login', 303);
});

app.get('/register', (c) => c.html(<RegisterView />));

app.post('/register', async (c) => {
  const form = await c.req.formData();
  const username = String(form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const birthday = String(form.get('birthday') ?? '').trim();
  const gender = String(form.get('gender') ?? '').trim();
  const heightStr = String(form.get('height_cm') ?? '').trim();
  const weightStr = String(form.get('weight_kg') ?? '').trim();
  const values = { username, birthday, gender, height_cm: heightStr, weight_kg: weightStr };

  if (!username || username.length < 2 || username.length > 32) return c.html(<RegisterView error="Username must be 2–32 characters." values={values} />, 400);
  if (!password || password.length < 6) return c.html(<RegisterView error="Password must be at least 6 characters." values={values} />, 400);
  if (!birthday || !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return c.html(<RegisterView error="Birthday is required." values={values} />, 400);
  if (!['M', 'F', 'other'].includes(gender)) return c.html(<RegisterView error="Gender is required." values={values} />, 400);
  const height_cm = parseFloat(heightStr);
  if (!Number.isFinite(height_cm) || height_cm < 80 || height_cm > 230) return c.html(<RegisterView error="Height must be 80–230 cm." values={values} />, 400);
  const weight_kg = parseFloat(weightStr);
  if (!Number.isFinite(weight_kg) || weight_kg < 20 || weight_kg > 300) return c.html(<RegisterView error="Weight must be 20–300 kg." values={values} />, 400);

  const dup = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (dup) return c.html(<RegisterView error="That username is taken." values={values} />, 409);

  const now = Date.now();
  const hash = await hashPassword(password);
  const result = await c.env.DB.prepare(
    'INSERT INTO users (username, password_hash, role, birthday, gender, height_cm, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(username, hash, 'user', birthday, gender, height_cm, now, now).run();
  const newId = Number(result.meta.last_row_id);

  // Write first daily_weight entry.
  const today = localDate(c.env.DEFAULT_TZ);
  await c.env.DB.prepare(
    'INSERT INTO daily_weight (user_id, date, weight_kg, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET weight_kg = excluded.weight_kg'
  ).bind(newId, today, weight_kg, now).run();

  // Do NOT seed menu jobs immediately. Mark the user as awaiting first seed;
  // the cron triggers seeding at the next 03:00 in the user's tz.
  await c.env.DB.prepare(
    `UPDATE users SET menu_seed_state='awaiting_first', awaiting_since_ms=?, updated_at=? WHERE id=?`
  ).bind(now, now, newId).run();

  const cookie = await signSession(c.env.SESSION_SECRET, newId, 'user');
  c.header('Set-Cookie', sessionCookie(cookie));
  return c.redirect('/', 303);
});

// ─── Read-only Scriptable widget endpoint ──────────────────────────────
// GET /api/me — Bearer-token JSON for a personal-health iOS widget. Must be
// registered ahead of the cookie-auth catch-all (the requireUser mount on '/'),
// otherwise requireUser 303-redirects the token request to /login and the
// widget's loadJSON() chokes on HTML.
//
// Keep this route in-tree: a deploy from committed main overwrites any
// uncommitted local edit on the live worker, which once silently turned this
// route into a 404 and broke the widget.
//
// Auth: Authorization: Bearer <API_TOKEN>. Returns 503 when API_TOKEN /
// API_USER_ID env are unset, 401 on missing/bad token, 404 if the configured
// user id no longer exists. Never 404s for a valid token.
app.get('/api/me', async (c) => {
  if (!c.env.API_TOKEN || !c.env.API_USER_ID) {
    return c.json({ error: 'api_not_configured' }, 503);
  }
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== c.env.API_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const userId = parseInt(c.env.API_USER_ID, 10);
  if (isNaN(userId)) return c.json({ error: 'api_not_configured' }, 503);

  const u = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(userId).first<UserRow>();
  if (!u) return c.json({ error: 'user_not_found' }, 404);

  const today = localDate(c.env.DEFAULT_TZ);
  const [latestRes, prevRes, trendRes, exerciseRes] = await Promise.all([
    // most recent weight on/before today
    c.env.DB.prepare(
      'SELECT date, weight_kg FROM daily_weight WHERE user_id = ? ORDER BY date DESC LIMIT 1',
    ).bind(u.id).first<{ date: string; weight_kg: number }>(),
    // the weight just before that, for deltaKg
    c.env.DB.prepare(
      'SELECT date, weight_kg FROM daily_weight WHERE user_id = ? ORDER BY date DESC LIMIT 1 OFFSET 1',
    ).bind(u.id).first<{ date: string; weight_kg: number }>(),
    // last 30 days weight trend, oldest→newest
    c.env.DB.prepare(
      "SELECT date, weight_kg FROM daily_weight WHERE user_id = ? AND date >= date(?, '-30 days') ORDER BY date ASC",
    ).bind(u.id, today).all<{ date: string; weight_kg: number }>(),
    // today's exercise (if logged)
    c.env.DB.prepare(
      'SELECT kind, note FROM daily_exercise WHERE user_id = ? AND date = ?',
    ).bind(u.id, today).first<{ kind: string; note: string | null }>(),
  ]);

  const latestKg = latestRes?.weight_kg ?? null;
  const deltaKg =
    latestRes && prevRes ? Math.round((latestRes.weight_kg - prevRes.weight_kg) * 10) / 10 : null;
  const bmiVal = latestKg != null ? calcBMI(latestKg, u.height_cm) : null;
  const ideal = idealWeightRange(u.height_cm);

  const exLabel = exerciseRes
    ? (EXERCISE_OPTIONS.find((e) => e.id === exerciseRes.kind)?.label ?? exerciseRes.kind)
    : null;

  return c.json({
    date: today,
    weight: {
      kg: latestKg,
      date: latestRes?.date ?? null,
      deltaKg,
    },
    bmi: {
      value: bmiVal,
      category: bmiCategory(bmiVal),
      idealRange: ideal,
    },
    trend: trendRes.results.map((r) => ({ date: r.date, kg: r.weight_kg })),
    exercise: exerciseRes
      ? { kind: exerciseRes.kind, label: exLabel, note: exerciseRes.note }
      : null,
    heightCm: u.height_cm,
  });
});

// ─── User routes ───

app.use('/', requireUser);
app.use('/log/*', requireUser);
app.use('/menu/*', requireUser);

// request_log middleware (post-auth user paths).
//
// Design choice: we register this AFTER requireUser so `c.get('user')` is
// available for user_id attribution. To avoid logging every dashboard GET
// twice (cheap reads), we record only:
//   • status >= 400  (errors / redirects-with-error get the row)
//   • /menu/img/*    (so admins can see lost_pool_image bursts)
//   • /log/*         (already had inline logRequest calls;
//                     middleware now covers any path we forgot to wrap)
//
// Inline logRequest calls in /log/daily and /log/vitals are kept — they
// carry more granular error reasons (e.g. weight-range) that the generic
// middleware can't infer from status code alone. The middleware is the
// safety-net, not the primary logger.
const userPathLogger = async (c: any, next: () => Promise<void>) => {
  const t0 = Date.now();
  await next();
  const status = c.res.status;
  const path = c.req.path;
  const shouldLog =
    status >= 400 ||
    path.startsWith('/menu/img/');
  if (!shouldLog) return;
  const user = c.get('user');
  logRequest(c.env.DB, c.executionCtx as any, {
    user_id: user?.id ?? null,
    path,
    method: c.req.method,
    status,
    duration_ms: Date.now() - t0,
    error: null,
    ua: c.req.header('user-agent') ?? null,
  });
};
app.use('/', userPathLogger);
app.use('/log/*', userPathLogger);
app.use('/menu/*', userPathLogger);

app.get('/', async (c) => {
  const u = c.get('user');
  const today = localDate(c.env.DEFAULT_TZ);
  const isoW = isoWeek();
  const tz = c.env.DEFAULT_TZ;
  const todayDay = weekdayMelbourne(tz);

  const [weights30Res, vitalsRow, vitalsTrendRes, weightToday, exerciseToday, todayJobsRes, allWeekJobsRes, weights365Res, exercises365Res] = await Promise.all([
    c.env.DB.prepare(
      "SELECT date, weight_kg FROM daily_weight WHERE user_id = ? AND date >= date(?, '-30 days') ORDER BY date ASC"
    ).bind(u.id, today).all<{ date: string; weight_kg: number }>(),
    c.env.DB.prepare(
      // Latest vitals event for current week (was: weekly_vitals row).
      'SELECT id, iso_week, heart_rate, bp_systolic, bp_diastolic, height_cm, measured_at FROM vitals_events WHERE user_id = ? AND iso_week = ? ORDER BY measured_at DESC LIMIT 1'
    ).bind(u.id, isoW).first<{ id: number; iso_week: string; heart_rate: number | null; bp_systolic: number | null; bp_diastolic: number | null; height_cm: number | null; measured_at: number }>(),
    c.env.DB.prepare(
      // Full event stream for trend chart (was: 1 row per iso_week).
      'SELECT id, iso_week, heart_rate, bp_systolic, bp_diastolic, height_cm, measured_at FROM vitals_events WHERE user_id = ? ORDER BY measured_at ASC'
    ).bind(u.id).all<{ id: number; iso_week: string; heart_rate: number | null; bp_systolic: number | null; bp_diastolic: number | null; height_cm: number | null; measured_at: number }>(),
    c.env.DB.prepare('SELECT weight_kg FROM daily_weight WHERE user_id = ? AND date = ?').bind(u.id, today).first<{ weight_kg: number }>(),
    c.env.DB.prepare('SELECT kind, note FROM daily_exercise WHERE user_id = ? AND date = ?').bind(u.id, today).first<{ kind: string; note: string | null }>(),
    c.env.DB.prepare(
      "SELECT day, meal, status, content_json, image_url, menu_pool_id FROM menu_jobs WHERE user_id=? AND iso_week=? AND day=? ORDER BY meal ASC"
    ).bind(u.id, isoW, todayDay).all<Pick<MenuJobRow, 'day' | 'meal' | 'status' | 'content_json' | 'image_url' | 'menu_pool_id'>>(),
    c.env.DB.prepare(
      "SELECT day, meal, status, content_json, image_url, menu_pool_id FROM menu_jobs WHERE user_id=? AND iso_week=? ORDER BY day ASC, meal ASC"
    ).bind(u.id, isoW).all<Pick<MenuJobRow, 'day' | 'meal' | 'status' | 'content_json' | 'image_url' | 'menu_pool_id'>>(),
    // Cap weight scan to 365 days (was unbounded full-table scan;
    //   CF observed exceededResources for heavy-history users). Trend ranges 1M/3M/6M/1Y filter
    //   client-side from this set; 'All' is now effectively 1Y. The heatmap renders only
    //   the last 180 days, sliced inside <WeightHeatmap>.
    c.env.DB.prepare(
      "SELECT date, weight_kg FROM daily_weight WHERE user_id = ? AND date >= date(?, '-365 days') ORDER BY date ASC"
    ).bind(u.id, today).all<{ date: string; weight_kg: number }>(),
    // Exercise heatmap window 365 → 180 days (matches new heatmap COLS=26).
    c.env.DB.prepare(
      "SELECT date, kind, note FROM daily_exercise WHERE user_id = ? AND date >= date(?, '-180 days')"
    ).bind(u.id, today).all<{ date: string; kind: string; note: string | null }>(),
  ]);

  const weights365: Record<string, number> = {};
  for (const r of weights365Res.results) weights365[r.date] = r.weight_kg;
  const vitalsTrend = vitalsTrendRes.results.map(v => ({
    ...v,
    // Date string still derived for any consumer that needs day-level grouping (heatmap, etc.).
    date: v.measured_at ? new Date(v.measured_at).toISOString().slice(0, 10) : isoWeekStartDate(v.iso_week),
  }));
  const recentVitals = vitalsTrend.slice(-20).reverse();
  const exercises365: Record<string, { kind: string; note: string | null }> = {};
  for (const r of exercises365Res.results) exercises365[r.date] = { kind: r.kind, note: r.note };

  const weights30 = weights30Res.results;
  const latest = weights30.length ? weights30[weights30.length - 1] : null;
  const bmi = latest ? calcBMI(latest.weight_kg, u.height_cm) : null;
  const ideal = idealWeightRange(u.height_cm);
  const weekVitalsLogged = vitalsRow != null;

  const notice = c.req.query('ok') ? 'Saved.' : null;
  const error = c.req.query('error') ? `Error: ${c.req.query('error')}` : null;

  // The dashboard no longer triggers a drain. The cron handler runs
  // refills on schedule, gated on active-user existence.
  // A fetch-handler `ctx.waitUntil` LLM call gets cancelled by CF as soon
  // as the dashboard response flushes — so LLM work lives in cron only.

  return c.html(
    <Dashboard
      username={u.username}
      age={calcAge(u.birthday)}
      gender={u.gender}
      height_cm={u.height_cm}
      latestWeight={latest}
      bmi={bmi}
      bmiCategory={bmiCategory(bmi)}
      ideal={ideal}
      weights30={weights30}
      latestVitals={vitalsRow ?? null}
      todayDate={today}
      isoWeek={isoW}
      todayDay={todayDay as any}
      todayWeight={weightToday?.weight_kg ?? null}
      todayExercise={exerciseToday ?? null}
      weekVitals={vitalsRow ?? null}
      weekVitalsLogged={weekVitalsLogged}
      todayJobs={todayJobsRes.results}
      allWeekJobs={allWeekJobsRes.results}
      menuSeedState={u.menu_seed_state}
      weights365={weights365}
      vitalsTrend={vitalsTrend}
      recentVitals={recentVitals}
      exercises365={exercises365}
      notice={notice}
      error={error}
    />
  );
});

// Combined daily log (weight + exercise).
// Wrapped in try/catch + request_log telemetry.
app.post('/log/daily', async (c) => {
  const u = c.get('user');
  const start = Date.now();
  try {
    const form = await c.req.formData();
    const weight = parseFloat(String(form.get('weight_kg') ?? ''));
    if (!Number.isFinite(weight) || weight < 20 || weight > 300) {
      logRequest(c.env.DB, c.executionCtx as any, { user_id: u.id, path: '/log/daily', method: 'POST', status: 303, duration_ms: Date.now() - start, error: 'weight-range', ua: c.req.header('user-agent') ?? null });
      return c.redirect('/?error=weight-range', 303);
    }
    const today = localDate(c.env.DEFAULT_TZ);
    const now = Date.now();
    await c.env.DB.prepare(
      'INSERT INTO daily_weight (user_id, date, weight_kg, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET weight_kg = excluded.weight_kg'
    ).bind(u.id, today, weight, now).run();
    const exerciseKind = String(form.get('exercise_kind') ?? '').trim();
    if (exerciseKind && EXERCISE_IDS.includes(exerciseKind as any)) {
      const note = String(form.get('ex_note') ?? '').trim().slice(0, 200) || null;
      if (exerciseKind === 'other' && !note) {
        logRequest(c.env.DB, c.executionCtx as any, { user_id: u.id, path: '/log/daily', method: 'POST', status: 303, duration_ms: Date.now() - start, error: 'note-required', ua: c.req.header('user-agent') ?? null });
        return c.redirect('/?error=note-required', 303);
      }
      await c.env.DB.prepare(
        'INSERT INTO daily_exercise (user_id, date, kind, note, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET kind = excluded.kind, note = excluded.note'
      ).bind(u.id, today, exerciseKind, note, now).run();
    }
    logRequest(c.env.DB, c.executionCtx as any, { user_id: u.id, path: '/log/daily', method: 'POST', status: 303, duration_ms: Date.now() - start, ua: c.req.header('user-agent') ?? null });
    return c.redirect('/?ok=1', 303);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.error('[/log/daily]', msg);
    logRequest(c.env.DB, c.executionCtx as any, { user_id: u.id, path: '/log/daily', method: 'POST', status: 500, duration_ms: Date.now() - start, error: msg, ua: c.req.header('user-agent') ?? null });
    return c.text('Internal error', 500);
  }
});

// vitals_events — every submission appends a new row.
// Wrapped in try/catch + request_log telemetry.
app.post('/log/vitals', async (c) => {
  const u = c.get('user');
  const start = Date.now();
  try {
  const form = await c.req.formData();
  const hr = String(form.get('heart_rate') ?? '').trim();
  const sys = String(form.get('bp_systolic') ?? '').trim();
  const dia = String(form.get('bp_diastolic') ?? '').trim();
  const hStr = String(form.get('height_cm') ?? '').trim();
  const heart_rate = hr ? parseInt(hr, 10) : null;
  const bp_systolic = sys ? parseInt(sys, 10) : null;
  const bp_diastolic = dia ? parseInt(dia, 10) : null;
  const height_cm = hStr ? parseFloat(hStr) : null;
  if (heart_rate != null && (heart_rate < 30 || heart_rate > 220)) return c.redirect('/?error=hr', 303);
  if (bp_systolic != null && (bp_systolic < 60 || bp_systolic > 260)) return c.redirect('/?error=bp', 303);
  if (bp_diastolic != null && (bp_diastolic < 30 || bp_diastolic > 200)) return c.redirect('/?error=bp', 303);
  if (height_cm != null && (height_cm < 80 || height_cm > 230)) return c.redirect('/?error=height', 303);
  // At least one field must be present — don't append empty rows.
  if (heart_rate == null && bp_systolic == null && bp_diastolic == null && height_cm == null) {
    return c.redirect('/?error=vitals-empty', 303);
  }
  const now = Date.now();
  const isoW = isoWeek();
  await c.env.DB.prepare(
    `INSERT INTO vitals_events (user_id, measured_at, iso_week, heart_rate, bp_systolic, bp_diastolic, height_cm, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?)`
  ).bind(u.id, now, isoW, heart_rate, bp_systolic, bp_diastolic, height_cm, now).run();
  if (height_cm != null) {
    await c.env.DB.prepare('UPDATE users SET height_cm = ?, updated_at = ? WHERE id = ?').bind(height_cm, now, u.id).run();
  }
  logRequest(c.env.DB, c.executionCtx as any, { user_id: u.id, path: '/log/vitals', method: 'POST', status: 303, duration_ms: Date.now() - start, ua: c.req.header('user-agent') ?? null });
  return c.redirect('/?ok=1#weekly', 303);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.error('[/log/vitals]', msg);
    logRequest(c.env.DB, c.executionCtx as any, { user_id: u.id, path: '/log/vitals', method: 'POST', status: 500, duration_ms: Date.now() - start, error: msg, ua: c.req.header('user-agent') ?? null });
    return c.text('Internal error', 500);
  }
});

// Delete a single vitals event.
app.post('/log/vitals/:id/delete', async (c) => {
  const u = c.get('user');
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id)) return c.redirect('/?error=vitals-id', 303);
  await c.env.DB.prepare('DELETE FROM vitals_events WHERE id = ? AND user_id = ?').bind(id, u.id).run();
  return c.redirect('/?ok=1#weekly', 303);
});

// "Generate now" — seed the current week + next week in full, mark seeded.
// /menu/generate is kept as an alias for older frontends.
async function doSeedNow(c: any): Promise<Response> {
  const u = c.get('user');
  const now = Date.now();
  const currentIso = isoWeek();
  const nextIso = nextIsoWeekFromDate(new Date(now));
  await seedMenuJobsMultiWeek(c.env.DB, u.id, [currentIso, nextIso]);
  await c.env.DB.prepare(
    `UPDATE users SET menu_seed_state='seeded', awaiting_since_ms=NULL, updated_at=? WHERE id=?`
  ).bind(now, u.id).run();
  // Kick async prefill for both weeks (idempotent).
  for (const w of [currentIso, nextIso]) {
    c.executionCtx.waitUntil(
      prefillPoolWeek(c.env.DB, c.env as unknown as PrefillEnv, u.id, w, c.executionCtx)
        .then(() => undefined)
        .catch((err: unknown) => console.warn('[seed-now prefill]', (err as Error)?.message)),
    );
  }
  return c.redirect('/#menu', 303);
}
app.post('/menu/seed-now', doSeedNow);
app.post('/menu/generate', doSeedNow);

// Serve thumbnail blob from D1.
// When the blob is missing, return an inline SVG "image lost"
// placeholder (NOT a 302 redirect to dashscope, which 404s after 7d).
// Also writes a lost_pool_image entry to request_log so admins can detect
// invariant violations (any occurrence is a bug).
app.get('/menu/img/:pool_id', async (c) => {
  const u = c.get('user');
  const start = Date.now();
  const poolId = parseInt(c.req.param('pool_id'), 10);
  if (isNaN(poolId)) return c.text('Not found', 404);

  const row = await c.env.DB.prepare(
    `SELECT image_blob, image_format, image_url, user_id, iso_week, day, meal, seq
     FROM menu_pool WHERE id = ? AND user_id = ?`
  ).bind(poolId, u.id).first<{ image_blob: ArrayBuffer | null; image_format: string | null; image_url: string | null; user_id: number; iso_week: string; day: string; meal: string; seq: number }>();

  if (!row) return c.text('Not found', 404);

  if (row.image_blob) {
    const mime = row.image_format === 'jpeg' ? 'image/jpeg' : 'image/webp';
    const bytes = new Uint8Array(row.image_blob);
    return new Response(bytes, {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  // Fallback / defense: the requested row has no blob (it is a
  // seq≥1 candidate — only seq=0 rows persist the blob). Before giving
  // up to the placeholder, fall back to the same slot's seq=0 row, which is the
  // invariant blob holder. This covers existing data already shuffled onto a
  // seq≥1 row before the root fix landed, so those meals show an
  // image immediately without a backfill. We only reach the placeholder when
  // even seq=0 lacks a blob (a genuine invariant violation worth
  // logging).
  if (row.seq !== 0) {
    const seq0 = await c.env.DB.prepare(
      `SELECT image_blob, image_format FROM menu_pool
       WHERE user_id=? AND iso_week=? AND day=? AND meal=? AND seq=0 AND image_blob IS NOT NULL
       ORDER BY batch_no DESC LIMIT 1`
    ).bind(row.user_id, row.iso_week, row.day, row.meal).first<{ image_blob: ArrayBuffer | null; image_format: string | null }>();
    if (seq0?.image_blob) {
      const mime = seq0.image_format === 'jpeg' ? 'image/jpeg' : 'image/webp';
      const bytes = new Uint8Array(seq0.image_blob);
      return new Response(bytes, {
        headers: {
          'Content-Type': mime,
          'Content-Length': String(bytes.byteLength),
          // no-store: a backfill/regen that gives this very pool row its own
          // blob should win on the next load rather than be masked by a cached
          // sibling image.
          'Cache-Control': 'no-store',
        },
      });
    }
  }

  // Blob missing AND no seq=0 fallback available — NEVER redirect
  // to dashscope (URL is dead after 7d). Return inline SVG placeholder, no-store
  // so the moment a backfill / regen lands, users see the real image on next load.
  console.warn('[lost-pool-image]', poolId);
  logRequest(c.env.DB, c.executionCtx as any, {
    user_id: u.id,
    path: `/menu/img/${poolId}`,
    method: 'GET',
    status: 200,
    duration_ms: Date.now() - start,
    error: `lost_pool_image pool_id=${poolId}`,
    ua: c.req.header('user-agent') ?? null,
  });
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'>`
    + `<rect width='200' height='200' fill='#e0e0e0'/>`
    + `<text x='100' y='105' text-anchor='middle' font-family='system-ui' font-size='14' fill='#666'>image lost</text>`
    + `</svg>`;
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store',
    },
  });
});

// Shuffle one meal — pool-only, no LLM fallback.
app.post('/menu/shuffle/:day/:meal', async (c) => {
  const u = c.get('user');
  const day = c.req.param('day');
  const meal = c.req.param('meal');
  const isoW = isoWeek();
  if (!DAYS.includes(day as any) || !MEALS.includes(meal as any)) {
    return c.redirect('/#menu', 303);
  }
  await shuffleMealJob(c.env.DB, u.id, isoW, day, meal, c.executionCtx, c.env as unknown as PrefillEnv);
  return c.redirect('/#menu', 303);
});

// /menu/retry replaced — no live LLM retry. Trigger an
// idempotent background prefill for the current week instead.
app.post('/menu/retry', async (c) => {
  const u = c.get('user');
  const isoW = isoWeek();
  c.executionCtx.waitUntil(
    prefillPoolWeek(c.env.DB, c.env as unknown as PrefillEnv, u.id, isoW, c.executionCtx)
      .then(() => undefined)
      .catch(err => console.warn('[/menu/retry prefill]', (err as Error)?.message)),
  );
  return c.redirect('/', 303);
});

// ─── Admin routes (NO access to weight/vitals/menu tables) ───

app.use('/admin', requireAdmin);
app.use('/admin/*', requireAdmin);

// Admin path logger (status>=400 only; admin reads are noisy).
const adminPathLogger = async (c: any, next: () => Promise<void>) => {
  const t0 = Date.now();
  await next();
  const status = c.res.status;
  if (status < 400) return;
  const user = c.get('user');
  logRequest(c.env.DB, c.executionCtx as any, {
    user_id: user?.id ?? null,
    path: c.req.path,
    method: c.req.method,
    status,
    duration_ms: Date.now() - t0,
    error: null,
    ua: c.req.header('user-agent') ?? null,
  });
};
app.use('/admin', adminPathLogger);
app.use('/admin/*', adminPathLogger);

app.get('/admin', async (c) => {
  const adminUser = c.get('user');
  const flash = await verifyAdminFlash(c.env.SESSION_SECRET, readAdminFlashCookie(c.req.raw));
  if (readAdminFlashCookie(c.req.raw)) c.header('Set-Cookie', clearAdminFlashCookie());
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  const users = await c.env.DB.prepare(
    "SELECT id, username, role, created_at FROM users ORDER BY id ASC"
  ).all<{ id: number; username: string; role: 'user' | 'admin'; created_at: number }>();
  return c.html(<AdminView username={adminUser.username} users={users.results} notice={flash ?? c.req.query('ok') ?? null} error={c.req.query('error') ?? null} />);
});

// Admin diagnostic — inspect menu_pool / menu_jobs counts per (user, iso_week)
// to verify pool sizing and detect lazy-fill stalls. Admin only.
//
// SECURITY / privacy contract:
//   This endpoint queries menu_pool directly via raw SQL, **intentionally**.
//   Aggregate stats only — COUNT(*), SUM(consumed=0), GROUP BY (day, meal, status).
//   The response MUST NEVER expand to expose menu_pool.content (LLM-generated meal
//   text, possibly containing user-profile-derived dietary data) or menu_pool.image_url
//   (CDN URL of the user's generated meal image). Both are user-private content.
//   If future diagnostics need richer fields, add a SEPARATE admin endpoint with
//   per-user authz + audit log; do NOT widen this endpoint's SELECT list.
//   Regression: see test/unit.test.ts 'admin/menu-pool/stats handler — no
//   content/image_url in SQL or response'.
app.get('/admin/menu-pool/stats', async (c) => {
  const userId = parseInt(c.req.query('user_id') ?? '', 10);
  const isoWeek = String(c.req.query('iso_week') ?? '').trim();
  if (!Number.isFinite(userId) || !isoWeek) return c.json({ error: 'user_id and iso_week required' }, 400);

  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) AS pool_rows, SUM(CASE WHEN consumed=0 THEN 1 ELSE 0 END) AS unconsumed
     FROM menu_pool WHERE user_id=? AND iso_week=?`
  ).bind(userId, isoWeek).first<{ pool_rows: number; unconsumed: number }>();

  const perCell = await c.env.DB.prepare(
    `SELECT day, meal, COUNT(*) AS pool_size, SUM(CASE WHEN consumed=0 THEN 1 ELSE 0 END) AS unconsumed
     FROM menu_pool WHERE user_id=? AND iso_week=?
     GROUP BY day, meal ORDER BY day, meal`
  ).bind(userId, isoWeek).all<{ day: string; meal: string; pool_size: number; unconsumed: number }>();

  const jobs = await c.env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM menu_jobs WHERE user_id=? AND iso_week=? GROUP BY status`
  ).bind(userId, isoWeek).all<{ status: string; n: number }>();

  return c.json({
    user_id: userId,
    iso_week: isoWeek,
    pool_rows: totals?.pool_rows ?? 0,
    pool_unconsumed: totals?.unconsumed ?? 0,
    expected_pool_rows: 7 * 4 * 5,
    cells: perCell.results,
    job_status: Object.fromEntries(jobs.results.map(r => [r.status, r.n])),
  });
});

// One-shot backfill — fetch + compress + write image_blob for rows
// that still rely on the dashscope redirect fallback. Limit per call to keep
// CPU under the Workers cap; call it repeatedly until remaining=0.
app.post('/admin/backfill-image-blobs', async (c) => {
  const limit = Math.max(1, Math.min(50, parseInt(c.req.query('limit') ?? '20', 10)));
  const rows = await c.env.DB.prepare(
    `SELECT id, image_url FROM menu_pool
      WHERE image_blob IS NULL AND image_url IS NOT NULL
      ORDER BY id ASC
      LIMIT ?`
  ).bind(limit).all<{ id: number; image_url: string }>();

  let done = 0; let failed = 0;
  for (const row of rows.results) {
    const blob = await fetchAndCompressImage(row.image_url);
    if (!blob) { failed++; continue; }
    await c.env.DB.prepare(
      `UPDATE menu_pool SET image_blob=?, image_format=?, image_thumb_w=?, image_thumb_h=?
        WHERE id=?`
    ).bind(blob.bytes, blob.format, 200, 200, row.id).run();
    done++;
    // 200ms between rows — rate-limit guidance.
    await new Promise(r => setTimeout(r, 200));
  }

  const remainingRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM menu_pool WHERE image_blob IS NULL AND image_url IS NOT NULL`
  ).first<{ n: number }>();

  return c.json({
    scanned: rows.results.length,
    done,
    failed,
    remaining: remainingRow?.n ?? 0,
    limit,
  });
});

// Admin escape hatch for stuck menu_jobs.
//
// Refills are driven by nightlyPrefillGuard (daily 03:00) + per-shuffle
// enqueue into prefill_queue (drained by the */10 cron); there is no
// per-minute scan loop. The admin escape hatch follows the
// same contract — reset stuck rows to status='empty' AND enqueue an explicit
// continuation so the next */10 tick picks the user up within ~5–10 min,
// not 22 hours later at the next 03:00.
//
//   - find seeded users' menu_jobs rows in current+next iso_week that are
//     stuck in legacy non-terminal states (status IN ('pending','failed'))
//   - reset them to status='empty', attempt=0, retry_after=NULL, started_at=NULL,
//     finished_at=NULL
//   - enqueuePrefillSlice for each affected (user, iso_week) pair
//   - return counts.
//
// No LLM calls in fetch path. No ctx.waitUntil(prefillPoolWeek). Idempotent:
// running twice on already-empty rows is a no-op for the UPDATE; the enqueue
// step is a no-op via UNIQUE(user_id, iso_week) ON CONFLICT.
//
// Why current+next: nightlyPrefillGuard scans the same window; matching that
// scope keeps admin behavior aligned with the cron's natural boundary.
const DRAIN_RESET_STATUSES = ['pending', 'failed'] as const;

async function resetStuckJobsForUser(
  db: D1Database,
  userId: number,
  isoWeeks: readonly string[],
): Promise<{ user_id: number; reset: number; weeks: string[] }> {
  const placeholders = isoWeeks.map(() => '?').join(',');
  const r = await db.prepare(
    `UPDATE menu_jobs
        SET status='empty', attempt=0, retry_after=NULL,
            started_at=NULL, finished_at=NULL
      WHERE user_id=?
        AND iso_week IN (${placeholders})
        AND status IN ('pending','failed')`,
  ).bind(userId, ...isoWeeks).run();
  return { user_id: userId, reset: r.meta?.changes ?? 0, weeks: [...isoWeeks] };
}

// POST /admin/drain-all — fan out reset across every seeded user.
app.post('/admin/drain-all', async (c) => {
  const currentIso = isoWeek();
  const nextIso = nextIsoWeekFromDate(new Date());
  const weeks = [currentIso, nextIso] as const;
  const placeholders = weeks.map(() => '?').join(',');
  // Only users that actually have stuck rows in window — keeps response small
  // and avoids touching users with nothing to do.
  const users = await c.env.DB.prepare(
    `SELECT DISTINCT j.user_id
       FROM menu_jobs j
       INNER JOIN users u ON u.id = j.user_id
      WHERE u.menu_seed_state='seeded'
        AND j.iso_week IN (${placeholders})
        AND j.status IN ('pending','failed')`,
  ).bind(...weeks).all<{ user_id: number }>();

  const details: Array<{ user_id: number; reset: number; weeks: string[] }> = [];
  let totalReset = 0;
  for (const u of users.results) {
    const r = await resetStuckJobsForUser(c.env.DB, u.user_id, weeks);
    totalReset += r.reset;
    // Enqueue an explicit prefill continuation so the
    // next */10 cron tick picks up this user within ~5–10 min, not 22h
    // later at the next 03:00 nightly guard.
    for (const w of weeks) {
      try { await enqueuePrefillSlice(c.env.DB, u.user_id, w, Date.now()); }
      catch (err) { console.warn(`[admin/drain-all] enqueue failed u=${u.user_id} ${w}`, (err as Error)?.message); }
    }
    details.push(r);
  }
  return c.json({
    iso_weeks: weeks,
    users: users.results.length,
    total_rows_reset: totalReset,
    note: 'rows now status=empty; prefill_queue continuations enqueued, */10 drain picks up within ~5–10 min',
    details,
  });
});

// POST /admin/drain-user/:userId — surgical, one user.
app.post('/admin/drain-user/:userId', async (c) => {
  const userId = parseInt(c.req.param('userId'), 10);
  if (!Number.isFinite(userId)) return c.json({ error: 'bad user_id' }, 400);
  const currentIso = isoWeek();
  const nextIso = nextIsoWeekFromDate(new Date());
  const weeks = [currentIso, nextIso] as const;
  const r = await resetStuckJobsForUser(c.env.DB, userId, weeks);
  // Explicit enqueue for fast pickup.
  for (const w of weeks) {
    try { await enqueuePrefillSlice(c.env.DB, userId, w, Date.now()); }
    catch (err) { console.warn(`[admin/drain-user] enqueue failed u=${userId} ${w}`, (err as Error)?.message); }
  }
  return c.json({
    ...r,
    iso_weeks: weeks,
    note: 'rows now status=empty; prefill_queue continuation enqueued, */10 drain picks up within ~5–10 min',
  });
});

// One-shot ops backfill endpoint for a fixed username list.
// Triggers idempotent prefillPoolWeek for hard-coded user list × (current +
// next iso_week). Each prefill is fire-and-forget via ctx.waitUntil so the
// response returns immediately with the list of queued (user, week) pairs.
//
// Usage:
//   curl -X POST -H "Cookie: session=<admin>" \
//        https://<your-domain>/admin/backfill-pool
// Example usernames — replace with your own.
const BACKFILL_USERNAMES = ['alice', 'bob', 'carol'] as const;
app.post('/admin/backfill-pool', async (c) => {
  const now = Date.now();
  const currentIso = isoWeek();
  const nextIso = nextIsoWeekFromDate(new Date(now));
  const placeholders = BACKFILL_USERNAMES.map(() => '?').join(',');
  const rows = await c.env.DB.prepare(
    `SELECT id, username FROM users WHERE username IN (${placeholders})`,
  ).bind(...BACKFILL_USERNAMES).all<{ id: number; username: string }>();

  const queued: Array<{ user: string; userId: number; isoWeek: string }> = [];
  for (const u of rows.results) {
    // Seed 'empty' rows only — NO c.executionCtx.waitUntil(prefillPoolWeek)
    // (CF kills fetch-handler waitUntil after response flush; LLM round-trips
    // never complete). Then explicit enqueuePrefillSlice so the */10 cron
    // drains it within minutes, instead of waiting for the next 03:00 guard.
    await seedMenuJobsMultiWeek(c.env.DB, u.id, [currentIso, nextIso]);
    for (const w of [currentIso, nextIso]) {
      try { await enqueuePrefillSlice(c.env.DB, u.id, w, Date.now()); }
      catch (err) { console.warn(`[admin/backfill-pool] enqueue failed u=${u.id} ${w}`, (err as Error)?.message); }
      queued.push({ user: u.username, userId: u.id, isoWeek: w });
    }
  }
  return c.json({
    queued,
    requestedUsernames: BACKFILL_USERNAMES,
    foundUserCount: rows.results.length,
    weeks: [currentIso, nextIso],
  });
});

// Recent 4xx+5xx errors view (admin only).
// Widened to status >= 400 (was 500); admins want to see auth
// rejections, validation failures, and lost_pool_image markers too.
app.get('/admin/errors', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, user_id, path, method, status, duration_ms, error, ua, ts
     FROM request_log WHERE status >= 400 ORDER BY ts DESC LIMIT 100`
  ).all<{ id: number; user_id: number | null; path: string; method: string; status: number; duration_ms: number | null; error: string | null; ua: string | null; ts: number }>();
  const esc = (s: string | null | undefined) =>
    (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tr = rows.results.map(r => `<tr>
      <td>${r.id}</td>
      <td>${new Date(r.ts).toISOString()}</td>
      <td>${r.user_id ?? ''}</td>
      <td>${esc(r.method)}</td>
      <td><code>${esc(r.path)}</code></td>
      <td>${r.status}</td>
      <td>${r.duration_ms ?? ''}</td>
      <td><code>${esc(r.error).slice(0, 240)}</code></td>
      <td>${esc(r.ua).slice(0, 80)}</td>
    </tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>request errors</title>
    <style>body{font-family:system-ui,sans-serif;margin:1rem;background:#0d1117;color:#e6edf3}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #30363d;padding:4px 6px;vertical-align:top;text-align:left}th{background:#161b22}code{font-family:ui-monospace,monospace;font-size:11px}a{color:#58a6ff}</style></head>
    <body><h1>request_log status≥500 — last 100</h1><p><a href="/admin">← back to admin</a></p>
    <table><thead><tr><th>id</th><th>ts (UTC)</th><th>user</th><th>method</th><th>path</th><th>status</th><th>ms</th><th>error</th><th>ua</th></tr></thead>
    <tbody>${tr || '<tr><td colspan="9">no errors logged</td></tr>'}</tbody></table></body></html>`;
  return c.html(html);
});

app.post('/admin/users', async (c) => {
  const form = await c.req.formData();
  const username = String(form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const role = String(form.get('role') ?? 'user');
  if (!username || username.length < 2 || password.length < 6 || !['user', 'admin'].includes(role)) {
    return c.redirect('/admin?error=invalid', 303);
  }
  const dup = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (dup) return c.redirect('/admin?error=duplicate', 303);
  const now = Date.now();
  const hash = await hashPassword(password);
  await c.env.DB.prepare(
    'INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(username, hash, role, now, now).run();
  return c.redirect('/admin?ok=created', 303);
});

app.post('/admin/users/:id/reset', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id)) return c.redirect('/admin?error=badid', 303);
  // Generate temp password (10 chars from URL-safe alphabet).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let temp = '';
  for (const b of bytes) temp += alphabet[b % alphabet.length];
  const hash = await hashPassword(temp);
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(hash, Date.now(), id).run();
  const flash = await signAdminFlash(c.env.SESSION_SECRET, 'Temp password: ' + temp + ' — ask user to log in and go to /settings to change it.');
  c.header('Set-Cookie', adminFlashCookie(flash));
  return c.redirect('/admin', 303);
});

app.post('/admin/users/:id/delete', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id)) return c.redirect('/admin?error=badid', 303);
  const me = c.get('user');
  if (id === me.id) return c.redirect('/admin?error=self', 303);
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return c.redirect('/admin?ok=deleted', 303);
});

// ─── Settings (all logged-in roles) ───
app.use('/settings', requireLoggedIn);
app.use('/settings/*', requireLoggedIn);

app.get('/settings', async (c) => {
  const u = c.get('user');
  const ok = c.req.query('ok');
  const err = c.req.query('error');
  const section = (c.req.query('section') as 'profile' | 'password' | null) ?? null;
  const SUCCESS_MSGS: Record<string, string> = {
    password: 'Password updated. Please sign in again.',
    profile: 'Profile saved.',
  };
  const ERROR_MSGS: Record<string, string> = {
    current_pw: 'Current password is incorrect.',
    pw_mismatch: 'New passwords don\'t match.',
    pw_short: 'New password must be at least 8 characters.',
    height: 'Height must be 100–230 cm.',
    gender: 'Please select a valid gender.',
    birthday: 'Birthday must be a valid date (YYYY-MM-DD).',
  };
  return c.html(
    <SettingsView
      username={u.username}
      role={u.role}
      birthday={u.birthday}
      gender={u.gender}
      height_cm={u.height_cm}
      success={ok ? (SUCCESS_MSGS[ok] ?? 'Saved.') : null}
      error={err ? (ERROR_MSGS[err] ?? err) : null}
      section={section}
    />
  );
});

app.post('/settings/profile', async (c) => {
  const u = c.get('user');
  if (u.role === 'admin') return c.redirect('/settings?error=admin_no_profile&section=profile', 303);
  const form = await c.req.formData();
  const birthday = String(form.get('birthday') ?? '').trim();
  const gender = String(form.get('gender') ?? '').trim();
  const heightStr = String(form.get('height_cm') ?? '').trim();
  if (!birthday || !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return c.redirect('/settings?error=birthday&section=profile', 303);
  if (!['M', 'F', 'other'].includes(gender)) return c.redirect('/settings?error=gender&section=profile', 303);
  const height_cm = parseFloat(heightStr);
  if (!Number.isFinite(height_cm) || height_cm < 100 || height_cm > 230) return c.redirect('/settings?error=height&section=profile', 303);
  await c.env.DB.prepare(
    'UPDATE users SET birthday = ?, gender = ?, height_cm = ?, updated_at = ? WHERE id = ?'
  ).bind(birthday, gender, height_cm, Date.now(), u.id).run();
  return c.redirect('/settings?ok=profile&section=profile', 303);
});

app.post('/settings/password', async (c) => {
  const u = c.get('user');
  const form = await c.req.formData();
  const current = String(form.get('current_password') ?? '');
  const next = String(form.get('new_password') ?? '');
  const confirm = String(form.get('confirm_password') ?? '');
  if (next.length < 8) return c.redirect('/settings?error=pw_short&section=password', 303);
  if (next !== confirm) return c.redirect('/settings?error=pw_mismatch&section=password', 303);
  if (!(await verifyPassword(current, u.password_hash))) return c.redirect('/settings?error=current_pw&section=password', 303);
  const hash = await hashPassword(next);
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'
  ).bind(hash, Date.now(), u.id).run();
  // Clear session so user must re-login with new password.
  c.header('Set-Cookie', clearSessionCookie());
  return c.redirect('/login?ok=pw_changed', 303);
});

// ─── Hard 404 + error fallback ───
app.notFound((c) => c.text('Not found', 404));
app.onError((err, c) => {
  console.error('[onError]', err);
  return c.text('Internal error', 500);
});

// ─── Scheduled handler (cron) ───


async function scheduledHandler(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  // Zero per-minute scanning. The handler now
  // fires on a daily cron ("0 17 * * *" = Melbourne 03:00) plus a queue-drain
  // cron ("*/10 * * * *"). We can't cheaply distinguish the two triggers in
  // a single scheduled handler, so we run the always-cheap drain + the
  // gated nightly guard every invocation. The nightly path early-exits when
  // local hour ≠ 3; the drain early-exits when prefill_queue is empty.
  const nowMs = Date.now();
  const tz = env.DEFAULT_TZ;

  // (1) processAwaitingFirstSeeds — first-seed gating already waits until
  // local 03:00 via nextLocal3amMs, so calling it on either cron is safe.
  ctx.waitUntil(
    processAwaitingFirstSeeds(env.DB, tz, nowMs, env as unknown as PrefillEnv, ctx)
      .then(() => undefined),
  );

  // (2) Sunday-03:00 weekly renew (seed next iso_week + GC old pool). The
  // function self-gates on weekday==Sun && hour==3, so it's a cheap no-op
  // on the */10 ticks.
  ctx.waitUntil(scheduledWeeklyRenewTzAware(env.DB, tz, nowMs).then(() => undefined));

  // (3) Nightly prefill guard — the ONLY scheduled LLM kickoff. Self-gates
  // on local hour===3 so it fires once per day (matches "0 17 * * *" UTC =
  // Melbourne 03:00). On partial results it enqueues continuations into
  // prefill_queue (drained by step 4).
  const local = getLocalParts(nowMs, tz);
  if (local.hour === 3) {
    ctx.waitUntil(
      nightlyPrefillGuard(env.DB, env as unknown as PrefillEnv, ctx, nowMs, tz)
        .then(r => console.log(`[nightlyPrefillGuard] users=${r.users} weeks=${r.weeks.join(',')} enqueued=${r.enqueued}`))
        .catch(err => console.error('[nightlyPrefillGuard] threw', (err as Error)?.message)),
    );
  }

  // (4) prefill_queue drain — every tick. Cheap when queue is empty
  // (one SELECT LIMIT 1). When non-empty, processes up to MAX_ENTRIES_PER_TICK
  // entries; partial slices stay queued for the next tick.
  ctx.waitUntil(
    drainPrefillQueue(env.DB, env as unknown as PrefillEnv, ctx, nowMs)
      .then(r => { if (r.processed > 0) console.log(`[drainPrefillQueue] processed=${r.processed} deleted=${r.deletedEntries} reArmed=${r.reArmedEntries}`); })
      .catch(err => console.error('[drainPrefillQueue] threw', (err as Error)?.message)),
  );
}

// Export both fetch and scheduled handlers.
export default {
  fetch: app.fetch,
  scheduled: scheduledHandler,
};

// No live LLM calls at request time. All meal candidates and images must come
// from menu_pool, prefilled asynchronously on registration + nightly cron + on
// shuffle when a slot is exhausted. shuffleMealJob only swaps the menu_jobs
// pointer to the next unconsumed pool row; if the pool is empty for that
// slot, the job goes to status='empty' and a background prefill is triggered.
//
// History (superseded models):
//   - menu_jobs + per-meal queue + processQueue cron drain.
//   - weekly renew + shuffle.
//   - prefillPoolEager (chunked sequential).
//   - dashboard waitUntil drain + pool refill + transient-error classification.
//   - gateway routing for LLM calls.
//   - API_LLM service binding (kept; reused by the prefill path).
//   - per-minute cron drain + active-user filtering (deleted).
//
// The no-live-LLM model deleted:
//   - processQueue, processOneJob, prefillPoolEager (live LLM drain codepath)
//   - drain-trigger.ts (cron drain coordinator)
//   - status "pending" / "running" / "failed" (now compacted to ready/empty)
//
// Renamed to private (only caller: prefillPoolWeek):
//   - generateMealCandidates → __generateMealCandidates
//   - generateImageUrl       → __generateImageUrl
//
// Added:
//   - prefillPoolWeek(...)  idempotent per-week prefill (chunked sequential)
//
// The event-driven prefill model supersedes the drain model:
//   DELETES drainEmptyMenuJobsCron + weeklyPrefillCron entirely.
//   ADDS:
//     - nightlyPrefillGuard(...)  daily 03:00 (DEFAULT_TZ) safety net; the
//                                 ONLY scheduled LLM kickoff in the system.
//     - enqueuePrefillSlice(...)  writes prefill_queue (D1) for event-driven
//                                 continuation (called from nightly-guard
//                                 partials and the shuffleMealJob pool_empty
//                                 branch).
//     - drainPrefillQueue(...)    every-10-min cron entrypoint; cheap when
//                                 queue is empty; sliced LLM otherwise.
//   EXTENDS prefillPoolWeek with a maxSlots cap (DEFAULT_MAX_SLOTS_PER_CALL=8)
//   and PrefillPoolWeekResult.remainingDeficits so callers can re-enqueue.

import type { D1Database } from '@cloudflare/workers-types';

// ─── Service binding fetcher ──────────────────────────────────────────────
export interface LlmFetcher {
  fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
}
let __apiLlmFetcher: LlmFetcher | null = null;
export function setApiLlmFetcher(f: LlmFetcher | null | undefined): void {
  __apiLlmFetcher = f ?? null;
}
export function getApiLlmFetcher(): LlmFetcher | null {
  return __apiLlmFetcher;
}
function makeLlmFetch(): typeof globalThis.fetch {
  const bound = __apiLlmFetcher;
  if (bound && typeof bound.fetch === 'function') {
    return ((input: any, init?: RequestInit) => bound.fetch(input, init)) as typeof globalThis.fetch;
  }
  return globalThis.fetch.bind(globalThis);
}

// All LLM/image calls go through the LLM gateway worker (LLM_GATEWAY_URL,
// or the API_LLM service binding when present).
const CHAT_PATH = '/v1/chat/completions';
const IMG_PATH  = '/v1/images/generations';

const DEFAULT_LLM_TIMEOUT_MS = 90_000;
const LLM_TIMEOUT_MIN_MS     = 10_000;
const LLM_TIMEOUT_MAX_MS     = 600_000;

export function parseLlmTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_LLM_TIMEOUT_MS;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LLM_TIMEOUT_MS;
  return Math.max(LLM_TIMEOUT_MIN_MS, Math.min(LLM_TIMEOUT_MAX_MS, n));
}

// The gateway's image-generation leg can take well over 60s end-to-end
// (worst case measured ≈67s) — the old 60s abort intermittently killed slots.
const IMG_TIMEOUT_MS              = 120_000;
const POOL_SIZE_PER_GEN           = 5;   // candidates per LLM call
const DEFAULT_PREFILL_PER_SLOT    = 3;   // minimum unconsumed pool rows per slot
const BLOB_FETCH_TIMEOUT_MS = 20_000;
const BLOB_MAX_BYTES        = 50 * 1024;
const BLOB_THUMB_W          = 200;
const BLOB_THUMB_H          = 200;
// D1 max row/string/BLOB size = 2,000,000 bytes
// (developers.cloudflare.com/d1/platform/limits). The gateway can return
// the full data:URL inline (measured ≈11.1MB) —
// INSERTing that into menu_pool.image_url exceeds the row limit and throws,
// failing every prefill slot. No consumer reads such a value: views render
// image_blob via /menu/img/:pool_id, and backfill skips NULL image_url rows.
const IMG_URL_MAX_DB_BYTES  = 100_000;

/**
 * Sanitize an image reference before persisting it to
 * menu_pool.image_url. data: URLs and oversized strings → NULL (D1 row
 * limit); http(s) OSS URLs pass through unchanged (backward compatible
 * with older gateway response shapes).
 */
export function sanitizeImageUrlForDb(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:')) return null;
  if (url.length > IMG_URL_MAX_DB_BYTES) return null;
  return url;
}

export async function fetchAndCompressImage(
  url: string,
): Promise<{ bytes: Uint8Array; format: 'webp' } | null> {
  try {
    // data:URL branch — decode inline, bypassing fetch() and
    // BLOB_FETCH_TIMEOUT_MS entirely (the gateway can return multi-MB base64
    // inline; a data: payload needs no network).
    let buf: Uint8Array;
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      if (comma < 0) {
        console.warn('[menu-gen blob] malformed data: URL (no comma)');
        return null;
      }
      const bin = atob(url.slice(comma + 1));
      buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    } else {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), BLOB_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) {
          console.warn('[menu-gen blob] fetch failed', res.status, url.slice(0, 80));
          return null;
        }
        buf = new Uint8Array(await res.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    }
    if (buf.byteLength === 0) return null;
    const photon = await import('@cf-wasm/photon');
    const img = photon.PhotonImage.new_from_byteslice(buf);
    try {
      const resized = photon.resize(img, BLOB_THUMB_W, BLOB_THUMB_H, 1);
      try {
        const out = resized.get_bytes_webp();
        if (out.byteLength > BLOB_MAX_BYTES) {
          console.warn('[menu-gen blob] webp over cap', out.byteLength);
        }
        return { bytes: out, format: 'webp' };
      } finally {
        resized.free();
      }
    } finally {
      img.free();
    }
  } catch (err) {
    const name = (err as Error)?.name;
    console.warn('[menu-gen blob] compress failed', name === 'AbortError' ? 'timeout' : (err as Error)?.message);
    return null;
  }
}

export const DAYS  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type MealKind = typeof MEALS[number];
export type DayName  = typeof DAYS[number];

export interface MealContent {
  name: string;
  description: string;
  ingredients: Array<{ name: string; qty: string }>;
  kcal: number;
  rationale: string;
}

export interface MenuJobRow {
  user_id: number;
  iso_week: string;
  day: DayName;
  meal: MealKind;
  /**
   * Only two states.
   *  - 'ready': content_json + image_url + menu_pool_id populated from pool
   *  - 'empty': pool empty for this slot; background refill in progress
   */
  status: 'ready' | 'empty';
  attempt: number;
  started_at: number | null;
  finished_at: number | null;
  /** Never surfaced to frontend; kept for audit only. */
  error: string | null;
  content_json: string | null;
  /**
   * WARNING: dashscope temp URL with ~7d expiry. Do NOT use as a
   * frontend `<img src>` directly — the URL will 404 after expiry. Use
   * `/menu/img/:pool_id` (D1 blob endpoint) or `getDisplayImageUrl()` from
   * `src/lib/image-url.ts` instead. Field is kept for audit / debug only.
   */
  image_url: string | null;
  menu_pool_id: number | null;
  retry_after: number | null;
}

export interface MenuPoolRow {
  id: number;
  user_id: number;
  iso_week: string;
  day: DayName;
  meal: MealKind;
  batch_no: number;
  seq: number;
  content: string;
  /**
   * WARNING: dashscope temp URL with ~7d expiry. Do NOT use as a
   * frontend `<img src>` directly. Use `/menu/img/:id` (served from
   * `image_blob`) or `getDisplayImageUrl()` from `src/lib/image-url.ts`.
   */
  image_url: string | null;
  consumed: number;
  created_at: number;
}

export type ErrorClass = 'transient' | 'timeout' | 'other';
export function classifyJobError(err: unknown): ErrorClass {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const name = (err as Error)?.name;
  if (name === 'AbortError' || /timeout/i.test(msg)) return 'timeout';
  if (/HTTP\s+401\b/i.test(msg)) return 'transient';
  if (/HTTP\s+503\b/i.test(msg)) return 'transient';
  if (/HTTP\s+429\b/i.test(msg)) return 'transient';
  if (/too many requests/i.test(msg)) return 'transient';
  if (/throttl/i.test(msg)) return 'transient';
  if (/\bAlgo\b/i.test(msg)) return 'transient';
  return 'other';
}

// ─── Seed: 28 rows (7 days × 4 meals) — default status='empty' ────────────
export async function seedMenuJobs(
  db: D1Database,
  userId: number,
  isoWeek: string,
): Promise<void> {
  const stmts: ReturnType<D1Database['prepare']>[] = [];
  for (const day of DAYS) {
    for (const meal of MEALS) {
      stmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO menu_jobs (user_id, iso_week, day, meal, status, attempt)
           VALUES (?, ?, ?, ?, 'empty', 0)`,
        ).bind(userId, isoWeek, day, meal),
      );
    }
  }
  await db.batch(stmts);
}

interface UserProfile {
  id: number;
  gender: string | null;
  height_cm: number | null;
  birthday: string | null;
  weight_kg: number | null;
}

function calcAgeSimple(birthdayISO: string | null | undefined): number | null {
  if (!birthdayISO) return null;
  const d = new Date(birthdayISO + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

// ─── Private LLM helpers (DoD §1 only callers: prefillPoolWeek / prefillOneSlot) ──

function buildImagePrompt(content: MealContent): string {
  const topIngredients = content.ingredients.slice(0, 3).map(i => i.name).join(', ');
  return `${content.name}, ingredients: ${topIngredients}, photographed top-down on a warm wooden table, soft natural daylight, Melbourne home kitchen, no text, no logos, photorealistic, shallow depth of field`;
}

interface SingleMealInput {
  age: number | null;
  gender: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  bmi: number | null;
  bmiCat: string;
  isoWeek: string;
  day: DayName;
  meal: MealKind;
  alreadyPlanned: string[];
}

async function __generateMealCandidates(
  gatewayUrl: string, serviceToken: string, model: string, input: SingleMealInput, count: number,
  timeoutMs: number,
): Promise<MealContent[]> {
  const mealLabels: Record<MealKind, string> = {
    breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snack: 'snack',
  };
  const system = [
    'You are a nutrition coach generating a small pool of alternative meals.',
    'Output strict JSON (no markdown, no prose) exactly matching:',
    '{"meals":[{"name":"...","description":"1 sentence","ingredients":[{"name":"...","qty":"..."}],"kcal":<int>,"rationale":"1 sentence why this fits the user"}]}',
    'Rules:',
    '- Return exactly the requested number of meals.',
    '- Each meal must be materially different from the others and from already_planned.',
    '- description: 1 sentence, plain text.',
    '- ingredients: 3-6 items, Melbourne supermarket-available.',
    '- kcal: integer estimate for one person.',
    '- rationale: 1 short sentence in English.',
    '- Mix Chinese and Western styles; respect Chinese palate.',
    '- For snack: keep kcal < 300, light and nutritious.',
  ].join('\n');

  const user = JSON.stringify({
    requested_count: count,
    iso_week: input.isoWeek,
    day: input.day,
    meal: input.meal,
    meal_label: mealLabels[input.meal],
    profile: {
      age: input.age, gender: input.gender, height_cm: input.height_cm,
      weight_kg: input.weight_kg, bmi: input.bmi, bmi_status: input.bmiCat,
    },
    already_planned: input.alreadyPlanned.slice(0, 30),
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const chatUrl = `${gatewayUrl}${CHAT_PATH}`;
  const tokPrefix = (serviceToken ?? '').slice(0, 8);
  const fetch = makeLlmFetch();
  const bindingMode = __apiLlmFetcher != null;
  console.log(JSON.stringify({
    spec: 'llm-gateway', op: 'chat.fetch', url: chatUrl,
    token_prefix: tokPrefix, model, timeoutMs,
    binding: bindingMode ? 'API_LLM' : 'public',
  }));
  try {
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceToken}`,
        // Usecase tag for the menu-generation chat scene: lets the gateway
        // auto-discover routing and allows dashboard hot-switching; when no
        // override is set, body.model is still used. Through the Service
        // Binding (API_LLM) the init object is passed to bound.fetch so the
        // header is not swallowed.
        'x-llm-usecase': 'menu-chat',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.85,
        max_tokens: 2400,
        response_format: { type: 'json_object' },
        enable_thinking: true,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 200);
      console.log(JSON.stringify({
        spec: 'llm-gateway', op: 'chat.fetch.error',
        requested: chatUrl, final: res.url, status: res.status,
        token_prefix: tokPrefix, body: errText,
      }));
      throw new Error(`LLM HTTP ${res.status}: ${errText}`);
    }
    const data = await res.json() as { error?: { message: string }; choices: Array<{ message: { content: string } }> };
    if (data.error) throw new Error(`LLM error: ${data.error.message}`);
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error('LLM empty content');
    const parsed = JSON.parse(raw) as { meals?: MealContent[] };
    if (!Array.isArray(parsed.meals)) throw new Error('LLM: missing meals array');
    const meals = parsed.meals.slice(0, count);
    if (meals.length !== count) throw new Error(`LLM: expected ${count} meals, got ${meals.length}`);
    for (const m of meals) validateMealContent(m);
    return meals;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new Error(`LLM timeout (${Math.round(timeoutMs/1000)}s)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function validateMealContent(parsed: MealContent): void {
  if (!parsed.name || typeof parsed.name !== 'string') throw new Error('LLM: missing name');
  if (!Array.isArray(parsed.ingredients)) throw new Error('LLM: missing ingredients');
  if (typeof parsed.kcal !== 'number') throw new Error('LLM: kcal not number');
}

async function __generateImageUrl(
  gatewayUrl: string, serviceToken: string, model: string, prompt: string,
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), IMG_TIMEOUT_MS);
  const imgEndpoint = `${gatewayUrl}${IMG_PATH}`;
  const tokPrefix = (serviceToken ?? '').slice(0, 8);
  const fetch = makeLlmFetch();
  const bindingMode = __apiLlmFetcher != null;
  console.log(JSON.stringify({
    spec: 'llm-gateway', op: 'image.fetch', url: imgEndpoint,
    token_prefix: tokPrefix, model,
    binding: bindingMode ? 'API_LLM' : 'public',
  }));
  try {
    const res = await fetch(imgEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceToken}`,
        // Usecase tag for the menu-image scene.
        'x-llm-usecase': 'menu-image',
      },
      body: JSON.stringify({
        model,
        input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
        parameters: { watermark: false },
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 200);
      console.log(JSON.stringify({
        spec: 'llm-gateway', op: 'image.fetch.error',
        requested: imgEndpoint, final: res.url, status: res.status,
        token_prefix: tokPrefix, body: errText,
      }));
      throw new Error(`ImgGen HTTP ${res.status}: ${errText}`);
    }
    const data = await res.json() as { output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> } };
    const imgUrl = data.output?.choices?.[0]?.message?.content?.[0]?.image ?? '';
    if (!imgUrl) throw new Error('ImgGen: empty image URL');
    return imgUrl;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new Error(`ImgGen timeout (${IMG_TIMEOUT_MS / 1000}s)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Idempotent weekly prefill ────────────────────────────────────────────

export interface PrefillEnv {
  LLM_GATEWAY_URL: string;
  LLM_SERVICE_TOKEN: string;
  LLM_MODEL: string;
  IMAGE_MODEL: string;
  LLM_TIMEOUT_MS?: string;
  API_LLM?: LlmFetcher;
}

export interface PrefillSlotResult {
  day: DayName;
  meal: MealKind;
  added: number;
  ok: boolean;
  error?: string;
}

export interface PrefillPoolWeekResult {
  // 'partial' is overloaded to mean EITHER
  //   (a) some slot LLM calls failed, OR
  //   (b) maxSlots cap hit — still-deficit slots remain (remainingDeficits > 0)
  // Callers (nightlyPrefillGuard, drainPrefillQueue) inspect
  // remainingDeficits to decide whether to enqueue a continuation slice.
  status: 'already_prefilled' | 'prefilled' | 'partial' | 'empty_user';
  isoWeek: string;
  slotsChecked: number;
  slotsFilled: number;
  slotsFailed: number;
  generatedRows: number;
  jobsFlippedReady: number;
  // Slots that were deficit on entry but not attempted this
  // call because of the maxSlots cap. Zero when status='already_prefilled'
  // or 'prefilled' (all deficits resolved). Non-zero ⇒ enqueue continuation.
  remainingDeficits: number;
  results?: PrefillSlotResult[];
}

async function loadUserProfile(db: D1Database, userId: number): Promise<UserProfile | null> {
  return db.prepare(
    `SELECT u.id, u.gender, u.height_cm, u.birthday,
            (SELECT weight_kg FROM daily_weight WHERE user_id=u.id ORDER BY date DESC LIMIT 1) AS weight_kg
     FROM users u WHERE u.id = ?`,
  ).bind(userId).first<UserProfile>();
}

/**
 * Idempotent per-week prefill.
 *
 * For each of the 28 slots (7 days × 4 meals):
 *   - If pool has ≥ candidatesPerSlot unconsumed rows, skip.
 *   - Otherwise, call __generateMealCandidates(POOL_SIZE_PER_GEN) and insert
 *     the candidates. seq=0 carries the image blob (hard invariant).
 *
 * Chunked sequential (chunk=5) to stay under CF CPU caps. Per-slot errors
 * are logged-and-swallowed: other slots still run. After the prefill pass,
 * any menu_jobs still 'empty' whose slot now has an unconsumed pool row
 * are flipped to 'ready'.
 *
 * Returns 'already_prefilled' when no slot needed work; 'prefilled' when
 * 28/28 slots ended at ≥ threshold; 'partial' when some failed.
 */
// Default slot cap per prefillPoolWeek call. The CF Worker
// scheduled handler gives 30 s wall + 30 min waitUntil, but a single 28-slot
// prefill can take 10+ min for one user. Slicing at 8 slots/call keeps each
// call well under CPU caps and lets the */10 cron drain progressively cover
// (e.g. 3 active users × 2 weeks × 28 slots) within ~2 hours of the nightly
// kick, without ever bunching LLM concurrency.
export const DEFAULT_MAX_SLOTS_PER_CALL = 8;

export async function prefillPoolWeek(
  db: D1Database,
  env: PrefillEnv,
  userId: number,
  isoWeek: string,
  ctx: ExecutionContext | undefined,
  candidatesPerSlot: number = DEFAULT_PREFILL_PER_SLOT,
  maxSlots: number = DEFAULT_MAX_SLOTS_PER_CALL,
): Promise<PrefillPoolWeekResult> {
  void ctx;
  setApiLlmFetcher(env.API_LLM ?? null);
  const llmTimeoutMs = parseLlmTimeout(env.LLM_TIMEOUT_MS);
  const tag = `[prefillPoolWeek u=${userId} ${isoWeek}]`;

  // (1) Per-slot unconsumed count.
  const poolRows = await db.prepare(
    `SELECT day, meal, COUNT(*) AS unconsumed FROM menu_pool
      WHERE user_id=? AND iso_week=? AND consumed=0
      GROUP BY day, meal`,
  ).bind(userId, isoWeek).all<{ day: DayName; meal: MealKind; unconsumed: number }>();
  const poolMap = new Map<string, number>();
  for (const r of poolRows.results) poolMap.set(`${r.day}|${r.meal}`, r.unconsumed);

  const allSlots = DAYS.flatMap(d => MEALS.map(m => ({ day: d as DayName, meal: m as MealKind })));
  const deficits = allSlots.filter(s => (poolMap.get(`${s.day}|${s.meal}`) ?? 0) < candidatesPerSlot);

  if (deficits.length === 0) {
    const flipped = await flipEmptyJobsToReady(db, userId, isoWeek);
    console.log(`${tag} already_prefilled (28/28); flipped=${flipped}`);
    return {
      status: 'already_prefilled', isoWeek,
      slotsChecked: 28, slotsFilled: 0, slotsFailed: 0,
      generatedRows: 0, jobsFlippedReady: flipped,
      remainingDeficits: 0,
    };
  }

  // Cap slots attempted this call. Slots beyond the cap are
  // reported back via remainingDeficits so the caller can enqueue continuation.
  const totalDeficit = deficits.length;
  const sliceDeficits = maxSlots > 0 && totalDeficit > maxSlots
    ? deficits.slice(0, maxSlots)
    : deficits;
  const carriedOver = totalDeficit - sliceDeficits.length;

  // (2) Profile + planned-set.
  const profile = await loadUserProfile(db, userId);
  if (!profile) {
    console.warn(`${tag} user not found`);
    return {
      status: 'empty_user', isoWeek,
      slotsChecked: 28, slotsFilled: 0, slotsFailed: 28,
      generatedRows: 0, jobsFlippedReady: 0,
      remainingDeficits: 0,
    };
  }
  const age = calcAgeSimple(profile.birthday);
  const bmi = profile.weight_kg && profile.height_cm
    ? Math.round((profile.weight_kg / Math.pow(profile.height_cm / 100, 2)) * 10) / 10
    : null;
  const bmiCat = bmi == null ? 'unknown' : bmi < 18.5 ? 'underweight' : bmi < 25 ? 'normal' : bmi < 30 ? 'overweight' : 'obese';

  const planned = await db.prepare(
    `SELECT content FROM menu_pool WHERE user_id=? AND iso_week=? AND content IS NOT NULL`,
  ).bind(userId, isoWeek).all<{ content: string }>();
  const alreadyPlanned = planned.results.map(r => {
    try { return (JSON.parse(r.content) as MealContent).name; } catch { return ''; }
  }).filter(Boolean);

  // (3) Chunked sequential prefill — only sliceDeficits.
  const CHUNK = 5;
  const results: PrefillSlotResult[] = [];
  let generatedRows = 0;
  for (let i = 0; i < sliceDeficits.length; i += CHUNK) {
    const chunk = sliceDeficits.slice(i, i + CHUNK);
    for (const slot of chunk) {
      const haveBefore = poolMap.get(`${slot.day}|${slot.meal}`) ?? 0;
      const need = Math.max(0, candidatesPerSlot - haveBefore);
      try {
        const inserted = await prefillOneSlot(
          db, env, userId, isoWeek, slot.day, slot.meal,
          { age, gender: profile.gender, height_cm: profile.height_cm,
            weight_kg: profile.weight_kg, bmi, bmiCat, alreadyPlanned },
          need, llmTimeoutMs,
        );
        generatedRows += inserted;
        results.push({ day: slot.day, meal: slot.meal, added: inserted, ok: true });
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        console.warn(`${tag} slot ${slot.day}/${slot.meal} failed:`, msg);
        results.push({ day: slot.day, meal: slot.meal, added: 0, ok: false, error: msg });
      }
    }
  }

  // (4) Flip 'empty' jobs to 'ready' where pool is now non-empty.
  const flipped = await flipEmptyJobsToReady(db, userId, isoWeek);

  const slotsFailed = results.filter(r => !r.ok).length;
  const slotsFilled = results.filter(r => r.ok).length;
  // Any uncovered slots OR any per-slot failure ⇒ 'partial'.
  // Caller enqueues a continuation slice when remainingDeficits > 0.
  const status: PrefillPoolWeekResult['status'] =
    (slotsFailed === 0 && carriedOver === 0) ? 'prefilled' : 'partial';
  const remainingDeficits = carriedOver + slotsFailed;
  console.log(`${tag} ${status} filled=${slotsFilled} failed=${slotsFailed} carried=${carriedOver} rows=${generatedRows} flipped=${flipped}`);
  return {
    status, isoWeek, slotsChecked: 28, slotsFilled, slotsFailed,
    generatedRows, jobsFlippedReady: flipped,
    remainingDeficits, results,
  };
}

async function prefillOneSlot(
  db: D1Database,
  env: PrefillEnv,
  userId: number,
  isoWeek: string,
  day: DayName,
  meal: MealKind,
  pctx: { age: number | null; gender: string | null; height_cm: number | null; weight_kg: number | null; bmi: number | null; bmiCat: string; alreadyPlanned: string[] },
  need: number,
  llmTimeoutMs: number,
): Promise<number> {
  if (need <= 0) return 0;
  const askCount = Math.min(POOL_SIZE_PER_GEN, Math.max(need, DEFAULT_PREFILL_PER_SLOT));

  const candidates = await __generateMealCandidates(
    env.LLM_GATEWAY_URL, env.LLM_SERVICE_TOKEN, env.LLM_MODEL,
    { age: pctx.age, gender: pctx.gender, height_cm: pctx.height_cm,
      weight_kg: pctx.weight_kg, bmi: pctx.bmi, bmiCat: pctx.bmiCat,
      isoWeek, day, meal, alreadyPlanned: pctx.alreadyPlanned },
    askCount, llmTimeoutMs,
  );

  // seq=0 image — hard invariant: persist blob before INSERT.
  const seq0Prompt = buildImagePrompt(candidates[0]);
  const seq0Url = await __generateImageUrl(env.LLM_GATEWAY_URL, env.LLM_SERVICE_TOKEN, env.IMAGE_MODEL, seq0Prompt);
  const seq0Blob = await fetchAndCompressImage(seq0Url);
  if (!seq0Blob) throw new Error('[menu-pool invariant] image fetch/compress failed');

  // Next batch_no for this slot.
  const batchRow = await db.prepare(
    `SELECT COALESCE(MAX(batch_no), 0) AS max_batch FROM menu_pool
     WHERE user_id=? AND iso_week=? AND day=? AND meal=?`,
  ).bind(userId, isoWeek, day, meal).first<{ max_batch: number }>();
  const batchNo = (batchRow?.max_batch ?? 0) + 1;

  let inserted = 0;
  for (let seq = 0; seq < candidates.length; seq++) {
    const isSeq0 = seq === 0;
    const content = candidates[seq];
    await db.prepare(
      `INSERT INTO menu_pool (user_id, iso_week, day, meal, batch_no, seq, content, image_url, image_blob, image_format, image_thumb_w, image_thumb_h, consumed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).bind(
      userId, isoWeek, day, meal, batchNo, seq,
      JSON.stringify(content),
      // Never persist a multi-MB data:URL (D1 row limit = 2MB).
      isSeq0 ? sanitizeImageUrlForDb(seq0Url) : null,
      isSeq0 ? seq0Blob.bytes : null,
      isSeq0 ? seq0Blob.format : null,
      isSeq0 ? BLOB_THUMB_W : null,
      isSeq0 ? BLOB_THUMB_H : null,
      Date.now(),
    ).run();
    inserted++;
  }
  return inserted;
}

async function flipEmptyJobsToReady(
  db: D1Database, userId: number, isoWeek: string,
): Promise<number> {
  const empties = await db.prepare(
    `SELECT day, meal FROM menu_jobs
      WHERE user_id=? AND iso_week=? AND status='empty'`,
  ).bind(userId, isoWeek).all<{ day: DayName; meal: MealKind }>();
  let flipped = 0;
  for (const { day, meal } of empties.results) {
    // Same blob guard as shuffleMealJob — never flip an 'empty'
    // slot onto a blob-less seq≥1 row (only seq=0 rows persist the blob),
    // or the user would see the grey placeholder the instant the slot turns
    // 'ready'. If no blob-bearing candidate exists we leave the slot 'empty'
    // (skip) so the next prefill regenerates a fresh seq=0-with-blob batch.
    const pick = await db.prepare(
      `SELECT id, content, image_url FROM menu_pool
        WHERE user_id=? AND iso_week=? AND day=? AND meal=? AND consumed=0
          AND image_blob IS NOT NULL
        ORDER BY batch_no ASC, seq ASC LIMIT 1`,
    ).bind(userId, isoWeek, day, meal).first<{ id: number; content: string; image_url: string | null }>();
    if (!pick) continue;
    await db.batch([
      db.prepare(`UPDATE menu_pool SET consumed=1 WHERE id=?`).bind(pick.id),
      db.prepare(
        `UPDATE menu_jobs SET status='ready', content_json=?, image_url=?, menu_pool_id=?,
           error=NULL, retry_after=NULL, finished_at=?
         WHERE user_id=? AND iso_week=? AND day=? AND meal=?`,
      ).bind(pick.content, pick.image_url, pick.id, Date.now(), userId, isoWeek, day, meal),
    ]);
    flipped++;
  }
  return flipped;
}

/**
 * Single nightly LLM window.
 *
 * Fires once per day from scheduledHandler when local time matches 03:00 in
 * DEFAULT_TZ (cron is "0 17 * * *" = UTC 17:00 = Melbourne local 03:00).
 * For every active seeded user × {currentIso, nextIso}, calls
 * prefillPoolWeek with maxSlots cap. Each call either:
 *   • fully drains the deficit → status='prefilled'/'already_prefilled'
 *   • hits the maxSlots cap or per-slot LLM failure → status='partial' with
 *     remainingDeficits > 0 → we enqueue a continuation into prefill_queue.
 *
 * The every-10-min cron then drains prefill_queue slice-by-slice until empty.
 * This is the entire "event-driven + nightly safety net" model:
 * no every-minute scanning; LLM calls strictly bounded by user count.
 *
 * Returns shape mirrors the prior weeklyPrefillCron for log compatibility,
 * plus an `enqueued` count for observability.
 */
export async function nightlyPrefillGuard(
  db: D1Database,
  env: PrefillEnv,
  ctx: ExecutionContext,
  nowMs: number,
  defaultTz: string,
): Promise<{ users: number; weeks: string[]; enqueued: number; results: Array<{ user_id: number; iso_week: string; status: PrefillPoolWeekResult['status']; remainingDeficits: number }> }> {
  const currentIso = isoWeekForTzDate(nowMs, defaultTz);
  const nextIso = nextIsoWeekFromDate(new Date(nowMs));
  const weeks = [currentIso, nextIso];

  // Active seeded users: same definition as weeklyPrefillCron (≥1 weight
  // entry in last 30d). Keeps fleet-wide LLM budget bounded by real usage.
  const cutoff = new Date(nowMs - 30 * 86400_000).toISOString().slice(0, 10);
  const users = await db.prepare(
    `SELECT DISTINCT u.id FROM users u
     INNER JOIN daily_weight d ON d.user_id = u.id
     WHERE u.menu_seed_state = 'seeded' AND d.date >= ?`,
  ).bind(cutoff).all<{ id: number }>();
  console.log(`[nightlyPrefillGuard] users=${users.results.length} weeks=${weeks.join(',')}`);

  const results: Array<{ user_id: number; iso_week: string; status: PrefillPoolWeekResult['status']; remainingDeficits: number }> = [];
  let enqueued = 0;
  for (const { id } of users.results) {
    // Make sure menu_jobs rows exist before prefilling — was the
    // weeklyPrefillCron contract; nightlyPrefillGuard inherits it.
    await seedMenuJobsMultiWeek(db, id, weeks);
    for (const w of weeks) {
      try {
        const r = await prefillPoolWeek(db, env, id, w, ctx);
        results.push({ user_id: id, iso_week: w, status: r.status, remainingDeficits: r.remainingDeficits });
        if (r.remainingDeficits > 0) {
          // 5 min later — next */10 tick will pick it up.
          await enqueuePrefillSlice(db, id, w, nowMs + 5 * 60_000);
          enqueued++;
        }
      } catch (err) {
        console.warn(`[nightlyPrefillGuard] user=${id} week=${w} threw`, (err as Error)?.message);
        // Best effort: enqueue so the */10 drain retries.
        await enqueuePrefillSlice(db, id, w, nowMs + 5 * 60_000);
        enqueued++;
      }
    }
  }
  return { users: users.results.length, weeks, enqueued, results };
}

/**
 * prefill_queue write helper.
 *
 * UNIQUE(user_id, iso_week) means a second enqueue while the first is still
 * pending degrades to UPDATE-min(next_run_at) so the earlier deadline wins
 * (caller already wants the slot refilled sooner). attempts bump on conflict
 * so we can backoff abusive entries if needed.
 *
 * Called from:
 *   • nightlyPrefillGuard (partial branch)
 *   • shuffleMealJob (pool_empty branch)
 *   - drainPrefillQueue (partial branch - re-arm continuation)
 */
export async function enqueuePrefillSlice(
  db: D1Database,
  userId: number,
  isoWeek: string,
  nextRunAtMs: number,
): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO prefill_queue (user_id, iso_week, enqueued_at, next_run_at, attempts)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(user_id, iso_week) DO UPDATE SET
        next_run_at = MIN(prefill_queue.next_run_at, excluded.next_run_at),
        attempts    = prefill_queue.attempts + 1`,
  ).bind(userId, isoWeek, now, nextRunAtMs).run();
}

/**
 * Every-10-min queue drain.
 *
 * Picks up to MAX_ENTRIES_PER_TICK rows whose next_run_at ≤ now, runs
 * prefillPoolWeek slice for each. Status handling:
 *   • 'prefilled' | 'already_prefilled' | 'empty_user' → DELETE row
 *   • 'partial' with remainingDeficits > 0 → UPDATE next_run_at += 5min,
 *     attempts++. Stays in queue for next tick.
 *
 * No-op when queue is empty (single LIMIT 1 cheap check first). This is the
 * ONLY path that runs LLM outside of the nightly 03:00 window.
 */
const MAX_ENTRIES_PER_TICK = 5;
const PARTIAL_BACKOFF_MS = 5 * 60_000;
// Wall-clock budget per drain tick. One entry's
// prefillPoolWeek runs up to 8 slots × (content LLM + image gen measured
// ~46–67s) ≈ 11–15min; two due entries can exceed the scheduled handler's
// ctx.waitUntil 30min cap. A tick killed mid-flight never runs its trailing
// re-arm/DELETE (attempts freeze, later ticks repeat the same paid LLM/img
// work). Entries skipped by the guard stay due and are picked up next tick.
const DRAIN_TICK_BUDGET_MS = 12 * 60_000;

export async function drainPrefillQueue(
  db: D1Database,
  env: PrefillEnv,
  ctx: ExecutionContext,
  nowMs: number,
): Promise<{ processed: number; deletedEntries: number; reArmedEntries: number }> {
  // Cheap empty-check (avoids COUNT(*) on every tick).
  const peek = await db.prepare(
    `SELECT id FROM prefill_queue WHERE next_run_at <= ? LIMIT 1`,
  ).bind(nowMs).first<{ id: number }>();
  if (!peek) return { processed: 0, deletedEntries: 0, reArmedEntries: 0 };

  const due = await db.prepare(
    `SELECT id, user_id, iso_week, attempts FROM prefill_queue
      WHERE next_run_at <= ?
   ORDER BY next_run_at ASC
      LIMIT ?`,
  ).bind(nowMs, MAX_ENTRIES_PER_TICK).all<{ id: number; user_id: number; iso_week: string; attempts: number }>();

  let deletedEntries = 0;
  let reArmedEntries = 0;
  // Tick budget guard (see DRAIN_TICK_BUDGET_MS).
  const tickStartMs = Date.now();
  let processed = 0;
  for (const row of due.results) {
    if (Date.now() - tickStartMs > DRAIN_TICK_BUDGET_MS) {
      console.log(`[drainPrefillQueue] tick budget ${DRAIN_TICK_BUDGET_MS}ms exhausted after ${processed} entries; deferring ${due.results.length - processed} due entries to next tick`);
      break;
    }
    processed++;
    try {
      const r = await prefillPoolWeek(db, env, row.user_id, row.iso_week, ctx);
      if (r.remainingDeficits === 0) {
        await db.prepare(`DELETE FROM prefill_queue WHERE id=?`).bind(row.id).run();
        deletedEntries++;
        console.log(`[drainPrefillQueue] done u=${row.user_id} ${row.iso_week} status=${r.status}`);
      } else {
        await db.prepare(
          `UPDATE prefill_queue
              SET next_run_at = ?, attempts = attempts + 1, last_error = NULL
            WHERE id = ?`,
        ).bind(nowMs + PARTIAL_BACKOFF_MS, row.id).run();
        reArmedEntries++;
        console.log(`[drainPrefillQueue] partial u=${row.user_id} ${row.iso_week} remaining=${r.remainingDeficits}`);
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      console.warn(`[drainPrefillQueue] threw u=${row.user_id} ${row.iso_week}`, msg);
      await db.prepare(
        `UPDATE prefill_queue
            SET next_run_at = ?, attempts = attempts + 1, last_error = ?
          WHERE id = ?`,
      ).bind(nowMs + PARTIAL_BACKOFF_MS, msg.slice(0, 500), row.id).run();
      reArmedEntries++;
    }
  }
  return { processed, deletedEntries, reArmedEntries };
}

// ─── Weekly renew (seed-only) ─────────────────────────────────────────────

export async function scheduledWeeklyRenew(
  db: D1Database,
  nextIsoWeek: string,
): Promise<void> {
  const cutoffDate = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const users = await db.prepare(
    `SELECT DISTINCT user_id FROM daily_weight WHERE date >= ?`,
  ).bind(cutoffDate).all<{ user_id: number }>();
  for (const { user_id } of users.results) {
    await seedMenuJobs(db, user_id, nextIsoWeek);
  }
}

export async function seedMenuJobsMultiWeek(
  db: D1Database,
  userId: number,
  isoWeeks: string[],
): Promise<void> {
  for (const w of isoWeeks) {
    await seedMenuJobs(db, userId, w);
  }
}

export function nextIsoWeekFromDate(d: Date): string {
  const t = new Date(d.getTime() + 7 * 86400_000);
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ─── shuffleMealJob — pool-only, no LLM fallback ────────────────────────

/**
 * Returns:
 *   { ok:true,  status:'ready',  poolId }            — swapped to next row
 *   { ok:false, reason:'pool_empty', refilling:true, status:'empty' }
 *                                                    — pool exhausted; bg refill kicked
 *   { ok:false, reason:'job not found' }
 */
export async function shuffleMealJob(
  db: D1Database,
  userId: number,
  isoWeek: string,
  day: string,
  meal: string,
  ctx?: ExecutionContext,
  env?: PrefillEnv,
): Promise<{ ok: boolean; reason?: string; status?: 'ready' | 'empty'; poolId?: number; refilling?: boolean }> {
  const row = await db.prepare(
    `SELECT status, menu_pool_id FROM menu_jobs WHERE user_id=? AND iso_week=? AND day=? AND meal=?`,
  ).bind(userId, isoWeek, day, meal).first<{ status: string; menu_pool_id: number | null }>();
  if (!row) return { ok: false, reason: 'job not found' };

  // Root fix: only swap to a candidate that actually carries a
  // blob. Only seq=0 rows persist `image_blob` (seq 1..4 are
  // intentionally NULL for cost). The old query ordered by seq ASC over all
  // unconsumed rows, so once seq=0 was consumed a shuffle advanced to seq≥1
  // (no blob) → /menu/img returned the grey placeholder. Filtering on
  // `image_blob IS NOT NULL` keeps shuffle on rows that have a real image; if
  // none remain the `!next` branch below treats the slot as pool_empty and
  // triggers a refill (which regenerates a fresh seq=0-with-blob batch).
  const next = await db.prepare(
    `SELECT id, content, image_url FROM menu_pool
     WHERE user_id=? AND iso_week=? AND day=? AND meal=? AND consumed=0 AND image_blob IS NOT NULL
     ORDER BY batch_no ASC, seq ASC LIMIT 1`,
  ).bind(userId, isoWeek, day, meal).first<{ id: number; content: string; image_url: string | null }>();

  if (!next) {
    // Pool empty → mark slot 'empty', enqueue an explicit
    // prefill_queue continuation. The */10 cron picks it up within minutes,
    // independent of the nightly 03:00 guard. No fetch-handler waitUntil, no
    // live LLM call here — same no-live-LLM invariant, just a different refill
    // trigger (event vs. per-minute scan).
    await db.prepare(
      `UPDATE menu_jobs SET status='empty', attempt=0, started_at=NULL, finished_at=NULL,
         error=NULL, retry_after=NULL, content_json=NULL, image_url=NULL, menu_pool_id=NULL
       WHERE user_id=? AND iso_week=? AND day=? AND meal=?`,
    ).bind(userId, isoWeek, day, meal).run();
    if (env) {
      // ASAP — next */10 cron tick (≤5 min wall time on average).
      try {
        await enqueuePrefillSlice(db, userId, isoWeek, Date.now());
      } catch (err) {
        // Don't break the user's shuffle response on queue write failure;
        // nightly guard at 03:00 will still pick up the empty slot.
        console.warn(`[shuffleMealJob] enqueuePrefillSlice failed u=${userId} ${isoWeek}`, (err as Error)?.message);
      }
    }
    return { ok: false, reason: 'pool_empty', refilling: true, status: 'empty' };
  }

  const stmts = [] as ReturnType<D1Database['prepare']>[];
  if (row.menu_pool_id != null) {
    stmts.push(db.prepare(`UPDATE menu_pool SET consumed=1 WHERE id=?`).bind(row.menu_pool_id));
  }
  stmts.push(db.prepare(`UPDATE menu_pool SET consumed=1 WHERE id=?`).bind(next.id));
  stmts.push(db.prepare(
    `UPDATE menu_jobs SET status='ready', content_json=?, image_url=?, menu_pool_id=?, error=NULL, retry_after=NULL, finished_at=?
     WHERE user_id=? AND iso_week=? AND day=? AND meal=?`,
  ).bind(next.content, next.image_url, next.id, Date.now(), userId, isoWeek, day, meal));
  await db.batch(stmts);

  // No fetch-handler waitUntil here either. Pool top-up for
  // a successful swap is handled by the nightly 03:00 guard + the per-shuffle
  // enqueue path above (when the pool eventually exhausts).
  void env;

  return { ok: true, status: 'ready', poolId: next.id };
}

/**
 * Opportunistic top-up. If any of `slots` (defaults to all 28)
 * has fewer than `targetPerSlot` unconsumed pool rows, kick prefillPoolWeek
 * (idempotent). With env/ctx omitted (legacy / test callers), returns the
 * deficit list without triggering any LLM work.
 */
export async function refillSlotsIfDeficit(
  db: D1Database,
  userId: number,
  isoWeek: string,
  targetPerSlot: number = DEFAULT_PREFILL_PER_SLOT,
  env?: PrefillEnv,
  ctx?: ExecutionContext,
  slots?: Array<{ day: string; meal: string }>,
): Promise<{ refilled: Array<{ day: string; meal: string }>; skipped: number }> {
  const poolRows = await db.prepare(
    `SELECT day, meal, COUNT(*) AS unconsumed FROM menu_pool
      WHERE user_id=? AND iso_week=? AND consumed=0
      GROUP BY day, meal`,
  ).bind(userId, isoWeek).all<{ day: string; meal: string; unconsumed: number }>();
  const poolMap = new Map<string, number>();
  for (const r of poolRows.results) poolMap.set(`${r.day}|${r.meal}`, r.unconsumed);

  const targets = slots && slots.length > 0
    ? slots
    : DAYS.flatMap(d => MEALS.map(m => ({ day: d as string, meal: m as string })));
  const deficits = targets.filter(s => (poolMap.get(`${s.day}|${s.meal}`) ?? 0) < targetPerSlot);

  if (deficits.length === 0) return { refilled: [], skipped: targets.length };
  if (env && ctx) {
    ctx.waitUntil(
      prefillPoolWeek(db, env, userId, isoWeek, ctx, targetPerSlot).then(() => undefined)
        .catch(err => console.warn('[refillSlotsIfDeficit]', (err as Error)?.message)),
    );
  }
  return { refilled: deficits.map(d => ({ day: d.day, meal: d.meal })), skipped: targets.length - deficits.length };
}

// First-time seed processor (runs from the nightly cron tick).
export async function processAwaitingFirstSeeds(
  db: D1Database,
  defaultTz: string,
  nowMs: number,
  env?: PrefillEnv,
  ctx?: ExecutionContext,
): Promise<{ seeded: number[]; prefillTargets: Array<{ userId: number; isoWeek: string }> }> {
  const users = await db.prepare(
    `SELECT id, awaiting_since_ms FROM users WHERE menu_seed_state = 'awaiting_first'`,
  ).all<{ id: number; awaiting_since_ms: number | null }>();

  const seeded: number[] = [];
  const prefillTargets: Array<{ userId: number; isoWeek: string }> = [];
  for (const u of users.results) {
    if (!u.awaiting_since_ms) continue;
    const triggerMs = nextLocal3amMs(u.awaiting_since_ms, defaultTz);
    if (nowMs < triggerMs) continue;

    const currentIso = isoWeekForTzDate(nowMs, defaultTz);
    const nextIso    = nextIsoWeekFromDate(new Date(nowMs));
    await seedMenuJobsMultiWeek(db, u.id, [currentIso, nextIso]);
    await db.prepare(
      `UPDATE users SET menu_seed_state='seeded', awaiting_since_ms=NULL, updated_at=? WHERE id=?`,
    ).bind(nowMs, u.id).run();
    seeded.push(u.id);
    prefillTargets.push({ userId: u.id, isoWeek: currentIso }, { userId: u.id, isoWeek: nextIso });

    // Kick async prefill for both weeks (idempotent).
    if (env && ctx) {
      for (const w of [currentIso, nextIso]) {
        ctx.waitUntil(
          prefillPoolWeek(db, env, u.id, w, ctx).then(() => undefined)
            .catch(err => console.warn(`[awaiting-first prefill] user=${u.id} week=${w}`, (err as Error)?.message)),
        );
      }
    }
  }
  return { seeded, prefillTargets };
}

export async function scheduledWeeklyRenewTzAware(
  db: D1Database,
  defaultTz: string,
  nowMs: number,
): Promise<{ seeded: number; nextIsoWeek: string | null; prefillTargets: Array<{ userId: number; isoWeek: string }> }> {
  const local = getLocalParts(nowMs, defaultTz);
  if (local.weekdayMon1Sun7 !== 7 || local.hour !== 3) {
    return { seeded: 0, nextIsoWeek: null, prefillTargets: [] };
  }
  const nextIso = nextIsoWeekFromDate(new Date(nowMs));
  const cutoffDate = new Date(nowMs - 30 * 86400_000).toISOString().slice(0, 10);
  const users = await db.prepare(
    `SELECT DISTINCT u.id FROM users u
     INNER JOIN daily_weight d ON d.user_id = u.id
     WHERE u.menu_seed_state = 'seeded' AND d.date >= ?`,
  ).bind(cutoffDate).all<{ id: number }>();
  const prefillTargets: Array<{ userId: number; isoWeek: string }> = [];
  for (const { id } of users.results) {
    await seedMenuJobs(db, id, nextIso);
    await db.prepare(
      `DELETE FROM menu_pool WHERE user_id=? AND iso_week < ?`,
    ).bind(id, nextIso).run();
    prefillTargets.push({ userId: id, isoWeek: nextIso });
  }
  return { seeded: users.results.length, nextIsoWeek: nextIso, prefillTargets };
}

// ─── Tz helpers ───────────────────────────────────────────────────────────

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekdayMon1Sun7: number; }

export function getLocalParts(nowMs: number, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const wdMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: parseInt(get('hour'), 10) % 24,
    minute: parseInt(get('minute'), 10),
    weekdayMon1Sun7: wdMap[get('weekday')] ?? 0,
  };
}

function nextLocal3amMs(sinceMs: number, tz: string): number {
  for (let off = 1; off <= 36 * 60; off += 5) {
    const t = sinceMs + off * 60_000;
    const lp = getLocalParts(t, tz);
    if (lp.hour === 3 && lp.minute < 5) return t;
  }
  return sinceMs + 24 * 3600_000;
}

export function isoWeekForTzDate(nowMs: number, tz: string): string {
  const lp = getLocalParts(nowMs, tz);
  const utcEquivalent = new Date(Date.UTC(lp.year, lp.month - 1, lp.day));
  const day = utcEquivalent.getUTCDay() || 7;
  utcEquivalent.setUTCDate(utcEquivalent.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utcEquivalent.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((utcEquivalent.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utcEquivalent.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}


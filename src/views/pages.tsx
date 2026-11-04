import type { FC } from 'hono/jsx';
import { Layout, NoticeBox } from './layout.tsx';
import { EXERCISE_OPTIONS } from '../lib/exercise.ts';
import type { MenuJobRow, MealKind, DayName, MealContent } from '../lib/menu-gen.ts';
import { getDisplayImageUrl } from '../lib/image-url.ts';
import { WeightHeatmap, ExerciseHeatmap } from './heatmap.tsx';

const MEAL_ORDER: MealKind[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const MEAL_LABELS: Record<MealKind, string> = { breakfast: 'Break', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
const DAYS_ORDER: DayName[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const EXERCISE_LABEL_BY_ID: Record<string, string> = Object.fromEntries(EXERCISE_OPTIONS.map(e => [e.id, e.label]));

function parseMeal(content_json: string | null): MealContent | null {
  if (!content_json) return null;
  try { return JSON.parse(content_json) as MealContent; } catch { return null; }
}

// ─── Dashboard — single-page (section 01 log + 02 trend + 03 menu) ───────────

interface DashboardProps {
  username: string;
  age: number | null;
  gender: string | null;
  height_cm: number | null;
  latestWeight: { date: string; weight_kg: number } | null;
  bmi: number | null;
  bmiCategory: 'under' | 'normal' | 'over' | 'obese' | 'unknown';
  ideal: { min: number; max: number } | null;
  weights30: Array<{ date: string; weight_kg: number }>;
  latestVitals: { iso_week: string; heart_rate: number | null; bp_systolic: number | null; bp_diastolic: number | null } | null;
  // Log section
  todayDate: string;
  isoWeek: string;
  todayWeight: number | null;
  todayExercise: { kind: string; note: string | null } | null;
  weekVitals: { heart_rate: number | null; bp_systolic: number | null; bp_diastolic: number | null; height_cm: number | null } | null;
  weekVitalsLogged: boolean;
  notice?: string | null;
  error?: string | null;
  // Menu section — job-based
  todayDay: DayName;
  todayJobs: Array<Pick<MenuJobRow, 'day' | 'meal' | 'status' | 'content_json' | 'image_url' | 'menu_pool_id'>>;
  allWeekJobs: Array<Pick<MenuJobRow, 'day' | 'meal' | 'status' | 'content_json' | 'image_url' | 'menu_pool_id'>>;
  // Menu async first-seed state
  menuSeedState: 'awaiting_first' | 'seeded' | null;
  // Trend + heatmap data
  weights365: Record<string, number>;
  vitalsTrend: Array<{ id: number; date: string; iso_week: string; heart_rate: number | null; bp_systolic: number | null; bp_diastolic: number | null; height_cm: number | null; measured_at: number }>;
  // Last 20 vitals events for the History table.
  recentVitals: Array<{ id: number; date: string; iso_week: string; heart_rate: number | null; bp_systolic: number | null; bp_diastolic: number | null; height_cm: number | null; measured_at: number }>;
  exercises365: Record<string, { kind: string; note: string | null }>;
}

const cat = (c: DashboardProps['bmiCategory']) =>
  c === 'unknown' ? '—' : c === 'normal' ? 'Within ideal' : c === 'under' ? 'Below ideal' : c === 'over' ? 'Above ideal' : 'Well above ideal';

export const Dashboard: FC<DashboardProps> = (p) => (
  <Layout title="Home" active="home" username={p.username} role="user">
    {p.notice && <div style="padding:0.75rem 1.5rem;background:var(--accent-soft);border-bottom:1px solid var(--hairline)"><p class="notice-box" style="margin:0">{p.notice}</p></div>}
    {p.error && <div style="padding:0.75rem 1.5rem;background:var(--accent-soft);border-bottom:1px solid var(--hairline)"><p class="error-box" role="alert" style="margin:0">{p.error}</p></div>}

    <div class="container">

      {/* Section order: trend → weight log → BMI auto → weekly modal → menu */}

      {/* ── 01 trend ── */}
      <section class="section" id="trend">
        <span class="section-num">01 · trend</span>
        <h2 class="section-title">Trend.</h2>
        <p class="section-sub">{p.todayDate} · Melbourne.</p>
        {!p.latestWeight ? (
          <p style="color:var(--ink-soft)">No weight logged yet. Your trend line will appear after today's entry.</p>
        ) : (
          <TrendRangePanel weights={Object.entries(p.weights365).map(([date, weight_kg]) => ({ date, weight_kg }))} vitals={p.vitalsTrend} ideal={p.ideal} />
        )}

        {/* 180-day heatmap (was 365) — weight log + exercise */}
        <h3 class="heatmap-title">180 days · weight log</h3>
        <div class="heatmap-scroll">
          <WeightHeatmap weightByDate={p.weights365} todayDate={p.todayDate} />
        </div>
        {/* Binary coloring (logged=green / no log=empty). Color must match weightHeat() in src/lib/heatmap.ts (WEIGHT_LOGGED_COLOR = #16a34a). */}
        <div class="heatmap-legend">
          <span class="hl-cell" style="background:#16a34a"></span>
          <span>logged</span>
          <span class="hl-cell" style="background:var(--heatmap-empty-bg);border:1px solid var(--heatmap-empty-border)"></span>
          <span>no log</span>
        </div>

        <h3 class="heatmap-title" style="margin-top:1.5rem">180 days · exercise</h3>
        <div class="heatmap-scroll">
          <ExerciseHeatmap exerciseByDate={p.exercises365} exerciseLabelById={EXERCISE_LABEL_BY_ID} todayDate={p.todayDate} />
        </div>
        <div class="heatmap-legend">
          <span class="hl-cell" style="background:#dc2626"></span><span>Run / HIIT</span>
          <span class="hl-cell" style="background:#2563eb"></span><span>Walk / Cycle / Swim</span>
          <span class="hl-cell" style="background:#7c3aed"></span><span>Strength</span>
          <span class="hl-cell" style="background:#16a34a"></span><span>Yoga</span>
          <span class="hl-cell" style="background:#ea580c"></span><span>Ball games</span>
          <span class="hl-cell" style="background:#db2777"></span><span>MMA</span>
          <span class="hl-cell" style="background:#6b7280"></span><span>Other</span>
          <span class="hl-cell" style="background:var(--heatmap-empty-bg);border:1px solid var(--heatmap-empty-border)"></span><span>Rest / no log</span>
        </div>
      </section>

      {/* ── 02 daily weight + exercise ── */}
      <section class="section" id="log">
        <span class="section-num">02 · log</span>
        <h2 class="section-title">Today's log.</h2>

        <form method="post" action="/log/daily" class="form-stack">
          <div class="form-row">
            <label for="weight_kg">Weight (kg)</label>
            <input id="weight_kg" name="weight_kg" type="number" step="0.1" min="20" max="300"
              value={p.todayWeight != null ? String(p.todayWeight) : ''}
              required autofocus inputmode="decimal" />
          </div>
          <div class="form-row">
            <label for="exercise_kind">Exercise</label>
            <select id="exercise_kind" name="exercise_kind"
              onchange="document.getElementById('ex-note-wrap').style.display=(this.value==='other'?'flex':'none');document.getElementById('ex_note').required=(this.value==='other')">
              <option value="">— none / skip —</option>
              {EXERCISE_OPTIONS.map(e => (
                <option value={e.id} selected={p.todayExercise?.kind === e.id}>{e.label}</option>
              ))}
            </select>
          </div>
          <div id="ex-note-wrap" class="form-row" style={`display:${p.todayExercise?.kind === 'other' ? 'flex' : 'none'};flex-direction:column;gap:0.35rem`}>
            <label for="ex_note">Note (required when “Other”)</label>
            <textarea id="ex_note" name="ex_note" maxlength={200} rows={2}
              required={p.todayExercise?.kind === 'other'}
              style="font:inherit;font-size:16px;padding:0.65rem 0.8rem;border:1px solid var(--hairline);resize:vertical;width:100%"
            >{p.todayExercise?.note ?? ''}</textarea>
          </div>
          <button type="submit" class="btn-primary">{p.todayWeight != null ? 'Update today’s log' : 'Save today’s log'}</button>
        </form>
      </section>

      {/* ── 03 BMI auto ── */}
      <section class="section" id="bmi">
        <span class="section-num">03 · bmi</span>
        <h2 class="section-title">BMI & body metrics.</h2>
        {!p.latestWeight ? (
          <p style="color:var(--ink-soft)">BMI is computed automatically once today’s weight is logged.</p>
        ) : (
          <div class="stat-grid">
            <div class="stat"><span class="stat-label">Today’s weight</span><span class="stat-value">{p.latestWeight!.weight_kg.toFixed(1)}<span class="stat-unit">kg</span></span><span class="stat-sub">{p.latestWeight!.date}</span></div>
            <div class="stat"><span class="stat-label">BMI</span><span class="stat-value">{p.bmi != null ? p.bmi.toFixed(1) : '—'}</span><span class="stat-sub">{cat(p.bmiCategory)}</span></div>
            <div class="stat"><span class="stat-label">Ideal range</span><span class="stat-value stat-value-range">{p.ideal ? `${p.ideal.min}–${p.ideal.max}` : '—'}<span class="stat-unit">kg</span></span><span class="stat-sub">BMI 18.5–24.9</span></div>
            <div class="stat"><span class="stat-label">Age</span><span class="stat-value">{p.age ?? '—'}</span><span class="stat-sub">{p.gender ?? ''}</span></div>
          </div>
        )}
      </section>

      {/* ── 04 weekly vitals modal ── */}
      <section class="section" id="weekly">
        <span class="section-num">04 · weekly</span>
        <h2 class="section-title">Heart rate / blood pressure.</h2>
        <p class="section-sub">
          {p.weekVitalsLogged
            ? `Latest · HR ${p.weekVitals?.heart_rate ?? '—'} bpm · BP ${p.weekVitals?.bp_systolic ?? '—'}/${p.weekVitals?.bp_diastolic ?? '—'}`
            : `${p.isoWeek} not logged yet.`}
        </p>
        <button type="button" class="btn-secondary" onclick="document.getElementById('vitals-modal').showModal()">
          Log HR / BP
        </button>

        <dialog id="vitals-modal" class="modal">
          <form method="post" action="/log/vitals" class="form-stack">
            <header class="modal-head">
              <h3 style="margin:0;font-family:var(--serif);font-size:1.4rem;font-style:italic">{p.isoWeek} weekly log</h3>
              <button type="button" class="link-btn" onclick="document.getElementById('vitals-modal').close()" aria-label="Close">×</button>
            </header>
            <div class="form-row">
              <label for="height_cm_w">Height (cm)</label>
              <input id="height_cm_w" name="height_cm" type="number" step="0.1" min="80" max="230"
                value={p.weekVitals?.height_cm != null ? String(p.weekVitals.height_cm) : (p.height_cm != null ? String(p.height_cm) : '')} />
            </div>
            <div class="form-row">
              <label for="heart_rate">Resting heart rate (bpm)</label>
              <input id="heart_rate" name="heart_rate" type="number" min="30" max="220"
                value={p.weekVitals?.heart_rate != null ? String(p.weekVitals.heart_rate) : ''} inputmode="numeric" />
            </div>
            <div class="form-row row-pair">
              <div class="form-row">
                <label for="bp_systolic">Systolic (mmHg)</label>
                <input id="bp_systolic" name="bp_systolic" type="number" min="60" max="260"
                  value={p.weekVitals?.bp_systolic != null ? String(p.weekVitals.bp_systolic) : ''} inputmode="numeric" />
              </div>
              <div class="form-row">
                <label for="bp_diastolic">Diastolic (mmHg)</label>
                <input id="bp_diastolic" name="bp_diastolic" type="number" min="30" max="200"
                  value={p.weekVitals?.bp_diastolic != null ? String(p.weekVitals.bp_diastolic) : ''} inputmode="numeric" />
              </div>
            </div>
            <div style="display:flex;gap:0.75rem;justify-content:flex-end">
              <button type="button" class="link-btn" onclick="document.getElementById('vitals-modal').close()">Cancel</button>
              <button type="submit" class="btn-primary">Save</button>
            </div>
          </form>
        </dialog>

        {/* History table for the last 20 events, with delete. */}
        {p.recentVitals.length > 0 && (
          <div class="vitals-history" style="margin-top:1.5rem">
            <h3 class="trend-subtitle">History</h3>
            <table class="user-table vitals-history-table">
              <thead>
                <tr><th>When</th><th>HR</th><th>SBP</th><th>DBP</th><th>Height</th><th class="col-actions">—</th></tr>
              </thead>
              <tbody>
                {p.recentVitals.map((v) => (
                  <tr>
                    <td data-label="When"><time>{fmtVitalsTs(v.measured_at)}</time></td>
                    <td data-label="HR">{v.heart_rate ?? '—'}</td>
                    <td data-label="SBP">{v.bp_systolic ?? '—'}</td>
                    <td data-label="DBP">{v.bp_diastolic ?? '—'}</td>
                    <td data-label="Height">{v.height_cm != null ? `${v.height_cm} cm` : '—'}</td>
                    <td data-label="" class="col-actions">
                      <form method="post" action={`/log/vitals/${v.id}/delete`} style="display:inline" onsubmit="return confirm('Delete this entry?')">
                        <button class="link-btn" type="submit">Delete</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 05 today's menu ── */}
      <section class="section" id="menu">
        <span class="section-num">05 · today's menu</span>
        <h2 class="section-title">Today's food.</h2>
        <p class="section-sub">{p.todayDay} · {p.isoWeek}</p>

        {p.menuSeedState === 'awaiting_first' ? (
          <div>
            <p style="color:var(--ink-soft);font-style:italic;margin-bottom:1rem">Cooking up your menu, please wait…<br/><span style="font-size:0.85rem">Auto-generation runs at 3:00 AM local time.</span></p>
            <form method="post" action="/menu/seed-now">
              <button type="submit" class="btn-narrow">Generate now</button>
            </form>
          </div>
        ) : p.todayJobs.length === 0 ? (
          <div>
            <p style="color:var(--ink-soft)">Menu not generated yet for this week.</p>
            <form method="post" action="/menu/seed-now">
              <button type="submit" class="btn-primary">Generate this week’s menu</button>
            </form>
          </div>
        ) : (
          <div style="display:flex;flex-direction:column;gap:1rem">
            {MEAL_ORDER.map(meal => {
              const job = p.todayJobs.find(j => j.meal === meal);
              if (!job) return null;
              return <MealJobCard job={job} meal={meal} day={p.todayDay} />;
            })}
          </div>
        )}

        {p.allWeekJobs.length > 0 && (
          <details style="margin-top:2rem">
            <summary style="cursor:pointer;font-size:0.85rem;color:var(--ink-soft);letter-spacing:0.06em;text-transform:uppercase;user-select:none">
              Full week — {p.isoWeek}
            </summary>
            <div class="menu-week" style="margin-top:1rem">
              {DAYS_ORDER.filter(d => d !== p.todayDay).map(day => {
                const dayJobs = p.allWeekJobs.filter(j => j.day === day);
                if (dayJobs.length === 0) return null;
                return (
                  <article class="menu-day">
                    <header class="menu-day-head"><h3 class="menu-day-name">{day}</h3></header>
                    {MEAL_ORDER.map(meal => {
                      const job = dayJobs.find(j => j.meal === meal);
                      if (!job) return null;
                      return <MealJobCard job={job} meal={meal} compact />;
                    })}
                  </article>
                );
              })}
            </div>
          </details>
        )}
      </section>
    </div>
  </Layout>
);

const MealJobCard: FC<{
  job: Pick<MenuJobRow, 'meal' | 'status' | 'content_json' | 'image_url' | 'menu_pool_id'>;
  meal: MealKind;
  day?: DayName;
  compact?: boolean;
}> = ({ job, meal, day, compact }) => {
  const content = parseMeal(job.content_json);
  // Only two states. 'empty' = pool refilling, gray placeholder,
  // no error text, no retry button.
  const isEmpty = job.status === 'empty';
  const label = MEAL_LABELS[meal];

  if (compact) {
    return (
      <div class="menu-meal">
        <span class="menu-meal-slot">{label}</span>
        <div>
          {isEmpty && <span style="color:var(--ink-soft);font-style:italic">Refilling…</span>}
          {job.status === 'ready' && content && (
            <><div class="menu-meal-name">{content.name}</div><div class="menu-meal-desc">{content.description}</div></>
          )}
        </div>
      </div>
    );
  }

  return (
    <div class="trend-card" style="display:flex;gap:1rem;align-items:flex-start;position:relative">
      {day && job.status === 'ready' && (
        <form method="post" action={`/menu/shuffle/${day}/${meal}`} style="position:absolute;top:0.5rem;right:0.5rem;margin:0">
          <button type="submit" class="btn-icon" title="Shuffle" aria-label="Shuffle">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M3 21v-5h5"/></svg>
          </button>
        </form>
      )}
      {/* Image MUST go through /menu/img/:pool_id. */}
      <div style="flex-shrink:0;width:80px;height:80px;background:var(--accent-soft);border-radius:4px;overflow:hidden">
        {job.menu_pool_id != null && job.status === 'ready' ? (
          <img
            src={getDisplayImageUrl({ id: job.menu_pool_id })}
            alt={content?.name ?? meal}
            width={80} height={80}
            style="object-fit:cover;width:100%;height:100%"
            loading="lazy" />
        ) : (
          <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center">
            <span style="font-size:0.65rem;color:var(--ink-soft);text-align:center;padding:4px">{isEmpty ? '…' : ''}</span>
          </div>
        )}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-family:var(--mono);font-size:0.72rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--ink-soft);margin-bottom:0.25rem">{label}</div>
        {isEmpty && (
          <p style="color:var(--ink-soft);font-style:italic;margin:0;font-size:0.9rem">
            Refilling this meal—please check back in a moment.
          </p>
        )}
        {job.status === 'ready' && content && (
          <>
            <div class="menu-meal-name">{content.name}</div>
            <div class="menu-meal-desc" style="margin-top:0.2rem">{content.description}</div>
            <p class="menu-ingredients" style="margin-top:0.5rem">
              {content.ingredients.map(i => `${i.name} ${i.qty}`).join(' · ')}
            </p>
            <p class="menu-rationale">{content.rationale}</p>
            <span style="font-family:var(--mono);font-size:0.78rem;color:var(--ink-soft)">{content.kcal} kcal</span>
          </>
        )}
      </div>
    </div>
  );
};

const TREND_RANGES = [
  { key: '1M', label: '1M', days: 30 },
  { key: '3M', label: '3M', days: 90 },
  { key: '6M', label: '6M', days: 180 },
  { key: '1Y', label: '1Y', days: 365 },
  { key: 'All', label: 'All', days: Infinity },
] as const;

const TrendRangePanel: FC<{ weights: Array<{ date: string; weight_kg: number }>; vitals: DashboardProps['vitalsTrend']; ideal: { min: number; max: number } | null }> = ({ weights, vitals, ideal }) => {
  const sorted = [...weights].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  const anchorDate = latest?.date ?? vitals[vitals.length - 1]?.date;
  // Vitals filtered by measured_at (ms epoch) instead of iso week date.
  const anchorMs = anchorDate ? new Date(`${anchorDate}T23:59:59Z`).getTime() : (vitals[vitals.length - 1]?.measured_at ?? Date.now());
  const rangeData = TREND_RANGES.map(r => ({
    ...r,
    weights: Number.isFinite(r.days) && anchorDate
      ? sorted.filter(w => daysBetween(w.date, anchorDate) < r.days)
      : sorted,
    vitals: Number.isFinite(r.days)
      ? vitals.filter(v => (anchorMs - v.measured_at) / 86400_000 < r.days)
      : vitals,
  }));
  return (
    <div class="trend-card trend-range-card">
      <div class="trend-range-buttons" role="group" aria-label="Trend range">
        {TREND_RANGES.map((r, i) => (
          <button type="button" class={`trend-range-btn${i === 0 ? ' is-active' : ''}`} data-range-button={r.key}
            onclick="var btn=this;var root=btn.closest('.trend-range-card');root.querySelectorAll('[data-range-button]').forEach(function(b){b.classList.remove('is-active')});btn.classList.add('is-active');root.querySelectorAll('[data-range-pane]').forEach(function(p){p.hidden=p.getAttribute('data-range-pane')!==btn.getAttribute('data-range-button')})">
            {r.label}
          </button>
        ))}
      </div>
      {rangeData.map((r, i) => (
        <div data-range-pane={r.key} hidden={i !== 0}>
          <WeightTrendSVG weights={r.weights} ideal={ideal} />
          <h3 class="trend-subtitle">Blood pressure trend</h3>
          <VitalsTrendSVG vitals={r.vitals} />
        </div>
      ))}
    </div>
  );
};

function daysBetween(a: string, b: string): number {
  return Math.floor((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400_000);
}


const WeightTrendSVG: FC<{ weights: Array<{ date: string; weight_kg: number }>; ideal: { min: number; max: number } | null }> = ({ weights, ideal }) => {
  if (weights.length === 0) return <p style="color:var(--ink-soft);margin:0">No data in this range.</p>;
  const W = 640, H = 230, padL = 44, padR = 16, padT = 18, padB = 42;
  const innerW = W - padL - padR; const innerH = H - padT - padB;
  const sorted = [...weights].sort((a, b) => a.date.localeCompare(b.date));
  const ws = sorted.map(w => w.weight_kg);
  const minW = Math.min(...ws, ideal?.min ?? Infinity);
  const maxW = Math.max(...ws, ideal?.max ?? -Infinity);
  const span = Math.max(maxW - minW, 2);
  const lo = Math.floor((minW - span * 0.12) * 2) / 2;
  const hi = Math.ceil((maxW + span * 0.12) * 2) / 2;
  const xOf = (i: number) => padL + (sorted.length === 1 ? innerW / 2 : (i / (sorted.length - 1)) * innerW);
  const yOf = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * innerH;
  const points = sorted.map((w, i) => `${xOf(i).toFixed(1)},${yOf(w.weight_kg).toFixed(1)}`).join(' ');
  const idealRect = ideal ? { y1: yOf(ideal.max), y2: yOf(ideal.min) } : null;
  const yTicks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) / 4) * i);
  const xTickCount = Math.min(7, Math.max(3, sorted.length));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => Math.round((i / Math.max(xTickCount - 1, 1)) * (sorted.length - 1)));
  return (
    <svg class="trend-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {idealRect && <rect class="ideal-band" x={padL} y={idealRect.y1} width={innerW} height={Math.max(idealRect.y2 - idealRect.y1, 0)} />}
      {yTicks.map(t => (
        <>
          <line class="grid-line" x1={padL} y1={yOf(t)} x2={padL + innerW} y2={yOf(t)} />
          <text class="axis-label" x={padL - 8} y={yOf(t) + 4} text-anchor="end">{t.toFixed(1)}</text>
        </>
      ))}
      <line class="axis" x1={padL} y1={padT} x2={padL} y2={padT + innerH} />
      <line class="axis" x1={padL} y1={padT + innerH} x2={padL + innerW} y2={padT + innerH} />
      {xTicks.map(i => (
        <>
          <line class="axis-tick" x1={xOf(i)} y1={padT + innerH} x2={xOf(i)} y2={padT + innerH + 4} />
          <text class="axis-label" x={xOf(i)} y={H - 14} text-anchor="middle">{shortDate(sorted[i].date)}</text>
        </>
      ))}
      <polyline class="line" points={points} />
      {sorted.map((w, i) => {
        // Always-visible labels: head, tail, max, min in dense ranges; all if ≤ 7 points.
        const isHead = i === 0;
        const isTail = i === sorted.length - 1;
        const isMax  = w.weight_kg === Math.max(...ws);
        const isMin  = w.weight_kg === Math.min(...ws);
        const showLabel = sorted.length <= 7 || isHead || isTail || isMax || isMin;
        const cy = yOf(w.weight_kg);
        const labelAbove = w.weight_kg >= (lo + hi) / 2;
        const labelY = labelAbove ? cy - 7 : cy + 13;
        return (
          <>
            <circle class="dot" cx={xOf(i)} cy={cy} r={2.8}>
              <title>{w.date} · {w.weight_kg.toFixed(1)} kg</title>
            </circle>
            {showLabel && (
              <text class="dot-label" x={xOf(i)} y={labelY} text-anchor="middle">{w.weight_kg.toFixed(1)}</text>
            )}
          </>
        );
      })}
    </svg>
  );
};

const VitalsTrendSVG: FC<{ vitals: DashboardProps['vitalsTrend'] }> = ({ vitals }) => {
  // Sort by measured_at; X axis is real time, not week-discrete.
  const rows = [...vitals].sort((a, b) => a.measured_at - b.measured_at);
  if (rows.length === 0) return <p style="color:var(--ink-soft);margin:0">No vitals in this range.</p>;
  const W = 640, H = 230, padL = 44, padR = 16, padT = 18, padB = 42;
  const innerW = W - padL - padR; const innerH = H - padT - padB;
  const bpLo = 60, bpHi = 180;
  const tMin = rows[0].measured_at;
  const tMax = rows[rows.length - 1].measured_at;
  const tSpan = Math.max(tMax - tMin, 1);
  const xOf = (t: number) => padL + (rows.length === 1 ? innerW / 2 : ((t - tMin) / tSpan) * innerW);
  const yBp = (v: number) => padT + (1 - (v - bpLo) / (bpHi - bpLo)) * innerH;
  const bpTicks = [60, 90, 120, 150, 180];
  const xTickCount = Math.min(7, Math.max(3, rows.length));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => Math.round((i / Math.max(xTickCount - 1, 1)) * (rows.length - 1)));
  const linesFor = (key: 'bp_systolic' | 'bp_diastolic', y: (v: number) => number) => {
    const segs: string[] = [];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]; const b = rows[i];
      const av = a[key]; const bv = b[key];
      if (av == null || bv == null) continue;
      // Break the line if there's a gap > 30 days between consecutive events.
      if ((b.measured_at - a.measured_at) > 30 * 86400_000) continue;
      segs.push(`${xOf(a.measured_at).toFixed(1)},${y(av).toFixed(1)} ${xOf(b.measured_at).toFixed(1)},${y(bv).toFixed(1)}`);
    }
    return segs;
  };
  const fmtTs = (ms: number) => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
  return (
    <svg class="trend-svg vitals-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {bpTicks.map(t => (
        <>
          <line class="grid-line" x1={padL} y1={yBp(t)} x2={padL + innerW} y2={yBp(t)} />
          <text class="axis-label" x={padL - 8} y={yBp(t) + 4} text-anchor="end">{t}</text>
        </>
      ))}
      <line class="axis" x1={padL} y1={padT} x2={padL} y2={padT + innerH} />
      <line class="axis" x1={padL} y1={padT + innerH} x2={padL + innerW} y2={padT + innerH} />
      {xTicks.map(i => (
        <>
          <line class="axis-tick" x1={xOf(rows[i].measured_at)} y1={padT + innerH} x2={xOf(rows[i].measured_at)} y2={padT + innerH + 4} />
          <text class="axis-label" x={xOf(rows[i].measured_at)} y={H - 14} text-anchor="middle">{shortDate(rows[i].date)}</text>
        </>
      ))}
      {linesFor('bp_systolic', yBp).map(points => <polyline class="line line-sbp line-dashed" points={points} />)}
      {linesFor('bp_diastolic', yBp).map(points => <polyline class="line line-dbp line-dashed" points={points} />)}
      {rows.map((r) => (
        <>
          {r.bp_systolic != null && <circle class="dot dot-sbp" cx={xOf(r.measured_at)} cy={yBp(r.bp_systolic)} r={2.8}><title>{fmtTs(r.measured_at)} · SBP {r.bp_systolic} mmHg</title></circle>}
          {r.bp_diastolic != null && <circle class="dot dot-dbp" cx={xOf(r.measured_at)} cy={yBp(r.bp_diastolic)} r={2.8}><title>{fmtTs(r.measured_at)} · DBP {r.bp_diastolic} mmHg</title></circle>}
        </>
      ))}
      <text class="axis-label" x={padL} y={10}>mmHg</text>
    </svg>
  );
};


function shortDate(date: string): string {
  return date.slice(5).replace('-', '/');
}

function fmtVitalsTs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}


// ─── Admin view ───────────────────────────────────────────────────────────────

interface AdminProps {
  username: string;
  users: Array<{ id: number; username: string; role: 'user' | 'admin'; created_at: number }>;
  notice?: string | null;
  error?: string | null;
}

export const AdminView: FC<AdminProps> = ({ username, users, notice, error }) => (
  <Layout title="Users" active="admin" username={username} role="admin">
    <section class="section">
      <span class="section-num">01 · admin</span>
      <h1 class="section-title">User accounts.</h1>
      <p class="section-sub">You can create accounts and reset passwords. You cannot read anyone's health data — that boundary is enforced in the database, not just the interface.</p>

      {notice && <NoticeBox message={notice} />}
      {error && <p class="error-box" role="alert">{error}</p>}

      <table class="user-table">
        <thead>
          <tr><th>ID</th><th>Username</th><th>Role</th><th>Created</th><th class="col-actions">Actions</th></tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr>
              <td data-label="ID"><code>{u.id}</code></td>
              <td data-label="Username">{u.username}</td>
              <td data-label="Role">{u.role}</td>
              <td data-label="Created"><time>{new Date(u.created_at).toISOString().slice(0, 10)}</time></td>
              <td data-label="Actions" class="col-actions">
                <form method="post" action={`/admin/users/${u.id}/reset`} style="display:inline">
                  <button class="link-btn" type="submit">Reset password</button>
                </form>
                {' · '}
                <form method="post" action={`/admin/users/${u.id}/delete`} style="display:inline" onsubmit="return confirm('Delete this user and all their data?')">
                  <button class="link-btn" type="submit">Delete</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <hr class="hairline" />
      <h2 class="section-title" style="font-size:1.5rem">Create user</h2>
      <form method="post" action="/admin/users" class="form-stack">
        <div class="form-row">
          <label for="new_username">Username</label>
          <input id="new_username" name="username" required minlength={2} maxlength={32} />
        </div>
        <div class="form-row">
          <label for="new_password">Password</label>
          <input id="new_password" name="password" required minlength={6} />
        </div>
        <div class="form-row">
          <label for="new_role">Role</label>
          <select id="new_role" name="role">
            <option value="user" selected>user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <button type="submit" class="btn-primary">Create</button>
      </form>
    </section>
  </Layout>
);

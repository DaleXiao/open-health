/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx';
import { exerciseHeat, weightHeat } from '../lib/heatmap.ts';

// GitHub-style heatmap, 26 weeks × 7 days, 180-day window.
// (was 53 weeks × 365 days; reverted to 180 to avoid right-edge clipping under scrollbar
// and match the prior UX choice.)
// SSR-rendered SVG; tooltip via native <title>.

const CELL = 12;
const GAP  = 2;
const COLS = 26;
const ROWS = 7;        // Mon..Sun, row 0 = Mon
const WINDOW_DAYS = 180;
const W    = COLS * (CELL + GAP) - GAP + 24; // +24 for left day labels
const H    = ROWS * (CELL + GAP) - GAP + 16; // +16 for top month labels

// Compute window: today (in local tz) anchored at COLS-1 column, walk back 364 days.
// Caller passes pre-anchored grid with `days[]` of length 365 in chronological order (oldest first).
export interface HeatmapDay {
  date: string;          // YYYY-MM-DD
  label: string;         // tooltip text e.g. "2026-04-22 · 65.5kg"
  fill: string;          // CSS color
  stroke?: string;
}

const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];

const Grid: FC<{ days: HeatmapDay[]; ariaLabel: string }> = ({ days, ariaLabel }) => {
  // We need WINDOW_DAYS cells. Layout: column = week index (0..COLS-1), row = weekday Mon..Sun.
  // Place oldest day so the last column is the most recent week. Row of first day matches its weekday.
  if (days.length !== WINDOW_DAYS) {
    return <svg width={W} height={H} role="img" aria-label={ariaLabel} />;
  }
  // Determine row of first day (Mon=0..Sun=6).
  const firstWd = (() => {
    const d = new Date(days[0].date + 'T00:00:00Z');
    const js = d.getUTCDay(); // 0=Sun..6=Sat
    return (js + 6) % 7;       // 0=Mon..6=Sun
  })();

  return (
    <svg width={W} height={H} role="img" aria-label={ariaLabel} style="display:block">
      {/* day labels */}
      {DAY_LABELS.map((lbl, i) => lbl && (
        <text x={0} y={16 + i * (CELL + GAP) + 9} font-size="9" fill="var(--ink-soft)" font-family="sans-serif">{lbl}</text>
      ))}
      {/* cells */}
      {days.map((d, idx) => {
        const pos = firstWd + idx;
        const col = Math.floor(pos / 7);
        const row = pos % 7;
        if (col >= COLS) return null;
        const x = 24 + col * (CELL + GAP);
        const y = 16 + row * (CELL + GAP);
        return (
          <rect x={x} y={y} width={CELL} height={CELL} rx={2} ry={2} fill={d.fill} stroke={d.stroke ?? 'none'} stroke-width={d.stroke ? 1 : 0}>
            <title>{d.label}</title>
          </rect>
        );
      })}
    </svg>
  );
};

// ─── Public components ───────────────────────────────────────────────────

export interface WeightHeatmapProps {
  // map of YYYY-MM-DD -> weight_kg
  weightByDate: Record<string, number>;
  todayDate: string; // YYYY-MM-DD in user tz
}

export const WeightHeatmap: FC<WeightHeatmapProps> = ({ weightByDate, todayDate }) => {
  // Binary coloring — logged = green, not logged = gray (empty-bg). No "since" gradient.
  const days: HeatmapDay[] = buildWindowDays(todayDate).map(date => {
    const w = weightByDate[date];
    if (w == null) {
      return {
        date,
        label: `${date} · no log`,
        fill: 'var(--heatmap-empty-bg)',
        stroke: 'var(--heatmap-empty-border)',
      };
    }
    return {
      date,
      label: `${date} · ${w.toFixed(1)} kg`,
      fill: weightHeat(),
    };
  });
  return <Grid days={days} ariaLabel="180-day weight log heatmap" />;
};

export interface ExerciseHeatmapProps {
  // map of YYYY-MM-DD -> { kind, note }
  exerciseByDate: Record<string, { kind: string; note: string | null }>;
  exerciseLabelById: Record<string, string>;
  todayDate: string;
}

export const ExerciseHeatmap: FC<ExerciseHeatmapProps> = ({ exerciseByDate, exerciseLabelById, todayDate }) => {
  const days: HeatmapDay[] = buildWindowDays(todayDate).map(date => {
    const e = exerciseByDate[date];
    if (!e) {
      return { date, label: `${date} · no exercise`, fill: 'var(--heatmap-empty-bg)', stroke: 'var(--heatmap-empty-border)' };
    }
    const heat = exerciseHeat(e.kind);
    const lbl = exerciseLabelById[e.kind] ?? e.kind;
    return {
      date,
      label: `${date} · ${lbl}${e.note ? ` · ${e.note}` : ''}`,
      fill: heat.family === 'rest' ? 'var(--heatmap-empty-bg)' : heat.color,
      stroke: heat.family === 'rest' ? 'var(--heatmap-empty-border)' : undefined,
    };
  });
  return <Grid days={days} ariaLabel="180-day exercise heatmap" />;
};

// ─── helpers ─────────────────────────────────────────────────────────────

function buildWindowDays(todayDate: string): string[] {
  const out: string[] = [];
  const today = new Date(todayDate + 'T00:00:00Z');
  // (WINDOW_DAYS - 1) days back, plus today = WINDOW_DAYS days
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function daysSinceLastEntry(map: Record<string, number>, asOfDate: string): number | null {
  const target = new Date(asOfDate + 'T00:00:00Z').getTime();
  let best: number | null = null;
  for (const k of Object.keys(map)) {
    const t = new Date(k + 'T00:00:00Z').getTime();
    if (t > target) continue;
    const diff = Math.floor((target - t) / 86400_000);
    if (best == null || diff < best) best = diff;
  }
  return best;
}

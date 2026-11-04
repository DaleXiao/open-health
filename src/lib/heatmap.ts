// Heatmap colors.
// Maps EXERCISE_OPTIONS ids to color families.
// Families: running=red / strength=purple / yoga=green / ball sports=orange /
// walking, cycling, swimming, rowing=blue / combat=pink-purple / rest=base color / other=gray.
// Each family is a single solid color (no 3-level shades, no level field);
// intensity reads naturally from the label.
import type { ExerciseKind } from './exercise.ts';

export type ExerciseFamily = 'cardio_run' | 'cardio_walk' | 'strength' | 'yoga' | 'ball' | 'mma' | 'rest' | 'other';

export interface HeatmapExerciseInfo {
  family: ExerciseFamily;
  // CSS color (light theme); rest uses the transparent base color — callers
  // render the base directly when family==='rest'
  color: string;
}

// One solid color per family (the former level-3 dark shade, matching the legend)
const PALETTE: Record<ExerciseFamily, string> = {
  cardio_run:  '#dc2626',   // red
  strength:    '#7c3aed',   // purple
  yoga:        '#16a34a',   // green
  ball:        '#ea580c',   // orange
  cardio_walk: '#2563eb',   // blue
  mma:         '#db2777',   // pink-purple (combat)
  rest:        '#f3f4f6',   // base color
  other:       '#6b7280',   // gray
};

// Map EXERCISE_OPTIONS ids to families
const MAP: Record<ExerciseKind, ExerciseFamily> = {
  walk_2km:       'cardio_walk',
  walk_5km:       'cardio_walk',
  run_5km:        'cardio_run',
  cycling_20km:   'cardio_walk',
  swim_1km:       'cardio_walk',
  rowing_5km:     'cardio_walk',
  pushup_100:     'strength',
  mma_90min:      'mma',
  yoga_60min:     'yoga',
  strength_45min: 'strength',
  hiit_30min:     'cardio_run',
  ball_60min:     'ball',
  rest:           'rest',
  other:          'other',
};

export function exerciseHeat(kind: string): HeatmapExerciseInfo {
  const family = MAP[kind as ExerciseKind] ?? 'other';
  return { family, color: PALETTE[family] };
}

// Weight heatmap: logged=green, not logged=gray (empty-bg). No "since" gradient.
// The green comes from the yoga family (#16a34a), matching the "health" semantic.
export const WEIGHT_LOGGED_COLOR = '#16a34a';
// Back-compat: signature retained, daysAgo ignored. Callers should use empty-bg
// directly for unlogged days instead of calling this function; kept only so
// old references don't break.
export function weightHeat(_daysAgo?: number | null): string {
  return WEIGHT_LOGGED_COLOR;
}
// The old 4-level blue palette is kept as deprecated so external imports don't crash.
export const WEIGHT_PALETTE = ['#f3f4f6', WEIGHT_LOGGED_COLOR, WEIGHT_LOGGED_COLOR, WEIGHT_LOGGED_COLOR] as const;

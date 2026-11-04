// Exercise options (English-only labels).
export const EXERCISE_OPTIONS = [
  { id: 'walk_2km',       label: 'Walk 2km (dog walk)' },
  { id: 'walk_5km',       label: 'Walk 5km' },
  { id: 'run_5km',        label: 'Run 5km' },
  { id: 'cycling_20km',   label: 'Cycle 20km' },
  { id: 'swim_1km',       label: 'Swim 1km' },
  { id: 'rowing_5km',     label: 'Rowing machine 5km' },
  { id: 'pushup_100',     label: 'Push-ups × 100' },
  { id: 'mma_90min',      label: 'MMA / kickboxing 90min' },
  { id: 'yoga_60min',     label: 'Yoga 60min' },
  { id: 'strength_45min', label: 'Strength 45min' },
  { id: 'hiit_30min',     label: 'HIIT 30min' },
  { id: 'ball_60min',     label: 'Ball games 60min (basketball / tennis / etc.)' },
  { id: 'rest',           label: 'Rest day' },
  { id: 'other',          label: 'Other (note required)' },
] as const;

export type ExerciseKind = typeof EXERCISE_OPTIONS[number]['id'];
export const EXERCISE_IDS = EXERCISE_OPTIONS.map(e => e.id);

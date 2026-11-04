// Health calculations & date helpers.

export function calcAge(birthdayISO: string | null | undefined, ref = new Date()): number | null {
  if (!birthdayISO) return null;
  const d = new Date(birthdayISO + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  let age = ref.getUTCFullYear() - d.getUTCFullYear();
  const m = ref.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && ref.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

export function calcBMI(weightKg: number, heightCm: number | null | undefined): number | null {
  if (!heightCm || heightCm <= 0) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

export function idealWeightRange(heightCm: number | null | undefined): { min: number; max: number } | null {
  if (!heightCm || heightCm <= 0) return null;
  const m = heightCm / 100;
  return {
    min: Math.round(18.5 * m * m * 10) / 10,
    max: Math.round(24.9 * m * m * 10) / 10,
  };
}

// ISO 8601 week — YYYY-Www (Mon as start, ISO week 01 = week containing first Thursday).
export function isoWeek(d: Date = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// Local-date YYYY-MM-DD in the given IANA timezone (e.g. Australia/Melbourne).
export function localDate(tz: string, d: Date = new Date()): string {
  // Intl gives parts in tz.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(d); // YYYY-MM-DD
}

// 0=Sun,1=Mon,...,6=Sat. Returns 'Mon'|'Tue'|...|'Sun'.
const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] as const;
export function weekdayMelbourne(tz = 'Australia/Melbourne', d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
  return parts.slice(0, 3);
}

export function bmiCategory(bmi: number | null): 'under' | 'normal' | 'over' | 'obese' | 'unknown' {
  if (bmi == null) return 'unknown';
  if (bmi < 18.5) return 'under';
  if (bmi < 25) return 'normal';
  if (bmi < 30) return 'over';
  return 'obese';
}

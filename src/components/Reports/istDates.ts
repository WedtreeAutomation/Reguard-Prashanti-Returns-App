/**
 * IST calendar helpers shared by the Analytics and Home dashboards
 * (chart bucketing, prior-period ranges). Dates are `YYYY-MM-DD` strings.
 */
const IST_DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const IST_HOUR_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' });

/** IST calendar day of an instant. */
export const istYmd = (d: Date): string => IST_DAY_FMT.format(d);

/** IST hour (0–23) of an instant. */
export const istHour = (d: Date): number => {
  const h = parseInt(IST_HOUR_FMT.format(d), 10);
  return isFinite(h) ? h % 24 : 0;
};

export const addDaysYmd = (ymd: string, n: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** Inclusive number of calendar days between two YYYY-MM-DD strings. */
export const daysInclusive = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

export const mondayOf = (ymd: string): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDaysYmd(ymd, -dow);
};

export const ymdLabel = (ymd: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }): string =>
  new Date(`${ymd}T00:00:00+05:30`).toLocaleDateString('en-IN', { ...opts, timeZone: 'Asia/Kolkata' });

/** Generic firestore-ish timestamp → Date. */
export const tsToDate = (ts: unknown): Date | null => {
  if (!ts) return null;
  try {
    if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts;
    if (typeof ts === 'object') {
      const o = ts as { toDate?: () => Date; seconds?: number; _seconds?: number };
      if (typeof o.toDate === 'function') return o.toDate();
      const s = o.seconds ?? o._seconds;
      return typeof s === 'number' ? new Date(s * 1000) : null;
    }
    const d = new Date(ts as string | number);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
};

export const firestoreErrorMessage = (e: unknown, fallback = 'Could not load data. Please retry.'): string => {
  const code = (e as { code?: string } | null)?.code || '';
  if (code.includes('permission-denied')) return 'You do not have permission to read this data.';
  if (code.includes('unavailable')) return 'Network error — could not reach the database. Check your connection and retry.';
  if (code.includes('failed-precondition')) return 'A database index for this query is still being built. Please retry in a few minutes.';
  if (code.includes('resource-exhausted')) return 'Too many requests right now. Please wait a moment and retry.';
  return fallback;
};

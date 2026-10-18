/**
 * IST date-range helpers (calendar days as `YYYY-MM-DD`).
 *
 * Kept separate from `excel.ts` so pages that only need dates (filters, dashboards, modals)
 * don't pull the SheetJS bundle into their chunk.
 */
export type DatePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'all' | 'custom';

/** First day used for the "All time" preset (before the portal held any data). */
export const ALL_TIME_FROM = '2023-01-01';

export const DATE_PRESETS: Array<{ id: DatePreset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
];

/** Today's date in IST as YYYY-MM-DD. */
export const istToday = (): string => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts; // en-CA → YYYY-MM-DD
};

const shift = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
};

export const presetRange = (preset: DatePreset): { from: string; to: string } => {
  const today = istToday();
  const [y, m] = today.split('-').map(Number);
  switch (preset) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const d = shift(today, -1); return { from: d, to: d }; }
    case 'last7': return { from: shift(today, -6), to: today };
    case 'last30': return { from: shift(today, -29), to: today };
    case 'thisMonth': return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'lastMonth': {
      const first = new Date(Date.UTC(y, m - 2, 1));
      const last = new Date(Date.UTC(y, m - 1, 0));
      return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
    }
    case 'all': return { from: ALL_TIME_FROM, to: today };
    default: return { from: shift(today, -29), to: today };
  }
};

/** Start (inclusive) and end (exclusive) instants for an IST date range. */
export const istRangeToDates = (from: string, to: string): { start: Date; end: Date } => ({
  start: new Date(`${from}T00:00:00+05:30`),
  end: new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 24 * 60 * 60 * 1000),
});

export const formatRangeLabel = (from: string, to: string): string => {
  if (from <= ALL_TIME_FROM && to === istToday()) return 'All time';
  const fmt = (s: string) => new Date(`${s}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  return from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`;
};

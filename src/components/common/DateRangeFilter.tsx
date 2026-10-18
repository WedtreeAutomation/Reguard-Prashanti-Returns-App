import { ReactNode, useEffect, useState } from 'react';
import { Calendar } from 'lucide-react';
import { DATE_PRESETS, DatePreset, formatRangeLabel, istToday, presetRange } from '../../utils/dates';

export interface DateRangeValue {
  preset: DatePreset;
  /** IST calendar day, YYYY-MM-DD (inclusive) */
  from: string;
  /** IST calendar day, YYYY-MM-DD (inclusive) */
  to: string;
}

export const defaultDateRange = (preset: DatePreset = 'last30'): DateRangeValue => ({ preset, ...presetRange(preset) });

interface Props {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  /** Maximum span in days for a custom range (inclusive). Default ~10 years. */
  maxDays?: number;
  className?: string;
  /** Narrow layouts (e.g. side panels): custom date inputs stack. */
  compact?: boolean;
  /** Extra controls shown at the end of the chip row (e.g. a refresh button). */
  trailing?: ReactNode;
  /** Text shown next to the range label (e.g. "12 requests"). */
  summary?: ReactNode;
}

const daysBetween = (from: string, to: string) =>
  Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1;

/**
 * Preset chips (Today … All time, Custom) on ONE line — they scroll sideways on
 * small screens instead of wrapping — plus a custom from/to picker.
 * Emits only valid ranges (from ≤ to, within maxDays, not in the future).
 */
export const DateRangeFilter = ({
  value, onChange, maxDays = 3660, className = '', compact = false, trailing, summary,
}: Props) => {
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const [error, setError] = useState('');
  const today = istToday();

  useEffect(() => {
    setFrom(value.from);
    setTo(value.to);
  }, [value.from, value.to]);

  const applyCustom = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    if (!nextFrom || !nextTo) return;
    if (nextFrom > nextTo) { setError('Start date must be on or before the end date.'); return; }
    if (nextTo > today) { setError('End date cannot be in the future.'); return; }
    if (daysBetween(nextFrom, nextTo) > maxDays) { setError(`Please choose a range of at most ${maxDays} days.`); return; }
    setError('');
    onChange({ preset: 'custom', from: nextFrom, to: nextTo });
  };

  const rangeLabel = formatRangeLabel(value.from, value.to);

  return (
    <div className={`w-full min-w-0 ${className}`}>
      <div className="flex items-center gap-2">
        <div
          className="flex min-w-0 flex-1 flex-nowrap gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
          role="group"
          aria-label="Date range presets"
        >
          {DATE_PRESETS.map((p) => {
            const active = value.preset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  if (p.id === 'custom') { onChange({ ...value, preset: 'custom' }); return; }
                  setError('');
                  onChange({ preset: p.id, ...presetRange(p.id) });
                }}
                className={`min-h-[40px] shrink-0 whitespace-nowrap rounded-full border px-3.5 text-xs font-semibold transition-colors ${
                  active
                    ? 'border-indigo-600 bg-indigo-600 text-white'
                    : 'border-gray-200 bg-white text-gray-700 hover:border-indigo-300 hover:text-indigo-700'
                }`}
                aria-pressed={active}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        {trailing && <div className="flex shrink-0 items-center gap-2 pb-1">{trailing}</div>}
      </div>

      {value.preset === 'custom' && (
        <div className={`mt-3 grid gap-3 ${compact ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 md:max-w-md'}`}>
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
            From
            <input
              type="date"
              value={from}
              max={to || today}
              onChange={(e) => applyCustom(e.target.value, to)}
              className="min-h-[40px] rounded-lg border border-gray-300 px-3 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
            To
            <input
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(e) => applyCustom(from, e.target.value)}
              className="min-h-[40px] rounded-lg border border-gray-300 px-3 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </label>
        </div>
      )}

      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-gray-500">
        <Calendar size={14} aria-hidden="true" />
        <span>{rangeLabel === 'All time' ? 'All time' : `${rangeLabel} (IST)`}</span>
        {summary && <span className="text-gray-400" aria-hidden="true">·</span>}
        {summary && <span className="text-gray-600">{summary}</span>}
      </p>
      {error && <p className="mt-1 text-xs font-medium text-red-600" role="alert">{error}</p>}
    </div>
  );
};

export default DateRangeFilter;

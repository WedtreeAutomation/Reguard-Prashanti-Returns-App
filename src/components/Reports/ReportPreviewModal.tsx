import { useEffect, useMemo, useRef } from 'react';
import { X, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import { toReportColumns, type ReportPayload, type ReportTypeMeta } from '../../Interfaces/reportsApi';
import { formatCellValue, isNumericType } from './format';
import type { CardAction } from './ReportCard';

const PREVIEW_ROWS = 50;

interface Props {
  meta: ReportTypeMeta;
  payload: ReportPayload;
  periodLabel: string;
  busy?: CardAction;
  onDownload: (meta: ReportTypeMeta, kind: 'xlsx' | 'csv') => void;
  onClose: () => void;
}

export const ReportPreviewModal = ({ meta, payload, periodLabel, busy, onDownload, onClose }: Props) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const columns = useMemo(() => toReportColumns(payload.columns), [payload.columns]);
  const rows = payload.rows.slice(0, PREVIEW_ROWS);
  const titleId = `report-preview-title-${meta.id}`;

  // Focus management, Escape to close, background scroll lock.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[90dvh] w-full max-w-5xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-6 sm:py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-bold text-slate-900 sm:text-lg">{meta.title}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{periodLabel} (IST) · {payload.rows.length.toLocaleString('en-IN')} row{payload.rows.length === 1 ? '' : 's'}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {payload.summary.length > 0 && (
            <dl className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {payload.summary.map((s, i) => (
                <div key={`${s.label}-${i}`} className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <dt className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500" title={s.label}>{s.label}</dt>
                  <dd className="mt-1 break-words text-base font-bold tabular-nums text-slate-900">
                    {formatCellValue(s.value, typeof s.value === 'number' && s.type === 'text' ? 'number' : s.type)}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {payload.rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 py-12 text-center">
              <p className="text-sm font-medium text-slate-600">No records in this period.</p>
              <p className="mt-1 text-xs text-slate-400">Try a wider date range.</p>
            </div>
          ) : (
            <>
              <p className="mb-2 text-xs text-slate-500">
                {payload.rows.length > PREVIEW_ROWS
                  ? `Showing the first ${PREVIEW_ROWS} of ${payload.rows.length.toLocaleString('en-IN')} rows — download the file for the full report.`
                  : `Showing all ${payload.rows.length.toLocaleString('en-IN')} row${payload.rows.length === 1 ? '' : 's'}.`}
              </p>
              <div className="overflow-x-auto rounded-xl border border-slate-200" tabIndex={0} aria-label={`${meta.title} preview table`}>
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      {columns.map((c) => (
                        <th
                          key={c.key}
                          scope="col"
                          className={`whitespace-nowrap border-b border-slate-200 px-3 py-2 font-semibold text-slate-600 ${isNumericType(c.type ?? 'text') ? 'text-right' : ''}`}
                        >
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((row, ri) => (
                      <tr key={ri} className="hover:bg-slate-50">
                        {columns.map((c) => {
                          const text = formatCellValue(row[c.key], c.type ?? 'text');
                          const numeric = isNumericType(c.type ?? 'text');
                          return (
                            <td
                              key={c.key}
                              title={text.length > 40 ? text : undefined}
                              className={`max-w-[18rem] truncate whitespace-nowrap px-3 py-2 text-slate-700 ${numeric ? 'text-right tabular-nums' : ''}`}
                            >
                              {text}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-4 py-3 sm:flex-row sm:justify-end sm:px-6">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => onDownload(meta, 'csv')}
            disabled={!!busy}
            className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-60"
          >
            {busy === 'csv' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FileText className="h-4 w-4" aria-hidden="true" />}
            Download CSV
          </button>
          <button
            type="button"
            onClick={() => onDownload(meta, 'xlsx')}
            disabled={!!busy}
            className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {busy === 'xlsx' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />}
            Download Excel
          </button>
        </div>
      </div>
    </div>
  );
};

export default ReportPreviewModal;

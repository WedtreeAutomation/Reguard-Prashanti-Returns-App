import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, AlertTriangle, CheckCircle2, FileSpreadsheet } from 'lucide-react';
import {
  REPORT_CATEGORIES, REPORT_TYPES, fetchReport, primaryValueColumn, sumColumn, toReportTable,
  type ReportPayload, type ReportTypeId, type ReportTypeMeta,
} from '../../Interfaces/reportsApi';
import { getApiErrorMessage } from '../../Interfaces/http';
import { getUserFromStorage, type Role } from '../../Interfaces/types';
import {
  downloadReportCsv, downloadReportXlsx, downloadWorkbookXlsx, reportFileName,
  type ReportTable,
} from '../../utils/excel';
import { formatRangeLabel } from '../../utils/dates';
import type { DateRangeValue } from '../common/DateRangeFilter';
import { ReportCard, type CardAction, type CardState } from './ReportCard';
import { ReportPreviewModal } from './ReportPreviewModal';
import { formatCellValue } from './format';

/** Re-use a fetched report for this long (Preview → Excel → CSV without re-querying). */
const CACHE_TTL_MS = 2 * 60 * 1000;
/** Parallel requests while building the "Download all" workbook. */
const BULK_CONCURRENCY = 3;

interface Props {
  range: DateRangeValue;
  /** Current staff role — hides reports the backend would refuse. */
  role?: Role | null;
}

interface BulkFailure { title: string; message: string }
interface BulkState {
  running: boolean;
  done: number;
  total: number;
  failures: BulkFailure[];
  included?: number;
  error?: string;
}

const cacheKey = (id: ReportTypeId, from: string, to: string) => `${id}|${from}|${to}`;

export const ReportCenter = ({ range, role }: Props) => {
  const { from, to } = range;
  const periodLabel = formatRangeLabel(from, to);
  const generatedBy = useMemo(() => {
    const u = getUserFromStorage();
    return u?.name || u?.displayName || u?.email || undefined;
  }, []);

  const reports = useMemo(
    () => REPORT_TYPES.filter((r) => !role || r.roles.includes(role)),
    [role],
  );

  const [cards, setCards] = useState<Partial<Record<ReportTypeId, CardState>>>({});
  const [preview, setPreview] = useState<{ meta: ReportTypeMeta; payload: ReportPayload } | null>(null);
  const [bulk, setBulk] = useState<BulkState | null>(null);

  const cache = useRef(new Map<string, { at: number; payload: ReportPayload }>());
  const inflight = useRef(new Map<string, Promise<ReportPayload>>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // A new period invalidates per-card messages (they described the old period).
  useEffect(() => {
    setCards({});
    setBulk((b) => (b?.running ? b : null));
  }, [from, to]);

  const setCard = useCallback((id: ReportTypeId, state: CardState) => {
    if (!mounted.current) return;
    setCards((prev) => ({ ...prev, [id]: state }));
  }, []);

  const loadReport = useCallback(async (id: ReportTypeId, f: string, t: string): Promise<ReportPayload> => {
    const key = cacheKey(id, f, t);
    const hit = cache.current.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.payload;
    const pending = inflight.current.get(key);
    if (pending) return pending;
    const p = fetchReport(id, f, t)
      .then((payload) => { cache.current.set(key, { at: Date.now(), payload }); return payload; })
      .finally(() => { inflight.current.delete(key); });
    inflight.current.set(key, p);
    return p;
  }, []);

  const tableFor = useCallback((payload: ReportPayload, f: string, t: string): ReportTable =>
    toReportTable(payload, { periodLabel: formatRangeLabel(f, t), generatedBy }), [generatedBy]);

  const downloadOne = useCallback(async (meta: ReportTypeMeta, payload: ReportPayload, kind: 'xlsx' | 'csv', f: string, t: string) => {
    const table = tableFor(payload, f, t);
    const name = reportFileName(meta.title, f, t);
    if (kind === 'xlsx') await downloadReportXlsx(table, name);
    else await downloadReportCsv(table, name);
  }, [tableFor]);

  const handleAction = useCallback(async (meta: ReportTypeMeta, action: CardAction) => {
    const f = from; const t = to;
    setCard(meta.id, { busy: action });
    try {
      const payload = await loadReport(meta.id, f, t);
      if (!mounted.current) return;
      if (action === 'preview') {
        setPreview({ meta, payload });
        setCard(meta.id, {});
        return;
      }
      await downloadOne(meta, payload, action, f, t);
      const n = payload.rows.length;
      setCard(meta.id, {
        notice: n
          ? `${action === 'xlsx' ? 'Excel' : 'CSV'} downloaded · ${n.toLocaleString('en-IN')} row${n === 1 ? '' : 's'}`
          : 'No records in this period — downloaded an empty report.',
      });
    } catch (err) {
      setCard(meta.id, { error: getApiErrorMessage(err, `Could not load or download "${meta.title}". Please try again.`) });
    }
  }, [from, to, loadReport, downloadOne, setCard]);

  const handlePreviewDownload = useCallback((meta: ReportTypeMeta, kind: 'xlsx' | 'csv') => {
    void handleAction(meta, kind);
  }, [handleAction]);

  const closePreview = useCallback(() => setPreview(null), []);

  // ── Download all (one workbook) ───────────────────────────────────────────
  const handleDownloadAll = useCallback(async () => {
    const f = from; const t = to;
    const list = reports;
    const results: Array<{ meta: ReportTypeMeta; payload?: ReportPayload; error?: string }> = list.map((meta) => ({ meta }));
    let next = 0;
    let done = 0;
    setBulk({ running: true, done: 0, total: list.length, failures: [] });

    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        const meta = list[i];
        try {
          results[i] = { meta, payload: await loadReport(meta.id, f, t) };
        } catch (err) {
          results[i] = { meta, error: getApiErrorMessage(err, 'Could not be generated.') };
        }
        done += 1;
        if (mounted.current) setBulk((b) => (b ? { ...b, done } : b));
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, list.length) }, worker));
      const ok = results.filter((r): r is { meta: ReportTypeMeta; payload: ReportPayload } => !!r.payload);
      const failures: BulkFailure[] = results.filter((r) => !r.payload).map((r) => ({ title: r.meta.title, message: r.error || 'Unknown error' }));

      if (!ok.length) {
        if (mounted.current) setBulk({ running: false, done, total: list.length, failures, included: 0, error: 'None of the reports could be generated, so nothing was downloaded.' });
        return;
      }

      const overviewRows = results.map((r) => {
        if (!r.payload) {
          return { report: r.meta.title, category: r.meta.category, rows: null, headline: null, headlineOf: '', summary: '', status: `FAILED — ${r.error || 'Unknown error'}` };
        }
        const col = primaryValueColumn(r.payload);
        return {
          report: r.meta.title,
          category: r.meta.category,
          rows: r.payload.rows.length,
          headline: col ? sumColumn(r.payload, col.key) : null,
          headlineOf: col?.label || '',
          summary: r.payload.summary.map((s) => `${s.label}: ${formatCellValue(s.value, typeof s.value === 'number' && s.type === 'text' ? 'number' : s.type)}`).join(' · '),
          status: 'Included',
        };
      });

      const overview: ReportTable = {
        title: 'Re-Guard Reports — Overview',
        sheetName: 'Summary',
        periodLabel: formatRangeLabel(f, t),
        generatedBy,
        columns: [
          { key: 'report', label: 'Report', type: 'text', width: 30 },
          { key: 'category', label: 'Category', type: 'text', width: 12 },
          { key: 'rows', label: 'Rows', type: 'number', total: false },
          { key: 'headline', label: 'Total value', type: 'currency', total: false, width: 16 },
          { key: 'headlineOf', label: 'Total of column', type: 'text', width: 22 },
          { key: 'summary', label: 'Summary', type: 'text', width: 60 },
          { key: 'status', label: 'Status', type: 'text', width: 24 },
        ],
        rows: overviewRows,
        summary: [
          { label: 'Reports included', value: `${ok.length} of ${list.length}` },
          ...(failures.length ? [{ label: 'Reports failed', value: failures.length }] : []),
        ],
        totals: false,
      };

      await downloadWorkbookXlsx(ok.map((r) => tableFor(r.payload, f, t)), reportFileName('All Reports', f, t), overview);
      if (mounted.current) setBulk({ running: false, done, total: list.length, failures, included: ok.length });
    } catch (err) {
      if (mounted.current) {
        setBulk({ running: false, done, total: list.length, failures: [], error: getApiErrorMessage(err, 'Could not build the workbook. Please try again.') });
      }
    }
  }, [from, to, reports, loadReport, tableFor, generatedBy]);

  const pct = bulk && bulk.total ? Math.round((bulk.done / bulk.total) * 100) : 0;

  return (
    <section aria-labelledby="report-center-title" className="space-y-5">
      {/* Header */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 id="report-center-title" className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <FileSpreadsheet className="h-5 w-5 text-indigo-600" aria-hidden="true" />
              Report Center
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Download any report for <span className="font-semibold text-slate-700">{periodLabel}</span> (IST) as Excel or CSV,
              or get everything in one workbook.
            </p>
          </div>
          <button
            type="button"
            onClick={handleDownloadAll}
            disabled={!!bulk?.running || reports.length === 0}
            className="inline-flex min-h-[44px] w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
          >
            {bulk?.running
              ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              : <Download className="h-4 w-4" aria-hidden="true" />}
            {bulk?.running ? 'Preparing workbook…' : 'Download all (one workbook)'}
          </button>
        </div>

        {/* Bulk progress / result */}
        <div aria-live="polite" className="empty:hidden">
          {bulk?.running && (
            <div className="mt-4">
              <div className="mb-1 flex justify-between text-xs font-medium text-slate-600">
                <span>Fetching reports… {bulk.done} of {bulk.total}</span>
                <span className="tabular-nums">{pct}%</span>
              </div>
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
                role="progressbar"
                aria-label="Download all progress"
                aria-valuemin={0}
                aria-valuemax={bulk.total}
                aria-valuenow={bulk.done}
              >
                <div className="h-full rounded-full bg-indigo-600 transition-all duration-300" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
          {bulk && !bulk.running && bulk.error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
              <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" aria-hidden="true" />{bulk.error}</p>
              {bulk.failures.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-6 text-xs">
                  {bulk.failures.map((f) => <li key={f.title}><span className="font-semibold">{f.title}:</span> {f.message}</li>)}
                </ul>
              )}
            </div>
          )}
          {bulk && !bulk.running && !bulk.error && (
            <div className={`mt-4 rounded-xl border p-3 text-sm ${bulk.failures.length ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
              <p className="flex items-center gap-2 font-semibold">
                {bulk.failures.length
                  ? <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                  : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                Workbook downloaded with {bulk.included} of {bulk.total} reports.
              </p>
              {bulk.failures.length > 0 && (
                <>
                  <p className="mt-1 text-xs">These reports could not be generated and were left out (listed on the Summary sheet). You can retry them individually below:</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-6 text-xs">
                    {bulk.failures.map((f) => <li key={f.title}><span className="font-semibold">{f.title}:</span> {f.message}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Cards grouped by category */}
      {REPORT_CATEGORIES.map((cat) => {
        const items = reports.filter((r) => r.category === cat);
        if (!items.length) return null;
        const headingId = `report-cat-${cat.toLowerCase()}`;
        return (
          <div key={cat} role="group" aria-labelledby={headingId}>
            <h3 id={headingId} className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">{cat}</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((meta) => (
                <ReportCard
                  key={meta.id}
                  meta={meta}
                  state={cards[meta.id] || {}}
                  disabled={!!bulk?.running}
                  onAction={handleAction}
                />
              ))}
            </div>
          </div>
        );
      })}

      {preview && (
        <ReportPreviewModal
          meta={preview.meta}
          payload={preview.payload}
          periodLabel={formatRangeLabel(preview.payload.from, preview.payload.to)}
          busy={cards[preview.meta.id]?.busy}
          onDownload={handlePreviewDownload}
          onClose={closePreview}
        />
      )}
    </section>
  );
};

export default ReportCenter;

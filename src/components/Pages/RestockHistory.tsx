import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, query, orderBy, getDocs, where, limit } from 'firebase/firestore';
import { toast } from 'react-toastify';
import { db } from '../../Interfaces/firebase';
import { RestockRecord, fetchRestockReport } from '../../Interfaces/api';
import { getApiErrorMessage, getApiErrorStatus } from '../../Interfaces/http';
import { DateRangeFilter, DateRangeValue, defaultDateRange } from '../common/DateRangeFilter';
import {
  downloadReportCsv, downloadReportXlsx, reportFileName,
  type ColumnType, type ReportColumn, type ReportTable,
} from '../../utils/excel';
import { formatRangeLabel, istRangeToDates } from '../../utils/dates';
import { getUserFromStorage } from '../../Interfaces/types';
import {
  RefreshCw, Search, Package, Calendar,
  ChevronLeft, ChevronRight, Tag, User, Hash, Image as ImageIcon, AlertCircle,
  Download, FileSpreadsheet, FileText,
} from 'lucide-react';

/** Hard cap for the on-screen list / client-side fallback report. */
const MAX_RECORDS = 5000;

const REPORT_COLUMNS: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'datetime' },
  { key: 'ran', label: 'RAN', type: 'text' },
  { key: 'orderNo', label: 'Order no.', type: 'text' },
  { key: 'product', label: 'Product', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'quantity', label: 'Quantity', type: 'number', total: true },
  { key: 'condition', label: 'Condition', type: 'text' },
  { key: 'status', label: 'Status', type: 'text' },
  { key: 'restockedBy', label: 'Restocked by', type: 'text' },
];

const KNOWN_TYPES: ColumnType[] = ['text', 'number', 'currency', 'date', 'datetime', 'percent'];
const toColumnType = (t?: string): ColumnType => (KNOWN_TYPES.includes(t as ColumnType) ? (t as ColumnType) : 'text');

const toDate = (value: any): Date | null => {
  if (!value) return null;
  try {
    const d = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
};

/** One report row per restocked item (client-side fallback). */
const recordsToRows = (records: RestockRecord[]): Array<Record<string, unknown>> =>
  records.flatMap((record) => {
    const items = Array.isArray(record.items) && record.items.length > 0 ? record.items : [null];
    return items.map((item) => ({
      date: toDate(record.restockedAt),
      ran: record.RAN || '',
      orderNo: record.orderName || record.orderId || '',
      product: item?.title || '',
      sku: item?.sku || '',
      quantity: item ? Number(item.quantityReturned) || 0 : Number(record.totalQuantityRestocked) || 0,
      condition: item?.condition || record.condition || '',
      status: record.status ? record.status.charAt(0).toUpperCase() + record.status.slice(1) : '',
      restockedBy: record.restockedBy || '',
    }));
  });

const fetchRecordsInRange = async (from: string, to: string): Promise<RestockRecord[]> => {
  const { start, end } = istRangeToDates(from, to);
  const q = query(
    collection(db, 'restock_history'),
    where('restockedAt', '>=', start),
    where('restockedAt', '<', end),
    orderBy('restockedAt', 'desc'),
    limit(MAX_RECORDS)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ ...(d.data() as RestockRecord), id: d.id }));
};

export const RestockHistory = () => {
  const [range, setRange] = useState<DateRangeValue>(() => defaultDateRange('last30'));
  const [history, setHistory] = useState<RestockRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [conditionFilter, setConditionFilter] = useState('All');

  // Report download
  const [generating, setGenerating] = useState<'xlsx' | 'csv' | null>(null);
  const [lastReport, setLastReport] = useState<{ rows: number; label: string } | null>(null);
  const [reportMessage, setReportMessage] = useState('');

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  /** Sequence guard: only the latest request (range change / refresh) may update the list. */
  const fetchSeqRef = useRef(0);

  const fetchHistory = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const records = await fetchRecordsInRange(range.from, range.to);
      if (seq !== fetchSeqRef.current) return;
      setHistory(records);
    } catch (error) {
      if (seq !== fetchSeqRef.current) return;
      setHistory([]);
      setLoadError(`Failed to load restock history: ${getApiErrorMessage(error)}`);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    void fetchHistory();
    // Unmount / range change: invalidate any in-flight request.
    return () => { fetchSeqRef.current += 1; };
  }, [fetchHistory]);

  useEffect(() => {
    setLastReport(null);
    setReportMessage('');
  }, [range.from, range.to]);

  const filteredHistory = useMemo(() => {
    const searchLower = searchTerm.trim().toLowerCase();
    return history.filter((record) => {
      const matchesSearch = !searchLower ||
        record.RAN?.toLowerCase().includes(searchLower) ||
        String(record.orderName || record.orderId || '').toLowerCase().includes(searchLower) ||
        (record.items || []).some((item) =>
          item.sku?.toLowerCase().includes(searchLower) ||
          item.title?.toLowerCase().includes(searchLower)
        );
      const matchesCondition = conditionFilter === 'All' || record.condition === conditionFilter;
      return matchesSearch && matchesCondition;
    });
  }, [history, searchTerm, conditionFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredHistory.length / itemsPerPage));
  const currentData = useMemo(
    () => filteredHistory.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage),
    [filteredHistory, currentPage]
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, conditionFilter, range.from, range.to]);

  const formatDate = (date: any) => {
    const d = toDate(date);
    if (!d) return { date: 'N/A', time: '' };
    return {
      date: d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' }),
      time: d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
    };
  };

  const getConditionColor = (condition: string) => {
    switch (condition?.toLowerCase()) {
      case 'fresh': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      case 'seconds': return 'bg-amber-50 text-amber-700 border-amber-200';
      case 'defect / damaged item': return 'bg-red-50 text-red-700 border-red-200';
      default: return 'bg-slate-50 text-slate-700 border-slate-200';
    }
  };

  /** Server report first (§5); on 404 build the same report from restock_history. */
  const buildReport = async (): Promise<ReportTable> => {
    const periodLabel = `${formatRangeLabel(range.from, range.to)} (IST)`;
    const me = getUserFromStorage();
    try {
      const report = await fetchRestockReport(range.from, range.to);
      return {
        title: report.title || 'Restock Report',
        sheetName: 'Restocks',
        periodLabel,
        generatedBy: report.generatedBy || me?.name,
        columns: (report.columns || []).map((c) => ({
          key: c.key,
          label: c.label,
          type: toColumnType(c.type),
          ...(c.type === 'number' && /qty|quantity/i.test(`${c.key} ${c.label}`) ? { total: true } : {}),
        })),
        rows: Array.isArray(report.rows) ? report.rows : [],
        summary: (report.summary || []).map((sItem) => ({ label: sItem.label, value: sItem.value, type: toColumnType(sItem.type) })),
      };
    } catch (error) {
      if (getApiErrorStatus(error) !== 404) throw error;
      const records = await fetchRecordsInRange(range.from, range.to);
      const rows = recordsToRows(records);
      return {
        title: 'Restock Report',
        sheetName: 'Restocks',
        periodLabel,
        generatedBy: me?.name,
        columns: REPORT_COLUMNS,
        rows,
        summary: [
          { label: 'Restock records', value: records.length, type: 'number' },
          { label: 'Units', value: rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0), type: 'number' },
        ],
      };
    }
  };

  const handleDownload = async (format: 'xlsx' | 'csv') => {
    if (generating) return;
    setGenerating(format);
    setReportMessage('');
    try {
      const report = await buildReport();
      const label = formatRangeLabel(range.from, range.to);
      if (report.rows.length === 0) {
        setLastReport({ rows: 0, label });
        setReportMessage('No restocks in this period.');
        toast.info('No restocks in this period — nothing to download.');
        return;
      }
      const filename = reportFileName('Restocks', range.from, range.to);
      if (format === 'xlsx') await downloadReportXlsx(report, filename);
      else await downloadReportCsv(report, filename);
      setLastReport({ rows: report.rows.length, label });
    } catch (error) {
      const msg = `Could not generate the report: ${getApiErrorMessage(error)}`;
      setReportMessage(msg);
      toast.error(msg);
    } finally {
      setGenerating(null);
    }
  };

  const rangeLabel = formatRangeLabel(range.from, range.to);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Restock History</h1>
          <p className="text-sm text-slate-500 mt-1">Detailed log of items returned to Shopify inventory</p>
        </div>
        <button
          type="button"
          onClick={() => void fetchHistory()}
          disabled={loading}
          className="self-start sm:self-auto min-h-[40px] inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-indigo-600' : 'text-slate-500'}`} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {/* Period + report download */}
      <section aria-labelledby="restock-report-heading" className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm mb-6">
        <div className="flex flex-col lg:flex-row lg:items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2 id="restock-report-heading" className="text-sm font-semibold text-slate-800 mb-3 flex items-center gap-2">
              <Download className="w-4 h-4 text-indigo-600" aria-hidden="true" />
              Period & download report
            </h2>
            <DateRangeFilter value={range} onChange={setRange} compact />
          </div>
          <div className="lg:w-64 shrink-0 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void handleDownload('xlsx')}
                disabled={!!generating}
                className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {generating === 'xlsx'
                  ? <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
                  : <FileSpreadsheet className="w-4 h-4" aria-hidden="true" />}
                Excel
              </button>
              <button
                type="button"
                onClick={() => void handleDownload('csv')}
                disabled={!!generating}
                className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {generating === 'csv'
                  ? <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
                  : <FileText className="w-4 h-4" aria-hidden="true" />}
                CSV
              </button>
            </div>
            <p className="text-xs text-slate-500" aria-live="polite">
              {generating
                ? 'Generating report…'
                : lastReport
                  ? lastReport.rows > 0
                    ? `Downloaded ${lastReport.rows} row${lastReport.rows === 1 ? '' : 's'} (${lastReport.label}).`
                    : 'No restocks in this period.'
                  : loading
                    ? 'Counting restocks…'
                    : history.length > 0
                      ? `${history.length} restock record${history.length === 1 ? '' : 's'} in this period.`
                      : 'No restocks in this period.'}
            </p>
            {reportMessage && reportMessage !== 'No restocks in this period.' && (
              <p role="alert" className="text-xs text-red-600">{reportMessage}</p>
            )}
          </div>
        </div>
      </section>

      {/* Filters */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm mb-6 flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <label htmlFor="restock-search" className="sr-only">Search restocks</label>
          <input
            id="restock-search"
            type="text"
            placeholder="Search RAN, Order, Product Title or SKU..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full min-h-[44px] pl-10 pr-4 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-shadow text-sm"
          />
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
        </div>

        <div className="relative w-full md:w-52 shrink-0">
          <label htmlFor="restock-condition" className="sr-only">Condition</label>
          <select
            id="restock-condition"
            value={conditionFilter}
            onChange={(e) => setConditionFilter(e.target.value)}
            className="w-full min-h-[44px] pl-10 pr-4 py-2 border border-slate-200 rounded-lg appearance-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 bg-white text-sm"
          >
            <option value="All">All Conditions</option>
            <option value="Fresh">Fresh</option>
            <option value="Seconds">Seconds</option>
            <option value="Defect / Damaged Item">Defect / Damaged</option>
            <option value="Mixed">Mixed</option>
          </select>
          <Tag className="w-4 h-4 text-indigo-500 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
        </div>

        {(searchTerm || conditionFilter !== 'All') && (
          <button
            type="button"
            onClick={() => { setSearchTerm(''); setConditionFilter('All'); }}
            className="min-h-[44px] px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            Clear
          </button>
        )}
      </div>

      {loadError && (
        <div role="alert" className="mb-4 p-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">{loadError}</div>
      )}
      {!loading && history.length >= MAX_RECORDS && (
        <div className="mb-4 p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-800">
          Showing the newest {MAX_RECORDS} records of this period — choose a shorter period to see older ones.
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        {loading ? (
          <div className="flex justify-center items-center py-16" role="status">
            <RefreshCw className="w-8 h-8 text-indigo-600 animate-spin" aria-hidden="true" />
            <span className="sr-only">Loading restock history</span>
          </div>
        ) : currentData.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <Package className="w-8 h-8 text-slate-300 mx-auto mb-3" aria-hidden="true" />
            <p className="text-slate-500 font-medium">
              {history.length === 0 ? 'No restocks in this period' : 'No restock records match your filters'}
            </p>
            <p className="text-sm text-slate-400 mt-1">{rangeLabel} (IST)</p>
          </div>
        ) : (
          <>
            {/* Mobile cards */}
            <ul className="md:hidden divide-y divide-slate-100">
              {currentData.map((record) => {
                const d = formatDate(record.restockedAt);
                return (
                  <li key={record.id} className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-bold text-slate-900 break-all">{record.RAN}</p>
                        <p className="text-xs text-slate-500">Order: {record.orderName || record.orderId}</p>
                      </div>
                      <StatusBadge status={record.status} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <span className="inline-flex items-center gap-1"><Calendar className="w-3.5 h-3.5" aria-hidden="true" />{d.date} {d.time}</span>
                      <span className="inline-flex items-center gap-1 text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded"><User className="w-3 h-3" aria-hidden="true" />{record.restockedBy || 'System'}</span>
                      <span className={`px-2 py-0.5 rounded-md font-semibold border ${getConditionColor(record.condition || '')}`}>{record.condition || 'Not Specified'}</span>
                    </div>
                    <ItemsList record={record} />
                    {record.status === 'failed' && record.errorMessage && (
                      <p className="text-xs text-red-600 flex items-start gap-1"><AlertCircle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />{record.errorMessage}</p>
                    )}
                  </li>
                );
              })}
            </ul>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th scope="col" className="px-6 py-4 font-semibold text-slate-700">Date & Agent</th>
                    <th scope="col" className="px-6 py-4 font-semibold text-slate-700">Order Info</th>
                    <th scope="col" className="px-6 py-4 font-semibold text-slate-700 w-2/5">Products Restocked</th>
                    <th scope="col" className="px-6 py-4 font-semibold text-slate-700">Condition</th>
                    <th scope="col" className="px-6 py-4 font-semibold text-slate-700">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {currentData.map((record) => {
                    const d = formatDate(record.restockedAt);
                    return (
                      <tr key={record.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap align-top">
                          <div className="flex items-center gap-2 mb-1.5">
                            <Calendar className="w-4 h-4 text-slate-400" aria-hidden="true" />
                            <span className="font-medium text-slate-700">{d.date}</span>
                          </div>
                          {d.time && <div className="text-xs text-slate-500 pl-6 mb-2">{d.time}</div>}
                          <div className="flex items-center gap-1.5 text-xs text-indigo-600 bg-indigo-50 px-2 py-1 rounded w-fit">
                            <User className="w-3 h-3" aria-hidden="true" />
                            <span className="font-medium">{record.restockedBy || 'System'}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 align-top">
                          <div className="flex items-center gap-1.5 mb-1">
                            <Hash className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                            <span className="font-bold text-slate-900">{record.RAN}</span>
                          </div>
                          <div className="text-xs text-slate-500 font-medium pl-5">Order: {record.orderName || record.orderId}</div>
                          <div className="mt-3 inline-flex items-center gap-1.5 bg-slate-100 px-2 py-1 rounded-md text-xs font-medium text-slate-600">
                            <Package className="w-3.5 h-3.5" aria-hidden="true" />
                            Total: {record.totalQuantityRestocked} units
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <ItemsList record={record} />
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap align-top">
                          <span className={`px-2.5 py-1 rounded-md text-xs font-semibold border ${getConditionColor(record.condition || '')}`}>
                            {record.condition || 'Not Specified'}
                          </span>
                        </td>
                        <td className="px-6 py-4 align-top">
                          <StatusBadge status={record.status} />
                          {record.status === 'failed' && record.errorMessage && (
                            <div className="flex items-start gap-1 mt-1.5 max-w-[220px]" title={record.errorMessage}>
                              <AlertCircle className="w-3 h-3 text-red-500 shrink-0 mt-0.5" aria-hidden="true" />
                              <p className="text-[10px] text-red-600 line-clamp-2 leading-snug">{record.errorMessage}</p>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {!loading && totalPages > 1 && (
          <div className="bg-slate-50 border-t border-slate-200 px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-sm text-slate-500 font-medium">
              Showing <span className="text-slate-900 font-semibold">{(currentPage - 1) * itemsPerPage + 1}</span> to <span className="text-slate-900 font-semibold">{Math.min(currentPage * itemsPerPage, filteredHistory.length)}</span> of <span className="text-slate-900 font-semibold">{filteredHistory.length}</span> results
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                aria-label="Previous page"
                className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" aria-hidden="true" />
              </button>
              <span className="text-sm text-slate-600 tabular-nums">{currentPage} / {totalPages}</span>
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                aria-label="Next page"
                className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const StatusBadge = ({ status }: { status?: string }) => (
  <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap ${
    status === 'success' ? 'bg-emerald-100 text-emerald-700' :
    status === 'failed' ? 'bg-red-100 text-red-700' :
    'bg-amber-100 text-amber-700'
  }`}>
    {status === 'success' ? '✓ ' : ''}
    {status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown'}
  </span>
);

const ItemsList = ({ record }: { record: RestockRecord }) => (
  <div className="space-y-2">
    {(record.items || []).map((item, idx) => {
      const hasCustomerImage = Array.isArray(item.customerImages) && item.customerImages.length > 0;
      const imageToDisplay = hasCustomerImage ? item.customerImages![0] : item.productImage;
      return (
        <div key={`${item.lineItemId}-${idx}`} className="flex items-start gap-3 p-2 bg-white border border-slate-100 rounded-lg shadow-sm">
          <div className="relative w-12 h-12 rounded overflow-hidden bg-slate-100 shrink-0 border border-slate-200 flex items-center justify-center group">
            {imageToDisplay ? (
              <>
                <img src={imageToDisplay} alt={item.title || 'Product'} loading="lazy" className="w-full h-full object-cover" />
                {hasCustomerImage && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" title="Customer Uploaded Image">
                    <ImageIcon className="w-4 h-4 text-white" aria-hidden="true" />
                  </div>
                )}
              </>
            ) : (
              <Package className="w-5 h-5 text-slate-300" aria-hidden="true" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-800 line-clamp-2 leading-snug break-words">{item.title || 'Unknown Product'}</p>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <span className="text-[11px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded break-all">{item.sku || 'No SKU'}</span>
              <span className="text-[11px] font-bold text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded">Qty: {item.quantityReturned}</span>
              {item.condition && <span className="text-[11px] text-slate-500">{item.condition}</span>}
            </div>
          </div>
        </div>
      );
    })}
  </div>
);

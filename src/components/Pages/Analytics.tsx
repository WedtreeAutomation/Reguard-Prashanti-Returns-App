import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  RefreshCw, Package, AlertCircle,
  ArrowUpRight, ArrowDownRight,
  DollarSign, Clock, Users, XCircle,
  TrendingUp, CreditCard, Gift, Wallet, BarChart2,
  ShieldAlert, Layers, AlertTriangle, Repeat,
  ArrowRightLeft, Receipt, Scale, Hourglass, Tag,
  LayoutDashboard, FileSpreadsheet, ArrowRight,
} from 'lucide-react';
import {
  collection, getDocs, query, orderBy, where, limit, Timestamp,
} from 'firebase/firestore';
import { db } from '../../Interfaces/firebase';
import type {
  ResolutionData, ReasonData, CustomerReturnData, StateReturnData, User,
} from '../../Interfaces/types';
import { canAccessAnalytics } from '../../Interfaces/permissions';
import { DateRangeFilter, defaultDateRange, type DateRangeValue } from '../common/DateRangeFilter';
import { formatRangeLabel, istRangeToDates } from '../../utils/dates';
import { ReportCenter } from '../Reports/ReportCenter';
import {
  addDaysYmd, firestoreErrorMessage, istYmd, mondayOf, tsToDate, ymdLabel,
} from '../Reports/istDates';

// ─── Chart palette ─────────────────────────────────────────────────────────────
// Single place to retune chart / bar colours. Brand first, then supporting
// accents and neutrals. (Tailwind accents elsewhere use `indigo-*`, which the
// theme remaps to the brand scale.)
const CHART_PALETTE = ['#560835', '#a8557a', '#d97706', '#0f766e', '#475569', '#94a3b8'] as const;
const CHART_UI = { grid: '#f1f5f9', axis: '#94a3b8', tooltipBorder: '#e2e8f0' } as const;
const SERIES_COLOR = { requests: CHART_PALETTE[0], exchanges: CHART_PALETTE[2] } as const;

/** Safety cap for one dashboard query (a bounded range should never get close). */
const MAX_DOCS = 5000;

// ─── Firestore document shape (only the fields this page reads) ───────────────
type Num = number | string | null | undefined;

interface ReturnItemDoc {
  lineItemId?: string | number;
  title?: string;
  sku?: string;
  price?: Num;
  quantityReturned?: Num;
  reason?: string;
  note?: string;
  productImage?: string;
  actionType?: string;
}

interface ReturnDoc {
  id: string;
  RAN?: string;
  orderId?: string;
  status?: string;
  refundStatus?: string;
  refundMethod?: string;
  requestedMethod?: string;
  actionType?: string;
  financialOutcome?: string;
  refundAmount?: Num;
  refundDetails?: { finalAmount?: Num; method?: string };
  outstandingBalance?: Num;
  netRefundAmount?: Num;
  invoiceSent?: boolean;
  awaitingCustomerPayment?: boolean;
  unappliableAdjustment?: Num;
  discountPercentage?: Num;
  discountAppliedViaOrderEdit?: boolean;
  totalQuantityRestocked?: Num;
  restockStatus?: string;
  isRestocked?: boolean;
  createdAt?: unknown;
  completedAt?: unknown;
  refundedAt?: unknown;
  customer?: { name?: string; email?: string; phone?: string; state?: string; city?: string };
  pickupAddress?: { state?: string };
  items?: ReturnItemDoc[];
}

// ─── Status constants ──────────────────────────────────────────────────────────
const COMPLETED_STATUSES = new Set(['completed', 'Completed', 'Approved']);
const REJECTED_STATUSES = new Set(['Denied', 'denied', 'Closed', 'closed', 'Cancelled', 'cancelled']);
const EXCLUDE_FROM_PENDING = new Set(['Cancelled', 'cancelled', 'Pickup Cancelled']);
const DEFECTIVE_REASONS = new Set([
  'I received a defective item',
  'received a defective item',
  'Defective Item',
]);

const EXCHANGE_ACTION_TYPES = new Set(['exchange', 'mixed']);
const isExchangeDoc = (r: ReturnDoc): boolean => EXCHANGE_ACTION_TYPES.has((r.actionType || '').toLowerCase());

// ─── Helpers ───────────────────────────────────────────────────────────────────
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return isFinite(n) ? n : 0;
};
const priceOf = (i: ReturnItemDoc): number => num(i.price);
const qtyOf = (i: ReturnItemDoc): number => num(i.quantityReturned) || 1;

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n).replace('₹', '₹ ');

const formatNumber = (n: number) => new Intl.NumberFormat('en-IN').format(n);
const pct = (v: number, t: number) => (t === 0 ? 0 : (v / t) * 100);

const toDate = tsToDate;

/** Amount actually settled for a request (falls back to item value once refunded). */
const getAmt = (r: ReturnDoc): number => {
  const a = num(r.refundAmount);
  if (a > 0) return a;
  const b = num(r.refundDetails?.finalAmount);
  if (b > 0) return b;
  if (r.refundStatus === 'Refunded' && r.items?.length) {
    const itemTotal = r.items.reduce((s, i) => s + priceOf(i) * qtyOf(i), 0);
    if (itemTotal > 0) return itemTotal;
  }
  return 0;
};

const getExchangeSettlementValue = (r: ReturnDoc): number => {
  if (r.financialOutcome === 'refund') return getAmt(r);
  if (r.financialOutcome === 'extra') return num(r.outstandingBalance ?? r.netRefundAmount);
  return 0;
};

const wasSettledByARefundMethod = (r: ReturnDoc): boolean => !isExchangeDoc(r) || r.financialOutcome === 'refund';

const getRestockStatusLabel = (r: ReturnDoc): string => {
  if (r.restockStatus) return r.restockStatus;
  if (r.isRestocked === true) return 'Completed';
  if (r.isRestocked === false) return 'Skipped';
  return 'Unknown';
};

const REASON_MAP: Record<string, string> = {
  'I received a defective item': 'Defective Item',
  'Wrong item shipped': 'Wrong Item',
  'Color mismatch': 'Color Mismatch',
  'Product quality issue': 'Quality Issue',
  'Delivery was delayed': 'Delivery Delay',
  'Other reason': 'Other',
  'product quality reason': 'Quality Issue',
  'color mismatch': 'Color Mismatch',
  'other reason': 'Other',
  'received a defective item': 'Defective Item',
  'wrong item shipped': 'Wrong Item',
  'delivery was delayed': 'Delivery Delay',
};
const getReasonLabel = (r: string) => REASON_MAP[r] ?? r;

type Granularity = 'daily' | 'weekly';
type TrendView = 'all' | 'returns' | 'exchanges';
interface TrendPoint { label: string; returns: number; value: number }

/** Bucket requests per IST day / week over the whole selected range (empty buckets included). */
const buildTrend = (docs: ReturnDoc[], from: string, to: string, granularity: Granularity, valueFn: (r: ReturnDoc) => number): TrendPoint[] => {
  const keys: string[] = [];
  if (granularity === 'weekly') {
    for (let k = mondayOf(from); k <= to; k = addDaysYmd(k, 7)) keys.push(k);
  } else {
    for (let k = from; k <= to; k = addDaysYmd(k, 1)) keys.push(k);
  }
  const map = new Map<string, TrendPoint>(keys.map((k) => [k, { label: ymdLabel(k), returns: 0, value: 0 }]));
  docs.forEach((r) => {
    const d = toDate(r.createdAt);
    if (!d) return;
    const day = istYmd(d);
    const key = granularity === 'weekly' ? mondayOf(day) : day;
    const point = map.get(key);
    if (!point) return;
    point.returns += 1;
    point.value += valueFn(r);
  });
  const points = keys.map((k) => map.get(k) as TrendPoint);
  // Long ranges (e.g. "All time"): skip the empty stretch before the first request.
  if (keys.length > 60) {
    const first = points.findIndex((p) => p.returns > 0);
    if (first > 0) return points.slice(first);
  }
  return points;
};

// Settlement value shown in the chart tooltip.
const trendValueFn = (r: ReturnDoc) => (isExchangeDoc(r) && r.financialOutcome === 'extra' ? getExchangeSettlementValue(r) : getAmt(r));

// ─── Metric Card ───────────────────────────────────────────────────────────────
type CardColor = 'blue' | 'purple' | 'orange' | 'emerald' | 'pink' | 'indigo' | 'amber' | 'red' | 'cyan' | 'teal';

const GRAD: Record<CardColor, string> = {
  blue: 'from-blue-500 to-blue-600',
  purple: 'from-purple-500 to-purple-600',
  orange: 'from-orange-500 to-pink-500',
  emerald: 'from-emerald-500 to-green-500',
  pink: 'from-pink-500 to-rose-500',
  indigo: 'from-indigo-500 to-purple-500',
  amber: 'from-amber-500 to-orange-500',
  red: 'from-red-500 to-rose-600',
  // Decorative icon tiles stay on the brand palette (plum/purple); cyan/teal only remain as names.
  cyan: 'from-fuchsia-500 to-purple-600',
  teal: 'from-emerald-500 to-green-600',
};

interface MetricCardProps {
  title: string;
  value: string | number;
  trend?: 'up' | 'down';
  trendValue?: string;
  icon: React.ReactNode;
  color?: CardColor;
  highlight?: boolean;
  badge?: { label: string; variant: 'warn' | 'ok' | 'info' };
}

const MetricCard = ({ title, value, trend, trendValue, icon, color = 'blue', highlight = false, badge }: MetricCardProps) => {
  const badgeCls =
    badge?.variant === 'warn' ? 'bg-amber-100 text-amber-700'
      : badge?.variant === 'info' ? 'bg-blue-100 text-blue-700'
        : 'bg-emerald-100 text-emerald-700';

  return (
    <div className={`bg-white rounded-2xl border p-4 sm:p-6 shadow-sm hover:shadow-md transition-all duration-300 relative overflow-hidden group min-w-0
      ${highlight ? 'border-red-200 ring-1 ring-red-100' : 'border-slate-200'}`}>
      <div className={`absolute top-0 right-0 w-32 h-32 bg-gradient-to-br ${GRAD[color]} rounded-full blur-3xl opacity-10 -mr-10 -mt-10 group-hover:opacity-20 transition-opacity`} aria-hidden="true" />
      <div className="relative flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-500 mb-1">{title}</p>
          <p className="text-2xl sm:text-3xl font-bold text-slate-900 truncate tabular-nums" title={String(value)}>{value}</p>
          {trend && trendValue && (
            <div className="flex items-center gap-1 mt-2">
              {trend === 'up'
                ? <ArrowUpRight className="w-4 h-4 text-emerald-500" aria-hidden="true" />
                : <ArrowDownRight className="w-4 h-4 text-red-500" aria-hidden="true" />}
              <span className={`text-xs font-medium ${trend === 'up' ? 'text-emerald-600' : 'text-red-600'}`}>{trendValue}</span>
            </div>
          )}
          {badge && (
            <span className={`inline-block mt-2 text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeCls}`}>{badge.label}</span>
          )}
        </div>
        <div className={`p-3 rounded-xl bg-gradient-to-br ${GRAD[color]} text-white shrink-0 ml-3`} aria-hidden="true">{icon}</div>
      </div>
    </div>
  );
};

// ─── Progress Bar ──────────────────────────────────────────────────────────────
const ProgressBar = ({ label, value, percentage, color }: { label: string; value: number; percentage: number; color: string }) => (
  <div className="space-y-1.5">
    <div className="flex justify-between items-center gap-2 text-sm">
      <span className="text-slate-600 min-w-0 truncate">{label}</span>
      <span className="font-medium text-slate-900 tabular-nums shrink-0">{value} ({percentage.toFixed(1)}%)</span>
    </div>
    <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(percentage, 100)}%`, background: color }} />
    </div>
  </div>
);

// ─── Refund Method Comparison Card ────────────────────────────────────────────
interface MethodRow { label: string; count: number; value: number; color: string; swatch: string; icon: React.ReactNode }

const RefundMethodComparison = ({ title, data, icon, colorScheme, unit = 'requests' }: {
  title: string; data: MethodRow[]; icon: React.ReactNode; colorScheme: string; unit?: string;
}) => {
  const totalCount = data.reduce((s, d) => s + d.count, 0);
  const totalValue = data.reduce((s, d) => s + d.value, 0);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6 min-w-0">
      <div className="flex items-center gap-3 mb-6">
        <div className={`p-2 rounded-xl ${colorScheme}`} aria-hidden="true">{icon}</div>
        <h3 className="text-base font-bold text-slate-900">{title}</h3>
        <span className="ml-auto text-sm text-slate-500 shrink-0">{formatNumber(totalCount)} {unit}</span>
      </div>
      <div className="space-y-4">
        {data.map((item) => {
          const p = pct(item.count, totalCount);
          return (
            <div key={item.label} className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${item.color}`} aria-hidden="true">{item.icon}</div>
                  <span className="text-sm font-medium text-slate-700 truncate">{item.label}</span>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-bold text-slate-900 tabular-nums">
                    {item.count} <span className="font-normal text-slate-400">({p.toFixed(1)}%)</span>
                  </div>
                  <div className="text-xs text-emerald-600 font-semibold tabular-nums">{formatCurrency(item.value)}</div>
                </div>
              </div>
              <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700" style={{ width: `${p}%`, background: item.swatch }} />
              </div>
            </div>
          );
        })}
      </div>
      {totalValue > 0 && (
        <div className="mt-5 pt-4 border-t border-slate-100 flex justify-between items-center">
          <span className="text-sm text-slate-500">Total Value</span>
          <span className="text-base font-bold text-slate-900 tabular-nums">{formatCurrency(totalValue)}</span>
        </div>
      )}
    </div>
  );
};

// ─── Data Table ────────────────────────────────────────────────────────────────
function DataTable<T>({ headers, data, renderRow, emptyMessage = 'No data available', maxHeight = '400px', caption }: {
  headers: string[];
  data: T[];
  renderRow: (item: T, idx: number) => React.ReactNode;
  emptyMessage?: string;
  maxHeight?: string;
  caption?: string;
}) {
  if (!data.length) {
    return (
      <div className="text-center py-12 px-4">
        <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <Package className="w-8 h-8 text-slate-400" aria-hidden="true" />
        </div>
        <p className="text-slate-500 font-medium">{emptyMessage}</p>
        <p className="text-sm text-slate-400 mt-1">Try a wider date range.</p>
      </div>
    );
  }

  return (
    <div style={{ maxHeight }} className="overflow-auto custom-scrollbar">
      <table className="w-full min-w-max">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="sticky top-0 bg-white z-10">
          <tr className="border-b border-slate-200">
            {headers.map((h) => (
              <th key={h} scope="col" className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map((item, idx) => renderRow(item, idx))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Returns Over Time Chart ───────────────────────────────────────────────────
const VIEW_LABEL: Record<TrendView, string> = { all: 'Requests', returns: 'Returns', exchanges: 'Exchanges' };

const SegButton = ({ active, onClick, children, label }: { active: boolean; onClick: () => void; children: React.ReactNode; label: string }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    aria-label={label}
    className={`min-h-[40px] px-3 text-xs font-semibold rounded-lg transition-all capitalize
      ${active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
  >
    {children}
  </button>
);

const ReturnsOverTimeChart = ({ data, granularity, onGranularityChange, view, onViewChange, periodLabel }: {
  data: TrendPoint[];
  granularity: Granularity;
  onGranularityChange: (g: Granularity) => void;
  view: TrendView;
  onViewChange: (v: TrendView) => void;
  periodLabel: string;
}) => {
  const color = view === 'exchanges' ? SERIES_COLOR.exchanges : SERIES_COLOR.requests;
  const hasData = data.some((d) => d.returns > 0);
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h3 className="text-lg font-bold text-slate-900">{VIEW_LABEL[view]} Over Time</h3>
          <p className="text-sm text-slate-500 mt-0.5">{periodLabel}{view !== 'all' ? ` · ${view} only` : ''}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex bg-slate-100 rounded-xl p-1 gap-1" role="group" aria-label="Request type">
            {(['all', 'returns', 'exchanges'] as const).map((v) => (
              <SegButton key={v} active={view === v} onClick={() => onViewChange(v)} label={`Show ${v === 'all' ? 'all requests' : v}`}>{v}</SegButton>
            ))}
          </div>
          <div className="flex bg-slate-100 rounded-xl p-1 gap-1" role="group" aria-label="Granularity">
            {(['daily', 'weekly'] as const).map((g) => (
              <SegButton key={g} active={granularity === g} onClick={() => onGranularityChange(g)} label={`Group ${g}`}>{g}</SegButton>
            ))}
          </div>
        </div>
      </div>
      {!hasData
        ? <div className="h-52 flex items-center justify-center text-slate-400 text-sm">No {VIEW_LABEL[view].toLowerCase()} in this period</div>
        : (
          <div className="w-full h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="analyticsTrendGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={color} stopOpacity={0.2} />
                    <stop offset="95%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_UI.grid} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: CHART_UI.axis }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
                <YAxis tick={{ fontSize: 11, fill: CHART_UI.axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ borderRadius: 12, border: `1px solid ${CHART_UI.tooltipBorder}`, boxShadow: '0 4px 16px rgba(0,0,0,0.08)', fontSize: 12 }}
                  formatter={(value: number, name: string) =>
                    (name === 'returns' ? [value, VIEW_LABEL[view]] : [formatCurrency(value), 'Settled Value'])}
                />
                <Area type="monotone" dataKey="returns" stroke={color} strokeWidth={2.5}
                  fill="url(#analyticsTrendGrad)" dot={false} activeDot={{ r: 5, fill: color }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
    </div>
  );
};

// ─── Main Analytics Component ──────────────────────────────────────────────────
interface AnalyticsProps {
  currentUser?: User | null;
}

type LoadStatus = 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';
interface DashboardData {
  status: LoadStatus;
  docs: ReturnDoc[];
  error?: string;
  truncated?: boolean;
}

type Tab = 'overview' | 'reports';

export const Analytics = ({ currentUser }: AnalyticsProps) => {
  const allowed = canAccessAnalytics(currentUser?.role);
  const [range, setRange] = useState<DateRangeValue>(() => defaultDateRange('thisMonth'));
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<DashboardData>({ status: 'idle', docs: [] });
  const [chartGranularity, setChartGranularity] = useState<Granularity>('daily');
  const [trendView, setTrendView] = useState<TrendView>('all');

  const { from, to } = range;
  const rangeKey = `${from}|${to}`;
  const periodLabel = formatRangeLabel(from, to);
  const requestSeq = useRef(0);
  const loadedKey = useRef<string | null>(null);

  // ── Firestore fetch (bounded to the selected IST range) ──────────────────
  const load = useCallback(async (f: string, t: string, isRefresh = false) => {
    const seq = ++requestSeq.current;
    loadedKey.current = `${f}|${t}`;
    setData((prev) => ({ ...prev, status: isRefresh && prev.status === 'ready' ? 'refreshing' : 'loading', error: undefined }));
    try {
      const { start, end } = istRangeToDates(f, t);
      const snap = await getDocs(query(
        collection(db, 'returns'),
        where('createdAt', '>=', Timestamp.fromDate(start)),
        where('createdAt', '<', Timestamp.fromDate(end)),
        orderBy('createdAt', 'desc'),
        limit(MAX_DOCS),
      ));
      if (seq !== requestSeq.current) return;
      const docs: ReturnDoc[] = snap.docs.map((d) => ({ ...(d.data() as Omit<ReturnDoc, 'id'>), id: d.id }));
      setData({ status: 'ready', docs, truncated: snap.size >= MAX_DOCS });
    } catch (e) {
      if (seq !== requestSeq.current) return;
      console.error('Analytics: load error', e);
      loadedKey.current = null;
      setData({ status: 'error', docs: [], error: firestoreErrorMessage(e, 'Could not load analytics data. Please retry.') });
    }
  }, []);

  useEffect(() => {
    if (!allowed || tab !== 'overview') return;
    if (loadedKey.current === rangeKey) return;
    void load(from, to);
  }, [allowed, tab, rangeKey, from, to, load]);

  const docs = data.docs;

  // ── KPIs ─────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const totalReturns = docs.length;
    const rejectedReturns = docs.filter((r) => REJECTED_STATUSES.has(r.status || '')).length;
    const rejectionRate = pct(rejectedReturns, totalReturns);
    const completedReturns = docs.filter((r) => COMPLETED_STATUSES.has(r.status || '') || r.refundStatus === 'Refunded').length;

    const pendingRefunds = docs.filter((r) =>
      r.refundStatus !== 'Refunded'
      && !REJECTED_STATUSES.has(r.status || '')
      && !EXCLUDE_FROM_PENDING.has(r.status || '')
      // Balance-due exchanges wait on a customer payment, not a refund.
      && !(isExchangeDoc(r) && r.financialOutcome === 'extra')).length;

    let totalRefundValue = 0;
    let revenueSaved = 0;
    docs.forEach((r) => {
      const amt = getAmt(r);
      totalRefundValue += amt;
      if (r.requestedMethod === 'store_credit' || r.requestedMethod === 'gift_card') revenueSaved += amt;
    });

    const uniqueCustomers = new Set(docs.map((r) => r.customer?.email).filter(Boolean)).size;

    let totalDays = 0;
    let completedCount = 0;
    docs.forEach((r) => {
      if (!COMPLETED_STATUSES.has(r.status || '')) return;
      const created = toDate(r.createdAt);
      const done = toDate(r.completedAt) || toDate(r.refundedAt);
      if (created && done) {
        totalDays += Math.ceil((done.getTime() - created.getTime()) / 86400000);
        completedCount++;
      }
    });
    const avgProcessingTime = completedCount > 0 ? Math.round(totalDays / completedCount) : 0;

    const totalItems = docs.reduce((s, r) => s + (r.items?.reduce((si, i) => si + qtyOf(i), 0) ?? 0), 0);
    const avgItemsPerReturn = totalReturns > 0 ? parseFloat((totalItems / totalReturns).toFixed(1)) : 0;

    let defectiveItems = 0;
    docs.forEach((r) => r.items?.forEach((item) => {
      if (item.reason && DEFECTIVE_REASONS.has(item.reason)) defectiveItems += qtyOf(item);
    }));
    const defectiveRate = pct(defectiveItems, totalItems);

    const customerCounts = new Map<string, number>();
    docs.forEach((r) => {
      const id = r.customer?.email || r.customer?.name || 'unknown';
      customerCounts.set(id, (customerCounts.get(id) || 0) + 1);
    });
    const repeatReturners = Array.from(customerCounts.values()).filter((c) => c >= 3).length;

    let totalQuantityRestocked = 0;
    let restockedCount = 0;
    docs.forEach((r) => {
      totalQuantityRestocked += num(r.totalQuantityRestocked);
      const label = getRestockStatusLabel(r);
      if (label === 'Completed' || label === 'Partial') restockedCount++;
    });

    return {
      totalReturns, rejectedReturns, rejectionRate, pendingRefunds, totalRefundValue, revenueSaved,
      uniqueCustomers, avgProcessingTime, completedReturns, avgItemsPerReturn, defectiveRate,
      defectiveItems, totalItems, repeatReturners, totalQuantityRestocked, restockedCount,
    };
  }, [docs]);

  // ── Exchange KPIs ────────────────────────────────────────────────────────
  const exchangeKpis = useMemo(() => {
    const exchangeDocs = docs.filter(isExchangeDoc);
    let evenCount = 0, refundDueCount = 0, extraDueCount = 0, unresolvedCount = 0;
    let refundDueValue = 0, extraDueValue = 0, checkoutLinksSent = 0, awaitingPayment = 0;
    let outstandingBalanceTotal = 0, completedExchanges = 0, invoiceSendFailures = 0;
    let discountRequestedCount = 0, discountFailedCount = 0, unappliableAdjustmentTotal = 0;

    exchangeDocs.forEach((r) => {
      switch (r.financialOutcome) {
        case 'even': evenCount++; break;
        case 'refund': refundDueCount++; refundDueValue += getAmt(r); break;
        case 'extra':
          extraDueCount++;
          extraDueValue += getExchangeSettlementValue(r);
          if (r.invoiceSent) checkoutLinksSent++; else invoiceSendFailures++;
          break;
        default: unresolvedCount++;
      }
      if (r.awaitingCustomerPayment) {
        awaitingPayment++;
        outstandingBalanceTotal += num(r.outstandingBalance);
      }
      unappliableAdjustmentTotal += num(r.unappliableAdjustment);
      if (num(r.discountPercentage) > 0.01) {
        discountRequestedCount++;
        if (!r.discountAppliedViaOrderEdit) discountFailedCount++;
      }
      if (COMPLETED_STATUSES.has(r.status || '') || (r.financialOutcome === 'refund' && r.refundStatus === 'Refunded')) completedExchanges++;
    });

    return {
      totalExchanges: exchangeDocs.length, evenCount, refundDueCount, extraDueCount, unresolvedCount,
      refundDueValue, extraDueValue, checkoutLinksSent, awaitingPayment, outstandingBalanceTotal,
      completedExchanges, exchangeShare: pct(exchangeDocs.length, docs.length), invoiceSendFailures,
      unappliableAdjustmentTotal, discountRequestedCount, discountFailedCount,
    };
  }, [docs]);

  // ── Trend ────────────────────────────────────────────────────────────────
  const returnsOverTime = useMemo(() => {
    const subset = trendView === 'returns' ? docs.filter((r) => !isExchangeDoc(r))
      : trendView === 'exchanges' ? docs.filter(isExchangeDoc)
        : docs;
    // More than ~4 months of daily points is unreadable (and slow): use weekly buckets.
    const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    const granularity = chartGranularity === 'daily' && span > 120 ? 'weekly' : chartGranularity;
    return buildTrend(subset, from, to, granularity, trendValueFn);
  }, [docs, from, to, chartGranularity, trendView]);

  // ── Requested method breakdown ───────────────────────────────────────────
  const requestedMethodData = useMemo((): MethodRow[] => {
    const sc = { count: 0, value: 0 };
    const gc = { count: 0, value: 0 };
    const rf = { count: 0, value: 0 };
    docs.filter(wasSettledByARefundMethod).forEach((r) => {
      const amt = getAmt(r);
      if (r.requestedMethod === 'store_credit') { sc.count++; sc.value += amt; }
      else if (r.requestedMethod === 'gift_card') { gc.count++; gc.value += amt; }
      else { rf.count++; rf.value += amt; }
    });
    return [
      { label: 'Store Credit', ...sc, color: 'bg-emerald-100 text-emerald-600', swatch: CHART_PALETTE[3], icon: <Wallet className="w-3.5 h-3.5" /> },
      { label: 'Gift Card', ...gc, color: 'bg-indigo-100 text-indigo-600', swatch: CHART_PALETTE[0], icon: <Gift className="w-3.5 h-3.5" /> },
      { label: 'Original Payment', ...rf, color: 'bg-slate-100 text-slate-600', swatch: CHART_PALETTE[4], icon: <CreditCard className="w-3.5 h-3.5" /> },
    ];
  }, [docs]);

  // ── Applied refund method ────────────────────────────────────────────────
  const appliedRefundData = useMemo((): MethodRow[] => {
    const sc = { count: 0, value: 0 };
    const gc = { count: 0, value: 0 };
    const op = { count: 0, value: 0 };
    const mn = { count: 0, value: 0 };
    docs.filter(wasSettledByARefundMethod).forEach((r) => {
      let method = r.refundMethod || r.refundDetails?.method;
      if (!method && r.refundStatus === 'Refunded') method = r.requestedMethod === 'refund' ? 'original' : r.requestedMethod;
      if (!method) return;
      const amt = getAmt(r);
      if (method === 'store_credit') { sc.count++; sc.value += amt; }
      else if (method === 'giftcard' || method === 'gift_card') { gc.count++; gc.value += amt; }
      else if (method === 'original' || method === 'original_payment' || method === 'refund') { op.count++; op.value += amt; }
      else if (method === 'manual') { mn.count++; mn.value += amt; }
    });
    return [
      { label: 'Store Credit', ...sc, color: 'bg-emerald-100 text-emerald-600', swatch: CHART_PALETTE[3], icon: <Wallet className="w-3.5 h-3.5" /> },
      { label: 'Gift Card', ...gc, color: 'bg-indigo-100 text-indigo-600', swatch: CHART_PALETTE[0], icon: <Gift className="w-3.5 h-3.5" /> },
      { label: 'Original Payment', ...op, color: 'bg-slate-100 text-slate-600', swatch: CHART_PALETTE[4], icon: <CreditCard className="w-3.5 h-3.5" /> },
      { label: 'Manual', ...mn, color: 'bg-amber-100 text-amber-600', swatch: CHART_PALETTE[2], icon: <DollarSign className="w-3.5 h-3.5" /> },
    ];
  }, [docs]);

  // ── Exchange settlement outcome ──────────────────────────────────────────
  const exchangeOutcomeData = useMemo((): MethodRow[] => {
    const even = { count: 0, value: 0 };
    const refund = { count: 0, value: 0 };
    const extra = { count: 0, value: 0 };
    docs.filter(isExchangeDoc).forEach((r) => {
      if (r.financialOutcome === 'even') even.count++;
      else if (r.financialOutcome === 'refund') { refund.count++; refund.value += getAmt(r); }
      else if (r.financialOutcome === 'extra') { extra.count++; extra.value += getExchangeSettlementValue(r); }
    });
    return [
      { label: 'Even Swap (no money moved)', ...even, color: 'bg-emerald-100 text-emerald-600', swatch: CHART_PALETTE[3], icon: <Scale className="w-3.5 h-3.5" /> },
      { label: 'Refund Due (new item cheaper)', ...refund, color: 'bg-indigo-100 text-indigo-600', swatch: CHART_PALETTE[0], icon: <DollarSign className="w-3.5 h-3.5" /> },
      { label: 'Balance Due (checkout link sent)', ...extra, color: 'bg-amber-100 text-amber-600', swatch: CHART_PALETTE[2], icon: <Receipt className="w-3.5 h-3.5" /> },
    ];
  }, [docs]);

  // ── Resolution mix (revenue saved) ───────────────────────────────────────
  const resolutionData = useMemo((): ResolutionData[] => {
    const res: ResolutionData[] = [
      { type: 'Original Payment Refund', count: 0, percentage: 0, totalValue: 0 },
      { type: 'Store Credit', count: 0, percentage: 0, totalValue: 0 },
      { type: 'Gift Card', count: 0, percentage: 0, totalValue: 0 },
    ];
    const eligible = docs.filter(wasSettledByARefundMethod);
    eligible.forEach((r) => {
      const amt = getAmt(r);
      if (!r.requestedMethod || r.requestedMethod === 'refund') { res[0].count++; res[0].totalValue += amt; }
      else if (r.requestedMethod === 'store_credit') { res[1].count++; res[1].totalValue += amt; }
      else if (r.requestedMethod === 'gift_card') { res[2].count++; res[2].totalValue += amt; }
    });
    res.forEach((r) => { r.percentage = pct(r.count, eligible.length); });
    return res;
  }, [docs]);

  // ── Top return reasons ───────────────────────────────────────────────────
  const topReasons = useMemo((): ReasonData[] => {
    const map = new Map<string, { count: number; value: number }>();
    let total = 0;
    docs.forEach((ret) => ret.items?.forEach((item) => {
      if (!item.reason) return;
      const reason = getReasonLabel(item.reason);
      const cur = map.get(reason) || { count: 0, value: 0 };
      map.set(reason, { count: cur.count + 1, value: cur.value + priceOf(item) * qtyOf(item) });
      total++;
    }));
    return Array.from(map.entries())
      .map(([reason, d]) => ({ reason, count: d.count, percentage: pct(d.count, total), totalValue: d.value }))
      .sort((a, b) => b.count - a.count);
  }, [docs]);

  // ── Most returned products (top 10 by units) ─────────────────────────────
  const mostReturnedProducts = useMemo(() => {
    interface ProductRow {
      key: string; title: string; sku: string; image?: string;
      requests: number; unitsReturned: number; unitsExchanged: number; totalUnits: number; totalValue: number;
      reasons: Map<string, number>;
    }
    const map = new Map<string, ProductRow>();
    docs.forEach((ret) => {
      const seenInDoc = new Set<string>();
      ret.items?.forEach((item) => {
        const sku = item.sku && item.sku !== 'N/A' ? item.sku : '';
        const key = sku || (item.title || '').trim().toLowerCase() || `line-${item.lineItemId ?? 'unknown'}`;
        const qty = qtyOf(item);
        const isExchange = (item.actionType || '').toLowerCase() === 'exchange'
          || (!item.actionType && (ret.actionType || '').toLowerCase() === 'exchange');
        const row = map.get(key) || {
          key, title: item.title || 'Unknown product', sku: sku || '—', image: item.productImage,
          requests: 0, unitsReturned: 0, unitsExchanged: 0, totalUnits: 0, totalValue: 0, reasons: new Map<string, number>(),
        };
        if (!seenInDoc.has(key)) { row.requests += 1; seenInDoc.add(key); }
        if (isExchange) row.unitsExchanged += qty; else row.unitsReturned += qty;
        row.totalUnits += qty;
        row.totalValue += priceOf(item) * qty;
        if (!row.image && item.productImage) row.image = item.productImage;
        if (item.reason) {
          const r = getReasonLabel(item.reason);
          row.reasons.set(r, (row.reasons.get(r) || 0) + qty);
        }
        map.set(key, row);
      });
    });
    return Array.from(map.values())
      .sort((a, b) => b.totalUnits - a.totalUnits || b.totalValue - a.totalValue)
      .slice(0, 10)
      .map((p) => ({
        ...p,
        topReason: Array.from(p.reasons.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '—',
      }));
  }, [docs]);

  // ── Top customers ────────────────────────────────────────────────────────
  const topReturningCustomers = useMemo(() => {
    const map = new Map<string, CustomerReturnData & { isRepeat: boolean }>();
    docs.forEach((ret) => {
      const id = ret.customer?.email || `cust-${ret.customer?.name || 'unknown'}`;
      const amt = getAmt(ret);
      const ex = map.get(id);
      if (ex) {
        ex.returnCount++;
        ex.totalValue += amt;
        ex.isRepeat = ex.returnCount >= 3;
      } else {
        map.set(id, {
          customerId: id,
          name: ret.customer?.name || 'Unknown',
          email: ret.customer?.email || '',
          returnCount: 1,
          totalValue: amt,
          phone: ret.customer?.phone,
          isRepeat: false,
        });
      }
    });
    return Array.from(map.values()).sort((a, b) => b.returnCount - a.returnCount).slice(0, 10);
  }, [docs]);

  // ── Returns by state ─────────────────────────────────────────────────────
  const returnsByState = useMemo((): StateReturnData[] => {
    const map = new Map<string, StateReturnData & { emails: Set<string> }>();
    docs.forEach((ret) => {
      const state = ret.customer?.state || ret.pickupAddress?.state || 'Unknown';
      const ex = map.get(state) || { state, returnCount: 0, totalValue: 0, uniqueCustomers: 0, emails: new Set<string>() };
      ex.returnCount += 1;
      ex.totalValue += getAmt(ret);
      if (ret.customer?.email) ex.emails.add(ret.customer.email);
      map.set(state, ex);
    });
    return Array.from(map.values())
      .map(({ emails, ...s }) => ({ ...s, uniqueCustomers: emails.size }))
      .sort((a, b) => b.returnCount - a.returnCount);
  }, [docs]);

  // ── Access gate ──────────────────────────────────────────────────────────
  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4 sm:p-8">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 sm:p-10 max-w-md w-full text-center">
          <div className="h-16 w-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4 text-red-500">
            <ShieldAlert className="h-8 w-8" aria-hidden="true" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Access Restricted</h2>
          <p className="text-sm text-slate-500">
            You don't have permission to view Analytics. Contact an Admin or Super Admin for access.
          </p>
        </div>
      </div>
    );
  }

  const exchangeCount = exchangeKpis.totalExchanges;
  const busy = data.status === 'loading' || data.status === 'refreshing';
  const reasonColors = CHART_PALETTE;

  // ── Overview body ────────────────────────────────────────────────────────
  const renderOverview = () => {
    if (data.status === 'idle' || data.status === 'loading') {
      return (
        <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading analytics">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => <div key={i} className="bg-white rounded-2xl border border-slate-200 p-6 h-28" />)}
          </div>
          <div className="bg-white rounded-2xl border border-slate-200 h-64" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-2xl border border-slate-200 h-56" />
            <div className="bg-white rounded-2xl border border-slate-200 h-56" />
          </div>
        </div>
      );
    }

    if (data.status === 'error') {
      return (
        <div className="bg-white border border-red-200 rounded-2xl p-6 sm:p-8 text-center" role="alert">
          <AlertTriangle className="w-10 h-10 text-red-500 mx-auto mb-3" aria-hidden="true" />
          <h3 className="text-lg font-bold text-slate-900 mb-1">Couldn't load analytics</h3>
          <p className="text-sm text-slate-600 mb-5">{data.error}</p>
          <button
            type="button"
            onClick={() => void load(from, to)}
            className="inline-flex min-h-[44px] items-center gap-2 px-5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" /> Retry
          </button>
        </div>
      );
    }

    if (docs.length === 0) {
      return (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 sm:p-8 text-center">
          <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" aria-hidden="true" />
          <h3 className="text-lg font-bold text-amber-800 mb-2">No requests for {periodLabel}</h3>
          <p className="text-sm text-amber-700">No return or exchange requests were created in this period. Try a wider date range above.</p>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        {data.truncated && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-800 flex items-start gap-3" role="status">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
            <p>
              This period has more than {formatNumber(MAX_DOCS)} requests — the charts below use the latest {formatNumber(MAX_DOCS)}.
              Use the <button type="button" className="font-semibold underline" onClick={() => setTab('reports')}>Report Center</button> for complete figures.
            </p>
          </div>
        )}

        {/* KPI Row 1 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard title="Total Requests" value={formatNumber(kpis.totalReturns)}
            trendValue={`${kpis.completedReturns} completed`} trend="up"
            badge={exchangeCount > 0 ? { label: `${exchangeCount} are exchanges`, variant: 'info' } : undefined}
            icon={<Package className="w-6 h-6" />} color="blue" />
          <MetricCard title="Total Refund Value" value={formatCurrency(kpis.totalRefundValue)}
            icon={<DollarSign className="w-6 h-6" />} color="emerald" />
          <MetricCard title="Unique Customers" value={formatNumber(kpis.uniqueCustomers)}
            icon={<Users className="w-6 h-6" />} color="purple" />
          <MetricCard title="Avg Processing Time" value={`${kpis.avgProcessingTime}d`}
            trend={kpis.avgProcessingTime > 3 ? 'down' : 'up'}
            trendValue={kpis.avgProcessingTime > 3 ? 'Needs improvement' : 'On track'}
            icon={<Clock className="w-6 h-6" />} color="amber" />
        </div>

        {/* KPI Row 2 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard title="Rejection Rate" value={`${kpis.rejectionRate.toFixed(1)}%`}
            trend={kpis.rejectionRate > 10 ? 'down' : 'up'} trendValue={`${kpis.rejectedReturns} rejected`}
            icon={<XCircle className="w-6 h-6" />} color="red" highlight={kpis.rejectionRate > 10} />
          <MetricCard title="Pending Refunds" value={formatNumber(kpis.pendingRefunds)}
            badge={kpis.pendingRefunds > 0 ? { label: 'Needs action', variant: 'warn' } : { label: 'All clear', variant: 'ok' }}
            icon={<AlertTriangle className="w-6 h-6" />} color="orange" highlight={kpis.pendingRefunds > 5} />
          <MetricCard title="Defective Item Rate" value={`${kpis.defectiveRate.toFixed(1)}%`}
            trend={kpis.defectiveRate > 20 ? 'down' : 'up'} trendValue={`${kpis.defectiveItems} of ${kpis.totalItems} items`}
            icon={<ShieldAlert className="w-6 h-6" />} color="pink" />
          <MetricCard title="Avg Items / Return" value={kpis.avgItemsPerReturn}
            badge={kpis.avgItemsPerReturn > 2 ? { label: 'Bulk returns detected', variant: 'warn' } : undefined}
            icon={<Layers className="w-6 h-6" />} color="indigo" />
        </div>

        {/* Repeat returners banner */}
        {kpis.repeatReturners > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center gap-4">
            <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center shrink-0" aria-hidden="true">
              <Repeat className="w-5 h-5 text-amber-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-amber-900">
                {kpis.repeatReturners} repeat returner{kpis.repeatReturners > 1 ? 's' : ''} detected
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                {kpis.repeatReturners} customer{kpis.repeatReturners > 1 ? 's have' : ' has'} 3+ requests in this period
              </p>
            </div>
            <span className="text-2xl font-bold text-amber-700 tabular-nums shrink-0">{kpis.repeatReturners}</span>
          </div>
        )}

        <ReturnsOverTimeChart
          data={returnsOverTime}
          granularity={chartGranularity}
          onGranularityChange={setChartGranularity}
          view={trendView}
          onViewChange={setTrendView}
          periodLabel={periodLabel}
        />

        {/* Actual refunds issued */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6">
          <h3 className="text-lg font-bold text-slate-900 mb-5">Actual Refunds Issued by Method</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
            {appliedRefundData.map((item) => (
              <div key={item.label} className="bg-slate-50 border border-slate-100 rounded-2xl p-3 sm:p-4 min-w-0">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-3 ${item.color}`} aria-hidden="true">{item.icon}</div>
                <p className="text-xs font-semibold text-slate-500 mb-1 truncate">{item.label}</p>
                <p className="text-lg sm:text-xl font-bold text-slate-900 tabular-nums truncate" title={formatCurrency(item.value)}>{formatCurrency(item.value)}</p>
                <p className="text-xs font-medium text-slate-500 mt-1">{item.count} request{item.count === 1 ? '' : 's'}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Exchange performance */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <ArrowRightLeft className="w-5 h-5 text-slate-400" aria-hidden="true" />
            <h2 className="text-lg font-bold text-slate-900">Exchange Performance</h2>
            {exchangeCount > 0 && (
              <span className="text-xs font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                {exchangeKpis.exchangeShare.toFixed(1)}% of all requests
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            <MetricCard title="Total Exchanges" value={formatNumber(exchangeCount)}
              trendValue={exchangeCount > 0 ? `${exchangeKpis.completedExchanges} completed` : undefined}
              trend={exchangeCount > 0 ? 'up' : undefined}
              icon={<ArrowRightLeft className="w-6 h-6" />} color="indigo" />
            <MetricCard title="Checkout Links Sent" value={formatNumber(exchangeKpis.checkoutLinksSent)}
              trendValue="Balance-due exchanges invoiced"
              badge={exchangeKpis.invoiceSendFailures > 0 ? { label: `${exchangeKpis.invoiceSendFailures} failed to send`, variant: 'warn' } : undefined}
              icon={<Receipt className="w-6 h-6" />} color="cyan" highlight={exchangeKpis.invoiceSendFailures > 0} />
            <MetricCard title="Discounts Applied" value={formatNumber(exchangeKpis.discountRequestedCount - exchangeKpis.discountFailedCount)}
              trendValue={exchangeKpis.discountRequestedCount > 0 ? `of ${exchangeKpis.discountRequestedCount} requested` : 'None requested'}
              badge={exchangeKpis.discountFailedCount > 0 ? { label: `${exchangeKpis.discountFailedCount} failed to apply`, variant: 'warn' } : undefined}
              icon={<Tag className="w-6 h-6" />} color="pink" highlight={exchangeKpis.discountFailedCount > 0} />
            <MetricCard title="Awaiting Customer Payment" value={formatNumber(exchangeKpis.awaitingPayment)}
              badge={exchangeKpis.awaitingPayment > 0 ? { label: 'Needs follow-up', variant: 'warn' } : { label: 'All clear', variant: 'ok' }}
              icon={<Hourglass className="w-6 h-6" />} color="amber" highlight={exchangeKpis.awaitingPayment > 5} />
            <MetricCard title="Outstanding Balance" value={formatCurrency(exchangeKpis.outstandingBalanceTotal)}
              trendValue={`${exchangeKpis.awaitingPayment} unpaid checkout link${exchangeKpis.awaitingPayment !== 1 ? 's' : ''}`}
              icon={<DollarSign className="w-6 h-6" />} color="orange" />
          </div>

          {exchangeCount > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <RefundMethodComparison title="Exchange Settlement Outcome" data={exchangeOutcomeData} unit="exchanges"
                icon={<Scale className="w-4 h-4 text-indigo-600" />} colorScheme="bg-indigo-50" />
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6">
                <h3 className="text-base font-bold text-slate-900 mb-1">How Exchanges Settle</h3>
                <p className="text-sm text-slate-500 mb-5">{periodLabel}</p>
                <div className="space-y-4">
                  {[
                    { icon: <Scale className="w-4 h-4" />, cls: 'bg-emerald-100 text-emerald-600', title: `${exchangeKpis.evenCount} even swaps`, text: 'Same value in and out — closed automatically, no money moves.' },
                    { icon: <DollarSign className="w-4 h-4" />, cls: 'bg-indigo-100 text-indigo-600', title: `${exchangeKpis.refundDueCount} refunds due — ${formatCurrency(exchangeKpis.refundDueValue)}`, text: 'New item was cheaper than the item returned.' },
                    { icon: <Receipt className="w-4 h-4" />, cls: 'bg-amber-100 text-amber-600', title: `${exchangeKpis.extraDueCount} balances due — ${formatCurrency(exchangeKpis.extraDueValue)}`, text: 'New item was pricier — a Shopify checkout link was emailed to the customer.' },
                  ].map((row) => (
                    <div key={row.text} className="flex items-start gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${row.cls}`} aria-hidden="true">{row.icon}</div>
                      <div>
                        <p className="text-sm font-semibold text-slate-800">{row.title}</p>
                        <p className="text-xs text-slate-500">{row.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 text-center text-sm text-slate-500">
              No exchanges in this period.
            </div>
          )}
        </div>

        {/* Revenue saved + top reasons */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-gradient-to-br from-indigo-900 to-indigo-700 rounded-2xl p-4 sm:p-6 text-white shadow-xl">
            <h3 className="text-sm font-medium opacity-80 mb-2">Revenue Saved</h3>
            <p className="text-3xl sm:text-4xl font-bold mb-1 tabular-nums break-words">{formatCurrency(kpis.revenueSaved)}</p>
            <p className="text-sm opacity-70 mb-5">Store credit + gift card refunds</p>
            <div className="space-y-3">
              {resolutionData.map((res) => (
                <div key={res.type} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="opacity-90">{res.type}</span>
                    <span className="font-medium tabular-nums">{res.percentage.toFixed(1)}%</span>
                  </div>
                  <div className="w-full h-1.5 bg-white/20 rounded-full overflow-hidden">
                    <div className="h-full bg-white rounded-full transition-all duration-500" style={{ width: `${res.percentage}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 shadow-sm lg:col-span-2">
            <h3 className="text-lg font-bold text-slate-900 mb-4">Top Return Reasons</h3>
            <div className="space-y-4 max-h-[300px] overflow-y-auto custom-scrollbar pr-2">
              {topReasons.slice(0, 6).map((reason, idx) => (
                <ProgressBar key={reason.reason} label={reason.reason} value={reason.count} percentage={reason.percentage}
                  color={reasonColors[idx % reasonColors.length]} />
              ))}
              {!topReasons.length && <p className="text-slate-500 text-center py-8">No reason data in this period</p>}
            </div>
          </div>
        </div>

        {/* Requested vs applied */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <RefundMethodComparison title="Requested Refund Method" data={requestedMethodData}
            icon={<TrendingUp className="w-4 h-4 text-indigo-600" />} colorScheme="bg-indigo-50" />
          <RefundMethodComparison title="Applied Refund Method" data={appliedRefundData}
            icon={<BarChart2 className="w-4 h-4 text-emerald-600" />} colorScheme="bg-emerald-50" />
        </div>

        {/* Most returned products */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 sm:p-6 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold text-slate-900">Most Returned Products · Top 10</h3>
              <p className="text-sm text-slate-500 mt-1">{periodLabel} · ranked by units returned + exchanged</p>
            </div>
            <button
              type="button"
              onClick={() => setTab('reports')}
              className="inline-flex min-h-[40px] items-center gap-1.5 self-start rounded-xl border border-slate-200 px-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
            >
              Full report <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
          <DataTable
            caption="Most returned products"
            headers={['#', 'Product', 'SKU', 'Requests', 'Returned', 'Exchanged', 'Total units', 'Share of units', 'Value', 'Top reason']}
            data={mostReturnedProducts}
            maxHeight="480px"
            renderRow={(p, idx) => (
              <tr key={p.key} className="hover:bg-slate-50 transition-colors">
                <td className="py-3 px-4 text-sm font-semibold text-slate-400 tabular-nums">{idx + 1}</td>
                <td className="py-3 px-4">
                  <div className="flex items-center gap-3 min-w-[200px] max-w-[320px]">
                    {p.image
                      ? <img src={p.image} alt="" loading="lazy" className="w-10 h-12 object-cover rounded-lg border border-slate-200 shrink-0" />
                      : <div className="w-10 h-12 bg-slate-100 rounded-lg flex items-center justify-center shrink-0" aria-hidden="true"><Package className="w-5 h-5 text-slate-400" /></div>}
                    <span className="text-sm font-medium text-slate-800 line-clamp-2 whitespace-normal">{p.title}</span>
                  </div>
                </td>
                <td className="py-3 px-4 text-sm font-mono text-slate-600 whitespace-nowrap">{p.sku}</td>
                <td className="py-3 px-4 text-sm text-slate-700 tabular-nums">{p.requests}</td>
                <td className="py-3 px-4 text-sm text-slate-700 tabular-nums">{p.unitsReturned}</td>
                <td className="py-3 px-4 text-sm text-slate-700 tabular-nums">{p.unitsExchanged}</td>
                <td className="py-3 px-4 text-sm font-semibold text-slate-900 tabular-nums">{p.totalUnits}</td>
                <td className="py-3 px-4 text-sm text-slate-600 tabular-nums">{pct(p.totalUnits, kpis.totalItems).toFixed(1)}%</td>
                <td className="py-3 px-4 text-sm font-semibold text-emerald-600 tabular-nums whitespace-nowrap">{formatCurrency(p.totalValue)}</td>
                <td className="py-3 px-4 text-sm text-slate-600 whitespace-nowrap">{p.topReason}</td>
              </tr>
            )}
            emptyMessage="No product return data in this period"
          />
        </div>

        {/* Customers + region */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden min-w-0">
            <div className="p-4 sm:p-6 border-b border-slate-200">
              <h3 className="text-lg font-bold text-slate-900">Customers That Return The Most</h3>
              {kpis.repeatReturners > 0 && (
                <p className="text-xs text-amber-600 mt-1 font-medium">
                  {kpis.repeatReturners} repeat returner{kpis.repeatReturners > 1 ? 's' : ''} (3+ requests) flagged below
                </p>
              )}
            </div>
            <DataTable
              caption="Customers that return the most"
              headers={['Customer', 'Requests', 'Value', 'Flag']}
              data={topReturningCustomers}
              renderRow={(c) => (
                <tr key={c.customerId} className={`hover:bg-slate-50 transition-colors ${c.isRepeat ? 'bg-amber-50/40' : ''}`}>
                  <td className="py-3 px-4">
                    <p className="text-sm font-medium text-slate-800">{c.name}</p>
                    <p className="text-xs text-slate-500">{c.email}</p>
                  </td>
                  <td className="py-3 px-4 text-sm font-semibold text-slate-900 tabular-nums">{c.returnCount}</td>
                  <td className="py-3 px-4 text-sm font-semibold text-emerald-600 tabular-nums whitespace-nowrap">{formatCurrency(c.totalValue)}</td>
                  <td className="py-3 px-4">
                    {c.isRepeat
                      ? <span className="text-[10px] font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full inline-flex items-center gap-1"><Repeat className="w-3 h-3" aria-hidden="true" />Repeat</span>
                      : <span className="text-[10px] text-slate-400">—</span>}
                  </td>
                </tr>
              )}
              emptyMessage="No customer data in this period"
            />
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden min-w-0">
            <div className="p-4 sm:p-6 border-b border-slate-200">
              <h3 className="text-lg font-bold text-slate-900">Returns By Region</h3>
            </div>
            <DataTable
              caption="Returns by region"
              headers={['State', 'Requests', 'Customers', 'Value']}
              data={returnsByState}
              renderRow={(s) => (
                <tr key={s.state} className="hover:bg-slate-50 transition-colors">
                  <td className="py-3 px-4 text-sm font-medium text-slate-800">{s.state}</td>
                  <td className="py-3 px-4 text-sm font-semibold text-slate-900 tabular-nums">{s.returnCount}</td>
                  <td className="py-3 px-4 text-sm text-slate-700 tabular-nums">{s.uniqueCustomers}</td>
                  <td className="py-3 px-4 text-sm font-semibold text-emerald-600 tabular-nums whitespace-nowrap">{formatCurrency(s.totalValue)}</td>
                </tr>
              )}
              emptyMessage="No regional data in this period"
            />
          </div>
        </div>
      </div>
    );
  };

  // ── Render ───────────────────────────────────────────────────────────────
  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: 'Overview', icon: <LayoutDashboard className="w-4 h-4" aria-hidden="true" /> },
    { id: 'reports', label: 'Report Center', icon: <FileSpreadsheet className="w-4 h-4" aria-hidden="true" /> },
  ];

  return (
    <div className="bg-slate-50">
      <div className="max-w-7xl mx-auto space-y-5">
        {/* Toolbar: section tabs + period + refresh on one row (title is in the top bar) */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-3 pt-3 pb-2">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
            <div className="flex shrink-0 gap-1 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Analytics sections">
              {tabs.map((t) => {
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    id={`analytics-tab-${t.id}`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`analytics-panel-${t.id}`}
                    onClick={() => setTab(t.id)}
                    className={`flex-1 lg:flex-none inline-flex min-h-[36px] items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition-colors ${
                      active ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:bg-white'
                    }`}
                  >
                    {t.icon}{t.label}
                  </button>
                );
              })}
            </div>
            <div className="min-w-0 flex-1">
              <DateRangeFilter
                value={range}
                onChange={setRange}
                summary={tab === 'overview' && data.status === 'ready'
                  ? <>
                      <span className="font-semibold text-slate-700">{formatNumber(docs.length)}</span> request{docs.length === 1 ? '' : 's'}
                      {docs.length > 0 && <> ({formatNumber(docs.length - exchangeCount)} returns · {formatNumber(exchangeCount)} exchanges)</>}
                    </>
                  : undefined}
                trailing={tab === 'overview' ? (
                  <button
                    type="button"
                    onClick={() => void load(from, to, true)}
                    disabled={busy}
                    aria-label="Refresh analytics"
                    title="Refresh"
                    className="inline-flex h-10 w-10 items-center justify-center bg-white border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
                  </button>
                ) : undefined}
              />
            </div>
          </div>
        </div>

        <div
          id={`analytics-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`analytics-tab-${tab}`}
          aria-busy={tab === 'overview' && busy ? true : undefined}
        >
          {tab === 'overview'
            ? renderOverview()
            : <ReportCenter range={range} role={currentUser?.role ?? null} />}
        </div>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar       { width: 6px; height: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track  { background: #f1f1f1; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb  { background: #cbd5e1; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
      `}</style>
    </div>
  );
};

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Package, Clock, CheckCircle, XCircle, Truck, CreditCard, ChevronRight, RefreshCw,
  AlertTriangle, RotateCcw, TrendingUp, TrendingDown,
  Minus, ShoppingBag, ArrowRight, Zap,
  ArrowRightLeft, Receipt, Hourglass,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell, CartesianGrid,
} from 'recharts';
import {
  collection, query, orderBy, getDocs, where, limit, Timestamp, getCountFromServer,
} from 'firebase/firestore';
import { db } from '../../Interfaces/firebase';
import { Link } from 'react-router-dom';
import type { ReturnRequest } from '../../Interfaces/types';
import { DateRangeFilter, defaultDateRange, type DateRangeValue } from '../common/DateRangeFilter';
import { formatRangeLabel, istRangeToDates, istToday } from '../../utils/dates';
import {
  addDaysYmd, daysInclusive, firestoreErrorMessage, istHour, istYmd, mondayOf, tsToDate, ymdLabel,
} from '../Reports/istDates';

// ─── Chart palette ─────────────────────────────────────────────────────────────
// Single place to retune chart colours: brand first, then supporting accents
// and neutrals. Semantic colours (status, approved/rejected) are derived here.
const CHART_PALETTE = ['#560835', '#a8557a', '#d97706', '#0f766e', '#475569', '#94a3b8'] as const;
const CHART_UI = { grid: '#f1f5f9', axis: '#94a3b8', axisLabel: '#64748b', cursor: '#f8fafc' } as const;
const SERIES_COLOR = { requests: CHART_PALETTE[0], exchanges: CHART_PALETTE[2] } as const;
const STATUS_COLORS = {
  open: CHART_PALETTE[2],
  pickup: CHART_PALETTE[1],
  delivered: CHART_PALETTE[0],
  exchangePending: '#ea580c',
  completed: CHART_PALETTE[3],
  rejected: '#dc2626',
  cancelled: CHART_PALETTE[5],
} as const;
const METHOD_COLORS = { storeCredit: CHART_PALETTE[3], giftCard: CHART_PALETTE[0], original: CHART_PALETTE[4] } as const;
const OUTCOME_COLORS = { approved: CHART_PALETTE[3], rejected: '#dc2626' } as const;

// ─── Data window ───────────────────────────────────────────────────────────────
/** Activity feed, alerts and "today" tiles look at requests created in the last N days. */
const RECENT_DAYS = 90;
/** Prior-period comparison only for ranges up to this many days (keeps the query bounded). */
const COMPARE_MAX_DAYS = 92;
/** Safety cap for one dashboard query. */
const MAX_DOCS = 5000;
const SLA_DAYS = 14;

// ─── Helpers ───────────────────────────────────────────────────────────────────
const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0 })
    .format(n).replace('₹', '₹ ');
const formatNumber = (n: number) => new Intl.NumberFormat('en-IN').format(n);

const toDate = tsToDate;

const timeAgo = (ts: unknown): string => {
  const d = toDate(ts); if (!d) return 'N/A';
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000); const h = Math.floor(diff / 3600000); const dy = Math.floor(diff / 86400000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (dy < 7) return `${dy}d ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
};

// ─── Exchange-aware row type ────────────────────────────────────────────────
// The shared ReturnRequest type predates the exchange feature; extend it
// locally so this page stays fully typed without touching types.ts.
type ReturnRow = Omit<ReturnRequest, 'actionType' | 'items'> & {
  actionType?: 'return' | 'exchange' | 'mixed';
  items?: Array<{ title?: string; sku?: string; quantityReturned?: number; price?: string | number }>;
  invoiceSent?: boolean;
  invoiceSentAt?: unknown;
  invoiceError?: string | null;
  awaitingCustomerPayment?: boolean;
  outstandingBalance?: number;
  exchangeLoggedAt?: unknown;
  exchangeLoggedBy?: string;
  returned_product_received?: boolean;
  awbCreatedAt?: unknown;
};

const getAmt = (r: ReturnRow): number => {
  const a = Number(r.refundAmount); if (a > 0) return a;
  const b = Number(r.refundDetails?.finalAmount); if (b > 0) return b;
  return 0;
};

const EXCHANGE_ACTION_TYPES = new Set(['exchange', 'mixed']);
const isExchangeDoc = (r: ReturnRow): boolean => EXCHANGE_ACTION_TYPES.has((r.actionType || '').toLowerCase());

const getExchangeSettlementValue = (r: ReturnRow): number => {
  if (r.financialOutcome === 'refund') return getAmt(r);
  if (r.financialOutcome === 'extra') return Number(r.outstandingBalance) || 0;
  return 0;
};

/** start inclusive, end exclusive */
const isInRange = (ts: unknown, start: Date, end: Date): boolean => {
  const d = toDate(ts); return d ? d >= start && d < end : false;
};

const REJECTED_SET = new Set(['denied', 'Denied']);
const COMPLETED_SET = new Set(['completed', 'Completed']);
const CANCELLED_SET = new Set(['Cancelled', 'cancelled', 'closed', 'Closed']);

type Stage = 'completed' | 'rejected' | 'cancelled' | 'exchange_pending' | 'delivered' | 'pickup' | 'approved' | 'open';
const classifyStage = (r: ReturnRow): Stage => {
  const status = r.status || '';
  if (COMPLETED_SET.has(status)) return 'completed';
  if (REJECTED_SET.has(status)) return 'rejected';
  if (CANCELLED_SET.has(status)) return 'cancelled';
  // Exchange logged but money not settled yet — distinct from "open".
  if (isExchangeDoc(r) && status === 'Exchanged_Created') return 'exchange_pending';
  const ship = (r.shipmentStatus || '').toLowerCase();
  if (ship === 'item delivered') return 'delivered';
  if (ship === 'pickup created' || ship === 'in transit') return 'pickup';
  if (status.toLowerCase() === 'approved') return 'approved';
  return 'open';
};

// ─── Chart builder (IST buckets over the selected range) ───────────────────────
interface ChartPoint { label: string; count: number }

const buildChartData = (rows: ReturnRow[], from: string, to: string): ChartPoint[] => {
  const span = daysInclusive(from, to);
  const days: string[] = rows.map((r) => {
    const d = toDate(r.createdAt);
    return d ? istYmd(d) : '';
  });

  if (span === 1) {
    const buckets = Array.from({ length: 12 }, (_, i) => ({ label: `${String(i * 2).padStart(2, '0')}:00`, count: 0 }));
    rows.forEach((r, i) => {
      if (days[i] !== from) return;
      const d = toDate(r.createdAt);
      if (d) buckets[Math.floor(istHour(d) / 2)].count++;
    });
    return buckets;
  }

  let keys: string[] = [];
  let keyOf: (ymd: string) => string;
  let labelOf: (key: string) => string;
  if (span <= 31) {
    for (let k = from; k <= to; k = addDaysYmd(k, 1)) keys.push(k);
    keyOf = (ymd) => ymd;
    labelOf = (k) => ymdLabel(k);
  } else if (span <= 120) {
    for (let k = mondayOf(from); k <= to; k = addDaysYmd(k, 7)) keys.push(k);
    keyOf = mondayOf;
    labelOf = (k) => ymdLabel(k);
  } else {
    const [fy, fm] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    keys = [];
    for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, m = 1) : m++) {
      keys.push(`${y}-${String(m).padStart(2, '0')}`);
    }
    keyOf = (ymd) => ymd.slice(0, 7);
    labelOf = (k) => ymdLabel(`${k}-01`, { month: 'short', year: '2-digit' });
  }
  const counts = new Map<string, number>(keys.map((k) => [k, 0]));
  days.forEach((ymd) => {
    if (!ymd || ymd < from || ymd > to) return;
    const k = keyOf(ymd);
    if (counts.has(k)) counts.set(k, (counts.get(k) || 0) + 1);
  });
  const points = keys.map((k) => ({ label: labelOf(k), count: counts.get(k) || 0 }));
  // Long ranges (e.g. "All time"): skip the empty stretch before the first request.
  if (span > 120) {
    const first = points.findIndex((p) => p.count > 0);
    if (first > 0) return points.slice(first);
  }
  return points;
};

// ─── Small components ──────────────────────────────────────────────────────────
const Trend = ({ current, previous, show = true }: { current: number; previous: number; show?: boolean }) => {
  if (!show) return <span className="text-[10px] text-slate-400">—</span>;
  if (previous === 0 && current === 0) return <span className="text-[10px] text-slate-400">—</span>;
  if (previous === 0) return <span className="text-[10px] text-emerald-600 font-medium flex items-center gap-0.5"><TrendingUp className="w-3 h-3" aria-hidden="true" />New</span>;
  const diff = current - previous;
  const p = Math.abs(Math.round((diff / previous) * 100));
  if (diff === 0) return <span className="text-[10px] text-slate-400 flex items-center gap-0.5"><Minus className="w-3 h-3" aria-hidden="true" />Same</span>;
  return (
    <span className={`text-[10px] font-medium flex items-center gap-0.5 ${diff > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
      {diff > 0 ? <TrendingUp className="w-3 h-3" aria-hidden="true" /> : <TrendingDown className="w-3 h-3" aria-hidden="true" />}
      {p}% vs prior period
    </span>
  );
};

interface TooltipPayload { name?: string; value?: number | string; color?: string }
const ChartTooltip = ({ active, payload, label }: { active?: boolean; payload?: TooltipPayload[]; label?: string }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg px-3 py-2 text-xs">
      <p className="font-semibold text-slate-700 mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color }} className="font-medium">{p.name}: {p.value}</p>
      ))}
    </div>
  );
};

const ACTIVITY_STYLE: Record<string, { bg: string; icon: React.ReactNode }> = {
  return_submitted: { bg: 'bg-indigo-100 text-indigo-600', icon: <Package className="w-3.5 h-3.5" /> },
  pickup_created: { bg: 'bg-slate-100 text-slate-600', icon: <Truck className="w-3.5 h-3.5" /> },
  item_received: { bg: 'bg-emerald-100 text-emerald-600', icon: <CheckCircle className="w-3.5 h-3.5" /> },
  refund_issued: { bg: 'bg-green-100 text-green-600', icon: <CreditCard className="w-3.5 h-3.5" /> },
  return_rejected: { bg: 'bg-red-100 text-red-600', icon: <XCircle className="w-3.5 h-3.5" /> },
  exchange_processed: { bg: 'bg-amber-100 text-amber-700', icon: <ArrowRightLeft className="w-3.5 h-3.5" /> },
  checkout_link_sent: { bg: 'bg-cyan-100 text-cyan-600', icon: <Receipt className="w-3.5 h-3.5" /> },
};

const returnLink = (r: ReturnRow) => `/returns/${encodeURIComponent(r.id || r.orderId || '')}`;

interface Activity { id: string; RAN: string; orderId: string; type: string; title: string; description: string; timestamp: unknown; amount?: number }

type LoadStatus = 'loading' | 'refreshing' | 'ready' | 'error';
interface HomeData {
  status: LoadStatus;
  docs: ReturnRow[];
  error?: string;
  truncated?: boolean;
  allTimeCount?: number;
  rangeCount?: number;
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════════
export const Home = () => {
  const [range, setRange] = useState<DateRangeValue>(() => defaultDateRange('last30'));
  const [trendView, setTrendView] = useState<'all' | 'returns' | 'exchanges'>('all');
  const [data, setData] = useState<HomeData>({ status: 'loading', docs: [] });
  const requestSeq = useRef(0);

  const { from, to } = range;
  const today = istToday();
  const periodLabel = formatRangeLabel(from, to);

  // Windows (IST calendar days). One bounded query covers: current range,
  // prior period (when comparable) and the recent window for alerts/activity.
  const win = useMemo(() => {
    const span = daysInclusive(from, to);
    const compare = span <= COMPARE_MAX_DAYS;
    const prevFrom = addDaysYmd(from, -span);
    const prevTo = addDaysYmd(from, -1);
    const recentFrom = addDaysYmd(today, -(RECENT_DAYS - 1));
    const queryFrom = [from, recentFrom, compare ? prevFrom : from].sort()[0];
    const queryTo = to > today ? to : today;
    return { span, compare, prevFrom, prevTo, recentFrom, queryFrom, queryTo };
  }, [from, to, today]);

  const load = useCallback(async (qFrom: string, qTo: string, cFrom: string, cTo: string, isRefresh = false) => {
    const seq = ++requestSeq.current;
    setData((prev) => ({ ...prev, status: isRefresh && prev.status === 'ready' ? 'refreshing' : 'loading', error: undefined }));
    const returnsCol = collection(db, 'returns');
    const q = istRangeToDates(qFrom, qTo);
    const c = istRangeToDates(cFrom, cTo);
    try {
      const countsP = Promise.allSettled([
        getCountFromServer(returnsCol),
        getCountFromServer(query(
          returnsCol,
          where('createdAt', '>=', Timestamp.fromDate(c.start)),
          where('createdAt', '<', Timestamp.fromDate(c.end)),
        )),
      ]);
      const snap = await getDocs(query(
        returnsCol,
        where('createdAt', '>=', Timestamp.fromDate(q.start)),
        where('createdAt', '<', Timestamp.fromDate(q.end)),
        orderBy('createdAt', 'desc'),
        limit(MAX_DOCS),
      ));
      const [allTime, inRange] = await countsP;
      if (seq !== requestSeq.current) return;
      setData({
        status: 'ready',
        docs: snap.docs.map((d) => ({ ...(d.data() as Omit<ReturnRow, 'id'>), id: d.id }) as ReturnRow),
        truncated: snap.size >= MAX_DOCS,
        allTimeCount: allTime.status === 'fulfilled' ? allTime.value.data().count : undefined,
        rangeCount: inRange.status === 'fulfilled' ? inRange.value.data().count : undefined,
      });
    } catch (e) {
      if (seq !== requestSeq.current) return;
      console.error('Home: load error', e);
      setData({ status: 'error', docs: [], error: firestoreErrorMessage(e, 'Could not load the dashboard. Please retry.') });
    }
  }, []);

  useEffect(() => {
    void load(win.queryFrom, win.queryTo, from, to);
  }, [load, win.queryFrom, win.queryTo, from, to]);

  const reload = () => void load(win.queryFrom, win.queryTo, from, to, true);

  const allDocs = data.docs;

  const bounds = useMemo(() => ({
    cur: istRangeToDates(from, to),
    prev: win.compare ? istRangeToDates(win.prevFrom, win.prevTo) : null,
    recent: istRangeToDates(win.recentFrom, today),
    today: istRangeToDates(today, today),
    week: istRangeToDates(mondayOf(today), today),
  }), [from, to, win, today]);

  const curReturns = useMemo(() => allDocs.filter((r) => isInRange(r.createdAt, bounds.cur.start, bounds.cur.end)), [allDocs, bounds]);
  const prevReturns = useMemo(() => (bounds.prev
    ? allDocs.filter((r) => isInRange(r.createdAt, bounds.prev!.start, bounds.prev!.end))
    : []), [allDocs, bounds]);
  const recentDocs = useMemo(() => allDocs.filter((r) => isInRange(r.createdAt, bounds.recent.start, bounds.recent.end)), [allDocs, bounds]);

  // ── KPIs (single pass) ─────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const calc = (arr: ReturnRow[]) => {
      let open = 0, approved = 0, pickup = 0, delivered = 0, completed = 0;
      let rejected = 0, cancelled = 0, refunded = 0, refundValue = 0, exchangePending = 0;
      let exchanges = 0, exchangeEven = 0, exchangeRefundDue = 0, exchangeExtraDue = 0;
      let checkoutLinksSent = 0, awaitingPayment = 0, outstandingBalance = 0, invoiceSendFailures = 0;

      for (const r of arr) {
        const stage = classifyStage(r);
        if (stage === 'open') open++;
        if (stage === 'approved' || stage === 'pickup' || stage === 'delivered') approved++;
        if (stage === 'pickup') pickup++;
        if (stage === 'delivered') delivered++;
        if (stage === 'completed') completed++;
        if (stage === 'exchange_pending') exchangePending++;
        if (REJECTED_SET.has(r.status || '')) rejected++;
        if (CANCELLED_SET.has(r.status || '')) cancelled++;
        if (r.refundStatus === 'Refunded') { refunded++; refundValue += getAmt(r); }
        if (isExchangeDoc(r)) {
          exchanges++;
          if (r.financialOutcome === 'even') exchangeEven++;
          else if (r.financialOutcome === 'refund') exchangeRefundDue++;
          else if (r.financialOutcome === 'extra') {
            exchangeExtraDue++;
            if (r.invoiceSent) checkoutLinksSent++; else invoiceSendFailures++;
          }
          if (r.awaitingCustomerPayment) {
            awaitingPayment++;
            outstandingBalance += Number(r.outstandingBalance) || 0;
          }
        }
      }
      return {
        total: arr.length, open, approved, pickup, delivered, completed, rejected, cancelled, refunded, refundValue,
        exchangePending, exchanges, exchangeEven, exchangeRefundDue, exchangeExtraDue,
        checkoutLinksSent, awaitingPayment, outstandingBalance, invoiceSendFailures,
      };
    };
    return { cur: calc(curReturns), prev: calc(prevReturns) };
  }, [curReturns, prevReturns]);

  // ── Today KPIs (always today, IST) ─────────────────────────────────────────
  const todayKpis = useMemo(() => {
    const { start, end } = bounds.today;
    let submitted = 0, refunds = 0, refundAmount = 0, exchangesToday = 0, checkoutLinksToday = 0;
    for (const r of recentDocs) {
      if (isInRange(r.createdAt, start, end)) {
        submitted++;
        if (isExchangeDoc(r)) exchangesToday++;
      }
      if (r.refundStatus === 'Refunded' && (isInRange(r.refundedAt, start, end) || isInRange(r.completedAt, start, end))) {
        refunds++;
        refundAmount += getAmt(r);
      }
      if (isExchangeDoc(r) && r.invoiceSent && isInRange(r.invoiceSentAt || r.exchangeLoggedAt, start, end)) checkoutLinksToday++;
    }
    return { submitted, refunds, refundAmount, exchangesToday, checkoutLinksToday };
  }, [recentDocs, bounds]);

  // ── Chart data ─────────────────────────────────────────────────────────────
  const chartData = useMemo(() => {
    const rows = trendView === 'returns' ? curReturns.filter((r) => !isExchangeDoc(r))
      : trendView === 'exchanges' ? curReturns.filter(isExchangeDoc)
        : curReturns;
    return buildChartData(rows, from, to);
  }, [curReturns, trendView, from, to]);
  const chartHasData = chartData.some((p) => p.count > 0);

  const chartVolume = trendView === 'exchanges' ? kpis.cur.exchanges
    : trendView === 'returns' ? kpis.cur.total - kpis.cur.exchanges
      : kpis.cur.total;
  const chartVolumePrev = trendView === 'exchanges' ? kpis.prev.exchanges
    : trendView === 'returns' ? kpis.prev.total - kpis.prev.exchanges
      : kpis.prev.total;

  // ── Status distribution ────────────────────────────────────────────────────
  const statusDist = useMemo(() => [
    { name: 'Open', value: kpis.cur.open, color: STATUS_COLORS.open },
    { name: 'Pickup', value: kpis.cur.pickup, color: STATUS_COLORS.pickup },
    { name: 'Delivered', value: kpis.cur.delivered, color: STATUS_COLORS.delivered },
    { name: 'Exchange Pending', value: kpis.cur.exchangePending, color: STATUS_COLORS.exchangePending },
    { name: 'Completed', value: kpis.cur.completed, color: STATUS_COLORS.completed },
    { name: 'Rejected', value: kpis.cur.rejected, color: STATUS_COLORS.rejected },
    { name: 'Cancelled', value: kpis.cur.cancelled, color: STATUS_COLORS.cancelled },
  ].filter((d) => d.value > 0), [kpis]);

  const methodData = useMemo(() => [
    { name: 'Store Credit', count: curReturns.filter((r) => r.requestedMethod === 'store_credit').length, color: METHOD_COLORS.storeCredit },
    { name: 'Gift Card', count: curReturns.filter((r) => r.requestedMethod === 'gift_card').length, color: METHOD_COLORS.giftCard },
    { name: 'Original Pay', count: curReturns.filter((r) => r.requestedMethod === 'refund' || !r.requestedMethod).length, color: METHOD_COLORS.original },
  ].filter((d) => d.count > 0), [curReturns]);

  // ── Today's activity feed ──────────────────────────────────────────────────
  const todayActivities = useMemo(() => {
    const { start, end } = bounds.today;
    const acts: Activity[] = [];
    recentDocs.forEach((ret) => {
      const add = (ts: unknown, type: string, title: string, desc: string, amt?: number) => {
        if (isInRange(ts, start, end)) {
          acts.push({ id: `${ret.id}-${type}`, RAN: ret.RAN || '', orderId: ret.orderId || '', type, title, description: desc, timestamp: ts, amount: amt });
        }
      };
      add(ret.createdAt, 'return_submitted', 'Request Submitted', `${ret.items?.length || 0} item(s) · ${ret.customer?.name || ''}`, getAmt(ret) || undefined);
      add(ret.receivedAt, 'item_received', 'Items Received', `${ret.items?.length || 0} item(s) at warehouse`, getAmt(ret) || undefined);
      if (ret.refundStatus === 'Refunded') {
        add(ret.refundedAt || ret.completedAt, 'refund_issued',
          `Refund · ${(ret.refundMethod || ret.requestedMethod || '').replace(/_/g, ' ')}`,
          formatCurrency(getAmt(ret)), getAmt(ret) || undefined);
      }
      if (ret.awb) add(ret.awbCreatedAt || ret.updatedAt, 'pickup_created', 'Pickup Scheduled', `AWB: ${ret.awb}`);
      if (REJECTED_SET.has(ret.status || '')) add(ret.updatedAt, 'return_rejected', 'Request Rejected', ret.rejectionReason || 'No reason');
      if (isExchangeDoc(ret) && ret.exchangeLoggedAt) {
        const outcomeDesc = ret.financialOutcome === 'even'
          ? 'Even swap — closed automatically, no money moved'
          : ret.financialOutcome === 'refund'
            ? `Refund due · ${formatCurrency(getAmt(ret))}`
            : `Balance due · ${formatCurrency(getExchangeSettlementValue(ret))}`;
        add(ret.exchangeLoggedAt, 'exchange_processed', 'Exchange Processed', outcomeDesc, getExchangeSettlementValue(ret) || undefined);
      }
      if (isExchangeDoc(ret) && ret.invoiceSent) {
        add(ret.invoiceSentAt || ret.exchangeLoggedAt, 'checkout_link_sent', 'Checkout Link Sent',
          `${formatCurrency(ret.outstandingBalance || 0)} balance due`, ret.outstandingBalance || undefined);
      }
    });
    return acts
      .sort((a, b) => (toDate(b.timestamp)?.getTime() ?? 0) - (toDate(a.timestamp)?.getTime() ?? 0))
      .slice(0, 25);
  }, [recentDocs, bounds]);

  // ── Alerts (recent window) ─────────────────────────────────────────────────
  const slaBreaches = useMemo(() => recentDocs.filter((r) => {
    const d = toDate(r.createdAt); if (!d) return false;
    return classifyStage(r) === 'open' && Math.floor((Date.now() - d.getTime()) / 86400000) > SLA_DAYS;
  }), [recentDocs]);

  // "Delivered, but Mark-Received hasn't happened yet".
  const awaitingRestock = useMemo(() => recentDocs.filter((r) =>
    (r.shipmentStatus || '').toLowerCase() === 'item delivered'
    && !r.returned_product_received
    && !COMPLETED_SET.has(r.status || '')), [recentDocs]);

  const exchangesAwaitingPayment = useMemo(() => recentDocs
    .filter((r) => isExchangeDoc(r) && r.awaitingCustomerPayment)
    .sort((a, b) => (Number(b.outstandingBalance) || 0) - (Number(a.outstandingBalance) || 0)), [recentDocs]);
  const awaitingPaymentTotal = useMemo(
    () => exchangesAwaitingPayment.reduce((s, r) => s + (Number(r.outstandingBalance) || 0), 0),
    [exchangesAwaitingPayment],
  );

  // ── Top product this week (IST, Monday start) ──────────────────────────────
  const topProduct = useMemo(() => {
    const { start, end } = bounds.week;
    const map = new Map<string, { title: string; count: number; sku: string }>();
    recentDocs.forEach((r) => {
      if (!isInRange(r.createdAt, start, end)) return;
      r.items?.forEach((item) => {
        const key = item.sku && item.sku !== 'N/A' ? item.sku : item.title;
        if (!key) return;
        const ex = map.get(key) || { title: item.title || key, count: 0, sku: item.sku || '' };
        map.set(key, { ...ex, count: ex.count + (Number(item.quantityReturned) || 1) });
      });
    });
    return map.size ? Array.from(map.values()).sort((a, b) => b.count - a.count)[0] : null;
  }, [recentDocs, bounds]);

  const busy = data.status === 'loading' || data.status === 'refreshing';
  const headlineTotal = data.truncated && data.rangeCount != null ? data.rangeCount : kpis.cur.total;

  // ── Toolbar (always shown): date range + refresh on one row; the page title
  // already lives in the top bar, so there is no separate heading here.
  const header = (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-4 pt-3 pb-2">
      <DateRangeFilter
        value={range}
        onChange={setRange}
        summary={data.allTimeCount != null ? <>{formatNumber(data.allTimeCount)} requests all time</> : undefined}
        trailing={
          <button
            type="button"
            onClick={reload}
            disabled={busy}
            aria-label="Refresh dashboard"
            title="Refresh"
            className="inline-flex h-10 w-10 items-center justify-center bg-white border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        }
      />
    </div>
  );

  // ── Loading ────────────────────────────────────────────────────────────────
  if (data.status === 'loading') {
    return (
      <div className="bg-slate-50">
        <div className="max-w-7xl mx-auto space-y-5">
          {header}
          <div className="space-y-5 animate-pulse" aria-busy="true" aria-label="Loading dashboard">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {[...Array(4)].map((_, i) => <div key={i} className="bg-white rounded-2xl border border-slate-200 p-6 h-32" />)}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {[...Array(6)].map((_, i) => <div key={i} className="bg-white rounded-xl border border-slate-200 p-4 h-20" />)}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 h-72" />
              <div className="bg-white rounded-2xl border border-slate-200 h-72" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (data.status === 'error') {
    return (
      <div className="bg-slate-50">
        <div className="max-w-7xl mx-auto space-y-5">
          {header}
          <div className="bg-white border border-red-200 rounded-2xl p-6 sm:p-8 text-center" role="alert">
            <AlertTriangle className="w-10 h-10 text-red-500 mx-auto mb-3" aria-hidden="true" />
            <h2 className="text-lg font-bold text-slate-900 mb-1">Couldn't load the dashboard</h2>
            <p className="text-sm text-slate-600 mb-5">{data.error}</p>
            <button
              type="button"
              onClick={() => void load(win.queryFrom, win.queryTo, from, to)}
              className="inline-flex min-h-[44px] items-center gap-2 px-5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold"
            >
              <RefreshCw className="w-4 h-4" aria-hidden="true" /> Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const primaryCards = [
    {
      title: 'Requests Received',
      value: headlineTotal,
      prev: kpis.prev.total,
      sub: `${todayKpis.submitted} today${todayKpis.exchangesToday ? ` · ${todayKpis.exchangesToday} exch.` : ''}`,
      icon: <Package className="w-5 h-5" />,
      accent: 'bg-indigo-50 text-indigo-600',
    },
    {
      title: 'Approved / In Progress',
      value: kpis.cur.approved,
      prev: kpis.prev.approved,
      sub: `${kpis.cur.pickup} pickup · ${kpis.cur.delivered} delivered`,
      icon: <CheckCircle className="w-5 h-5" />,
      accent: 'bg-emerald-50 text-emerald-600',
    },
    {
      title: 'Rejected / Closed',
      value: kpis.cur.rejected + kpis.cur.cancelled,
      prev: kpis.prev.rejected + kpis.prev.cancelled,
      sub: `${kpis.cur.rejected} denied · ${kpis.cur.cancelled} closed`,
      icon: <XCircle className="w-5 h-5" />,
      accent: 'bg-red-50 text-red-600',
    },
    {
      title: 'Completed',
      value: kpis.cur.completed,
      prev: kpis.prev.completed,
      sub: `${formatCurrency(kpis.cur.refundValue)} refunded`,
      icon: <CreditCard className="w-5 h-5" />,
      accent: 'bg-slate-100 text-slate-700',
    },
  ];

  const miniKpis: Array<{ label: string; value: number | string; color: string; bg: string; sub?: string }> = [
    { label: 'Open', value: kpis.cur.open, color: 'text-amber-700', bg: 'bg-amber-50 border-amber-100' },
    { label: 'Pickup Created', value: kpis.cur.pickup, color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-100' },
    { label: 'Item Delivered', value: kpis.cur.delivered, color: 'text-slate-700', bg: 'bg-slate-50 border-slate-200' },
    { label: 'Refunds Issued', value: kpis.cur.refunded, color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-100' },
    { label: 'Submitted Today', value: todayKpis.submitted, color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-100' },
    { label: "Today's Refunds", value: todayKpis.refunds, color: 'text-green-700', bg: 'bg-green-50 border-green-100', sub: formatCurrency(todayKpis.refundAmount) },
  ];

  const exchangeTiles = [
    {
      label: 'Exchanges', value: formatNumber(kpis.cur.exchanges), color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-100',
      icon: <ArrowRightLeft className="w-3.5 h-3.5" />, sub: `${kpis.cur.exchangeEven} even · ${kpis.cur.exchangeRefundDue} refund due`,
    },
    {
      label: 'Checkout Links Sent', value: formatNumber(kpis.cur.checkoutLinksSent),
      color: kpis.cur.invoiceSendFailures > 0 ? 'text-red-700' : 'text-cyan-700',
      bg: kpis.cur.invoiceSendFailures > 0 ? 'bg-red-50 border-red-100' : 'bg-cyan-50 border-cyan-100',
      icon: <Receipt className="w-3.5 h-3.5" />,
      sub: kpis.cur.invoiceSendFailures > 0 ? `${kpis.cur.invoiceSendFailures} failed to send` : 'Balance-due exchanges invoiced',
    },
    {
      label: 'Awaiting Payment', value: formatNumber(kpis.cur.awaitingPayment), color: 'text-amber-700', bg: 'bg-amber-50 border-amber-100',
      icon: <Hourglass className="w-3.5 h-3.5" />, sub: 'Unpaid checkout links',
    },
    {
      label: 'Outstanding Balance', value: formatCurrency(kpis.cur.outstandingBalance), color: 'text-orange-700', bg: 'bg-orange-50 border-orange-100',
      icon: <Package className="w-3.5 h-3.5" />, sub: 'Owed from checkout links',
    },
  ];

  const approvedN = kpis.cur.approved + kpis.cur.completed;
  const rejectedN = kpis.cur.rejected + kpis.cur.cancelled;
  const outcomeTotal = approvedN + rejectedN || 1;
  const outcomeData = [
    { name: 'Approved', value: approvedN, color: OUTCOME_COLORS.approved },
    { name: 'Rejected', value: rejectedN, color: OUTCOME_COLORS.rejected },
  ];
  const seriesColor = trendView === 'exchanges' ? SERIES_COLOR.exchanges : SERIES_COLOR.requests;

  return (
    <div className="bg-slate-50">
      <div className="max-w-7xl mx-auto space-y-5">
        {header}

        {data.truncated && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-800 flex items-start gap-3" role="status">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
            <p>Very high volume: the charts use the latest {formatNumber(MAX_DOCS)} requests of this window. Headline count is exact.</p>
          </div>
        )}

        {/* ── Row 1: primary KPI cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {primaryCards.map((card) => (
            <div key={card.title} className="bg-white rounded-2xl border border-slate-200 p-3 sm:p-4 shadow-sm hover:shadow-md transition-all flex flex-col min-w-0">
              <div className="flex-1">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <p className="text-[11px] sm:text-xs font-semibold text-slate-500 uppercase tracking-wide leading-tight">{card.title}</p>
                  <div className={`p-1.5 rounded-lg shrink-0 ${card.accent}`} aria-hidden="true">{card.icon}</div>
                </div>
                <p className="text-2xl sm:text-3xl font-bold text-slate-900 tabular-nums">{formatNumber(card.value)}</p>
              </div>
              <div className="flex flex-col gap-1 mt-2 pt-2 border-t border-slate-50">
                <p className="text-[11px] text-slate-400 truncate" title={card.sub}>{card.sub}</p>
                <Trend current={card.value} previous={card.prev} show={win.compare} />
              </div>
            </div>
          ))}
        </div>

        {/* ── Row 2: secondary mini-KPIs ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {miniKpis.map((item) => (
            <div key={item.label} className={`rounded-xl border p-3 min-w-0 ${item.bg}`}>
              <p className={`text-[11px] font-semibold ${item.color} opacity-80 mb-1 leading-snug`}>{item.label}</p>
              <p className={`text-xl sm:text-2xl font-bold ${item.color} tabular-nums truncate`}>{item.value}</p>
              {item.sub && <p className={`text-[11px] font-medium ${item.color} opacity-70 mt-0.5 truncate`} title={item.sub}>{item.sub}</p>}
            </div>
          ))}
        </div>

        {/* ── Row 2b: exchange snapshot ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {exchangeTiles.map((item) => (
            <div key={item.label} className={`rounded-xl border p-3 min-w-0 ${item.bg}`}>
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className={`text-[11px] font-semibold ${item.color} opacity-80 leading-snug`}>{item.label}</p>
                <span className={`${item.color} opacity-60 shrink-0`} aria-hidden="true">{item.icon}</span>
              </div>
              <p className={`text-xl sm:text-2xl font-bold ${item.color} tabular-nums truncate`} title={String(item.value)}>{item.value}</p>
              <p className={`text-[11px] font-medium ${item.color} opacity-70 mt-0.5 truncate`} title={item.sub}>{item.sub}</p>
            </div>
          ))}
        </div>

        {/* ── Row 3: volume chart + status distribution ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6 min-w-0">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-5">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  {trendView === 'exchanges' ? 'Exchanges Volume' : trendView === 'returns' ? 'Returns Volume' : 'Requests Volume'}
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">{periodLabel}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex bg-slate-100 rounded-lg p-0.5 gap-0.5" role="group" aria-label="Request type">
                  {(['all', 'returns', 'exchanges'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setTrendView(v)}
                      aria-pressed={trendView === v}
                      className={`min-h-[40px] px-3 text-xs font-semibold rounded-md transition-all capitalize ${
                        trendView === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
                <div className="text-right shrink-0 ml-auto sm:ml-0">
                  <p className="text-2xl font-bold text-slate-900 tabular-nums">{chartVolume}</p>
                  <Trend current={chartVolume} previous={chartVolumePrev} show={win.compare} />
                </div>
              </div>
            </div>
            {!chartHasData ? (
              <div className="h-48 flex items-center justify-center text-slate-400 text-sm">No requests in this period</div>
            ) : (
              <div className="w-full h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                    <defs>
                      <linearGradient id="homeVolGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={seriesColor} stopOpacity={0.25} />
                        <stop offset="95%" stopColor={seriesColor} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_UI.grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: CHART_UI.axis }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
                    <YAxis tick={{ fontSize: 10, fill: CHART_UI.axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip content={<ChartTooltip />} />
                    <Area type="monotone" dataKey="count" name={trendView === 'exchanges' ? 'Exchanges' : trendView === 'returns' ? 'Returns' : 'Requests'}
                      stroke={seriesColor} strokeWidth={2.5}
                      fill="url(#homeVolGrad)" dot={false} activeDot={{ r: 5, fill: seriesColor, strokeWidth: 0 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6 min-w-0">
            <h2 className="text-base font-bold text-slate-900 mb-1">By Status</h2>
            <p className="text-xs text-slate-400 mb-4">{periodLabel}</p>
            {statusDist.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-slate-400 text-sm">No data</div>
            ) : (
              <>
                <div className="flex h-2.5 rounded-full overflow-hidden mb-5 bg-slate-100" aria-hidden="true">
                  {statusDist.map((d) => (
                    <div key={d.name} className="h-full transition-all duration-500" style={{ width: `${(d.value / Math.max(kpis.cur.total, 1)) * 100}%`, background: d.color }} />
                  ))}
                </div>
                <ul className="space-y-2.5">
                  {statusDist.map((d) => (
                    <li key={d.name} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} aria-hidden="true" />
                        <span className="text-sm text-slate-600 truncate">{d.name}</span>
                      </div>
                      <div className="flex items-center gap-2.5 shrink-0">
                        <div className="w-12 sm:w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden" aria-hidden="true">
                          <div className="h-full rounded-full" style={{ width: `${(d.value / Math.max(kpis.cur.total, 1)) * 100}%`, background: d.color }} />
                        </div>
                        <span className="text-sm font-bold text-slate-900 tabular-nums w-8 text-right">{d.value}</span>
                        <span className="text-[11px] text-slate-400 w-9 text-right tabular-nums">
                          {((d.value / Math.max(kpis.cur.total, 1)) * 100).toFixed(0)}%
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="mt-5 pt-4 border-t border-slate-100 grid grid-cols-2 gap-2">
                  <div className="bg-emerald-50 rounded-xl p-3 border border-emerald-100">
                    <p className="text-[11px] text-emerald-700 font-semibold mb-0.5">Approval Rate</p>
                    <p className="text-xl font-bold text-emerald-700 tabular-nums">
                      {kpis.cur.total > 0 ? `${Math.round((kpis.cur.approved / kpis.cur.total) * 100)}%` : '—'}
                    </p>
                  </div>
                  <div className="bg-red-50 rounded-xl p-3 border border-red-100">
                    <p className="text-[11px] text-red-700 font-semibold mb-0.5">Rejection Rate</p>
                    <p className="text-xl font-bold text-red-700 tabular-nums">
                      {kpis.cur.total > 0 ? `${Math.round(((kpis.cur.rejected + kpis.cur.cancelled) / kpis.cur.total) * 100)}%` : '—'}
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Row 4: refund methods + approved vs rejected ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6 min-w-0">
            <h2 className="text-base font-bold text-slate-900 mb-5">Requested Refund Methods</h2>
            {!methodData.length ? (
              <div className="h-32 flex items-center justify-center text-slate-400 text-sm">No data for this period</div>
            ) : (
              <div className="w-full h-[140px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={methodData} layout="vertical" margin={{ left: 0, right: 24, top: 0, bottom: 0 }}>
                    <XAxis type="number" tick={{ fontSize: 10, fill: CHART_UI.axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: CHART_UI.axisLabel }} axisLine={false} tickLine={false} width={84} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: CHART_UI.cursor }} />
                    <Bar dataKey="count" name="Requests" radius={[0, 4, 4, 0]}>
                      {methodData.map((d) => <Cell key={d.name} fill={d.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6 min-w-0">
            <h2 className="text-base font-bold text-slate-900 mb-1">Approved vs Rejected</h2>
            <p className="text-xs text-slate-400 mb-5">{periodLabel}</p>
            <div className="w-full h-[140px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={outcomeData} margin={{ left: -16, right: 8, top: 0, bottom: 0 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: CHART_UI.axisLabel }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: CHART_UI.axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: CHART_UI.cursor }} />
                  <Bar dataKey="value" name="Count" radius={[4, 4, 0, 0]}>
                    {outcomeData.map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden flex" aria-hidden="true">
                <div className="h-full transition-all" style={{ width: `${(approvedN / outcomeTotal) * 100}%`, background: OUTCOME_COLORS.approved }} />
                <div className="h-full transition-all" style={{ width: `${(rejectedN / outcomeTotal) * 100}%`, background: OUTCOME_COLORS.rejected }} />
              </div>
              <span className="text-xs text-slate-500 whitespace-nowrap tabular-nums shrink-0">{approvedN} : {rejectedN}</span>
            </div>
          </div>
        </div>

        {/* ── Row 5: activity + alerts ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden min-w-0">
            <div className="px-4 sm:px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-base font-bold text-slate-900">Today's Activity</h2>
                <p className="text-xs text-slate-400 mt-0.5">{todayActivities.length} event{todayActivities.length !== 1 ? 's' : ''} today</p>
              </div>
              <Link to="/returns" className="inline-flex min-h-[40px] items-center text-xs text-indigo-600 hover:text-indigo-700 font-medium gap-1 shrink-0">
                All returns <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
              </Link>
            </div>
            <div className="divide-y divide-slate-50 max-h-[420px] overflow-y-auto custom-scrollbar">
              {todayActivities.length > 0 ? todayActivities.map((act) => {
                const style = ACTIVITY_STYLE[act.type] || ACTIVITY_STYLE.return_rejected;
                return (
                  <div key={act.id} className="flex items-start gap-3 px-4 sm:px-5 py-3.5 hover:bg-slate-50 transition-colors">
                    <div className={`p-2 rounded-xl ${style.bg} shrink-0 mt-0.5`} aria-hidden="true">{style.icon}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-slate-800 truncate capitalize">{act.title}</p>
                        <span className="text-[11px] text-slate-400 whitespace-nowrap shrink-0">{timeAgo(act.timestamp)}</span>
                      </div>
                      <p className="text-xs text-slate-500 truncate mt-0.5">{act.description}</p>
                      <div className="flex items-center gap-2 mt-1">
                        {act.RAN && <span className="text-[11px] font-mono text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">{act.RAN}</span>}
                        {act.amount != null && act.amount > 0 && (
                          <span className="text-[11px] font-semibold text-emerald-600">{formatCurrency(act.amount)}</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }) : (
                <div className="flex flex-col items-center justify-center py-16 text-center px-4">
                  <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-3">
                    <Clock className="w-6 h-6 text-slate-400" aria-hidden="true" />
                  </div>
                  <p className="text-sm font-medium text-slate-500">No activity today</p>
                  <p className="text-xs text-slate-400 mt-1">New requests will appear here</p>
                </div>
              )}
            </div>
          </div>

          {/* Right sidebar */}
          <div className="space-y-4 min-w-0">
            {slaBreaches.length > 0 && (
              <div className="bg-white rounded-2xl border border-red-200 shadow-sm overflow-hidden">
                <div className="px-4 py-3 bg-red-50 border-b border-red-100 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-bold text-red-800">SLA Breached</p>
                    <p className="text-[11px] text-red-600 leading-snug">
                      {slaBreaches.length} request{slaBreaches.length > 1 ? 's' : ''} open &gt;{SLA_DAYS} days — no pickup yet (last {RECENT_DAYS} days)
                    </p>
                  </div>
                </div>
                <div className="p-3 max-h-56 overflow-y-auto custom-scrollbar space-y-2">
                  {slaBreaches.slice(0, 5).map((r) => {
                    const d = toDate(r.createdAt);
                    const days = d ? Math.floor((Date.now() - d.getTime()) / 86400000) : 0;
                    return (
                      <Link key={r.id} to={returnLink(r)}
                        className="flex min-h-[44px] items-center justify-between p-2.5 bg-red-50 rounded-xl border border-red-100 hover:bg-red-100 transition-colors">
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-red-800 truncate">{r.RAN}</p>
                          <p className="text-[11px] text-red-600 truncate">{r.customer?.name} · {r.orderId}</p>
                        </div>
                        <div className="text-right shrink-0 ml-2">
                          <p className="text-xs font-bold text-red-700">{days}d</p>
                          <p className="text-[11px] text-red-500">overdue</p>
                        </div>
                      </Link>
                    );
                  })}
                  {slaBreaches.length > 5 && <p className="text-[11px] text-center text-red-500 py-1">+{slaBreaches.length - 5} more</p>}
                </div>
              </div>
            )}

            {awaitingRestock.length > 0 && (
              <div className="bg-white rounded-2xl border border-amber-200 shadow-sm overflow-hidden">
                <div className="px-4 py-3 bg-amber-50 border-b border-amber-100 flex items-center gap-2">
                  <RotateCcw className="w-4 h-4 text-amber-600 shrink-0" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-bold text-amber-800">Awaiting Restock</p>
                    <p className="text-[11px] text-amber-600">{awaitingRestock.length} delivered but not marked received</p>
                  </div>
                </div>
                <div className="p-3 max-h-48 overflow-y-auto custom-scrollbar space-y-2">
                  {awaitingRestock.slice(0, 4).map((r) => (
                    <Link key={r.id} to={returnLink(r)}
                      className="flex min-h-[44px] items-center justify-between p-2.5 bg-amber-50 rounded-xl border border-amber-100 hover:bg-amber-100 transition-colors">
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-amber-800 truncate">{r.RAN}</p>
                        <p className="text-[11px] text-amber-600">{r.items?.length || 0} item(s) ready</p>
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 text-amber-500 shrink-0" aria-hidden="true" />
                    </Link>
                  ))}
                  {awaitingRestock.length > 4 && <p className="text-[11px] text-center text-amber-500 py-1">+{awaitingRestock.length - 4} more</p>}
                </div>
              </div>
            )}

            {exchangesAwaitingPayment.length > 0 && (
              <div className="bg-white rounded-2xl border border-cyan-200 shadow-sm overflow-hidden">
                <div className="px-4 py-3 bg-cyan-50 border-b border-cyan-100 flex items-center gap-2">
                  <Receipt className="w-4 h-4 text-cyan-600 shrink-0" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-bold text-cyan-800">Exchanges Awaiting Payment</p>
                    <p className="text-[11px] text-cyan-600">
                      {exchangesAwaitingPayment.length} unpaid checkout link{exchangesAwaitingPayment.length !== 1 ? 's' : ''} · {formatCurrency(awaitingPaymentTotal)} outstanding
                    </p>
                  </div>
                </div>
                <div className="p-3 max-h-48 overflow-y-auto custom-scrollbar space-y-2">
                  {exchangesAwaitingPayment.slice(0, 4).map((r) => (
                    <Link key={r.id} to={returnLink(r)}
                      className="flex min-h-[44px] items-center justify-between p-2.5 bg-cyan-50 rounded-xl border border-cyan-100 hover:bg-cyan-100 transition-colors">
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-cyan-800 truncate flex items-center gap-1.5">
                          {r.RAN}
                          {!r.invoiceSent && (
                            <span className="text-[9px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">LINK NOT SENT</span>
                          )}
                        </p>
                        <p className="text-[11px] text-cyan-600 truncate">{r.customer?.name || 'Customer'}</p>
                      </div>
                      <div className="text-right shrink-0 ml-2">
                        <p className="text-xs font-bold text-cyan-700">{formatCurrency(r.outstandingBalance || 0)}</p>
                        <p className="text-[11px] text-cyan-500">due</p>
                      </div>
                    </Link>
                  ))}
                  {exchangesAwaitingPayment.length > 4 && <p className="text-[11px] text-center text-cyan-500 py-1">+{exchangesAwaitingPayment.length - 4} more</p>}
                </div>
              </div>
            )}

            {/* Today's refunds card */}
            <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-2xl p-5 text-white shadow-xl">
              <div className="flex items-center gap-2 mb-3">
                <div className="p-1.5 bg-white/10 rounded-lg" aria-hidden="true"><Zap className="w-4 h-4 text-emerald-400" /></div>
                <p className="text-xs font-semibold opacity-70">Today's Refunds Processed</p>
              </div>
              {todayKpis.refunds > 0 ? (
                <>
                  <p className="text-3xl font-bold tabular-nums break-words">{formatCurrency(todayKpis.refundAmount)}</p>
                  <p className="text-xs text-emerald-400 font-medium mt-1">{todayKpis.refunds} refund{todayKpis.refunds !== 1 ? 's' : ''} completed</p>
                </>
              ) : (
                <>
                  <p className="text-3xl font-bold opacity-30 tabular-nums">₹ 0</p>
                  <p className="text-xs opacity-60 mt-1">No refunds processed today</p>
                </>
              )}
              <dl className="mt-4 pt-3 border-t border-white/10 space-y-1.5 text-xs">
                <div className="flex justify-between"><dt className="opacity-70">Submitted today</dt><dd className="font-bold">{todayKpis.submitted}</dd></div>
                <div className="flex justify-between"><dt className="opacity-70">Checkout links sent today</dt><dd className="font-bold text-cyan-400">{todayKpis.checkoutLinksToday}</dd></div>
                <div className="flex justify-between">
                  <dt className="opacity-70">SLA breaches</dt>
                  <dd className={`font-bold ${slaBreaches.length > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{slaBreaches.length}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="opacity-70">Awaiting restock</dt>
                  <dd className={`font-bold ${awaitingRestock.length > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>{awaitingRestock.length}</dd>
                </div>
              </dl>
            </div>

            {/* Top product this week */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="p-1.5 bg-indigo-50 rounded-lg" aria-hidden="true"><ShoppingBag className="w-4 h-4 text-indigo-600" /></div>
                <p className="text-sm font-bold text-slate-800">Top Returned · This Week</p>
              </div>
              {topProduct ? (
                <>
                  <div className="bg-slate-50 rounded-xl p-3 border border-slate-100 mb-3">
                    <p className="text-sm font-bold text-slate-900 line-clamp-2 leading-snug mb-2">{topProduct.title}</p>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">Units this week</span>
                      <span className="text-xl font-bold text-indigo-600 tabular-nums">{topProduct.count}</span>
                    </div>
                    {topProduct.sku && topProduct.sku !== 'N/A' && <p className="text-[11px] text-slate-400 font-mono mt-1">SKU: {topProduct.sku}</p>}
                  </div>
                  <Link to="/analytics" className="inline-flex min-h-[40px] items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 font-medium">
                    Full breakdown <ArrowRight className="w-3 h-3" aria-hidden="true" />
                  </Link>
                </>
              ) : (
                <div className="flex flex-col items-center py-6 text-center">
                  <ShoppingBag className="w-7 h-7 text-slate-300 mb-1.5" aria-hidden="true" />
                  <p className="text-xs text-slate-400">No returns this week yet</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar       { width:5px; height:5px; }
        .custom-scrollbar::-webkit-scrollbar-track  { background:#f8fafc; border-radius:10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb  { background:#cbd5e1; border-radius:10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background:#94a3b8; }
      `}</style>
    </div>
  );
};

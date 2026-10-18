/**
 * Reports API (CONTRACT §5) — `GET /api/reports/<type>?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 *
 * Exposes the report catalogue (`REPORT_TYPES`), a typed fetcher and a
 * converter to the shared spreadsheet model (`ReportTable`, src/utils/excel.ts).
 */
import { apiClient } from './http';
import type { ColumnType, ReportColumn, ReportTable } from '../utils/excel';

export type ReportTypeId =
  | 'gift-vouchers'
  | 'refunds'
  | 'store-credit'
  | 'transactions'
  | 'exchanges'
  | 'requests'
  | 'most-returned-products'
  | 'return-reasons'
  | 'agent-performance'
  | 'restocks';

export type ReportCategory = 'Money' | 'Requests' | 'Products' | 'Team' | 'Operations';

/** lucide-react icon names (resolved to components in src/components/Reports). */
export type ReportIconName =
  | 'Gift' | 'CreditCard' | 'Wallet' | 'Receipt' | 'ArrowRightLeft'
  | 'ClipboardList' | 'Package' | 'HelpCircle' | 'Users' | 'RotateCcw';

export interface ReportTypeMeta {
  id: ReportTypeId;
  title: string;
  description: string;
  icon: ReportIconName;
  category: ReportCategory;
  /** Short name used for the Excel sheet (≤ 31 chars). */
  sheetName: string;
  /** Roles allowed by the backend. */
  roles: Array<'agent' | 'admin' | 'super_admin'>;
}

const ADMINS: ReportTypeMeta['roles'] = ['admin', 'super_admin'];

export const REPORT_CATEGORIES: ReportCategory[] = ['Money', 'Requests', 'Products', 'Team', 'Operations'];

export const REPORT_TYPES: ReportTypeMeta[] = [
  {
    id: 'gift-vouchers', title: 'Gift Vouchers Issued', sheetName: 'Gift Vouchers', icon: 'Gift', category: 'Money', roles: ADMINS,
    description: 'Every gift voucher issued — order, customer e-mail, value, expiry and the agent who issued it.',
  },
  {
    id: 'refunds', title: 'Refunds Issued', sheetName: 'Refunds', icon: 'CreditCard', category: 'Money', roles: ADMINS,
    description: 'Original-payment and manual refunds with method, reference / transaction ID, value and agent.',
  },
  {
    id: 'store-credit', title: 'Store Credit Given', sheetName: 'Store Credit', icon: 'Wallet', category: 'Money', roles: ADMINS,
    description: 'Store credit issued per order and customer, with per-agent totals.',
  },
  {
    id: 'transactions', title: 'All Money Movements', sheetName: 'Transactions', icon: 'Receipt', category: 'Money', roles: ADMINS,
    description: 'Complete ledger: gift vouchers, store credit, refunds and exchange invoices in one list.',
  },
  {
    id: 'requests', title: 'Return & Exchange Requests', sheetName: 'Requests', icon: 'ClipboardList', category: 'Requests', roles: ADMINS,
    description: 'Every request raised in the period — status, customer, items, value, reasons and refund method.',
  },
  {
    id: 'exchanges', title: 'Exchanges Processed', sheetName: 'Exchanges', icon: 'ArrowRightLeft', category: 'Requests', roles: ADMINS,
    description: 'Items returned vs sent, outcome (even / refund due / customer to pay), net amount and agent.',
  },
  {
    id: 'most-returned-products', title: 'Most Returned Products', sheetName: 'Most Returned Products', icon: 'Package', category: 'Products', roles: ADMINS,
    description: 'Products ranked by units returned or exchanged, with value, top reason and share of all units.',
  },
  {
    id: 'return-reasons', title: 'Return Reasons', sheetName: 'Return Reasons', icon: 'HelpCircle', category: 'Products', roles: ADMINS,
    description: 'Why customers return — requests, units, value and share for each reason.',
  },
  {
    id: 'agent-performance', title: 'Agent Performance', sheetName: 'Agent Performance', icon: 'Users', category: 'Team', roles: ADMINS,
    description: 'Per agent: gift vouchers, store credit and refunds issued (count & value), exchanges and restocks.',
  },
  {
    id: 'restocks', title: 'Restocks', sheetName: 'Restocks', icon: 'RotateCcw', category: 'Operations', roles: ['agent', 'admin', 'super_admin'],
    description: 'Items put back into inventory — product, SKU, quantity, condition, status and who restocked.',
  },
];

export const getReportMeta = (id: ReportTypeId): ReportTypeMeta | undefined => REPORT_TYPES.find((r) => r.id === id);

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------
export type ReportValueType = 'text' | 'number' | 'currency' | 'date' | 'datetime' | 'percent';

export interface ReportPayloadColumn {
  key: string;
  label: string;
  type: ReportValueType;
}

export interface ReportPayloadSummary {
  label: string;
  value: string | number;
  type: ReportValueType;
}

export interface ReportPayload {
  type: ReportTypeId;
  title: string;
  from: string;
  to: string;
  generatedAt?: string;
  generatedBy?: string;
  columns: ReportPayloadColumn[];
  rows: Array<Record<string, unknown>>;
  summary: ReportPayloadSummary[];
}

const VALUE_TYPES: ReadonlySet<string> = new Set(['text', 'number', 'currency', 'date', 'datetime', 'percent']);

const asValueType = (t: unknown): ReportValueType =>
  (typeof t === 'string' && VALUE_TYPES.has(t) ? t : 'text') as ReportValueType;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate / normalise the backend response so the UI never crashes on a malformed field. */
export const normalizeReportPayload = (raw: unknown, type: ReportTypeId, from: string, to: string): ReportPayload => {
  if (!isRecord(raw)) throw new Error('The server returned an unexpected response for this report.');
  const columnsRaw = Array.isArray(raw.columns) ? raw.columns : [];
  const columns: ReportPayloadColumn[] = columnsRaw
    .filter(isRecord)
    .filter((c) => typeof c.key === 'string' && c.key)
    .map((c) => ({ key: String(c.key), label: String(c.label ?? c.key), type: asValueType(c.type) }));
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).filter(isRecord);
  // If the server sent rows but no column metadata, derive text columns from the first row.
  if (!columns.length && rows.length) {
    Object.keys(rows[0]).forEach((k) => columns.push({ key: k, label: k, type: 'text' }));
  }
  const summary: ReportPayloadSummary[] = (Array.isArray(raw.summary) ? raw.summary : [])
    .filter(isRecord)
    .filter((s) => typeof s.label === 'string')
    .map((s) => ({
      label: String(s.label),
      value: typeof s.value === 'number' ? s.value : String(s.value ?? ''),
      type: asValueType(s.type),
    }));
  return {
    type,
    title: typeof raw.title === 'string' && raw.title ? raw.title : (getReportMeta(type)?.title ?? type),
    from: typeof raw.from === 'string' ? raw.from : from,
    to: typeof raw.to === 'string' ? raw.to : to,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : undefined,
    generatedBy: typeof raw.generatedBy === 'string' ? raw.generatedBy : undefined,
    columns,
    rows,
    summary,
  };
};

interface ReportResponse {
  success?: boolean;
  error?: string;
  report?: unknown;
}

/** Fetch one report for an IST calendar-day range (inclusive). Throws on failure. */
export const fetchReport = async (
  type: ReportTypeId,
  from: string,
  to: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ReportPayload> => {
  const res = await apiClient.get<ReportResponse>(`/reports/${encodeURIComponent(type)}`, {
    params: { from, to },
    signal: opts.signal,
  });
  const data = res.data;
  if (!data || data.success === false || !data.report) {
    throw new Error(data?.error || 'The report could not be generated. Please try again.');
  }
  return normalizeReportPayload(data.report, type, from, to);
};

// ---------------------------------------------------------------------------
// Conversion to the spreadsheet model
// ---------------------------------------------------------------------------
/** Number columns that must NOT be summed in a totals row. */
const NON_ADDITIVE = /(%|percent|share|rate|avg|average|mean|median|days|last ?4|phone|pincode|zip|rank|#)/i;
/** Currency columns that must NOT be summed (unit prices, balances snapshot …). */
const NON_ADDITIVE_MONEY = /(unit price|price per|balance|avg|average)/i;

const toColumnType = (c: ReportPayloadColumn): ColumnType => {
  if (c.type === 'number' && /(%|percent|share)/i.test(c.label)) return 'percent';
  return c.type;
};

export const toReportColumns = (columns: ReportPayloadColumn[]): ReportColumn[] =>
  columns.map((c) => {
    const type = toColumnType(c);
    let total = false;
    if (type === 'currency') total = !NON_ADDITIVE_MONEY.test(c.label);
    else if (type === 'number') total = !NON_ADDITIVE.test(c.label);
    return { key: c.key, label: c.label, type, total };
  });

export const toReportTable = (
  payload: ReportPayload,
  opts: { periodLabel?: string; generatedBy?: string; sheetName?: string } = {},
): ReportTable => {
  const meta = getReportMeta(payload.type);
  const columns = toReportColumns(payload.columns);
  return {
    title: meta?.title || payload.title,
    sheetName: opts.sheetName || meta?.sheetName || payload.title,
    periodLabel: opts.periodLabel,
    generatedBy: opts.generatedBy || payload.generatedBy,
    columns,
    rows: payload.rows,
    summary: payload.summary.map((s) => ({ label: s.label, value: s.value, type: s.type })),
    totals: columns.some((c) => c.total),
  };
};

/**
 * The "headline" money column of a report, used for the overview sheet:
 * prefers a currency column labelled Total…, then Value/Amount, then the first currency column.
 */
export const primaryValueColumn = (payload: ReportPayload): ReportPayloadColumn | undefined => {
  const money = payload.columns.filter((c) => c.type === 'currency' && !NON_ADDITIVE_MONEY.test(c.label));
  return money.find((c) => /^total/i.test(c.label))
    || money.find((c) => /(value|amount)/i.test(c.label))
    || money[0];
};

export const sumColumn = (payload: ReportPayload, key: string): number =>
  payload.rows.reduce((sum, r) => {
    const v = r[key];
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return sum + (isFinite(n) ? n : 0);
  }, 0);

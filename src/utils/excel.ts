/**
 * Shared spreadsheet export helpers (SheetJS community edition).
 *
 * A "report" is a list of typed columns + plain row objects. Every sheet gets a
 * small title block (report name, period, generated at/by), a header row with
 * an auto-filter, sensible column widths, ₹ currency formatting on money
 * columns and an optional totals row.
 */
import type * as XLSXTypes from 'xlsx';

type XLSXLib = typeof XLSXTypes;

/**
 * SheetJS is ~400 kB, so it is loaded on demand the first time a spreadsheet is built
 * (keeps it out of every staff page's bundle).
 */
let xlsxPromise: Promise<XLSXLib> | null = null;
const loadXlsx = (): Promise<XLSXLib> => {
  if (!xlsxPromise) {
    xlsxPromise = import('xlsx')
      .then((mod) => {
        const m = mod as unknown as XLSXLib & { default?: XLSXLib };
        return (m.utils ? m : m.default) as XLSXLib;
      })
      .catch((err) => {
        xlsxPromise = null; // allow a retry (e.g. after a flaky network / redeploy)
        console.error('Could not load xlsx:', err);
        throw new Error('Could not load the spreadsheet module. Check your connection (or reload the page) and try again.');
      });
  }
  return xlsxPromise;
};

// Re-exported for backwards compatibility; new code should import from './dates' directly.
export * from './dates';

export type ColumnType = 'text' | 'number' | 'currency' | 'date' | 'datetime' | 'percent';

export interface ReportColumn {
  key: string;
  label: string;
  type?: ColumnType;
  /** Include this column in the totals row (number / currency columns only). */
  total?: boolean;
  width?: number;
}

export interface ReportSummaryItem {
  label: string;
  value: string | number;
  type?: ColumnType;
}

export interface ReportTable {
  title: string;
  /** Sheet name (max 31 chars, sanitised automatically). */
  sheetName?: string;
  periodLabel?: string;
  generatedBy?: string;
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  summary?: ReportSummaryItem[];
  /** Add a totals row for columns flagged `total` (defaults to all currency columns). */
  totals?: boolean;
}

const CURRENCY_FMT = '"₹"#,##0.00';
const NUMBER_FMT = '#,##0.##';
const PERCENT_FMT = '0.0"%"';
const DATE_FMT = 'dd-mmm-yyyy';
const DATETIME_FMT = 'dd-mmm-yyyy hh:mm AM/PM';

const sanitizeSheetName = (name: string, used: Set<string>): string => {
  let base = (name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${i++})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  base = candidate;
  return base;
};

const toDate = (v: unknown): Date | null => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'object' && v !== null && 'toDate' in v && typeof (v as { toDate: unknown }).toDate === 'function') {
    try { return (v as { toDate: () => Date }).toDate(); } catch { return null; }
  }
  if (typeof v === 'object' && v !== null && 'seconds' in v) {
    const s = Number((v as { seconds: unknown }).seconds);
    return isNaN(s) ? null : new Date(s * 1000);
  }
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
};

const toNumber = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return isFinite(n) ? n : null;
};

const textOf = (v: unknown): string => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  if (typeof v === 'object') {
    const d = toDate(v);
    if (d) return d.toISOString();
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
};

/**
 * Neutralise spreadsheet formula injection (CSV / "DDE" injection) in CSV output: a text value
 * starting with = + - @ TAB or CR is prefixed with an apostrophe so Excel / Sheets treat it as
 * literal text. Plain numeric-looking values (phone numbers like "+91 98765 43210", negative
 * amounts) are left untouched. XLSX output needs no escaping: text is written as string cells,
 * which spreadsheet apps never evaluate as formulas.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const NUMERIC_LIKE = /^[+-]?[\d\s().,/-]+$/;
export const safeText = (s: string): string => (FORMULA_TRIGGER.test(s) && !NUMERIC_LIKE.test(s) ? `'${s}` : s);

const defaultWidth = (col: ReportColumn, rows: Array<Record<string, unknown>>): number => {
  if (col.width) return col.width;
  switch (col.type) {
    case 'currency': return 14;
    case 'number': case 'percent': return Math.max(10, col.label.length + 2);
    case 'date': return 13;
    case 'datetime': return 20;
    default: {
      const sample = rows.slice(0, 200).reduce((m, r) => Math.max(m, textOf(r[col.key]).length), col.label.length);
      return Math.min(60, Math.max(10, sample + 2));
    }
  }
};

/** Build a worksheet for one report. */
export const buildSheet = (XLSX: XLSXLib, report: ReportTable): XLSXTypes.WorkSheet => {
  const aoa: unknown[][] = [];
  aoa.push([report.title]);
  if (report.periodLabel) aoa.push([`Period: ${report.periodLabel}`]);
  aoa.push([`Generated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST${report.generatedBy ? ` by ${report.generatedBy}` : ''}`]);
  if (report.summary && report.summary.length) {
    report.summary.forEach((s) => aoa.push([String(s.label ?? ''), s.value]));
  }
  aoa.push([]);
  const headerRowIdx = aoa.length;
  aoa.push(report.columns.map((c) => c.label));

  report.rows.forEach((row) => {
    aoa.push(report.columns.map((c) => {
      const v = row[c.key];
      switch (c.type) {
        case 'currency': case 'number': case 'percent': return toNumber(v);
        case 'date': case 'datetime': return toDate(v);
        default: return textOf(v);
      }
    }));
  });

  const wantTotals = report.totals !== false && report.rows.length > 0;
  const totalCols = report.columns.map((c) => (c.total ?? c.type === 'currency'));
  let totalsRowIdx = -1;
  if (wantTotals && totalCols.some(Boolean)) {
    totalsRowIdx = aoa.length;
    aoa.push(report.columns.map((c, i) => {
      if (i === 0) return 'TOTAL';
      if (!totalCols[i]) return null;
      return report.rows.reduce((sum, r) => sum + (toNumber(r[c.key]) || 0), 0);
    }));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });

  // Number formats
  const firstDataRow = headerRowIdx + 1;
  const lastRow = aoa.length - 1;
  report.columns.forEach((c, ci) => {
    const fmt = c.type === 'currency' ? CURRENCY_FMT
      : c.type === 'number' ? NUMBER_FMT
      : c.type === 'percent' ? PERCENT_FMT
      : c.type === 'date' ? DATE_FMT
      : c.type === 'datetime' ? DATETIME_FMT : null;
    if (!fmt) return;
    for (let r = firstDataRow; r <= lastRow; r++) {
      const ref = XLSX.utils.encode_cell({ r, c: ci });
      const cell = ws[ref];
      if (cell && cell.v != null && cell.v !== '') cell.z = fmt;
    }
  });
  // Summary values formatting
  if (report.summary) {
    report.summary.forEach((s, i) => {
      const rowIdx = (report.periodLabel ? 3 : 2) + i;
      const ref = XLSX.utils.encode_cell({ r: rowIdx, c: 1 });
      if (ws[ref] && s.type === 'currency') ws[ref].z = CURRENCY_FMT;
    });
  }

  ws['!cols'] = report.columns.map((c) => ({ wch: defaultWidth(c, report.rows) }));
  if (report.rows.length > 0) {
    ws['!autofilter'] = {
      ref: XLSX.utils.encode_range({ s: { r: headerRowIdx, c: 0 }, e: { r: headerRowIdx + report.rows.length, c: report.columns.length - 1 } }),
    };
  }
  if (report.columns.length > 1) {
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.min(report.columns.length - 1, 6) } }];
  }
  void totalsRowIdx;
  return ws;
};

const triggerDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** Download one report as .xlsx */
export const downloadReportXlsx = async (report: ReportTable, filename: string): Promise<void> => {
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildSheet(XLSX, report), sanitizeSheetName(report.sheetName || report.title, new Set()));
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  triggerDownload(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), ensureExt(filename, 'xlsx'));
};

/** Download several reports as one workbook. An optional overview sheet goes first. */
export const downloadWorkbookXlsx = async (reports: ReportTable[], filename: string, overview?: ReportTable): Promise<void> => {
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  if (overview) XLSX.utils.book_append_sheet(wb, buildSheet(XLSX, overview), sanitizeSheetName(overview.sheetName || 'Summary', used));
  reports.forEach((r) => XLSX.utils.book_append_sheet(wb, buildSheet(XLSX, r), sanitizeSheetName(r.sheetName || r.title, used)));
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  triggerDownload(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), ensureExt(filename, 'xlsx'));
};

const csvEscape = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Download one report as UTF-8 CSV (with BOM so Excel shows ₹ and Indic names correctly). */
export const downloadReportCsv = async (report: ReportTable, filename: string): Promise<void> => {
  const lines: string[] = [];
  lines.push(report.columns.map((c) => csvEscape(safeText(c.label))).join(','));
  report.rows.forEach((row) => {
    lines.push(report.columns.map((c) => {
      const v = row[c.key];
      if (c.type === 'date' || c.type === 'datetime') {
        const d = toDate(v);
        return d ? csvEscape(d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })) : '';
      }
      if (c.type === 'currency' || c.type === 'number' || c.type === 'percent') {
        const n = toNumber(v);
        return n == null ? '' : String(Math.round(n * 100) / 100);
      }
      return csvEscape(safeText(textOf(v)));
    }).join(','));
  });
  triggerDownload(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), ensureExt(filename, 'csv'));
};

const ensureExt = (name: string, ext: string) => (name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`);

/** `ReGuard_<Report>_<from>_to_<to>` style file name (no extension). */
export const reportFileName = (reportName: string, from: string, to: string) =>
  `ReGuard_${reportName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${from}_to_${to}`;

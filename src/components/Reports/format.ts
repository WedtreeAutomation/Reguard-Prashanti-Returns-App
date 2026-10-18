import type { ReportValueType } from '../../Interfaces/reportsApi';

const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

const toNumber = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return isFinite(n) ? n : null;
};

const toDate = (v: unknown): Date | null => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'object' && v !== null) {
    const o = v as { toDate?: () => Date; seconds?: number; _seconds?: number };
    if (typeof o.toDate === 'function') { try { return o.toDate(); } catch { return null; } }
    const s = o.seconds ?? o._seconds;
    if (typeof s === 'number') return new Date(s * 1000);
  }
  return null;
};

export const formatCellValue = (v: unknown, type: ReportValueType = 'text'): string => {
  switch (type) {
    case 'currency': { const n = toNumber(v); return n == null ? '—' : inr2.format(n); }
    case 'number': { const n = toNumber(v); return n == null ? '—' : num.format(n); }
    case 'percent': { const n = toNumber(v); return n == null ? '—' : `${n.toFixed(1)}%`; }
    case 'date': {
      const d = toDate(v);
      return d ? d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : (v ? String(v) : '—');
    }
    case 'datetime': {
      const d = toDate(v);
      return d
        ? d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
        : (v ? String(v) : '—');
    }
    default: {
      if (v == null || v === '') return '—';
      if (Array.isArray(v)) return v.map((x) => formatCellValue(x, 'text')).join(', ');
      if (typeof v === 'boolean') return v ? 'Yes' : 'No';
      if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
      return String(v);
    }
  }
};

export const isNumericType = (t: ReportValueType) => t === 'currency' || t === 'number' || t === 'percent';

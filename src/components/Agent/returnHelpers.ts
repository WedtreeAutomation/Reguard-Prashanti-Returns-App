/**
 * Small, pure helpers shared by the agent screens (return details + modals).
 */
import type { ReturnData, ReturnItem, RejectedItem } from '../../Interfaces/types';

/** Fields the server adds to a return document (CONTRACT §2) that types.ts doesn't declare yet. */
export interface ReturnServerFields {
  restockedQtyByLineItem?: Record<string, number>;
  exchangeResult?: {
    /** 'unknown' when Shopify's balance could not be read (needsReview). */
    financialOutcome?: 'even' | 'refund' | 'extra' | 'unknown';
    needsReview?: boolean;
    netRefundAmount?: number;
    outstandingBalance?: number;
    invoiceSent?: boolean;
    invoiceError?: string | null;
    discountApplied?: number;
    /** Name used on the persisted doc (the HTTP response calls it discountApplied). */
    discountPercentage?: number;
    discountAppliedViaOrderEdit?: boolean;
    discountEditError?: string | null;
    unappliableAdjustment?: number;
  } | null;
  restockStatus?: string;
  restockRecordId?: string;
}

export type ReturnDoc = ReturnData & ReturnServerFields;

/** Parse "₹2,499.00" / "2499" into a number (0 when unparsable). */
export const priceToNumber = (price: string | number | null | undefined): number => {
  if (typeof price === 'number') return Number.isFinite(price) ? price : 0;
  const n = parseFloat(String(price ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Numeric Shopify order id from a number, a numeric string or a gid. */
export const toNumericOrderId = (id: string | number | null | undefined): number | null => {
  if (id === null || id === undefined || id === '') return null;
  if (typeof id === 'number') return Number.isFinite(id) && id > 0 ? id : null;
  const m = String(id).match(/(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Units already put back into inventory per line item. Prefers the server's
 * `restockedQtyByLineItem`; falls back to the legacy `restockedItems` array
 * (whose rows used either `quantityReturned` or `quantity`).
 */
export const restockedQtyMap = (data: ReturnData | null | undefined): Map<number, number> => {
  const map = new Map<number, number>();
  const byLine = (data as ReturnDoc | null | undefined)?.restockedQtyByLineItem;
  if (byLine && typeof byLine === 'object') {
    Object.entries(byLine).forEach(([k, v]) => {
      const id = Number(k);
      const qty = Number(v);
      if (Number.isFinite(id) && Number.isFinite(qty)) map.set(id, qty);
    });
    return map;
  }
  (data?.restockedItems || []).forEach((r) => {
    const row = r as { lineItemId: number; quantityReturned?: number; quantity?: number };
    const qty = Number(row.quantityReturned ?? row.quantity ?? 0) || 0;
    map.set(row.lineItemId, (map.get(row.lineItemId) || 0) + qty);
  });
  return map;
};

/** Items that were not rejected. */
export const getActiveItems = (items: ReturnItem[] = [], rejectedItems: RejectedItem[] = []): ReturnItem[] => {
  const rejectedIds = new Set((rejectedItems || []).map((r) => r.lineItemId));
  return (items || []).filter((item) => !rejectedIds.has(item.lineItemId));
};

export const formatINR = (n: number): string =>
  `₹${(Number.isFinite(n) ? n : 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

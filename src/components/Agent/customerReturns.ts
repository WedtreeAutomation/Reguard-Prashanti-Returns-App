/**
 * "Total Returns" / "Total Return Value" for the customer panel on the return
 * details page: every return + exchange request raised by the same customer,
 * matched by e-mail OR phone across `returns` (union by doc id).
 */
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../Interfaces/firebase';
import type { ReturnData } from '../../Interfaces/types';
import { priceToNumber } from './returnHelpers';

export interface CustomerReturnStats {
  /** Number of return + exchange requests (including the current one). */
  count: number;
  /** Σ item price × quantityReturned across those requests (₹). */
  value: number;
}

const MAX_QUERIES = 8;

const emailVariants = (email?: string | null): string[] => {
  const e = (email || '').trim();
  if (!e || !e.includes('@')) return [];
  return Array.from(new Set([e, e.toLowerCase()]));
};

/** Stored phone formats vary (+91…, 91…, 10 digits) — query the common spellings. */
const phoneVariants = (phone?: string | null): string[] => {
  const raw = (phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) return raw ? [raw] : [];
  const last10 = digits.slice(-10);
  return Array.from(new Set([raw, last10, `+91${last10}`, `91${last10}`, `+91 ${last10}`]));
};

const requestValue = (data: Partial<ReturnData>): number =>
  (data.items || []).reduce((sum, item) => sum + priceToNumber(item?.price) * (Number(item?.quantityReturned) || 0), 0);

/**
 * Throws only when every lookup failed (the caller shows "—").
 */
export const fetchCustomerReturnStats = async (
  identifiers: { emails: Array<string | null | undefined>; phones: Array<string | null | undefined> },
  current?: { id: string; data: Partial<ReturnData> } | null
): Promise<CustomerReturnStats> => {
  const emails = Array.from(new Set(identifiers.emails.flatMap(emailVariants)));
  const phones = Array.from(new Set(identifiers.phones.flatMap(phoneVariants)));

  const lookups = [
    ...emails.map((e) => query(collection(db, 'returns'), where('customer.email', '==', e))),
    ...phones.map((p) => query(collection(db, 'returns'), where('customer.phone', '==', p))),
  ].slice(0, MAX_QUERIES);

  const byId = new Map<string, Partial<ReturnData>>();
  if (current?.id) byId.set(current.id, current.data);

  if (lookups.length > 0) {
    const results = await Promise.allSettled(lookups.map((q) => getDocs(q)));
    let succeeded = 0;
    results.forEach((r) => {
      if (r.status !== 'fulfilled') return;
      succeeded += 1;
      r.value.docs.forEach((d) => byId.set(d.id, d.data() as Partial<ReturnData>));
    });
    if (succeeded === 0) throw new Error('Could not load the customer\'s return history');
  }

  let value = 0;
  byId.forEach((data) => { value += requestValue(data); });
  return { count: byId.size, value: Math.round(value * 100) / 100 };
};

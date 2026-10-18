/**
 * Shared refund plumbing for IssueRefundModal and ExchangeModal:
 * UI method ids → API methods, server error-code → message mapping, and the
 * "is this failure definitive?" rule that decides when an idempotency key may
 * be regenerated (CONTRACT §4.1).
 */
import axios from 'axios';
import { getApiErrorMessage } from '../../Interfaces/http';
import type { RefundApiMethod, RefundDeductions } from '../../Interfaces/api';

/** Refund method ids used by the modals' method picker (see RefundShared REFUND_METHODS). */
export type UiRefundMethod = 'original' | 'store_credit' | 'giftcard' | 'manual';

export const toApiRefundMethod = (method: UiRefundMethod): RefundApiMethod => {
  switch (method) {
    case 'original': return 'original_payment';
    case 'giftcard': return 'gift_card';
    case 'manual': return 'manual';
    case 'store_credit':
    default: return 'store_credit';
  }
};

export const REFUND_METHOD_LABELS: Record<UiRefundMethod, string> = {
  original: 'Original Payment Method',
  store_credit: 'Store Credit',
  giftcard: 'Gift Card',
  manual: 'Manual Refund',
};

export interface DescribedRefundError {
  message: string;
  /** Server code when one was returned (e.g. `amount_exceeds_cap`). */
  code?: string;
  /**
   * true when the server definitively rejected the attempt (nothing happened),
   * so a fresh idempotency key may be used next time. false when the outcome
   * is unknown (timeout / network / lock held) — the SAME key must be reused.
   */
  definitive: boolean;
  /** The password was wrong — re-prompt for it. */
  badPassword?: boolean;
  /** Outcome unknown: tell the agent to check Shopify before retrying. */
  unknownOutcome?: boolean;
  /** The return was already refunded — stop offering a retry. */
  alreadyDone?: boolean;
}

const inr = (n: unknown) => {
  const v = typeof n === 'number' ? n : parseFloat(String(n ?? ''));
  return Number.isFinite(v)
    ? `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;
};

/** Human message + retry semantics for any error thrown by a refund / exchange call. */
export const describeRefundError = (err: unknown, fallback = 'Failed to process refund. Please try again.'): DescribedRefundError => {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = (err.response?.data || {}) as { code?: string; error?: string; maxRefundable?: number | string };
    const code = data.code;

    if (!err.response) {
      return {
        message: 'No response from the server — the refund status is unknown. Check the order in Shopify (and refresh this page) before retrying.',
        definitive: false,
        unknownOutcome: true,
      };
    }
    switch (code) {
      case 'bad_refund_password':
        return { message: 'Incorrect refund password. Please try again.', code, definitive: true, badPassword: true };
      case 'refund_in_progress':
        return {
          message: 'Another refund for this return is already being processed. Wait a minute, refresh the page and check its status before trying again.',
          code, definitive: false,
        };
      case 'exchange_in_progress':
        return {
          message: 'This exchange is already being processed. Wait a minute and refresh the page before trying again.',
          code, definitive: false,
        };
      case 'already_refunded':
        return { message: 'This return has already been refunded. Refresh the page to see the details.', code, definitive: true, alreadyDone: true };
      case 'amount_exceeds_cap': {
        const max = inr(data.maxRefundable);
        return {
          message: max
            ? `The refund amount is more than the maximum refundable for this return (${max}). Reduce the amount and try again.`
            : (data.error || 'The refund amount is more than the maximum refundable for this return.'),
          code, definitive: true,
        };
      }
      case 'shopify_timeout':
        return {
          message: 'Shopify did not respond in time — the refund status is unknown. Check the order in Shopify before retrying.',
          code, definitive: false, unknownOutcome: true,
        };
      case 'refund_status_unknown':
      case 'exchange_status_unknown':
      case 'refund_recording_failed':
        return {
          message: data.error || 'The status of an earlier attempt is unknown. Check the order in Shopify and ask an admin to resolve this request before retrying.',
          code, definitive: false, unknownOutcome: true,
        };
      default:
        break;
    }
    if ((data as { statusUnknown?: boolean }).statusUnknown === true) {
      return { message: data.error || 'The outcome is unknown. Check the order in Shopify before retrying.', code, definitive: false, unknownOutcome: true };
    }
    if (status === 408 || status === 504 || err.code === 'ECONNABORTED') {
      return {
        message: 'The request timed out — the refund status is unknown. Check the order in Shopify before retrying.',
        code, definitive: false, unknownOutcome: true,
      };
    }
    if (status === 403) {
      return { message: data.error || 'You do not have permission to issue this refund.', code, definitive: true };
    }
    if (status !== undefined && status >= 400 && status < 500 && status !== 409 && status !== 429) {
      return { message: getApiErrorMessage(err, fallback), code, definitive: true };
    }
    // 409 without a known code, 429, 5xx: we cannot be sure nothing happened.
    return { message: getApiErrorMessage(err, fallback), code, definitive: false };
  }
  return { message: err instanceof Error && err.message ? err.message : fallback, definitive: true };
};

/** Totals breakdown sent as refund metadata (shared by both modals). */
export const buildDeductions = (totals: {
  restocking: number;
  reverseShipment: number;
  forwardShipment: number;
}, adjustment: number, taxes: number): RefundDeductions => ({
  restocking: round2(totals.restocking),
  reverseShipment: round2(totals.reverseShipment),
  forwardShipment: round2(totals.forwardShipment),
  adjustment: round2(adjustment),
  taxes: round2(taxes),
});

export const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100 + Number.EPSILON) / 100;

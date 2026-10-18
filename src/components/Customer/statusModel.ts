/**
 * Turns a server `PublicReturn` into the customer-facing tracking model used
 * by the status page (4-step timeline or a terminal rejected/closed state).
 */
import {
  CheckCircle2, CreditCard, PackageCheck, PackageSearch, PackageX, RefreshCw, Truck, XCircle,
} from 'lucide-react';
import type { PublicReturn } from '../../Interfaces/publicApi';
import { formatDate, parsePrice } from './customerUtils';

export type StepState = 'complete' | 'current' | 'upcoming';

export interface TrackingStep {
  key: 'received' | 'shipment' | 'inspection' | 'resolution';
  title: string;
  shortLabel: string;
  description: string;
  icon: any;
  state: StepState;
  meta?: string;
}

export interface StatusPresentation {
  label: string;
  icon: any;
  color: string;
  bg: string;
  border: string;
  gradient: 'plum' | 'green' | 'red' | 'slate';
}

export type TrackingModel =
  | { terminal: null; exchange: boolean; steps: TrackingStep[] }
  | { terminal: 'rejected' | 'closed'; exchange: boolean; title: string; message: string };

const SHIPMENT_LABELS: Record<string, string> = {
  'pickup created': 'Pickup scheduled with our courier partner',
  'pickup scheduled': 'Pickup scheduled with our courier partner',
  'in transit': 'On its way to our facility',
  'product reached': 'Reached our facility — being checked in',
  'pickup exception': "There was a pickup issue — we're on it",
  'pickup cancelled': 'Pickup was cancelled — please contact us',
  'self ship requested': "Please ship the item to the address we've emailed you",
  'received': 'Arrived at our facility',
  'item delivered': 'Arrived at our facility',
  'failed': "There was a shipping issue — we're on it",
};

const RECEIVED_VALUES = new Set(['received', 'item delivered', 'product reached']);

export const lower = (v: unknown) => String(v ?? '').trim().toLowerCase();

export const isExchangeRecord = (r: PublicReturn): boolean => {
  const t = lower(r.requestType);
  if (t) return t === 'exchange' || t === 'mixed';
  return (r.items || []).some((i) => lower(i.actionType) === 'exchange');
};

export const isMixedRecord = (r: PublicReturn): boolean => {
  const t = lower(r.requestType);
  if (t) return t === 'mixed';
  const acts = new Set((r.items || []).map((i) => lower(i.actionType) || 'return'));
  return acts.has('return') && acts.has('exchange');
};

export const requestTypeLabel = (r: PublicReturn) =>
  isMixedRecord(r) ? 'Return & Exchange' : isExchangeRecord(r) ? 'Exchange' : 'Return';

export const formatINR = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 })
    .format(n).replace('₹', '₹ ');

export const refundMethodLabel = (method?: string | null, giftCardLast4?: string | null): string => {
  switch (lower(method)) {
    case 'store_credit': return 'store credit';
    case 'gift_card':
    case 'giftcard': return giftCardLast4 ? `gift card ending ${giftCardLast4}` : 'gift card';
    case 'original':
    case 'original_payment':
    case 'refund': return 'original payment method';
    case 'manual': return 'account (manual refund)';
    default: return 'account';
  }
};

export const requestedMethodLabel = (method?: string | null): string => {
  switch (lower(method)) {
    case 'store_credit': return 'Store Credit';
    case 'gift_card': return 'Gift Card';
    case 'refund': return 'Original Payment';
    default: return '';
  }
};

export const exchangeOutcomeLabel = (outcome?: string | null): string => {
  switch (lower(outcome)) {
    case 'even': return 'Even exchange — nothing to pay';
    case 'refund': return 'Refund due to you';
    case 'extra': return 'Balance payable by you';
    default: return '';
  }
};

/** Courier tracking link: server URL first, Blue Dart public tracking as fallback. */
export const courierTrackingUrl = (r: PublicReturn): string | null => {
  if (r.trackingUrl && /^https:\/\//i.test(r.trackingUrl)) return r.trackingUrl;
  if (!r.awb) return null;
  const courier = lower(r.courierPartner);
  if (courier && !courier.includes('blue')) return null;
  return `https://www.bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo=${encodeURIComponent(r.awb)}`;
};

export const refundAmountOf = (r: PublicReturn): number => parsePrice(r.refundAmount ?? 0);

export const getTrackingModel = (r: PublicReturn): TrackingModel => {
  const status = lower(r.status);
  const ship = lower(r.shipmentStatus);
  const refundStatus = lower(r.refundStatus);
  const exchange = isExchangeRecord(r);
  const noun = exchange ? 'Exchange' : 'Return';

  if (status === 'denied' || status === 'rejected') {
    return {
      terminal: 'rejected', exchange,
      title: `${noun} Request Not Approved`,
      message: r.rejectionReason || 'This request did not meet our return policy requirements. Please contact support for details.',
    };
  }
  if (status === 'closed' || status === 'cancelled') {
    return {
      terminal: 'closed', exchange,
      title: `${noun} Request Closed`,
      message: r.allowResubmit
        ? "This request has been closed, but you're welcome to submit a new request."
        : (r.closeReason || 'This request has been closed.'),
    };
  }

  const refunded = !exchange && refundStatus === 'refunded';
  const settled = status === 'completed' || status === 'exchanged_created' || refunded;
  const fullyDone = status === 'completed' || refunded;
  const itemReceived = !!r.itemReceived || RECEIVED_VALUES.has(ship) || RECEIVED_VALUES.has(status) || settled;
  const shipmentStarted = (!!ship && ship !== 'not created') || !!r.awb;

  const step1: StepState = shipmentStarted || itemReceived ? 'complete' : 'current';
  const step2: StepState = itemReceived ? 'complete' : (shipmentStarted ? 'current' : 'upcoming');
  const step3: StepState = settled ? 'complete' : (itemReceived ? 'current' : 'upcoming');
  const step4: StepState = fullyDone ? 'complete' : (settled ? 'current' : 'upcoming');

  const refundAmt = refundAmountOf(r);
  const methodLabel = refundMethodLabel(r.refundMethod || r.requestedMethod, r.giftCardLast4);
  const outcome = lower(r.financialOutcome);

  let step4Description = exchange
    ? "Once your returned item passes inspection, we'll finalize your exchange here."
    : 'Once your returned item passes inspection, your refund will be issued here.';

  if (fullyDone) {
    step4Description = exchange
      ? (outcome === 'refund' && refundAmt > 0
        ? `Exchange complete — a refund of ${formatINR(refundAmt)} was issued to your ${methodLabel}.`
        : 'Your exchange is complete. No further payment or refund was needed.')
      : (refundAmt > 0
        ? `Your refund of ${formatINR(refundAmt)} has been issued to your ${methodLabel}.`
        : 'Your refund has been processed.');
  } else if (settled) {
    if (exchange && outcome === 'extra') {
      step4Description = r.outstandingBalance
        ? `Your replacement item is on its way! We've emailed a secure payment link for the ${formatINR(r.outstandingBalance)} balance.`
        : "Your replacement item is on its way! We've emailed a secure payment link for the remaining balance.";
    } else if (exchange && outcome === 'even') {
      step4Description = 'Your exchange is being finalized — no extra payment or refund needed.';
    } else {
      step4Description = 'Your refund is being processed and will reflect soon.';
    }
  }

  const step2Description = itemReceived
    ? 'Delivered to our facility.'
    : shipmentStarted
      ? (SHIPMENT_LABELS[ship] || 'Your item is on its way to us.')
      : 'Once approved, our team will arrange pickup or share shipping instructions.';
  const metaParts = [
    r.awb ? `AWB ${r.awb}` : '',
    r.courierPartner || '',
    r.pickupDate && !itemReceived ? `Pickup ${formatDate(r.pickupDate) || r.pickupDate}` : '',
  ].filter(Boolean);

  return {
    terminal: null, exchange,
    steps: [
      {
        key: 'received',
        title: `${noun} Request Received`,
        shortLabel: 'Request Received',
        description: step1 === 'current'
          ? "We've got your request — it'll be reviewed and processed shortly."
          : 'Your request was received and reviewed.',
        icon: PackageSearch,
        state: step1,
      },
      {
        key: 'shipment',
        title: 'On The Way To Us',
        shortLabel: 'Shipment In Progress',
        description: step2Description,
        icon: Truck,
        state: step2,
        meta: metaParts.length ? metaParts.join(' · ') : undefined,
      },
      {
        key: 'inspection',
        title: 'Received & Quality Check',
        shortLabel: 'Quality Check',
        description: step3 === 'current'
          ? "We've received your item and it's going through quality inspection."
          : (step3 === 'complete' ? 'Item received and inspected.' : 'Waiting for your item to arrive at our facility.'),
        icon: PackageCheck,
        state: step3,
      },
      {
        key: 'resolution',
        title: exchange ? 'Exchange Completed' : 'Refund Completed',
        shortLabel: exchange ? 'Processing Exchange' : 'Processing Refund',
        description: step4Description,
        icon: exchange ? RefreshCw : CreditCard,
        state: step4,
      },
    ],
  };
};

export const getStatusPresentation = (r: PublicReturn): StatusPresentation => {
  const model = getTrackingModel(r);
  if (model.terminal !== null) {
    return model.terminal === 'rejected'
      ? { label: 'Not Approved', icon: PackageX, color: 'rg-status-red', bg: 'rg-status-bg-red', border: 'rg-status-border-red', gradient: 'red' }
      : { label: 'Closed', icon: XCircle, color: 'rg-status-slate', bg: 'rg-status-bg-slate', border: 'rg-status-border-slate', gradient: 'slate' };
  }
  if (model.steps.every((s) => s.state === 'complete')) {
    return { label: model.exchange ? 'Exchange Completed' : 'Refund Completed', icon: CheckCircle2, color: 'rg-status-green', bg: 'rg-status-bg-green', border: 'rg-status-border-green', gradient: 'green' };
  }
  const current = model.steps.find((s) => s.state === 'current') || model.steps[0];
  return { label: current.shortLabel, icon: current.icon, color: 'rg-status-plum', bg: 'rg-status-bg-plum', border: 'rg-status-border-plum', gradient: 'plum' };
};

export const getContactMessage = (r: PublicReturn, phone: string) => {
  const model = getTrackingModel(r);
  if (model.terminal !== null) {
    return model.terminal === 'rejected'
      ? `For clarification on this decision, please contact us at ${phone}`
      : `To submit a new request, contact us at ${phone}`;
  }
  const curr = model.steps.find((s) => s.state === 'current');
  if (curr?.key === 'resolution') return `For questions about your ${model.exchange ? 'exchange' : 'refund'}, contact us at ${phone}`;
  if (curr?.key === 'shipment') return `For any changes to your pickup, contact us at ${phone}`;
  return `For further details, contact customer support at ${phone}`;
};

/** Newest first; ties broken by the -2/-3 suffix of the doc id. */
export const sortReturns = (list: PublicReturn[]) => [...list].sort((a, b) => {
  const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (tb !== ta) return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  return String(b.returnId).localeCompare(String(a.returnId), undefined, { numeric: true });
});

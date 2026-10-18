/**
 * Staff (agent/admin) API helpers for the Re-Guard dashboard.
 *
 * Every call goes through `apiClient` (src/Interfaces/http.ts), which attaches
 * the signed-in agent's Firebase ID token. There is no shared API key any more.
 *
 * Server-side responsibilities (CONTRACT §4): the backend records the acting
 * agent from the token, writes restock_history / refund_ledger, and sends the
 * refund / pickup / exchange / self-ship e-mails itself. The functions here
 * only *request* those actions — they never write audit records client-side.
 */
import { apiClient } from './http';
import { db } from './firebase';
import { collection, query, where, orderBy, getDocs } from 'firebase/firestore';
import type { Order, ReturnData, ReturnItem } from './types';

// Other modules import the client from here.
export { apiClient } from './http';

// ==========================================================
// TYPES
// ==========================================================
export interface RestockItem {
  lineItemId: number;
  quantityReturned: number;
  sku?: string;
  title?: string;
  variantId?: number;
  productId?: number;
  /** Per-item condition, independent of the overall record condition. */
  condition?: string;
  productImage?: string;
  customerImages?: string[];
}

/** A `restock_history` document (written by the server). */
export interface RestockRecord {
  id?: string;
  returnId: string;
  /** Numeric Shopify order id (legacy rows) — display `orderName || orderId`. */
  orderId: string;
  /** Order name (e.g. P905422); written by the server since the split. */
  orderName?: string;
  RAN: string;
  items: RestockItem[];
  totalQuantityRestocked: number;
  /** Firestore Timestamp (or Date for legacy rows). */
  restockedAt: any;
  restockedBy: string;
  restockedByEmail?: string;
  condition?: string;
  status: 'success' | 'pending' | 'failed';
  errorMessage?: string;
}

/** Response of `POST /orders/<id>/restock`. */
export interface RestockResponse {
  success: boolean;
  restockRecordId?: string;
  restocked: Array<{ lineItemId: number; quantity: number }>;
  skipped: Array<{ lineItemId: number; reason: string }>;
}

// Extended ReturnData with actionType support
export interface ReturnDataWithActionType extends ReturnData {
  actionType?: 'return' | 'exchange';
  items: Array<ReturnItem & { actionType?: 'return' | 'exchange' }>;
}

/** Result of a frontend-triggered notification (CONTRACT §4.2). Never throws. */
export interface NotifyResult {
  emailSent: boolean;
  error?: string;
}

const toNumericOrderId = (orderId: number | string | null | undefined): number | null => {
  if (orderId === null || orderId === undefined || orderId === '') return null;
  if (typeof orderId === 'number') return Number.isFinite(orderId) && orderId > 0 ? orderId : null;
  const match = String(orderId).match(/(\d+)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const errorText = (err: unknown): string => {
  const data = (err as { response?: { data?: { error?: string } } })?.response?.data;
  if (data?.error) return data.error;
  return err instanceof Error ? err.message : 'Request failed';
};

// ==========================================================
// SHOPIFY ORDER NOTE / TAG
// ==========================================================
/** Adds a timeline note to the Shopify order. Best effort: resolves false on failure. */
export const addShopifyNote = async (
  orderNumericId: number | string,
  ran: string,
  eventTitle: string,
  message: string
): Promise<boolean> => {
  const id = toNumericOrderId(orderNumericId);
  if (!id) return false;
  try {
    await apiClient.post(`/orders/${id}/order-note`, { ran, eventTitle, message });
    return true;
  } catch (error) {
    console.error(`Failed to add Shopify note (${eventTitle}):`, errorText(error));
    return false;
  }
};

/** Adds a tag to the Shopify order. Best effort: resolves false on failure. */
export const addShopifyTag = async (orderId: string | number, tag: string): Promise<boolean> => {
  const id = toNumericOrderId(orderId);
  if (!id) return false;
  try {
    const response = await apiClient.post(`/orders/${id}/tags`, { tag });
    return !!response.data?.success;
  } catch (error) {
    console.error('Failed to add Shopify tag:', errorText(error));
    return false;
  }
};

// ==========================================================
// ORDERS / PRODUCTS
// ==========================================================
/** All orders of a customer by e-mail or phone (staff only). Resolves [] on failure. */
export const fetchOrdersByCustomer = async (identifier: string): Promise<Order[]> => {
  try {
    const response = await apiClient.post('/orders/customer', { identifier });
    return response.data?.orders || [];
  } catch (error) {
    console.error('Error fetching customer history:', errorText(error));
    return [];
  }
};

/** Shopify order by order name (staff only). Resolves null on failure. */
export const fetchShopifyOrder = async (orderName: string): Promise<Order | null> => {
  try {
    const response = await apiClient.get(`/orders/${encodeURIComponent(orderName)}`);
    return response.data?.order ?? null;
  } catch (error) {
    console.error('Error fetching Shopify order details:', errorText(error));
    return null;
  }
};

export const fetchProductDetails = async (productId: number): Promise<{ image: string | null; tags: string[] }> => {
  if (!productId) return { image: null, tags: [] };
  try {
    const response = await apiClient.get(`/products/${productId}`);
    return response.data;
  } catch (error) {
    console.error('Error fetching product details:', errorText(error));
    return { image: null, tags: [] };
  }
};

export const fetchProductVariants = async (productId: number) => {
  const response = await apiClient.get(`/products/${productId}/variants`);
  return response.data.product;
};

export const fetchProductVariantsBySku = async (sku: string) => {
  const response = await apiClient.get(`/products/by-sku/${encodeURIComponent(sku)}/variants`);
  return response.data.product;
};

export const getCustomerBalances = async (identifier: string, identifierType: 'email' | 'phone' = 'email') => {
  const response = await apiClient.post('/customer/balances', { identifier, identifierType });
  return response.data;
};

// ==========================================================
// RESTOCK
// ==========================================================
/**
 * Pure inventory adjustment for received items (never touches the order's
 * financial / disposition state). The server caps quantities by what was
 * returned minus `restockedQtyByLineItem`, updates the return document and
 * writes `restock_history` (success or failure).
 *
 * Throws on failure (axios error — use getApiErrorMessage).
 */
export const restockShopifyItems = async (
  returnId: string,
  orderNumericId: number | string,
  items: RestockItem[],
  condition: string
): Promise<RestockResponse> => {
  if (!returnId) throw new Error('Return ID is required');
  if (!items || items.length === 0) throw new Error('No items to restock');
  const id = toNumericOrderId(orderNumericId);
  if (!id) throw new Error('A valid Shopify order ID is required to restock');
  const invalid = items.filter((i) => !i.lineItemId || !(i.quantityReturned > 0));
  if (invalid.length > 0) throw new Error('Some items have no line item or quantity');

  const response = await apiClient.post(`/orders/${id}/restock`, {
    returnId,
    condition: condition || 'Unknown',
    items: items.map((i) => ({
      lineItemId: i.lineItemId,
      quantityReturned: i.quantityReturned,
      sku: i.sku || '',
      title: i.title || '',
      condition: i.condition || condition || 'Unknown',
      productImage: i.productImage || '',
      customerImages: i.customerImages || [],
    })),
  });
  const data = response.data || {};
  if (data.success === false) throw new Error(data.error || 'Restock failed');
  return {
    success: true,
    restockRecordId: data.restockRecordId,
    restocked: Array.isArray(data.restocked) ? data.restocked : [],
    skipped: Array.isArray(data.skipped) ? data.skipped : [],
  };
};

/** Restock history of one return (newest first). Resolves [] on failure. */
export const getRestockHistory = async (returnId: string): Promise<RestockRecord[]> => {
  try {
    const q = query(collection(db, 'restock_history'), where('returnId', '==', returnId), orderBy('restockedAt', 'desc'));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() } as RestockRecord));
  } catch (error) {
    console.error('Failed to fetch restock history:', errorText(error));
    return [];
  }
};

// ==========================================================
// CONVERT RETURN <-> EXCHANGE
// ==========================================================
/**
 * Flip the whole request (or one line item when `lineItemId` is given) between
 * return and exchange. `returnId` is the Firestore doc id. Throws on failure
 * (409 when the return is terminal / refunded / exchange already processed).
 */
export const convertReturnActionType = async (
  returnId: string,
  newActionType: 'return' | 'exchange',
  lineItemId?: number
): Promise<{ actionType?: 'return' | 'exchange'; type?: string; items?: ReturnItem[] }> => {
  const response = await apiClient.post(`/returns/${encodeURIComponent(returnId)}/convert-action`, {
    newActionType,
    ...(lineItemId !== undefined ? { lineItemId } : {}),
  });
  return response.data || {};
};

// ==========================================================
// NOTIFICATIONS (server builds the payload from Firestore/Shopify)
// ==========================================================
const notify = async (event: string, body: Record<string, unknown>): Promise<NotifyResult> => {
  try {
    const response = await apiClient.post(`/notify/${event}`, body);
    return { emailSent: !!response.data?.emailSent, error: response.data?.emailSent ? undefined : response.data?.error };
  } catch (error) {
    return { emailSent: false, error: errorText(error) };
  }
};

/** Whole-request rejection e-mail (`return_closed` when allowResubmit, else `return_rejected`). */
export const notifyReturnRejected = (returnId: string, reason: string, allowResubmit: boolean) =>
  notify('return-rejected', { returnId, reason, allowResubmit });

/** Single-item rejection e-mail. */
export const notifyItemRejected = (returnId: string, lineItemId: number, reason: string) =>
  notify('item-rejected', { returnId, lineItemId, reason });

/** "We received your return" e-mail — call only after the receipt was saved. */
export const notifyReturnReceived = (returnId: string) => notify('return-received', { returnId });

// ==========================================================
// REFUNDS (CONTRACT §4.1)
// ==========================================================
export type RefundApiMethod = 'gift_card' | 'store_credit' | 'original_payment' | 'manual';

export const REFUND_ENDPOINTS: Record<RefundApiMethod, string> = {
  gift_card: '/refund/gift-card',
  store_credit: '/refund/store-credit',
  original_payment: '/refund/original-payment',
  manual: '/refund/manual',
};

export interface RefundLineItem {
  /** `gid://shopify/LineItem/<id>` */
  lineItemId: string;
  quantity: number;
  sku?: string;
  alreadyRestockedQuantity?: number;
  restock?: boolean;
}

export interface RefundDeductions {
  restocking: number;
  reverseShipment: number;
  forwardShipment: number;
  adjustment: number;
  taxes: number;
}

export interface RefundRequest {
  /** Firestore return doc id. */
  returnId: string;
  /** One per user attempt (see newIdempotencyKey). */
  idempotencyKey: string;
  /** Agent-entered refund password (verified server-side). */
  refundPassword?: string;
  /** Order name (display / legacy). */
  orderId: string;
  /** `gid://shopify/Order/<id>` */
  shopifyOrderId?: string;
  /** Amount as a 2-dp string; the server re-validates it against its own cap. */
  amount: string;
  note: string;
  lineItems: RefundLineItem[];
  notifyCustomer: boolean;
  manualMethod?: string;
  manualReference?: string;
  metadata: {
    orderName: string;
    isFullReturn?: boolean;
    baseAmount?: number;
    netBalance?: number;
    shippingRefundAddition?: number;
    deductions?: RefundDeductions;
    quantityMultiplied?: Record<string, boolean>;
    source?: 'refund' | 'exchange';
  };
}

export interface RefundResponse {
  success: boolean;
  ledgerId?: string;
  emailSent?: boolean;
  /** true when the server returned the stored result of an earlier identical attempt. */
  duplicate?: boolean;
  refundMethod?: string;
  refundId?: string;
  transactionId?: string;
  amount?: string | number;
  currency?: string;
  /** Full gift-card code — returned ONLY here (show it once to the agent; never persist it client-side). */
  giftCardCode?: string;
  /** Last 4 of the gift-card code (what the return doc stores). */
  giftCardLast4?: string;
  firebaseUpdated?: boolean | string;
  errorMessage?: string;
  error?: string;
}

/** Issue a refund through one of the four refund endpoints. Throws on failure. */
export const issueRefund = async (method: RefundApiMethod, request: RefundRequest): Promise<RefundResponse> => {
  const response = await apiClient.post(REFUND_ENDPOINTS[method], request);
  const data = (response.data || {}) as RefundResponse;
  if (data.success === false) throw new Error(data.error || data.errorMessage || 'Failed to process refund');
  return { ...data, success: true };
};

// Refund-password pre-check lives in authApi.ts (verifyRefundPassword).

// ==========================================================
// EXCHANGES
// ==========================================================
export type FinancialOutcome = 'even' | 'refund' | 'extra';

export interface ExchangeProcessRequest {
  returnId: string;
  idempotencyKey: string;
  orderId: string;
  shopifyOrderId: string | number;
  /** Pre-commit estimate only — the server derives the real outcome from Shopify. */
  financialOutcome: FinancialOutcome;
  netRefundAmount: number;
  discountPercentage?: number;
  notifyCustomer?: boolean;
  removeItems: Array<{
    lineItemId: number | string;
    quantity: number;
    title?: string;
    sku?: string;
    reason?: string;
    alreadyRestockedQuantity?: number;
    restock?: boolean;
  }>;
  addItems: Array<{ variantId: number | string; quantity: number; title?: string; discountPercent?: number }>;
  totalFees?: number;
  feeBreakdown?: Partial<RefundDeductions>;
  currency?: string;
}

export interface ExchangeProcessResult {
  success: boolean;
  /** true when the exchange had already been processed (stored result, no Shopify calls). */
  resumed?: boolean;
  /** 'unknown' when Shopify's balance could not be read — the request needs review. */
  financialOutcome: FinancialOutcome | 'unknown';
  needsReview?: boolean;
  warnings?: string[];
  emailSent?: boolean;
  outstandingBalance: number;
  netRefundAmount: number;
  invoiceSent: boolean;
  invoiceError?: string | null;
  returnId: string | null;
  discountApplied: number;
  discountAppliedViaOrderEdit: boolean;
  discountEditError?: string | null;
  unappliableAdjustment?: number;
}

/** Process the exchange in Shopify (removes + adds items in one native call). Throws on failure. */
export const processShopifyExchange = async (payload: ExchangeProcessRequest): Promise<ExchangeProcessResult> => {
  const response = await apiClient.post('/exchange/process', payload);
  const data = response.data || {};
  if (data.success === false) throw new Error(data.error || 'Failed to process exchange');
  return data as ExchangeProcessResult;
};

export interface ExchangePreviewResult {
  success: boolean;
  netBalance: number;
  financialOutcome: FinancialOutcome;
  returnSubtotal: number;
  returnTax: number;
  exchangeSubtotal: number;
  exchangeTax: number;
  unresolvableItems?: string[] | null;
  unappliableAdjustment?: number;
  estimatedExchangeDiscountTotal?: number;
  discountedNetBalance?: number;
  discountedFinancialOutcome?: FinancialOutcome;
  error?: string;
}

export const previewShopifyExchange = async (
  payload: {
    shopifyOrderId: string | number;
    removeItems: Array<{ lineItemId: number | string; quantity: number; title?: string }>;
    addItems: Array<{ variantId: number | string; quantity: number; discountPercent?: number }>;
    totalFees?: number;
    valueAdjustment?: number;
    currency?: string;
  },
  signal?: AbortSignal
): Promise<ExchangePreviewResult> => {
  const response = await apiClient.post('/exchange/preview', payload, { signal });
  return response.data;
};

export const reconcileExchangeHold = async (orderNumericId: number | string): Promise<{
  success: boolean;
  released?: string[];
  checked?: number;
  outstandingBalance?: number;
  error?: string;
}> => {
  const response = await apiClient.post('/exchange/reconcile-hold', { orderNumericId });
  return response.data;
};

// ==========================================================
// BLUE DART (pickups, cancellation, serviceability, tracking)
// ==========================================================
export interface CreatePickupResponse {
  success: boolean;
  awbNumber: string;
  tokenNumber?: string;
  pickupDate?: string;
  labelUrl?: string | null;
  emailSent?: boolean;
  error?: string;
}

/** Generate a Blue Dart waybill + pickup. Throws on failure (409 `awb_exists`). */
export const createBlueDartPickup = async (payload: {
  returnId: string;
  idempotencyKey: string;
  Request: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
}): Promise<CreatePickupResponse> => {
  const response = await apiClient.post('/bluedart/waybill/generate', payload);
  const data = response.data || {};
  if (!data.success || !data.awbNumber) throw new Error(data.error || 'Failed to schedule pickup');
  return data as CreatePickupResponse;
};

export interface CancelPickupResponse {
  success: boolean;
  message?: string;
  awb_cancellation_status?: string;
  pickup_cancellation_status?: string;
  emailSent?: boolean;
  error?: string;
}

/**
 * Cancel a Blue Dart waybill/pickup. The server updates Firestore and e-mails
 * the customer only after Blue Dart confirms; otherwise it answers 502 and
 * nothing changes. Throws on failure.
 */
export const cancelBlueDartPickup = async (payload: {
  returnId: string;
  awbNumber: string;
  ran?: string;
  tokenNumber?: string;
  pickupDate?: string;
  reason: string;
  additionalNotes?: string;
  rescheduleAllowed: boolean;
}): Promise<CancelPickupResponse> => {
  const response = await apiClient.post('/bluedart/waybill/cancel', payload);
  const data = response.data || {};
  if (data.success === false) throw new Error(data.error || 'Blue Dart did not confirm the cancellation');
  return data as CancelPickupResponse;
};

/** Pincode → serviceable map. Throws on failure. */
export const checkPincodeServiceability = async (pincodes: string[]): Promise<Record<string, boolean>> => {
  const response = await apiClient.post('/bluedart/serviceability', { pincodes });
  if (!response.data?.success) throw new Error(response.data?.error || 'Serviceability check failed');
  return (response.data.results || {}) as Record<string, boolean>;
};

/** Raw Blue Dart tracking payload for one AWB. Throws on failure. */
export const fetchBlueDartTracking = async (awb: string): Promise<any> => {
  const response = await apiClient.get('/bluedart/tracking', { params: { awb } });
  if (!response.data?.success) throw new Error(response.data?.error || 'Tracking failed');
  return response.data.tracking;
};

// ==========================================================
// SELF SHIP
// ==========================================================
/** Ask the customer to ship the parcel themselves (server loads the warehouse + sends the e-mail). Throws on failure. */
export const requestSelfShip = async (payload: {
  returnId: string;
  warehouseId: string;
  instructions?: string;
  deadline?: string;
}): Promise<{ success: boolean; emailSent: boolean }> => {
  const response = await apiClient.post('/returns/self-ship', payload);
  const data = response.data || {};
  if (data.success === false) throw new Error(data.error || 'Failed to request self-ship');
  return { success: true, emailSent: !!data.emailSent };
};

// ==========================================================
// REPORTS
// ==========================================================
export interface ServerReport {
  type: string;
  title: string;
  from: string;
  to: string;
  generatedAt?: string;
  generatedBy?: string;
  columns: Array<{ key: string; label: string; type?: 'text' | 'number' | 'currency' | 'date' | 'datetime' }>;
  rows: Array<Record<string, unknown>>;
  summary?: Array<{ label: string; value: string | number; type?: string }>;
}

/** `GET /reports/restocks?from&to` (IST days, inclusive). Throws on failure. */
export const fetchRestockReport = async (from: string, to: string): Promise<ServerReport> => {
  const response = await apiClient.get('/reports/restocks', { params: { from, to } });
  if (!response.data?.success || !response.data?.report) throw new Error(response.data?.error || 'Report unavailable');
  return response.data.report as ServerReport;
};

/** Counts for every Returns-page tab (server-side, cached ~30 s). */
export type ReturnTabCounts = Record<'all' | 'open' | 'active' | 'product_received' | 'received' | 'completed' | 'rejected' | 'failed', number>;

/** `GET /returns/tab-counts?startMs&endMs` — throws on failure. */
export const fetchReturnTabCounts = async (start?: Date | null, end?: Date | null): Promise<{ counts: ReturnTabCounts; capped: boolean }> => {
  const params: Record<string, number> = {};
  if (start) params.startMs = start.getTime();
  if (end) params.endMs = end.getTime();
  const response = await apiClient.get('/returns/tab-counts', { params });
  if (!response.data?.success || !response.data?.counts) throw new Error(response.data?.error || 'Counts unavailable');
  return { counts: response.data.counts as ReturnTabCounts, capped: !!response.data.capped };
};

// ==========================================================
// DOWNLOADS
// ==========================================================
const saveBlob = (blob: Blob, filename: string) => {
  const blobUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => window.URL.revokeObjectURL(blobUrl), 1000);
};

export const downloadImageFile = async (url: string, filename: string): Promise<void> => {
  const response = await apiClient.get('/download/image', { params: { url, filename }, responseType: 'blob' });
  saveBlob(response.data as Blob, filename);
};

export const downloadImagesAsZip = async (
  images: Array<{ url: string; filename: string }>,
  zipFilename: string
): Promise<void> => {
  const response = await apiClient.post('/download/images-zip', { images, zipFilename }, { responseType: 'blob' });
  saveBlob(response.data as Blob, `${zipFilename}.zip`);
};

// ==========================================================
// MISC
// ==========================================================
export const getRefundMethodDisplay = (method: string): string => {
  switch (method) {
    case 'store_credit': return 'Store Credit';
    case 'gift_card': return 'Gift Card';
    case 'refund': return 'Original Payment Method';
    default: return method || 'Unknown';
  }
};

export interface ApiError {
  error: string;
  success?: boolean;
  code?: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}


/**
 * Customer (public portal) API — typed wrappers for CONTRACT.md §3.
 *
 * All calls go through `publicClient`, which attaches the order-scoped
 * customer token (`X-Customer-Token`) once one has been issued by
 * `verifyOrder` or `lookupReturns`. The browser never talks to Firestore /
 * Storage directly any more; eligibility, RAN generation, image storage and
 * e-mails are all server side.
 */
import type { AxiosProgressEvent } from 'axios';
import { publicClient, setCustomerToken, getCustomerToken } from './http';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------
export type ReturnActionType = 'return' | 'exchange';
export type RequestedMethod = 'store_credit' | 'gift_card' | 'refund' | 'none';
export type IneligibleReason = 'time_window' | 'final_sale' | 'international' | 'active_return' | 'not_fulfilled';

export interface ProductDetails {
  image: string | null;
  tags: string[];
}

export interface PublicLineItemProperty {
  name?: string | null;
  value?: unknown;
}

export interface PublicLineItem {
  id: number;
  title: string;
  quantity: number;
  /** Per-unit price as a string (Shopify REST style). */
  price: string;
  sku?: string | null;
  variant_title?: string | null;
  product_id?: number | null;
  properties?: PublicLineItemProperty[] | null;
  image?: string | null;
  /** ordered − already requested in non-rejected requests (server computed). */
  returnableQuantity?: number;
}

export interface PublicAddress {
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  province_code?: string | null;
  zip?: string | null;
  country?: string | null;
  phone?: string | null;
}

export interface PublicOrder {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  created_at: string;
  delivered_at?: string | null;
  tags?: string | null;
  currency?: string | null;
  total_price?: string | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  line_items: PublicLineItem[];
  customer?: { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null } | null;
  shipping_address?: PublicAddress | null;
  product_details?: Record<string, ProductDetails> | null;
}

export interface ExistingReturnSummary {
  returnId: string;
  RAN: string;
  status: string;
  items: { lineItemId: number; quantityReturned: number; actionType: ReturnActionType | string }[];
}

export interface OrderEligibility {
  eligible: boolean;
  reason?: IneligibleReason;
  returnDaysLimit?: number;
  daysSinceDelivery?: number;
}

export interface VerifyOrderResponse {
  success: boolean;
  order: PublicOrder;
  customerToken: string;
  existingReturns: ExistingReturnSummary[];
  eligibility: OrderEligibility;
}

export interface SubmitReturnItem {
  lineItemId: number;
  quantity: number;
  reason: string;
  note: string;
  actionType: ReturnActionType;
  imageCount: number;
}

export interface PickupAddress {
  name: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface SubmitReturnRequest {
  items: SubmitReturnItem[];
  requestedMethod: RequestedMethod;
  pickupAddress?: PickupAddress;
}

export interface SubmitReturnResponse {
  success: boolean;
  returnId: string;
  RAN: string;
  uploadToken: string;
}

export interface UploadImagesResponse {
  success: boolean;
  urls: string[];
}

export interface FinalizeReturnResponse {
  success: boolean;
  RAN: string;
  emailSent: boolean;
}

export interface PublicReturnItem {
  lineItemId: number;
  title: string;
  sku?: string | null;
  price?: string | number | null;
  quantityReturned: number;
  actionType?: ReturnActionType | string | null;
  reason?: string | null;
  productImage?: string | null;
  rejected?: boolean;
  rejectionReason?: string | null;
}

export interface PublicReturn {
  returnId: string;
  RAN: string;
  orderId: string;
  status: string;
  shipmentStatus?: string | null;
  refundStatus?: string | null;
  requestType?: 'return' | 'exchange' | 'mixed' | string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  items: PublicReturnItem[];
  requestedMethod?: RequestedMethod | string | null;
  awb?: string | null;
  courierPartner?: string | null;
  pickupDate?: string | null;
  trackingUrl?: string | null;
  refundMethod?: string | null;
  refundAmount?: number | string | null;
  giftCardLast4?: string | null;
  financialOutcome?: 'even' | 'refund' | 'extra' | string | null;
  timeline?: { title: string; at?: string | null }[];
  customer?: { name?: string | null; city?: string | null } | null;
  // Optional extras: used for nicer copy when the backend provides them.
  rejectionReason?: string | null;
  closeReason?: string | null;
  allowResubmit?: boolean | null;
  outstandingBalance?: number | null;
  itemReceived?: boolean | null;
}

export interface LookupReturnsResponse {
  success: boolean;
  customerToken: string;
  returns: PublicReturn[];
}

export interface BalancesResponse {
  success: boolean;
  storeCredit: { amount: number; currency: string } | null;
  giftCards: { last4: string; balance: number; currency: string; expiresOn?: string | null }[];
}

// ---------------------------------------------------------------------------
// Order the current customer token belongs to (so the status page can
// auto-load the right order). Stored next to the token in sessionStorage.
// ---------------------------------------------------------------------------
const CUSTOMER_ORDER_KEY = 'reguard_customer_order';

/** "#p905422 " -> "P905422" (order names are case-insensitive for lookups). */
export const normalizeOrderName = (value: string): string =>
  (value || '').trim().replace(/^#+/, '').replace(/\s+/g, '').toUpperCase();

const rememberCustomerSession = (token: string | null | undefined, orderName: string | null) => {
  setCustomerToken(token || null);
  try {
    if (token && orderName) sessionStorage.setItem(CUSTOMER_ORDER_KEY, orderName);
    else sessionStorage.removeItem(CUSTOMER_ORDER_KEY);
  } catch {
    /* storage unavailable — the token still lives in memory */
  }
};

/** Order name for which a customer token is held in this tab, if any. */
export const getCustomerSessionOrder = (): string | null => {
  if (!getCustomerToken()) return null;
  try {
    return sessionStorage.getItem(CUSTOMER_ORDER_KEY);
  } catch {
    return null;
  }
};

export const clearCustomerSession = () => rememberCustomerSession(null, null);

// ---------------------------------------------------------------------------
// Validation helpers shared by both public pages
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Returns an error message, or '' when the email/phone input looks valid. */
export const validateVerificationInput = (value: string): string => {
  const v = (value || '').trim();
  if (!v) return 'Please enter the email or phone number used at checkout.';
  if (v.includes('@')) return EMAIL_RE.test(v) ? '' : 'Please enter a valid email address.';
  const digits = v.replace(/\D/g, '');
  if (digits.length < 10) return 'Please enter a valid 10-digit phone number or your email address.';
  return '';
};

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
export const getPublicSettings = async (signal?: AbortSignal): Promise<{ returnDaysLimit: number }> => {
  const { data } = await publicClient.get<{ success: boolean; settings?: { returnDaysLimit?: number } }>(
    '/public/settings',
    { signal }
  );
  const days = Number(data?.settings?.returnDaysLimit);
  return { returnDaysLimit: Number.isFinite(days) && days > 0 ? days : 14 };
};

/** Verifies order ownership; stores the issued customer token for later calls. */
export const verifyOrder = async (orderName: string, verificationInput: string): Promise<VerifyOrderResponse> => {
  const name = normalizeOrderName(orderName);
  const { data } = await publicClient.post<VerifyOrderResponse>('/public/orders/verify', {
    orderName: name,
    verificationInput: verificationInput.trim(),
  });
  rememberCustomerSession(data?.customerToken, data?.order?.name ? normalizeOrderName(data.order.name) : name);
  return {
    ...data,
    existingReturns: Array.isArray(data?.existingReturns) ? data.existingReturns : [],
    eligibility: data?.eligibility ?? { eligible: true },
  };
};

export const submitReturn = async (body: SubmitReturnRequest): Promise<SubmitReturnResponse> => {
  const { data } = await publicClient.post<SubmitReturnResponse>('/public/returns', body);
  if (!data?.returnId || !data?.RAN || !data?.uploadToken) {
    throw new Error('The server did not confirm your request. Please try again.');
  }
  return data;
};

export interface UploadReturnImagesArgs {
  returnId: string;
  uploadToken: string;
  lineItemId: number;
  files: File[];
  /** Fraction 0..1 of this batch's bytes sent. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Uploads 1–5 photos for one line item (multipart/form-data). */
export const uploadReturnImages = async ({
  returnId, uploadToken, lineItemId, files, onProgress, signal,
}: UploadReturnImagesArgs): Promise<UploadImagesResponse> => {
  const form = new FormData();
  form.append('uploadToken', uploadToken);
  form.append('lineItemId', String(lineItemId));
  files.forEach((file) => form.append('files', file, file.name));
  const { data } = await publicClient.post<UploadImagesResponse>(
    `/public/returns/${encodeURIComponent(returnId)}/images`,
    form,
    {
      // Must override the client's JSON default, otherwise axios serialises
      // the FormData to JSON. In the browser axios then drops this header so
      // the boundary is set automatically.
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 180000,
      signal,
      onUploadProgress: (e: AxiosProgressEvent) => {
        if (onProgress && e.total) onProgress(Math.min(1, e.loaded / e.total));
      },
    }
  );
  if (!data?.success) throw new Error('Photo upload was not accepted.');
  return { success: true, urls: Array.isArray(data.urls) ? data.urls : [] };
};

/** Idempotent: writes the Shopify note and sends the confirmation e-mail once. */
export const finalizeReturn = async (returnId: string, uploadToken: string): Promise<FinalizeReturnResponse> => {
  const { data } = await publicClient.post<FinalizeReturnResponse>(
    `/public/returns/${encodeURIComponent(returnId)}/finalize`,
    { uploadToken }
  );
  return { success: !!data?.success, RAN: data?.RAN || '', emailSent: !!data?.emailSent };
};

/** Status-page lookup by order + email/phone; stores the issued token. */
export const lookupReturns = async (orderName: string, verificationInput: string): Promise<LookupReturnsResponse> => {
  const name = normalizeOrderName(orderName);
  const { data } = await publicClient.post<LookupReturnsResponse>('/public/returns/lookup', {
    orderName: name,
    verificationInput: verificationInput.trim(),
  });
  rememberCustomerSession(data?.customerToken, name);
  return { ...data, returns: Array.isArray(data?.returns) ? data.returns : [] };
};

/** Returns of the order the current customer token belongs to. */
export const getMyReturns = async (signal?: AbortSignal): Promise<PublicReturn[]> => {
  const { data } = await publicClient.get<{ success: boolean; returns: PublicReturn[] }>('/public/returns', { signal });
  return Array.isArray(data?.returns) ? data.returns : [];
};

/** Store credit / gift cards of the verified order's customer. */
export const getBalances = async (signal?: AbortSignal): Promise<BalancesResponse> => {
  const { data } = await publicClient.get<BalancesResponse>('/public/balances', { signal });
  return {
    success: !!data?.success,
    storeCredit: data?.storeCredit ?? null,
    giftCards: Array.isArray(data?.giftCards) ? data.giftCards : [],
  };
};

/** Public product image/tags (no PII). Never throws. */
export const getProductDetails = async (productId: number, signal?: AbortSignal): Promise<ProductDetails> => {
  if (!productId) return { image: null, tags: [] };
  try {
    const { data } = await publicClient.get<Partial<ProductDetails>>(`/products/${productId}`, { signal });
    return { image: data?.image ?? null, tags: Array.isArray(data?.tags) ? data.tags : [] };
  } catch {
    return { image: null, tags: [] };
  }
};

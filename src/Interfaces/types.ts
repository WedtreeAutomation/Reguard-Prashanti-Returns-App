import type { Timestamp } from 'firebase/firestore';

// Role-based access control
// - super_admin: full access to everything, including managing agents/admins
// - admin: can access Settings, Analytics, and issue refunds to the original
//          payment method, but cannot add/manage agents
// - agent: day-to-day return handling only. Can issue manual, store credit,
//          and gift card refunds, but NOT refunds to the original payment
//          method. No access to Settings, Analytics, or Agent management.
export type Role = "super_admin" | "admin" | "agent";

export interface LineItem {
  id: number;
  title: string;
  quantity: number;
  price: string;
  sku: string | null;
  variant_title: string | null;
  product_id: number | null;
}

export interface Customer {
  first_name?: string;
  last_name?: string;
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface Address {
  address1: string;
  address2: string | null;
  city: string;
  province?: string;
  province_code: string | null;
  zip: string;
  country: string;
  phone?: string | null;
  first_name?: string;     
  last_name?: string;
}

export interface ReturnItem {
  lineItemId: number;
  title: string;
  sku: string;
  price: string;
  productImage: string;
  quantityReturned: number;
  reason: string;
  actionType: string;
  note: string
  customerImages: string[];
}

export interface CreatePickupModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: string;
  orderNumericId?: number; // <--- ADD THIS
  RAN: string;
  customer?: Customer | null;
  currentUser?: User | null;
  shippingAddress?: Address | null;
  items?: ReturnItem[] | null;
  rejectedItems?: RejectedItem[] | null;
  onSuccess?: () => void;
}

export interface Dimensions {
  length: number;
  width: number;
  height: number;
  unit: 'cm' | 'in';
  weight: number;
  weightUnit: 'kg' | 'g' | 'lb';
}


export interface ReturnData {
  id: string;
  RAN: string;
  orderId: string;
  orderNumericId: number;
  type?: string;
  status: string;
  refundStatus?: string;
  shipmentStatus?: string;
  netRefundAmount: number;
  actionType?: 'return' | 'exchange';
  needsRefund?: boolean;
  financialOutcome?: 'even' | 'refund' | 'extra';
  discountPercentage?: number;
  discountAppliedViaOrderEdit?: boolean;
  discountEditError?: string | null;
  customer: {
    name: string;
    email: string;
    phone: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
  items: ReturnItem[];
  requestedMethod?: string;
  paymentMethod?: string;
  refundEligibility?: string;
  awb?: string;
  invoiceSent?: boolean;
  awaitingCustomerPayment?: boolean;
  outstandingBalance?: number;
  shippingLabelUrl?: string;
  trackingNumber?: string;
  courierPartner?: string;
  pickupDate?: string;
  pickupTime?: string;
  pickupAddress?: string;
  returned_product_received?: boolean;
  receivedAt?: any;
  itemCondition?: string;
  itemConditions?: Record<number, string>;
  isRestocked?: boolean;
  restockedItems?: Array<{
    lineItemId: number;
    quantityReturned: number;
    sku?: string;
    title?: string;
    condition?: string;
  }>;
  restockDecisions?: Record<number, boolean>;
  totalQuantityRestocked?: number;
  restockedAt?: any;
  restockFailed?: boolean;
  restockErrorMessage?: string;
  hasDefectiveItems?: boolean;
  rejectionReason?: string;
  denialReason?: string;
  closeReason?: string;
  allowResubmit?: boolean;
  DeniedMailSent?: boolean;
  ClosedMailSent?: boolean;
  emailSentAt?: any;
  lastEmailAttempt?: any;
  createdAt?: any;
  refundedAt?: any;
  updatedAt?: any;
  completedAt?: any;
  rejectedItems?: RejectedItem[];
}

export interface ReturnEmailPayload {
  RAN: string;
  orderId: string;
  orderNumericId: number;
  customer: {
    name: string;
    email: string;
    phone: string;
  };
  items: Array<{
    lineItemId: number;
    title: string;
    sku: string;
    price: number;
    productImage: string;
    quantityReturned: number;
    reason: string;
    note: string;
    customerImages: string[];
  }>;
  type: string;
  status: string;
  requestedMethod: string;
  refundEligibility: string;
  hasDefectiveItems: boolean;
  submittedAt: string;
  totalRefundAmount: number;
  imageCount: number;
  timeline: {
    submitted: string;
    estimatedProcessing: string;
  };
  shopDetails: {
    name: string;
    supportEmail: string;
    website: string;
  };
}

export interface Order {
  id: number;
  name: string;
  email: string;
  contact_email?: string | null;
  phone?: string | null;
  tags?: string; 
  currency: string;
  total_price: string;
  delivered_at?: string | null;
  created_at: string;
  product_details?: Record<string, { image: string | null; tags: string[] }>;
  financial_status: string;
  fulfillment_status: string | null;
  line_items: LineItem[];
  customer: Customer;
  shipping_address?: Address;
}

export interface FirestoreTimestamp {
  seconds: number;
  nanoseconds: number;
  toDate(): Date;
  toMillis(): number;
}

// Utility to handle persistent login state
const USER_STORAGE_KEY = 'prashanti_agent_user';

/**
 * Signed-in staff member. The authoritative copy comes from `GET /api/auth/me`
 * (see `src/components/common/AuthContext.tsx` / `useAuth()`); the copy in
 * localStorage is for display only and must never be used for authorization.
 */
export interface User {
  /** Firestore `agents` doc id. */
  id?: string;
  email: string;
  name: string;
  role: Role;
  profilePic?: string;
  phone?: string;
  active?: boolean;
  hasSetPassword?: boolean;
  /** Firestore timestamp (legacy docs) or ISO string (admin API). */
  createdAt?: FirestoreTimestamp | string | null;
  displayName?: string;
  updatedAt?: FirestoreTimestamp | string | null;
}

export const saveUserToStorage = (user: User) => {
  try {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
  } catch (error) {
    console.error("Failed to save user to storage:", error);
  }
};

export const getUserFromStorage = (): User | null => {
  try {
    const userStr = localStorage.getItem(USER_STORAGE_KEY);
    if (!userStr) return null;
    const parsed: unknown = JSON.parse(userStr);
    if (!parsed || typeof parsed !== 'object') return null;
    const u = parsed as Partial<User>;
    if (typeof u.email !== 'string') return null;
    return {
      ...u,
      email: u.email,
      name: typeof u.name === 'string' && u.name ? u.name : u.email,
      role: u.role === 'super_admin' || u.role === 'admin' || u.role === 'agent' ? u.role : 'agent',
    } as User;
  } catch (error) {
    console.error("Failed to get user from storage:", error);
    return null;
  }
};

export const clearUserFromStorage = () => {
  try {
    localStorage.removeItem(USER_STORAGE_KEY);
  } catch (error) {
    console.error("Failed to clear user from storage:", error);
  }
};

export interface ActivityItem {
  id: string;
  type: 'success' | 'info' | 'processing' | 'warning' | 'note' | 'notification';
  title: string;
  description: string;
  timestamp: Timestamp;
  user?: string;
  metadata?: any;
}

export interface Warehouse {
  id: string;
  name: string;
  code: string;
  externalId: string;
  address1: string;
  address2: string;
  address3: string;
  country: string;
  state: string;
  city: string;
  pincode: string;
  phone: string;
  isActive: boolean;
  createdAt?: any;
  updatedAt?: any;
}

export interface PackageTemplate {
  id: string;
  name: string;
  weight: number;
  weightUnit: 'kg' | 'g';
  length: number;
  width: number;
  height: number;
  dimensionUnit: 'cm' | 'in';
  isActive?: boolean;       
  createdAt?: any;          
  updatedAt?: any;
}
export interface ShopifyLineItem {
  id: number;
  price: string;
  sku: string;
  quantity: number;
  tax_lines?: Array<{ price: string }>;
  discount_allocations?: Array<{ amount: string }>;
}

export interface ShopifyOrder {
  id: number;
  name?: string;
  order_number?: number;
  total_price?: string;
  currency?: string;
  line_items?: ShopifyLineItem[];
  paymentGatewayNames?: string[];
  shipping_lines?: Array<{
    price: string;
  }>;
  customer?: {
    id: number;
    email: string;
  };
  discount_applications?: Array<{
    title?: string;
    description?: string;
    code?: string;
    value_type?: string;
    value?: string;
    [key: string]: any;
  }>;
  transactions?: Array<{
    gateway?: string;
    status?: string;
    kind?: string;
    amount?: string;
    [key: string]: any;
  }>;
}

export interface RefundDetails {
  method: string;
  baseAmount: number;
  deductions: number;
  finalAmount: number;
  taxDeducted: number;
  reverseShipmentFeeDeducted: number;
  restockingFee: number;
  adjustmentAmount: number;
  forwardShipmentFee?: number;
  shopifyRefundId?: string;
  transactionId?: string;
  shopifyResponse?: any;
  giftCardCode?: string;
  transactions?: any[];
}

export interface RefundResult {
  success: boolean;
  refundMethod: string;
  refundId?: string;
  transactionId?: string;
  amount?: string;
  currency?: string;
  firebaseUpdated?: string;
  giftCardCode?: string;
  errorMessage?: string;
  transactions?: any[];
  orderName?: string;
}

export interface CancelPickupModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: string;
  orderNumericId?: number;
  RAN: string;
  currentAWB?: string; 
  customerEmail?: string; 
  onSuccess?: (awb: string) => void;
  currentUser?: User | null;
}

export interface SelfShipModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: string;
  orderNumericId?: number;
  RAN: string;
  customerEmail?: string;
  customerName?: string;
  requestedMethod?: 'gift_card' | 'store_credit' | 'refund';
  currentUser?: User | null;
}

export interface MarkReceivedItemDecision {
  lineItemId: number;
  condition: string;
  restock: boolean;
  restockQuantity: number;
  quantityConditions?: string[];
  quantityRestockStatus?: boolean[];
}

export interface MarkReceivedModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (decisions: MarkReceivedItemDecision[]) => Promise<{ emailSent?: boolean } | void>;
  currentUser?: User | null;
  items?: ReturnItem[];
  RAN?: string;
  orderId?: string;
  customerName?: string;
  customerEmail?: string;
  requestedMethod?: string;
}

export interface RejectRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string, allowResubmit: boolean, itemId?: number) => Promise<void>;
  orderId?: string;
  RAN?: string;
  currentUser?: User | null;
  customerEmail?: string;
  customerName?: string;
  itemIdToReject?: number;
  itemToReject?: ReturnItem;
}

export interface RejectedItem {
  lineItemId: number;
  title: string;
  sku: string;
  quantityReturned: number;
  price: string;
  reason: string;
  rejectedAt: Timestamp;
  rejectedBy: string;
  rejectedByName: string;
}

export interface IssueRefundModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: string;
  data: ReturnData; // Replace the inline data type with ReturnData
  shopifyOrder?: ShopifyOrder;
  currentUser?: User | null;
}

export interface CheckboxWithInputProps {
  label: string;
  checked: boolean;
  onChangeCheck: (checked: boolean) => void;
  inputValue: string;
  onChangeInput: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  inputDisabled?: boolean;
  min?: number;
  max?: number;
}

export interface ReturnRequest {
  id: string;
  RAN: string;
  orderId: string;
  awb?: string;
  status: string;
  shipmentStatus?: string;
  refundStatus?: string;
  refundMethod?: string;
  requestedMethod?: 'refund' | 'gift_card' | 'store_credit';
  createdAt: any;
  actionType?: 'return' | 'exchange';
  needsRefund?: boolean;
  financialOutcome?: 'even' | 'refund' | 'extra';
  updatedAt?: any;
  refundedAt?: any;
  isRestocked?: boolean;
  completedAt?: any;
  receivedAt?: any;
  rejectionReason?: string;
  items: Array<{
    title: string;
    quantityReturned: number;
    price?: string;
  }>;
  customer: {
    name: string;
    email: string;
  };
  refundDetails?: {
    finalAmount?: number;
    method?: string;
  };
  refundAmount?: number;
  rejectedItems?: Array<any>;
}

export interface RecentActivity {
  id: string;
  RAN: string;
  orderId: string;
  type: 'return_submitted' | 'pickup_created' | 'item_received' | 'refund_issued' | 'return_rejected' | 'note_added';
  title: string;
  description: string;
  timestamp: any;
  amount?: number;
  method?: string;
}

export interface ProductReturnData {
  variantId: string;
  title: string;
  sku: string;
  price: number;
  image?: string;
  returnCount: number;
  totalQuantity: number;
  totalValue: number;
  reasons: Record<string, number>;
  returnRate: number; // percentage of orders this product was returned
}


export interface CustomerReturnData {
  customerId: string;
  name: string;
  email: string;
  returnCount: number;
  totalValue: number;
  phone?: string;
}

export interface StateReturnData {
  state: string;
  returnCount: number;
  totalValue: number;
  uniqueCustomers: number;
}

export interface ReasonData {
  reason: string;
  count: number;
  percentage: number;
  totalValue: number;
}

export interface ResolutionData {
  type: string;
  count: number;
  percentage: number;
  totalValue: number;
}

export interface DashboardStats {
  totalReturns: number;
  openReturns: number;
  pendingApproval: number;
  activeShipments: number;
  completedReturns: number;
  rejectedReturns: number;
  totalRefundedAmount: number;
  todayRefundedAmount: number;
  avgProcessingDays: number;
  pendingRefunds: number;
  giftCardReturns: number;
  storeCreditReturns: number;
  originalPaymentReturns: number;
}
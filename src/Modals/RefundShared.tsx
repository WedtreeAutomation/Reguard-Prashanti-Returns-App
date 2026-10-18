import { useState } from 'react';
import { BaseModal } from './BaseModal';
import { CheckboxWithInputProps } from '../Interfaces/types';

// ── Shopify money helpers (shared by IssueRefundModal + ExchangeModal) ──────
// These used to be copy-pasted (three times in ExchangeModal alone). The
// server re-validates every amount against its own cap; these only drive the
// on-screen estimate and the requested amount.
type LooseDiscountApp = { title?: string; description?: string; code?: string; value?: string };
type LooseLineItem = {
  id: number;
  sku?: string | null;
  price: string | number;
  quantity: number;
  tax_lines?: Array<{ price: string | number }>;
  discount_allocations?: Array<{ amount: string | number; discount_application_index?: number }>;
};
export type LooseShopifyOrder = {
  total_price?: string;
  currency?: string;
  discount_applications?: LooseDiscountApp[];
  transactions?: Array<{ gateway?: string; status?: string; kind?: string; amount?: string }>;
  line_items?: LooseLineItem[];
  shipping_lines?: Array<{ price: string | number }>;
} | null | undefined;

/** Parse "₹2,499.00" / "2499" / 2499 into a number (0 when unparsable). */
export const parsePrice = (price: string | number | null | undefined): number => {
  if (typeof price === 'number') return Number.isFinite(price) ? price : 0;
  const n = parseFloat(String(price ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const isStoreCreditOrGiftLabel = (app?: LooseDiscountApp | null): boolean => {
  const id = (app?.title || app?.description || app?.code || '').toLowerCase();
  return id.includes('credit') || id.includes('gift') || id.includes('wallet') || id.includes('reward') || id.includes('loyalty');
};

/** How the original order was paid (store credit / gift card / gateway cash). */
export const computePaymentBreakdown = (order: LooseShopifyOrder) => {
  let storeCreditTotal = 0;
  let giftCardTotal = 0;
  let originalCashTotal = parsePrice(order?.total_price || '0');
  const currency = order?.currency || 'INR';

  (order?.discount_applications || []).forEach((app) => {
    const id = (app.title || app.description || app.code || '').toLowerCase();
    if (id.includes('gift')) giftCardTotal += parsePrice(app.value || '0');
    else if (id.includes('credit') || id.includes('wallet') || id.includes('reward') || id.includes('loyalty')) {
      storeCreditTotal += parsePrice(app.value || '0');
    }
  });

  if (order?.transactions) {
    const nativeGiftCardTotal = order.transactions.reduce((sum, t) => (
      t.gateway === 'gift_card' && t.status === 'SUCCESS' && (t.kind === 'SALE' || t.kind === 'CAPTURE')
        ? sum + parsePrice(t.amount || '0')
        : sum
    ), 0);
    giftCardTotal += nativeGiftCardTotal;
    // Native gift cards are included in total_price — deduct them to get the cash actually paid.
    originalCashTotal = Math.max(0, originalCashTotal - nativeGiftCardTotal);
  }

  const hasMultipleMethods = (storeCreditTotal > 0 || giftCardTotal > 0) && originalCashTotal > 0;
  return { storeCreditTotal, giftCardTotal, originalCashTotal, currency, hasMultipleMethods };
};

export const findOrderLineItem = (order: LooseShopifyOrder, item: { lineItemId: number | string; sku?: string | null }) =>
  order?.line_items?.find((li) => li.id === Number(item.lineItemId) || (!!item.sku && li.sku === item.sku));

/**
 * Paid price of ONE unit of a returned item, net of real Shopify discounts
 * (store-credit / gift-card "discounts" are payment methods, not discounts).
 * Falls back to the price stored on the return item.
 */
export const getPaidUnitValue = (
  order: LooseShopifyOrder,
  item: { lineItemId: number | string; sku?: string | null; price?: string | number }
): number => {
  const li = findOrderLineItem(order, item);
  if (!li || !li.quantity) return parsePrice(item.price);
  const totalLineDiscount = (li.discount_allocations || []).reduce((sum, alloc) => {
    const idx = alloc.discount_application_index;
    const app = typeof idx === 'number' ? order?.discount_applications?.[idx] : undefined;
    if (app && isStoreCreditOrGiftLabel(app)) return sum;
    return sum + parsePrice(alloc.amount);
  }, 0);
  return parsePrice(li.price) - totalLineDiscount / li.quantity;
};

/** Tax charged on ONE unit of a returned item. */
export const getUnitTax = (order: LooseShopifyOrder, item: { lineItemId: number | string; sku?: string | null }): number => {
  const li = findOrderLineItem(order, item);
  if (!li?.tax_lines?.length || !li.quantity) return 0;
  return li.tax_lines.reduce((sum, t) => sum + parsePrice(t.price), 0) / li.quantity;
};

export const getOriginalShippingCost = (order: LooseShopifyOrder): number =>
  (order?.shipping_lines || []).reduce((sum, line) => sum + parsePrice(line.price), 0);

/** `gid://shopify/Order/<id>` for a numeric order id (undefined when missing). */
export const toShopifyOrderGid = (id?: number | string | null): string | undefined => {
  if (id === null || id === undefined || id === '') return undefined;
  const s = String(id);
  return s.startsWith('gid://') ? s : `gid://shopify/Order/${s.replace(/\D/g, '')}`;
};

// ── Per-item fee/adjustment state (shared shape for Exchange + Refund modals) ──
// Every deduction used to live as ONE global checkbox+amount applied to the
// whole return (fee × total quantity). That made it impossible to, say, only
// charge a restocking fee on the defective item and not the others. This
// state shape moves each fee to live on the line item it actually applies to.
export interface FeeToggle {
  enabled: boolean;
  amount: string; // currency amount per unit, kept as string to match input state
}

export interface ItemAdjustmentState {
  restocking: FeeToggle;
  reverseShipment: FeeToggle;
  forwardShipment: FeeToggle;
  valueAdjustment: { enabled: boolean; percent: string };
}

export const makeDefaultItemAdjustment = (
  opts: { reverseShipmentDefaultOn?: boolean } = {}
): ItemAdjustmentState => ({
  restocking: { enabled: false, amount: '' },
  reverseShipment: {
    enabled: !!opts.reverseShipmentDefaultOn,
    amount: DEFAULT_REVERSE_SHIPMENT_FEE,
  },
  forwardShipment: { enabled: false, amount: '0.00' },
  valueAdjustment: { enabled: false, percent: '' },
});

export interface ItemAdjustmentTotals {
  restocking: number;
  reverseShipment: number;
  forwardShipment: number;
  valueAdjustment: number;
  total: number;
}

export const computeItemAdjustmentTotals = (
  state: ItemAdjustmentState,
  unitValue: number,
  quantity: number,
  replacementUnitValue: number = unitValue,
  replacementQuantity: number = quantity
): ItemAdjustmentTotals => {
  const returnQty = Math.max(0, quantity || 0);
  const replacementQty = Math.max(0, replacementQuantity || 0);
  const restocking = state.restocking.enabled ? (parseFloat(state.restocking.amount || '0') || 0) * returnQty : 0;
  // Reverse/forward shipment are FLAT per-line costs -- "it costs ₹75 to
  // ship this parcel" doesn't become ₹150 because 2 units are in the box.
  // Only restocking (a genuine per-unit labor cost) and the goodwill
  // discount (a % of the line's total value) scale with quantity.
  const reverseShipment = state.reverseShipment.enabled ? (parseFloat(state.reverseShipment.amount || '0') || 0) : 0;
  const forwardShipment = state.forwardShipment.enabled ? (parseFloat(state.forwardShipment.amount || '0') || 0) : 0;
  const replacementLineValue = replacementUnitValue * replacementQty;
  const valueAdjustment = state.valueAdjustment.enabled
    ? (replacementLineValue * (parseFloat(state.valueAdjustment.percent || '0') || 0)) / 100
    : 0;
  return {
    restocking,
    reverseShipment,
    forwardShipment,
    valueAdjustment,
    total: restocking + reverseShipment + forwardShipment + valueAdjustment,
  };
};

export const sumItemAdjustmentTotals = (totalsList: ItemAdjustmentTotals[]): ItemAdjustmentTotals =>
  totalsList.reduce(
    (acc, t) => ({
      restocking: acc.restocking + t.restocking,
      reverseShipment: acc.reverseShipment + t.reverseShipment,
      forwardShipment: acc.forwardShipment + t.forwardShipment,
      valueAdjustment: acc.valueAdjustment + t.valueAdjustment,
      total: acc.total + t.total,
    }),
    { restocking: 0, reverseShipment: 0, forwardShipment: 0, valueAdjustment: 0, total: 0 }
  );

// ── Refund method catalogue (shared by IssueRefundModal + ExchangeModal) ──
export const REFUND_METHODS = [
  {
    id: 'original',
    label: 'Refund to original payment method via Shopify',
    description: 'Process refund back to original payment method (credit card, PayPal, etc.)',
    requiresCustomer: false
  },
  {
    id: 'store_credit',
    label: 'Refund as store credits',
    description: 'Issue store credit for future purchases',
    requiresCustomer: true
  },
  {
    id: 'giftcard',
    label: 'Refund via gift card',
    description: 'Create and send a gift card to customer',
    requiresCustomer: true
  },
  {
    id: 'manual',
    label: 'Mark as manually refunded',
    description: 'Mark refund as completed outside Shopify (no API call)',
    requiresCustomer: false
  }
] as const;

export type RefundMethod = typeof REFUND_METHODS[number]['id'];

/** Radio-card picker for the refund method (shared by both refund flows). */
export const RefundMethodPicker: React.FC<{
  value: RefundMethod;
  onChange: (method: RefundMethod) => void;
  allowOriginalPayment: boolean;
  hasCustomer: boolean;
  disabled?: boolean;
  showDescriptions?: boolean;
}> = ({ value, onChange, allowOriginalPayment, hasCustomer, disabled = false, showDescriptions = true }) => (
  <div className="space-y-2" role="radiogroup" aria-label="Refund method">
    {REFUND_METHODS.map((option) => {
      const restricted = option.id === 'original' && !allowOriginalPayment;
      const optionDisabled = disabled || (option.requiresCustomer && !hasCustomer) || restricted;
      const selected = value === option.id;
      return (
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          key={option.id}
          disabled={optionDisabled}
          onClick={() => !optionDisabled && onChange(option.id)}
          className={`w-full text-left p-3.5 min-h-[44px] rounded-lg border flex flex-col transition-all ${
            selected ? 'border-slate-800 bg-slate-50' : 'border-slate-200 bg-white hover:border-slate-300'
          } ${optionDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          <span className="flex justify-between items-center gap-3">
            <span className={`text-sm ${selected ? 'text-slate-900 font-medium' : 'text-slate-700'}`}>{option.label}</span>
            <span
              aria-hidden="true"
              className={`w-4 h-4 shrink-0 rounded-full border transition-all ${selected ? 'border-slate-900 border-[5px]' : 'border-slate-300'}`}
            />
          </span>
          {showDescriptions && <span className="text-xs text-slate-500 mt-1">{option.description}</span>}
          {option.requiresCustomer && !hasCustomer && <span className="text-xs text-amber-600 mt-1">Requires customer account</span>}
          {restricted && <span className="text-xs text-amber-600 mt-1">Requires admin access</span>}
        </button>
      );
    })}
  </div>
);

// ── Manual refund details (sent as manualMethod / manualReference) ──
export const MANUAL_REFUND_METHODS = [
  { id: 'bank_transfer', label: 'Bank transfer' },
  { id: 'upi', label: 'UPI' },
  { id: 'cash', label: 'Cash' },
  { id: 'cheque', label: 'Cheque' },
  { id: 'other', label: 'Other' },
] as const;

export type ManualRefundMethod = typeof MANUAL_REFUND_METHODS[number]['id'];

/** How a manual refund was paid (required) + an optional reference (UTR, cheque no., …). */
export const ManualRefundFields: React.FC<{
  method: ManualRefundMethod | '';
  onMethodChange: (method: ManualRefundMethod | '') => void;
  reference: string;
  onReferenceChange: (reference: string) => void;
  disabled?: boolean;
  idPrefix?: string;
}> = ({ method, onMethodChange, reference, onReferenceChange, disabled = false, idPrefix = 'manual-refund' }) => (
  <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
    <div className="space-y-1">
      <label htmlFor={`${idPrefix}-method`} className="text-sm font-medium text-slate-700">
        How was the refund paid? <span className="text-red-600" aria-hidden="true">*</span>
      </label>
      <select
        id={`${idPrefix}-method`}
        value={method}
        required
        aria-required="true"
        disabled={disabled}
        onChange={(e) => onMethodChange(e.target.value as ManualRefundMethod | '')}
        className="w-full min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-indigo-600 disabled:opacity-50"
      >
        <option value="">Select a method…</option>
        {MANUAL_REFUND_METHODS.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>
    </div>
    <div className="space-y-1">
      <label htmlFor={`${idPrefix}-reference`} className="text-sm font-medium text-slate-700">
        Reference <span className="font-normal text-slate-500">(optional — UTR, UPI ref., cheque no.…)</span>
      </label>
      <input
        id={`${idPrefix}-reference`}
        type="text"
        value={reference}
        maxLength={120}
        disabled={disabled}
        autoComplete="off"
        onChange={(e) => onReferenceChange(e.target.value)}
        className="w-full min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-indigo-600 disabled:opacity-50"
      />
    </div>
  </div>
);

/**
 * The full gift-card code is returned ONLY in the refund API response (return docs keep the
 * last 4 digits), so it is shown here once with a copy button.
 */
export const GiftCardCodeReveal: React.FC<{ code: string }> = ({ code }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      window.prompt('Copy the gift card code:', code);
    }
  };
  return (
    <div className="w-full max-w-sm rounded-lg border border-purple-200 bg-purple-50 p-3 text-left">
      <p className="text-xs font-semibold uppercase tracking-wide text-purple-700">Gift card code</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-base font-bold text-purple-900 select-all">{code}</code>
        <button
          type="button"
          onClick={() => void copy()}
          className="shrink-0 min-h-[40px] rounded-md border border-purple-300 bg-white px-3 text-sm font-medium text-purple-700 hover:bg-purple-100"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-2 text-xs text-purple-800">
        Shown once — copy it now. Only the last 4 digits are kept on the return.
      </p>
    </div>
  );
};

export const DEFAULT_REVERSE_SHIPMENT_FEE = '75.00';

export const formatRefundCurrency = (amount: number): string => {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
};

// ── Checkbox + amount input, with optional per-item quantity multiplier ──
export const CheckboxWithInput: React.FC<CheckboxWithInputProps & {
  showQuantityMultiplier?: boolean;
  quantity?: number;
}> = ({
  label,
  checked,
  onChangeCheck,
  inputValue,
  onChangeInput,
  placeholder = "0.00",
  disabled = false,
  inputDisabled = false,
  min = 0,
  max,
  showQuantityMultiplier = false,
  quantity = 1
}) => {
  const numericValue = parseFloat(inputValue) || 0;
  const multipliedTotal = numericValue * quantity;

  return (
    <div className="space-y-2">
      <label className={`flex items-center gap-3 cursor-pointer ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => !disabled && onChangeCheck(e.target.checked)}
          disabled={disabled}
          className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600 cursor-pointer disabled:cursor-not-allowed"
        />
        <span className="text-slate-700 text-sm">{label}</span>
      </label>
      {checked && (
        <div className="ml-7">
          <div className="flex border border-slate-200 rounded-md overflow-hidden w-full max-w-[220px]">
            <span className="px-3 py-2 bg-slate-100 border-r border-slate-200 text-slate-700 font-medium text-sm flex items-center">
              ₹
            </span>
            <input
              type="number"
              value={inputValue}
              onChange={(e) => {
                const val = e.target.value;
                if (val === '' || val === '-') {
                  onChangeInput(val);
                  return;
                }

                let numVal = parseFloat(val);

                if (isNaN(numVal)) {
                  onChangeInput('0');
                  return;
                }

                if (max !== undefined && numVal > max) {
                  onChangeInput(max.toString());
                  return;
                }
                if (min !== undefined && numVal < min) {
                  onChangeInput(min.toString());
                  return;
                }

                onChangeInput(val);
              }}
              placeholder={placeholder}
              disabled={inputDisabled || disabled}
              className="w-full px-3 py-2 text-sm outline-none bg-slate-50 disabled:bg-slate-100 disabled:cursor-not-allowed"
              min={min}
              max={max}
              step="0.01"
            />
          </div>
          {showQuantityMultiplier && quantity > 1 && (
            <div className="text-xs text-slate-500 mt-1 ml-1">
              × {quantity} items = ₹{formatRefundCurrency(multipliedTotal)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const CheckboxWithPercentage: React.FC<{
  label: string;
  checked: boolean;
  onChangeCheck: (checked: boolean) => void;
  percentageValue: string;
  onChangePercentage: (val: string) => void;
  baseAmount: number; // The total amount the % is calculated against (already qty x unit price)
  disabled?: boolean;
  // Optional "qty x unit price" breakdown shown next to the base amount so
  // an agent can visually confirm the discount is being calculated against
  // the FULL line value (unit price x quantity), not just a single unit.
  baseAmountBreakdown?: { quantity: number; unitValue: number };
}> = ({
  label,
  checked,
  onChangeCheck,
  percentageValue,
  onChangePercentage,
  baseAmount,
  disabled = false,
  baseAmountBreakdown
}) => {
  const numericPercent = parseFloat(percentageValue) || 0;
  const calculatedAmount = (baseAmount * numericPercent) / 100;

  return (
    <div className="space-y-2">
      <label className={`flex items-center gap-3 cursor-pointer ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => !disabled && onChangeCheck(e.target.checked)}
          disabled={disabled}
          className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600 cursor-pointer disabled:cursor-not-allowed"
        />
        <span className="text-slate-700 text-sm">{label}</span>
      </label>
      
      {checked && (
        <div className="ml-7 space-y-1">
          {baseAmountBreakdown && baseAmountBreakdown.quantity > 1 && (
            <div className="text-xs text-slate-500">
              Applies to {baseAmountBreakdown.quantity} × ₹{formatRefundCurrency(baseAmountBreakdown.unitValue)} = ₹{formatRefundCurrency(baseAmount)}
            </div>
          )}
          <div className="flex items-center gap-3">
          <div className="flex border border-slate-200 rounded-md overflow-hidden w-[120px]">
            <input
              type="number"
              value={percentageValue}
              onChange={(e) => {
                const val = e.target.value;
                let numVal = parseFloat(val);
                
                if (isNaN(numVal)) {
                  onChangePercentage('');
                  return;
                }
                
                if (numVal > 100) numVal = 100;
                if (numVal < 0) numVal = 0;
                
                onChangePercentage(val);
              }}
              placeholder="0"
              disabled={disabled}
              className="w-full px-3 py-2 text-sm outline-none bg-slate-50 disabled:bg-slate-100 disabled:cursor-not-allowed"
              min="0"
              max="100"
              step="0.1"
            />
            <span className="px-3 py-2 bg-slate-100 border-l border-slate-200 text-slate-700 font-medium text-sm flex items-center">
              %
            </span>
          </div>
          <span className="text-sm font-medium text-slate-700 bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-md border border-emerald-100">
            = ₹{formatRefundCurrency(calculatedAmount)}
          </span>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Quantity dropdown for a single line item ──────────────────────────────
// Lets an agent process fewer units than the full quantity that came back on
// one line (e.g. 2 units returned, only 1 is being exchanged right now).
// Hidden entirely when there's only ever 1 unit -- nothing to choose.
export const QuantityDropdown: React.FC<{
  value: number;
  max: number;
  onChange: (qty: number) => void;
  disabled?: boolean;
  label?: string;
}> = ({ value, max, onChange, disabled = false, label = 'Qty to process' }) => {
  if (max <= 1) return null;
  const options = Array.from({ length: max }, (_, i) => i + 1);
  return (
    <label className="inline-flex items-center gap-2 text-xs text-slate-600">
      <span className="font-medium">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 1)}
        className="border border-slate-200 rounded-md px-2 py-1 text-xs font-semibold text-slate-800 bg-white outline-none focus:ring-1 focus:ring-indigo-600 disabled:bg-slate-100 disabled:cursor-not-allowed"
      >
        {options.map(n => (
          <option key={n} value={n}>{n} of {max}</option>
        ))}
      </select>
    </label>
  );
};

export const ItemAdjustmentPanel: React.FC<{
  state: ItemAdjustmentState;
  onChange: (next: ItemAdjustmentState) => void;
  unitValue: number;
  quantity: number;
  replacementUnitValue?: number;
  replacementQuantity?: number;
  disabled?: boolean;
  showReturnFees?: boolean;
  showForwardShipment?: boolean;
  showValueAdjustment?: boolean;
  compact?: boolean;
}> = ({
  state, onChange, unitValue, quantity,
  replacementUnitValue = unitValue, replacementQuantity = quantity,
  disabled = false, showReturnFees = true, showForwardShipment = true,
  showValueAdjustment = true, compact = false
}) => {
  const totals = computeItemAdjustmentTotals(state, unitValue, quantity, replacementUnitValue, replacementQuantity);
  const wrap = compact ? 'space-y-1.5' : 'space-y-2.5';

  return (
    <div className={`${wrap} bg-slate-50/70 border border-slate-200 rounded-lg p-3`}>
      {showReturnFees && (
        <>
      <CheckboxWithInput
        label="Restocking fee"
        checked={state.restocking.enabled}
        onChangeCheck={(v) => onChange({ ...state, restocking: { ...state.restocking, enabled: v } })}
        inputValue={state.restocking.amount}
        onChangeInput={(v) => onChange({ ...state, restocking: { ...state.restocking, amount: v } })}
        disabled={disabled}
        min={0}
        max={unitValue * Math.max(1, quantity) + 1000}
        showQuantityMultiplier
        quantity={quantity}
      />
      <CheckboxWithInput
        label="Reverse shipment cost"
        checked={state.reverseShipment.enabled}
        onChangeCheck={(v) => onChange({ ...state, reverseShipment: { ...state.reverseShipment, enabled: v } })}
        inputValue={state.reverseShipment.amount}
        onChangeInput={(v) => onChange({ ...state, reverseShipment: { ...state.reverseShipment, amount: v } })}
        placeholder={DEFAULT_REVERSE_SHIPMENT_FEE}
        disabled={disabled}
        min={0}
        max={unitValue * Math.max(1, quantity) + 1000}
      />
        </>
      )}
      {showForwardShipment && (
        <CheckboxWithInput
          label="Forward shipment cost"
          checked={state.forwardShipment.enabled}
          onChangeCheck={(v) => onChange({ ...state, forwardShipment: { ...state.forwardShipment, enabled: v } })}
          inputValue={state.forwardShipment.amount}
          onChangeInput={(v) => onChange({ ...state, forwardShipment: { ...state.forwardShipment, amount: v } })}
          disabled={disabled}
          min={0}
          max={replacementUnitValue * Math.max(1, replacementQuantity) + 1000}
        />
      )}
      {showValueAdjustment && (
        <CheckboxWithPercentage
          label="Discount"
          checked={state.valueAdjustment.enabled}
          onChangeCheck={(v) => onChange({ ...state, valueAdjustment: { ...state.valueAdjustment, enabled: v } })}
          percentageValue={state.valueAdjustment.percent}
          onChangePercentage={(v) => onChange({ ...state, valueAdjustment: { ...state.valueAdjustment, percent: v } })}
          baseAmount={replacementUnitValue * Math.max(1, replacementQuantity)}
          baseAmountBreakdown={{ quantity: Math.max(1, replacementQuantity), unitValue: replacementUnitValue }}
          disabled={disabled}
        />
      )}
      {totals.total > 0.001 && (
        <div className="text-xs font-semibold text-slate-600 pt-1 border-t border-slate-200 flex justify-between">
          <span>Line total deduction</span>
          <span>₹{formatRefundCurrency(totals.total)}</span>
        </div>
      )}
    </div>
  );
};

// ── Line-item row inside a deductions/refund summary card ──
export const SummaryRow: React.FC<{ label: string; value: number; className?: string }> = ({
  label,
  value,
  className = "text-slate-700"
}) => (
  <div className={`flex justify-between text-xs ${className}`}>
    <span>{label}</span>
    <span>₹{formatRefundCurrency(value)}</span>
  </div>
);

// ── Refund password confirmation gate ──
// The password is sent to the server with the refund request (and optionally
// pre-checked via /auth/verify-refund-password). It is never compared in the
// browser any more.
export const PasswordPromptModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (password: string) => void | Promise<void>;
  isLoading?: boolean;
  error?: string | null;
  title?: string;
  confirmLabel?: string;
  description?: React.ReactNode;
}> = ({ isOpen, onClose, onConfirm, isLoading = false, error = null, title = 'Verify Refund', confirmLabel = 'Confirm Refund', description }) => {
  const [password, setPassword] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading || !password.trim()) return;
    const entered = password;
    setPassword('');
    void onConfirm(entered);
  };

  const handleClose = () => {
    if (isLoading) return;
    setPassword('');
    onClose();
  };

  return (
    <BaseModal isOpen={isOpen} onClose={handleClose} title={title} closeDisabled={isLoading}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {description && <div className="text-sm text-slate-600">{description}</div>}
        <div className="space-y-2">
          <label htmlFor="refund-password-input" className="text-sm font-medium text-slate-700">
            Enter Refund Password
          </label>
          <input
            id="refund-password-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your refund password"
            autoComplete="off"
            data-autofocus
            disabled={isLoading}
            className="w-full min-h-[44px] px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
          />
          <p className="text-xs text-slate-500">
            This password is required to process refunds for security purposes.
          </p>
        </div>

        {error && (
          <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm whitespace-pre-wrap">
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={handleClose}
            disabled={isLoading}
            className="flex-1 min-h-[44px] px-4 py-2 border border-slate-300 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isLoading || !password.trim()}
            className="flex-1 min-h-[44px] bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-md text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Processing...
              </span>
            ) : confirmLabel}
          </button>
        </div>
      </form>
    </BaseModal>
  );
};

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { BaseModal } from './BaseModal';
import {
  RefreshCw, AlertCircle, CheckCircle2,
  Loader2, ArrowRight, ShoppingBag,
  Tag, Layers, Info, Search, MinusCircle,
  CreditCard, Mail
} from 'lucide-react';
import {
  processShopifyExchange, previewShopifyExchange, apiClient, addShopifyNote,
  issueRefund, ExchangeProcessResult, RefundRequest,
} from '../Interfaces/api';
import { verifyRefundPassword } from '../Interfaces/authApi';
import { newIdempotencyKey, getApiErrorMessage } from '../Interfaces/http';
import { ReturnData, ReturnItem, User } from '../Interfaces/types';
import { canRefundOriginalPayment } from '../Interfaces/permissions';
import {
  REFUND_METHODS, RefundMethod, RefundMethodPicker,
  CheckboxWithInput, PasswordPromptModal,
  ItemAdjustmentState, makeDefaultItemAdjustment, computeItemAdjustmentTotals,
  sumItemAdjustmentTotals, QuantityDropdown, ItemAdjustmentPanel,
  computePaymentBreakdown, getPaidUnitValue, getUnitTax, toShopifyOrderGid, parsePrice,
  ManualRefundFields, ManualRefundMethod, GiftCardCodeReveal,
} from './RefundShared';
import {
  describeRefundError, toApiRefundMethod, REFUND_METHOD_LABELS, buildDeductions, round2,
} from '../components/Agent/refunds';
import { restockedQtyMap, ReturnDoc } from '../components/Agent/returnHelpers';

// ─── Types ─────────────────────────────────────────────────────────────────────
interface ShopifyVariant {
  id: number;
  title: string;
  sku: string;
  price: string;
  compare_at_price: string | null;
  inventory_quantity: number;
  available: boolean;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  image_id: number | null;
}

interface ShopifyProductOption {
  id: number;
  name: string;
  position: number;
  values: string[];
}

interface ShopifyProductImage {
  id: number;
  src: string;
  variant_ids: number[];
  alt: string | null;
}

interface ShopifyProductFull {
  id: number;
  title: string;
  handle: string;
  product_type: string;
  tags: string;
  status: string;
  variants: ShopifyVariant[];
  options: ShopifyProductOption[];
  images: ShopifyProductImage[];
}

interface ExchangeLineItem {
  id: string; // Unique identifier for the row
  originalItem?: ReturnItem; // Optional: Only exists if tied to a returned item
  isPureReturn: boolean;
  // Agent override: forces a row that was originally flagged as an
  // "exchange" to instead be treated as pooled return credit (removed +
  // refunded, no per-row replacement search required). This is what lets
  // 3 separate ₹1000 exchange items fund ONE ₹5000 replacement instead of
  // forcing 3 separate 1:1 replacement searches.
  creditOverride?: boolean;
  // How many of originalItem.quantityReturned this specific row covers.
  // Defaults to the full quantity; lowering it and clicking "Split" spins
  // off a sibling row for the remainder so e.g. 1 of 2 returned units can
  // be exchanged while the other is refunded.
  processQuantity: number;
  adjustments: ItemAdjustmentState;
  product: ShopifyProductFull | null;
  loadingProduct: boolean;
  errorProduct: string | null;
  selectedVariantId: number | null;
  selectedOptionValues: Record<string, string>;
  quantity: number;
  activePrice: number | null;
}

// A row counts as "pooled credit" (removed + refunded, no replacement
// required) either because it was submitted as a plain return, or because
// the agent explicitly converted an exchange row into credit in this modal.
const isCreditRow = (li: ExchangeLineItem) => li.isPureReturn || !!li.creditOverride;

export interface ExchangeModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Order name (display). */
  orderId: string;
  data: ReturnData;
  /** Firestore return doc id (defaults to data.id). */
  returnId?: string;
  currentUser?: User | null;
  onSuccess?: () => void;
  shopifyOrder?: any;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
const formatCurrency = (price: string | number) => {
  const n = typeof price === 'string' ? parseFloat(price) : price;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n).replace('₹', '₹ ');
};

const getVariantImage = (
  product: ShopifyProductFull,
  variantId: number | null,
): string | null => {
  if (!product.images?.length) return null;
  if (variantId) {
    const variantImg = product.images.find(
      i => i.variant_ids?.length > 0 && i.variant_ids.includes(variantId)
    );
    if (variantImg) return variantImg.src;
  }
  if (variantId) {
    const variant = product.variants.find(v => v.id === variantId);
    if (variant?.image_id) {
      const imgById = product.images.find(i => i.id === variant.image_id);
      if (imgById) return imgById.src;
    }
  }
  return product.images[0]?.src ?? null;
};

const findMatchingVariant = (
  variants: ShopifyVariant[],
  options: ShopifyProductOption[],
  selectedValues: Record<string, string>,
): ShopifyVariant | null => {
  return variants.find(v => {
    return options.every((opt, idx) => {
      const optionKey = `option${idx + 1}` as 'option1' | 'option2' | 'option3';
      const selected = selectedValues[opt.name];
      if (!selected) return true;
      return v[optionKey] === selected;
    });
  }) ?? null;
};

// ─── Option Selector ───────────────────────────────────────────────────────────
const OptionSelector = ({
  option,
  selectedValue,
  variants,
  options,
  allSelected,
  onSelect,
  allowOutOfStock,
}: {
  option: ShopifyProductOption;
  selectedValue: string;
  variants: ShopifyVariant[];
  options: ShopifyProductOption[];
  allSelected: Record<string, string>;
  onSelect: (optionName: string, value: string) => void;
  allowOutOfStock: boolean;
}) => {
  const isValueAvailable = (value: string) => {
    const testSelection = { ...allSelected, [option.name]: value };
    return variants.some(v =>
      options.every((opt, idx) => {
        const optKey = `option${idx + 1}` as 'option1' | 'option2' | 'option3';
        const sel = testSelection[opt.name];
        if (!sel) return true;
        return v[optKey] === sel;
      }) && (allowOutOfStock || v.available || v.inventory_quantity > 0)
    );
  };

  return (
    <div>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
        {option.name}
        {selectedValue && (
          <span className="ml-2 text-slate-700 normal-case font-normal">— {selectedValue}</span>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {option.values.map(value => {
          const available = isValueAvailable(value);
          const isSelected = selectedValue === value;
          return (
            <button
              key={value}
              onClick={() => available && onSelect(option.name, value)}
              disabled={!available}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${
                isSelected
                  ? 'bg-slate-900 text-white border-slate-900 shadow-sm'
                  : available
                    ? 'bg-white text-slate-700 border-slate-200 hover:border-slate-400'
                    : 'bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed line-through'
              }`}
            >
              {value}
            </button>
          );
        })}
      </div>
    </div>
  );
};

// ─── Single Item Exchange Card ─────────────────────────────────────────────────
const ItemExchangeCard = ({
  lineItem,
  index,
  onSearchSku,
  onVariantSelect,
  onQuantityChange,
  allowOutOfStock,
  onRemoveItem,
  onToggleCreditOverride,
  onProcessQuantityChange,
  onSplitRemainder,
  remainingQuantity,
  onAdjustmentChange,
  unitValue,
}: {
  lineItem: ExchangeLineItem;
  index: number;
  onSearchSku: (id: string, sku: string) => void;
  onVariantSelect: (id: string, optionName: string, value: string) => void;
  onQuantityChange: (id: string, qty: number) => void;
  allowOutOfStock: boolean;
  onRemoveItem: (id: string) => void;
  onToggleCreditOverride: (id: string) => void;
  onProcessQuantityChange: (id: string, qty: number) => void;
  onSplitRemainder: (id: string) => void;
  remainingQuantity: number; // units of the original item still unclaimed by sibling rows
  onAdjustmentChange: (id: string, next: ItemAdjustmentState) => void;
  unitValue: number;
}) => {
  const { id, originalItem, isPureReturn, product, loadingProduct, errorProduct, selectedOptionValues, selectedVariantId, quantity, activePrice, processQuantity, adjustments } = lineItem;
  const [searchSku, setSearchSku] = useState('');
  const credited = isCreditRow(lineItem);
  const canSplit = !!originalItem && remainingQuantity > processQuantity;

  const selectedVariant = useMemo(() => {
    if (!product || !selectedVariantId) return null;
    return product.variants.find(v => v.id === selectedVariantId) ?? null;
  }, [product, selectedVariantId]);

  const variantImage = product ? getVariantImage(product, selectedVariantId) : null;

  return (
    <div className={`border rounded-2xl overflow-hidden bg-white ${credited ? 'border-emerald-200' : 'border-slate-200'} mb-4`}>
      <div className={`px-4 sm:px-5 py-3 border-b flex flex-wrap items-center gap-3 ${credited ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'}`}>
        <div className={`w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold shrink-0 ${credited ? 'bg-emerald-200 text-emerald-800' : originalItem ? 'bg-indigo-100 text-indigo-600' : 'bg-purple-100 text-purple-600'}`}>
          {originalItem ? index + 1 : '+'}
        </div>
        <div className="flex-1 min-w-[10rem]">
          <p className="text-sm font-semibold text-slate-800 break-words">
            {originalItem ? originalItem.title : 'Additional Replacement Item'}
          </p>
          {originalItem && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-0.5">
              <span className="font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200">
                {originalItem.sku !== 'N/A' ? originalItem.sku : 'No SKU'}
              </span>
              <span>·</span>
              <span>Returned: {originalItem.quantityReturned}</span>
              <span>·</span>
              <span>{originalItem.price}</span>
              <QuantityDropdown
                value={processQuantity}
                max={remainingQuantity}
                onChange={(qty) => onProcessQuantityChange(id, qty)}
                label="Processing"
              />
              {canSplit && (
                <button
                  onClick={() => onSplitRemainder(id)}
                  className="text-[11px] px-2 py-0.5 rounded-md border border-indigo-200 text-indigo-600 bg-indigo-50 hover:bg-indigo-100 font-medium"
                  title="Split the remaining units into their own row so they can be handled differently"
                >
                  Split remaining {remainingQuantity - processQuantity}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          {originalItem ? (
            <>
              <div className={`text-xs px-2 py-1 rounded-lg border flex items-center gap-1.5 ${credited ? 'text-emerald-700 bg-white border-emerald-200' : 'text-amber-600 bg-amber-50 border-amber-100'}`}>
                {credited ? <MinusCircle className="w-3 h-3" /> : <RefreshCw className="w-3 h-3" />}
                {credited ? 'Refund / Return' : 'Exchange'}
              </div>
              {!isPureReturn && (
                <button
                  onClick={() => onToggleCreditOverride(id)}
                  className="text-xs px-2 py-1 rounded-lg border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 font-medium"
                  title="Convert this row into pooled store credit instead of searching for its own 1:1 replacement -- useful when several returned items are being combined into one bigger replacement below"
                >
                  {lineItem.creditOverride ? 'Give it its own replacement' : 'Use as credit instead'}
                </button>
              )}
            </>
          ) : (
            <button onClick={() => onRemoveItem(id)} className="text-xs px-3 py-1.5 bg-red-50 text-red-600 border border-red-200 rounded-lg font-medium hover:bg-red-100 transition-colors">
              Remove
            </button>
          )}
        </div>
      </div>

      {credited ? (
        <div className="p-6 space-y-4 bg-white">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-emerald-50 rounded-full flex items-center justify-center shrink-0">
               <MinusCircle className="w-6 h-6 text-emerald-500" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-800">
                {lineItem.creditOverride ? 'Converted to store credit' : 'Processing as Return Only'}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {lineItem.creditOverride
                  ? 'This row\u2019s value is pooled toward any "Extra Replacement Item" added below instead of requiring its own 1:1 swap.'
                  : 'This item will be removed from the order and its value will be credited to the final net balance. No replacement is needed.'}
              </p>
            </div>
          </div>
          <ItemAdjustmentPanel
            state={adjustments}
            onChange={(next) => onAdjustmentChange(id, next)}
            unitValue={unitValue}
            quantity={processQuantity}
            showReturnFees
            showForwardShipment={false}
            compact
          />
        </div>
      ) : (
        <>
          <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50">
            <label className="text-xs font-semibold text-slate-500 uppercase mb-2 block">
              Search Replacement Product (SKU or Name)
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchSku}
                  onChange={e => setSearchSku(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && searchSku.trim() && onSearchSku(id, searchSku.trim())}
                  placeholder="Enter SKU or Name (e.g., bspoke)..."
                  className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                />
              </div>
              <button
                onClick={() => onSearchSku(id, searchSku.trim())}
                disabled={!searchSku.trim() || loadingProduct}
                className="bg-slate-900 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50 transition-colors flex items-center justify-center min-w-[80px]"
              >
                {loadingProduct ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
              </button>
            </div>
          </div>

          <div className="p-5">
            {loadingProduct && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-500 mr-3" />
                <span className="text-sm text-slate-500">Searching catalog...</span>
              </div>
            )}

            {errorProduct && (
              <div className="flex items-center gap-3 py-6 px-4 bg-red-50 rounded-xl border border-red-100">
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-red-700">Failed to load product</p>
                  <p className="text-xs text-red-500 mt-0.5">{errorProduct}</p>
                </div>
              </div>
            )}

            {!product && !loadingProduct && !errorProduct && (
              <div className="text-center py-8 text-slate-500 text-sm">
                <Search className="w-8 h-8 mx-auto mb-3 text-slate-300" />
                Enter a valid SKU or Name above to select a replacement product.
              </div>
            )}

            {!loadingProduct && !errorProduct && product && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 animate-in fade-in slide-in-from-bottom-2">
                <div className="space-y-4">
                  <div className="aspect-square rounded-xl overflow-hidden bg-slate-50 border border-slate-200 relative group">
                    {variantImage ? (
                      <img
                        src={variantImage}
                        alt={selectedVariant?.title ?? product.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-slate-300">
                        <ShoppingBag className="w-12 h-12 mb-2" />
                        <p className="text-xs">No image</p>
                      </div>
                    )}
                  </div>

                  {selectedVariant && (
                    <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 space-y-2">
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Selected Variant</p>
                      <p className="text-sm font-bold text-slate-900">{selectedVariant.title}</p>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-500">Price</span>
                        <span className="font-semibold text-slate-900">
                          {activePrice !== null ? formatCurrency(activePrice) : formatCurrency(selectedVariant.price)}
                          {activePrice !== null && (
                            <span className="ml-2 text-xs text-emerald-600 font-medium">
                              (Discounted)
                            </span>
                          )}
                        </span>
                      </div>
                      {selectedVariant.sku && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-500">SKU</span>
                          <span className="font-mono text-xs bg-white px-2 py-0.5 rounded border border-slate-200">
                            {selectedVariant.sku}
                          </span>
                        </div>
                      )}
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-500">Stock</span>
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          selectedVariant.inventory_quantity > 5
                            ? 'bg-emerald-100 text-emerald-700'
                            : selectedVariant.inventory_quantity > 0 || selectedVariant.available
                              ? 'bg-amber-100 text-amber-700'
                              : allowOutOfStock 
                                ? 'bg-purple-100 text-purple-700'
                                : 'bg-red-100 text-red-700'
                        }`}>
                          {selectedVariant.inventory_quantity > 0
                            ? `${selectedVariant.inventory_quantity} in stock`
                            : selectedVariant.available
                              ? `${selectedVariant.inventory_quantity} in stock (Available)`
                              : allowOutOfStock 
                                ? `${selectedVariant.inventory_quantity} in stock (Allowed)` 
                                : 'Out of stock'}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-5">
                  <div>
                    <p className="text-sm font-bold text-slate-800 mb-1">{product.title}</p>
                    <p className="text-xs text-slate-400">{product.variants.length} variant{product.variants.length !== 1 ? 's' : ''} available</p>
                  </div>

                  {product.options.map(option => (
                    <OptionSelector
                      key={option.id}
                      option={option}
                      selectedValue={selectedOptionValues[option.name] ?? ''}
                      variants={product.variants}
                      options={product.options}
                      allSelected={selectedOptionValues}
                      onSelect={(name, value) => onVariantSelect(id, name, value)}
                      allowOutOfStock={allowOutOfStock}
                    />
                  ))}

                  <div>
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                      Quantity
                    </p>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => onQuantityChange(id, Math.max(1, quantity - 1))}
                        className="w-9 h-9 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center text-slate-700 font-bold text-lg transition-colors"
                      >
                        −
                      </button>
                      <span className="w-10 text-center font-bold text-slate-900 text-lg tabular-nums">
                        {quantity}
                      </span>
                      <button
                        onClick={() => onQuantityChange(
                          id,
                          selectedVariant
                            ? (allowOutOfStock ? quantity + 1 : Math.min(selectedVariant.inventory_quantity, quantity + 1))
                            : quantity + 1
                        )}
                        disabled={selectedVariant ? (!allowOutOfStock && !selectedVariant.available && quantity >= selectedVariant.inventory_quantity) : false}
                        className="w-9 h-9 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center text-slate-700 font-bold text-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        +
                      </button>
                      {originalItem && (
                        <span className="text-xs text-slate-400">
                          (originally returned {originalItem.quantityReturned})
                        </span>
                      )}
                    </div>
                  </div>

                  {selectedVariant && (
                    (() => {
                      const origPrice = originalItem ? parsePrice(originalItem?.price) : 0;
                      const newPrice = activePrice !== null ? activePrice : parseFloat(selectedVariant.price) || 0;
                      const diff = (newPrice - origPrice) * quantity;
                      if (Math.abs(diff) < 0.01) return null;
                      return (
                        <div className={`flex items-start gap-2 p-3 rounded-xl border text-xs ${
                          diff > 0
                            ? 'bg-amber-50 border-amber-100 text-amber-700'
                            : 'bg-emerald-50 border-emerald-100 text-emerald-700'
                        }`}>
                          <Info className="w-4 h-4 shrink-0 mt-0.5" />
                          <span>
                            {diff > 0
                              ? `Added value is ${formatCurrency(diff)} higher.`
                              : `Added value is ${formatCurrency(Math.abs(diff))} lower.`}
                          </span>
                        </div>
                      );
                    })()
                  )}

                  <ItemAdjustmentPanel
                    state={adjustments}
                    onChange={(next) => onAdjustmentChange(id, next)}
                    unitValue={unitValue}
                    quantity={originalItem ? processQuantity : quantity}
                    // Forward shipment + Value Adjustment are based on THIS
                    // replacement item's own price, not the returned item's --
                    // see getReplacementUnitValue in the parent component.
                    // selectedVariant can still be null here (before every
                    // option is picked), so guard it the same way the price-
                    // diff block above does.
                    replacementUnitValue={activePrice !== null ? activePrice : (selectedVariant ? parseFloat(selectedVariant.price) || 0 : 0)}
                    replacementQuantity={quantity}
                    // FIXED: this used to hide restocking/reverse-shipment
                    // whenever a row had no originalItem -- i.e. every
                    // "Additional Replacement Item" row. Those rows have no
                    // distinct return side, but an agent may still want to
                    // apply a restocking-style handling fee against the
                    // added item itself, so all four fee types are shown for
                    // every row now (see adjustmentTotalsByRow below for the
                    // matching fix to the actual deduction math).
                    showForwardShipment
                    compact
                  />
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

type ProcessedExchange = Pick<
  ExchangeProcessResult,
  'financialOutcome' | 'netRefundAmount' | 'outstandingBalance' | 'invoiceSent' | 'invoiceError'
  | 'discountApplied' | 'discountAppliedViaOrderEdit' | 'discountEditError' | 'unappliableAdjustment'
> & { resumed?: boolean };

const fromStoredResult = (stored: ReturnDoc['exchangeResult']): ProcessedExchange | null => {
  if (!stored || !stored.financialOutcome) return null;
  return {
    financialOutcome: stored.financialOutcome,
    netRefundAmount: Number(stored.netRefundAmount) || 0,
    outstandingBalance: Number(stored.outstandingBalance) || 0,
    invoiceSent: !!stored.invoiceSent,
    invoiceError: stored.invoiceError ?? null,
    discountApplied: Number(stored.discountApplied ?? stored.discountPercentage) || 0,
    discountAppliedViaOrderEdit: !!stored.discountAppliedViaOrderEdit,
    discountEditError: stored.discountEditError ?? null,
    unappliableAdjustment: Number(stored.unappliableAdjustment) || 0,
    resumed: true,
  };
};

export const ExchangeModal: React.FC<ExchangeModalProps> = ({
  isOpen, onClose, orderId, data, returnId, currentUser, onSuccess, shopifyOrder
}) => {
  const docId = returnId || data?.id;
  const [lineItems, setLineItems] = useState<ExchangeLineItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; unknownOutcome?: boolean } | null>(null);
  const [success, setSuccess] = useState(false);

  // Result of /exchange/process (fresh, or resumed from the return doc). Once
  // set, the item editor is locked and only the refund step remains.
  const [processed, setProcessed] = useState<ProcessedExchange | null>(null);
  const [refundDone, setRefundDone] = useState(false);
  const [refundedAmount, setRefundedAmount] = useState<number | null>(null);
  const [refundWarning, setRefundWarning] = useState<string | null>(null);
  /** Full gift-card code from the refund response — shown once, never stored on the return doc. */
  const [giftCardCode, setGiftCardCode] = useState<string | null>(null);
  const [manualMethod, setManualMethod] = useState<ManualRefundMethod | ''>('');
  const [manualReference, setManualReference] = useState('');

  // ── Refund settlement state ──
  const [refundMethod, setRefundMethod] = useState<RefundMethod>('store_credit');
  const allowOriginalPayment = canRefundOriginalPayment(currentUser?.role);
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  const [allowOutOfStock, setAllowOutOfStock] = useState(false);
  const [deductTaxes, setDeductTaxes] = useState(false);
  const [taxInput, setTaxInput] = useState('');
  const [calculatedTax, setCalculatedTax] = useState(0);

  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  /** What the password prompt is for: process + refund in one go, or only the refund step. */
  const [promptMode, setPromptMode] = useState<'exchange' | 'refund'>('exchange');

  // One idempotency key per attempt (see CONTRACT §4.1).
  const exchangeAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const refundAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const changedServerStateRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const wasOpenRef = useRef(false);

  // ─── fetchActivePrice ────────────────────────────────────────────────────────
  const fetchActivePrice = useCallback(async (itemId: string, variantId: number, qty: number = 1) => {
    try {
      const discountCodes = shopifyOrder?.discount_codes?.map((d: any) => d.code) || [];
      const buyerIdentity = shopifyOrder?.customer?.email ? { email: shopifyOrder.customer.email } : undefined;
      const res = await apiClient.post('/exchange/active-price', { variantId, quantity: qty, discountCodes, buyerIdentity });
      if (res.data?.success && res.data.activePrice !== undefined) {
        setLineItems(prev => prev.map(li => (li.id === itemId && li.selectedVariantId === variantId ? { ...li, activePrice: res.data.activePrice } : li)));
      }
    } catch {
      // Falls back to the catalog price; nothing to tell the agent.
    }
  }, [shopifyOrder]);

  const paymentBreakdown = useMemo(() => computePaymentBreakdown(shopifyOrder), [shopifyOrder]);

  const buildInitialLineItems = useCallback((): ExchangeLineItem[] => (data?.items || []).map(item => ({
    id: `return_${item.lineItemId}`,
    originalItem: item,
    isPureReturn: item.actionType === 'return',
    creditOverride: false,
    processQuantity: item.quantityReturned,
    adjustments: makeDefaultItemAdjustment({ reverseShipmentDefaultOn: true }),
    product: null,
    loadingProduct: false,
    errorProduct: null,
    selectedVariantId: null,
    selectedOptionValues: {},
    quantity: item.quantityReturned,
    activePrice: null,
  })), [data?.items]);

  const handleAddReplacementItem = () => {
    setLineItems(prev => [
      ...prev,
      {
        id: `added_${Date.now()}`,
        isPureReturn: false,
        processQuantity: 1,
        adjustments: makeDefaultItemAdjustment(),
        product: null,
        loadingProduct: false,
        errorProduct: null,
        selectedVariantId: null,
        selectedOptionValues: {},
        quantity: 1,
        activePrice: null,
      }
    ]);
  };

  const handleRemoveReplacementItem = (idToRemove: string) => {
    setLineItems(prev => prev.filter(li => li.id !== idToRemove));
  };

  const updateLineItemAdjustment = useCallback((id: string, next: ItemAdjustmentState) => {
    setLineItems(prev => prev.map(li => (li.id === id ? { ...li, adjustments: next } : li)));
  }, []);

  const handleToggleCreditOverride = useCallback((id: string) => {
    setLineItems(prev => prev.map(li => (li.id === id ? { ...li, creditOverride: !li.creditOverride } : li)));
  }, []);

  const remainingQuantityFor = useCallback((li: ExchangeLineItem) => {
    if (!li.originalItem) return 0;
    const total = li.originalItem.quantityReturned;
    const usedByOthers = lineItems
      .filter(x => x.id !== li.id && x.originalItem?.lineItemId === li.originalItem!.lineItemId)
      .reduce((sum, x) => sum + x.processQuantity, 0);
    return Math.max(0, total - usedByOthers);
  }, [lineItems]);

  const handleProcessQuantityChange = useCallback((id: string, qty: number) => {
    setLineItems(prev => prev.map(li => {
      if (li.id !== id || !li.originalItem) return li;
      const cap = remainingQuantityFor(li);
      const clamped = Math.min(Math.max(1, qty), Math.max(1, cap));
      return { ...li, processQuantity: clamped, quantity: isCreditRow(li) ? clamped : li.quantity };
    }));
  }, [remainingQuantityFor]);

  const handleSplitRemainder = useCallback((id: string) => {
    setLineItems(prev => {
      const row = prev.find(li => li.id === id);
      if (!row?.originalItem) return prev;
      const usedByOthers = prev
        .filter(x => x.id !== id && x.originalItem?.lineItemId === row.originalItem!.lineItemId)
        .reduce((sum, x) => sum + x.processQuantity, 0);
      const remainder = row.originalItem.quantityReturned - usedByOthers - row.processQuantity;
      if (remainder <= 0) return prev;
      const splitRow: ExchangeLineItem = {
        id: `${row.originalItem.lineItemId}_split_${Date.now()}`,
        originalItem: row.originalItem,
        isPureReturn: false,
        creditOverride: true,
        processQuantity: remainder,
        adjustments: makeDefaultItemAdjustment({ reverseShipmentDefaultOn: true }),
        product: null,
        loadingProduct: false,
        errorProduct: null,
        selectedVariantId: null,
        selectedOptionValues: {},
        quantity: remainder,
        activePrice: null,
      };
      return [...prev, splitRow];
    });
  }, []);

  /** Unit value of a row: the returned item's paid price, or the replacement's price for added rows. */
  const getUnitValue = useCallback((li: ExchangeLineItem): number => {
    if (li.originalItem) return getPaidUnitValue(shopifyOrder, li.originalItem);
    if (!isCreditRow(li)) {
      const variant = li.product?.variants.find(v => v.id === li.selectedVariantId);
      if (variant) return li.activePrice !== null ? li.activePrice : parseFloat(variant.price) || 0;
    }
    return 0;
  }, [shopifyOrder]);

  /** The REPLACEMENT item's own unit price (forward shipment + value adjustment are based on it). */
  const getReplacementUnitValue = useCallback((li: ExchangeLineItem): number => {
    if (isCreditRow(li)) return 0;
    const variant = li.product?.variants.find(v => v.id === li.selectedVariantId);
    if (!variant) return 0;
    return li.activePrice !== null ? li.activePrice : parseFloat(variant.price) || 0;
  }, []);

  const adjustmentTotalsByRow = useMemo(() => {
    const map: Record<string, ReturnType<typeof computeItemAdjustmentTotals>> = {};
    lineItems.forEach(li => {
      const returnUnitValue = getUnitValue(li);
      const returnQuantity = li.originalItem ? li.processQuantity : li.quantity;
      const hasReplacement = !isCreditRow(li) && !!li.selectedVariantId;
      const replacementUnitValue = hasReplacement ? getReplacementUnitValue(li) : returnUnitValue;
      const replacementQuantity = hasReplacement ? li.quantity : returnQuantity;
      map[li.id] = computeItemAdjustmentTotals(li.adjustments, returnUnitValue, returnQuantity, replacementUnitValue, replacementQuantity);
    });
    return map;
  }, [lineItems, getUnitValue, getReplacementUnitValue]);

  const combinedAdjustmentTotals = useMemo(
    () => sumItemAdjustmentTotals(Object.values(adjustmentTotalsByRow)),
    [adjustmentTotalsByRow]
  );

  const creditRowValueAdjustmentTotal = useMemo(() => lineItems.reduce((sum, li) => (
    isCreditRow(li) ? sum + (adjustmentTotalsByRow[li.id]?.valueAdjustment || 0) : sum
  ), 0), [lineItems, adjustmentTotalsByRow]);

  // Reset only when the modal OPENS (not on every parent refresh while open —
  // that would wipe the refund step after the exchange was processed).
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setLineItems(buildInitialLineItems());
      setError(null);
      setSuccess(false);
      // A refund already recorded on the return (e.g. finished in another tab) is never offered again.
      setRefundDone((data?.refundStatus || '').toLowerCase() === 'refunded');
      setRefundedAmount(null);
      setRefundWarning(null);
      setGiftCardCode(null);
      setManualMethod('');
      setManualReference('');
      setProcessed(fromStoredResult((data as ReturnDoc)?.exchangeResult));
      setRefundMethod('store_credit');
      setNotifyCustomer(true);
      setAllowOutOfStock(false);
      setDeductTaxes(false);
      setTaxInput('');
      setCalculatedTax(0);
      setPasswordError(null);
      setShowPasswordPrompt(false);
      exchangeAttemptRef.current = null;
      refundAttemptRef.current = null;
      changedServerStateRef.current = false;
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, buildInitialLineItems, data]);

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  const handleSearchSku = useCallback((itemId: string, sku: string) => {
    if (!sku) return;
    let currentQty = 1;
    setLineItems(prev => prev.map(li => {
      if (li.id === itemId) {
        currentQty = li.quantity || 1;
        return { ...li, loadingProduct: true, errorProduct: null, product: null, selectedVariantId: null, selectedOptionValues: {}, activePrice: null };
      }
      return li;
    }));

    apiClient.get<{ product: ShopifyProductFull }>(`/products/by-sku/${encodeURIComponent(sku)}/variants`)
      .then(res => {
        const product = res.data?.product;
        if (!product || !Array.isArray(product.variants)) throw new Error('Product not found');
        const matchingVariant = product.variants.find(v => (v.sku || '').toLowerCase() === sku.toLowerCase());
        const preselected: Record<string, string> = {};
        if (matchingVariant) {
          (product.options || []).forEach((opt, i) => {
            const key = `option${i + 1}` as 'option1' | 'option2' | 'option3';
            const val = matchingVariant[key];
            if (val) preselected[opt.name] = val;
          });
        }
        setLineItems(prev => prev.map(li => (li.id === itemId ? {
          ...li, product, loadingProduct: false, selectedOptionValues: preselected,
          selectedVariantId: matchingVariant?.id ?? null, activePrice: null,
        } : li)));
        if (matchingVariant?.id) fetchActivePrice(itemId, matchingVariant.id, currentQty);
      })
      .catch(err => {
        setLineItems(prev => prev.map(li => (li.id === itemId ? {
          ...li, loadingProduct: false, errorProduct: getApiErrorMessage(err, 'Failed to load product'), activePrice: null,
        } : li)));
      });
  }, [fetchActivePrice]);

  const handleVariantSelect = useCallback((itemId: string, optionName: string, value: string) => {
    let matchedVariantId: number | null = null;
    let currentQty = 1;
    setLineItems(prev => prev.map(li => {
      if (li.id === itemId && li.product) {
        const newSelected = { ...li.selectedOptionValues, [optionName]: value };
        const matched = findMatchingVariant(li.product.variants, li.product.options, newSelected);
        matchedVariantId = matched?.id ?? null;
        currentQty = li.quantity;
        return { ...li, selectedOptionValues: newSelected, selectedVariantId: matchedVariantId, activePrice: null };
      }
      return li;
    }));
    if (matchedVariantId) fetchActivePrice(itemId, matchedVariantId, currentQty);
  }, [fetchActivePrice]);

  const handleQuantityChange = useCallback((itemId: string, qty: number) => {
    let variantId: number | null = null;
    setLineItems(prev => prev.map(li => {
      if (li.id === itemId) {
        variantId = li.selectedVariantId;
        return { ...li, quantity: qty };
      }
      return li;
    }));
    if (variantId) fetchActivePrice(itemId, variantId, qty);
  }, [fetchActivePrice]);

  // Price summary
  const priceSummary = useMemo(() => {
    let originalTotal = 0;
    let newTotal = 0;
    let newTotalCatalog = 0; // full base price Shopify initially charges
    lineItems.forEach(li => {
      if (li.originalItem) {
        // This row's OWN processed quantity (a row may cover part of the line once split).
        originalTotal += getPaidUnitValue(shopifyOrder, li.originalItem) * li.processQuantity;
      }
      if (!isCreditRow(li)) {
        const variant = li.product?.variants.find(v => v.id === li.selectedVariantId);
        if (variant) {
          const unitPrice = li.activePrice !== null ? li.activePrice : parseFloat(variant.price) || 0;
          newTotal += unitPrice * li.quantity;
          newTotalCatalog += (parseFloat(variant.price) || 0) * li.quantity;
        }
      }
    });
    return { originalTotal, newTotal, newTotalCatalog, diff: newTotal - originalTotal };
  }, [lineItems, shopifyOrder]);

  const taxDeduction = deductTaxes ? parseFloat(taxInput || '0') || 0 : 0;

  const totalRefundDeductions =
    combinedAdjustmentTotals.restocking +
    combinedAdjustmentTotals.reverseShipment +
    combinedAdjustmentTotals.forwardShipment +
    taxDeduction;

  const totalValueAdjustment = combinedAdjustmentTotals.valueAdjustment;
  const storefrontDiscountAmount = Math.max(0, priceSummary.newTotalCatalog - priceSummary.newTotal);
  const totalCombinedDiscountToSync = totalValueAdjustment + storefrontDiscountAmount;
  const totalDiscountPercentageToSync = priceSummary.newTotalCatalog > 0
    ? (totalCombinedDiscountToSync / priceSummary.newTotalCatalog) * 100
    : 0;

  const netBalance = priceSummary.diff + totalRefundDeductions - totalValueAdjustment;
  const financialOutcome: 'even' | 'refund' | 'extra' = netBalance > 0.01 ? 'extra' : netBalance < -0.01 ? 'refund' : 'even';
  const finalRefundAmount = financialOutcome === 'refund' ? round2(Math.abs(netBalance)) : 0;
  const outstandingBalanceAmount = financialOutcome === 'extra' ? netBalance : 0;

  const [serverPreview, setServerPreview] = useState<{
    netBalance: number;
    financialOutcome: 'even' | 'refund' | 'extra';
    unappliableAdjustment: number;
    estimatedExchangeDiscountTotal: number;
    discountedNetBalance: number;
    discountedFinancialOutcome: 'even' | 'refund' | 'extra';
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewSeqRef = useRef(0);

  const previewReady = useMemo(() => (
    lineItems.length > 0 && lineItems.every(li => isCreditRow(li) || !!li.selectedVariantId)
  ), [lineItems]);

  // Shopify expects at most one remove entry per lineItemId, not one per UI row.
  const buildRemoveItems = useCallback(() => {
    const byLineItem = new Map<number, { lineItemId: number; quantity: number; title?: string; sku?: string; reason?: string }>();
    lineItems.forEach(li => {
      if (!li.originalItem || li.processQuantity <= 0) return;
      const key = li.originalItem.lineItemId;
      const existing = byLineItem.get(key);
      if (existing) existing.quantity += li.processQuantity;
      else byLineItem.set(key, { lineItemId: key, quantity: li.processQuantity, title: li.originalItem.title, sku: li.originalItem.sku, reason: li.originalItem.reason });
    });
    return Array.from(byLineItem.values());
  }, [lineItems]);

  const buildAddItems = useCallback(() => lineItems
    .filter(li => !isCreditRow(li) && li.selectedVariantId)
    .map(li => ({
      variantId: li.selectedVariantId!,
      quantity: li.quantity,
      discountPercent: li.adjustments.valueAdjustment.enabled ? (parseFloat(li.adjustments.valueAdjustment.percent || '0') || 0) : 0,
    })), [lineItems]);

  // Debounced Shopify preview. Every request gets a sequence number and an
  // AbortController so a slow, stale response can never overwrite a newer one.
  useEffect(() => {
    if (!isOpen || !previewReady || success || processed) {
      previewSeqRef.current += 1;
      setServerPreview(null);
      setPreviewLoading(false);
      return;
    }
    const seq = ++previewSeqRef.current;
    const controller = new AbortController();
    const handle = window.setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const res = await previewShopifyExchange({
          shopifyOrderId: data.orderNumericId || data.orderId,
          removeItems: buildRemoveItems(),
          addItems: buildAddItems(),
          totalFees: totalRefundDeductions,
          valueAdjustment: creditRowValueAdjustmentTotal,
          currency: shopifyOrder?.currency || 'INR',
        }, controller.signal);
        if (seq !== previewSeqRef.current) return;
        if (res?.success) {
          setServerPreview({
            netBalance: res.netBalance,
            financialOutcome: res.financialOutcome,
            unappliableAdjustment: res.unappliableAdjustment || 0,
            estimatedExchangeDiscountTotal: res.estimatedExchangeDiscountTotal || 0,
            discountedNetBalance: res.discountedNetBalance ?? res.netBalance,
            discountedFinancialOutcome: res.discountedFinancialOutcome || res.financialOutcome,
          });
        } else {
          setServerPreview(null);
          setPreviewError(res?.error || 'Could not verify the balance with Shopify.');
        }
      } catch (err) {
        if (controller.signal.aborted || seq !== previewSeqRef.current) return;
        setServerPreview(null);
        setPreviewError(getApiErrorMessage(err, 'Could not verify the balance with Shopify.'));
      } finally {
        if (seq === previewSeqRef.current) setPreviewLoading(false);
      }
    }, 600);

    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [isOpen, previewReady, success, processed, lineItems, buildRemoveItems, buildAddItems, totalRefundDeductions, creditRowValueAdjustmentTotal, data.orderNumericId, data.orderId, shopifyOrder?.currency]);

  const confirmedNetBalance = serverPreview?.discountedNetBalance ?? null;
  const confirmedFinancialOutcome = serverPreview?.discountedFinancialOutcome ?? null;
  const unappliableAdjustment = serverPreview?.unappliableAdjustment ?? 0;

  // ─── Tax Calculation ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (priceSummary.diff >= -0.01) {
      setCalculatedTax(0);
      setTaxInput('0.00');
      return;
    }
    let totalTax = 0;
    lineItems.forEach(li => {
      if (!isCreditRow(li) || !li.originalItem) return;
      totalTax += getUnitTax(shopifyOrder, li.originalItem) * li.processQuantity;
    });
    setCalculatedTax(totalTax);
    setTaxInput(totalTax.toFixed(2));
  }, [priceSummary.diff, lineItems, shopifyOrder]);

  const hasCustomer = !!shopifyOrder?.customer?.id;

  useEffect(() => {
    if (refundMethod === 'original' && !allowOriginalPayment) setRefundMethod('store_credit');
  }, [refundMethod, allowOriginalPayment]);

  const methodAllowed = useMemo(() => {
    const method = REFUND_METHODS.find(m => m.id === refundMethod);
    if (method?.requiresCustomer && !hasCustomer) return false;
    if (refundMethod === 'original' && !allowOriginalPayment) return false;
    return true;
  }, [refundMethod, hasCustomer, allowOriginalPayment]);

  /** A manual refund must say how it was paid (reports show "Manual – <method>"). */
  const manualDetailsValid = refundMethod !== 'manual' || !!manualMethod;

  const isRefundMethodValid = financialOutcome !== 'refund' || ((finalRefundAmount > 0 || refundMethod === 'manual') && methodAllowed && manualDetailsValid);

  const canSubmit = useMemo(() => {
    if (!lineItems.length || !docId) return false;
    const itemsValid = lineItems.every(li => {
      if (isCreditRow(li)) return true;
      if (li.loadingProduct || li.errorProduct || !li.selectedVariantId) return false;
      const variant = li.product?.variants.find(v => v.id === li.selectedVariantId);
      if (!variant) return false;
      if (!allowOutOfStock && !variant.available && variant.inventory_quantity <= 0) return false;
      return li.quantity >= 1 && (allowOutOfStock || variant.available || li.quantity <= variant.inventory_quantity);
    });
    return itemsValid && isRefundMethodValid;
  }, [lineItems, docId, isRefundMethodValid, allowOutOfStock]);

  const agentName = currentUser?.name || (currentUser?.email ? currentUser.email.split('@')[0] : 'Agent');

  // Only pooled-credit rows (plain returns + agent-converted exchange rows) are refundable line items.
  const refundLineItems = useMemo(() => {
    const byLineItem = new Map<number, { lineItemId: number; quantity: number; sku?: string }>();
    lineItems.forEach(li => {
      if (!li.originalItem || !isCreditRow(li) || li.processQuantity <= 0) return;
      const key = li.originalItem.lineItemId;
      const existing = byLineItem.get(key);
      if (existing) existing.quantity += li.processQuantity;
      else byLineItem.set(key, { lineItemId: key, quantity: li.processQuantity, sku: li.originalItem.sku });
    });
    return Array.from(byLineItem.values()).map(item => ({
      lineItemId: `gid://shopify/LineItem/${item.lineItemId}`,
      quantity: item.quantity,
      sku: item.sku,
    }));
  }, [lineItems]);

  const refundNote = useMemo(() => {
    const notes: string[] = [];
    if (combinedAdjustmentTotals.restocking > 0.01) notes.push('Restocking fee applied');
    if (combinedAdjustmentTotals.reverseShipment > 0.01) notes.push('Reverse shipment cost deducted');
    if (combinedAdjustmentTotals.forwardShipment > 0.01) notes.push('Forward shipment cost deducted');
    if (totalValueAdjustment > 0.01) notes.push('Value adjustment applied');
    if (deductTaxes) notes.push('Taxes deducted');
    const suffix = notes.length ? ` (${notes.join(', ')})` : '';
    return `Refund for exchange balance on order ${data.orderId}${suffix}`;
  }, [data.orderId, combinedAdjustmentTotals, totalValueAdjustment, deductTaxes]);

  const alreadyRestockedByLineItem = useMemo(() => restockedQtyMap(data), [data]);

  const exchangeRequestBody = useCallback(() => {
    const removeItems = buildRemoveItems().map(item => {
      const alreadyRestocked = Math.min(alreadyRestockedByLineItem.get(item.lineItemId) || 0, item.quantity);
      const hasReceivingDecision = data.restockDecisions?.[item.lineItemId] !== undefined;
      return { ...item, alreadyRestockedQuantity: alreadyRestocked, restock: hasReceivingDecision ? false : alreadyRestocked < item.quantity };
    });
    const addItems = lineItems
      .filter(li => !isCreditRow(li) && li.selectedVariantId && li.product)
      .map(li => {
        const variant = li.product!.variants.find(v => v.id === li.selectedVariantId);
        const isOutOfStock = !!variant && variant.inventory_quantity <= 0 && !variant.available;
        return {
          variantId: li.selectedVariantId!,
          quantity: li.quantity,
          title: `${variant?.title || 'Variant'} (${li.product!.title})${isOutOfStock ? ' [Pre-order/Out of Stock]' : ''}`,
          discountPercent: li.adjustments.valueAdjustment.enabled ? (parseFloat(li.adjustments.valueAdjustment.percent || '0') || 0) : 0,
        };
      });
    return {
      orderId: data.orderId || orderId,
      shopifyOrderId: data.orderNumericId || data.orderId,
      // Estimates for logging only — the server derives the real outcome from Shopify.
      financialOutcome,
      netRefundAmount: financialOutcome === 'refund' ? finalRefundAmount : round2(outstandingBalanceAmount),
      removeItems,
      addItems,
      totalFees: round2(totalRefundDeductions),
      discountPercentage: totalDiscountPercentageToSync,
      notifyCustomer,
      feeBreakdown: {
        restocking: round2(combinedAdjustmentTotals.restocking),
        reverseShipment: round2(combinedAdjustmentTotals.reverseShipment),
        forwardShipment: round2(combinedAdjustmentTotals.forwardShipment),
        // Credit-row share only; the exchange-row share travels as each add item's discountPercent.
        adjustment: round2(creditRowValueAdjustmentTotal),
        taxes: round2(taxDeduction),
      },
      currency: shopifyOrder?.currency || 'INR',
    };
  }, [
    buildRemoveItems, alreadyRestockedByLineItem, data, lineItems, orderId, financialOutcome, finalRefundAmount,
    outstandingBalanceAmount, totalRefundDeductions, totalDiscountPercentageToSync, notifyCustomer,
    combinedAdjustmentTotals, creditRowValueAdjustmentTotal, taxDeduction, shopifyOrder?.currency,
  ]);

  /** Runs /exchange/process (or returns the already-processed result). Throws on failure. */
  const runExchangeProcess = useCallback(async (): Promise<ProcessedExchange> => {
    if (processed) return processed;
    const body = exchangeRequestBody();
    const fingerprint = JSON.stringify(body);
    if (!exchangeAttemptRef.current || exchangeAttemptRef.current.fingerprint !== fingerprint) {
      exchangeAttemptRef.current = { fingerprint, key: newIdempotencyKey() };
    }
    const result = await processShopifyExchange({ ...body, returnId: docId as string, idempotencyKey: exchangeAttemptRef.current.key });
    changedServerStateRef.current = true;
    const next: ProcessedExchange = {
      financialOutcome: result.financialOutcome,
      netRefundAmount: Number(result.netRefundAmount) || 0,
      outstandingBalance: Number(result.outstandingBalance) || 0,
      invoiceSent: !!result.invoiceSent,
      invoiceError: result.invoiceError ?? null,
      discountApplied: Number(result.discountApplied) || 0,
      discountAppliedViaOrderEdit: !!result.discountAppliedViaOrderEdit,
      discountEditError: result.discountEditError ?? null,
      unappliableAdjustment: Number(result.unappliableAdjustment) || 0,
      resumed: !!result.resumed,
    };
    setProcessed(next);
    return next;
  }, [processed, exchangeRequestBody, docId]);

  /** Shopify's confirmed refund for this exchange (0 when nothing is owed back). */
  const confirmedRefundAmount = (p: ProcessedExchange | null) =>
    p && p.financialOutcome === 'refund' ? round2(Math.max(0, Number(p.netRefundAmount) || 0)) : 0;

  /** Issues the refund for a processed exchange. Throws on failure. */
  const runRefund = useCallback(async (p: ProcessedExchange, password: string): Promise<{ warning: string | null; giftCardCode: string | null }> => {
    const amount = confirmedRefundAmount(p);
    if (amount <= 0) return { warning: null, giftCardCode: null };
    const request: Omit<RefundRequest, 'idempotencyKey'> = {
      returnId: docId as string,
      refundPassword: password,
      orderId: data.orderId || orderId,
      shopifyOrderId: toShopifyOrderGid(shopifyOrder?.id ?? data.orderNumericId),
      amount: amount.toFixed(2),
      note: refundNote,
      lineItems: refundLineItems,
      notifyCustomer,
      ...(refundMethod === 'manual'
        ? { manualMethod: manualMethod || 'other', ...(manualReference.trim() ? { manualReference: manualReference.trim().slice(0, 120) } : {}) }
        : {}),
      metadata: {
        orderName: data.orderId || orderId,
        isFullReturn: false,
        baseAmount: round2(Math.abs(priceSummary.diff)),
        netBalance: amount,
        deductions: buildDeductions(combinedAdjustmentTotals, totalValueAdjustment, taxDeduction),
        source: 'exchange',
      },
    };
    const fingerprint = JSON.stringify([refundMethod, request.amount, request.lineItems, notifyCustomer, request.manualMethod, request.manualReference]);
    if (!refundAttemptRef.current || refundAttemptRef.current.fingerprint !== fingerprint) {
      refundAttemptRef.current = { fingerprint, key: newIdempotencyKey() };
    }
    const result = await issueRefund(toApiRefundMethod(refundMethod), { ...request, idempotencyKey: refundAttemptRef.current.key });
    refundAttemptRef.current = null;
    setRefundDone(true);
    setRefundedAmount(amount);
    const warnings: string[] = [];
    if (result.duplicate) warnings.push('This refund had already been completed — no second refund was made.');
    if (refundMethod !== 'manual' && result.emailSent === false) warnings.push('The refund e-mail to the customer could not be sent.');
    const code = refundMethod === 'giftcard' && typeof result.giftCardCode === 'string' && result.giftCardCode.trim()
      ? result.giftCardCode.trim()
      : null;
    setGiftCardCode(code);
    const warningText = warnings.length ? warnings.join(' ') : null;
    setRefundWarning(warningText);
    void addShopifyNote(
      data.orderNumericId || data.orderId,
      data.RAN || 'Unknown',
      'Refund Issued',
      `Amount: ₹${amount.toFixed(2)}\nMethod: ${REFUND_METHOD_LABELS[refundMethod]}\nAction by: ${agentName}`
    );
    return { warning: warningText, giftCardCode: code };
  }, [
    docId, data, orderId, shopifyOrder?.id, refundNote, refundLineItems, notifyCustomer, priceSummary.diff,
    combinedAdjustmentTotals, totalValueAdjustment, taxDeduction, refundMethod, agentName, manualMethod, manualReference,
  ]);

  const finishSuccess = useCallback((p: ProcessedExchange, hasWarning = false, keepOpen = false) => {
    setSuccess(true);
    setShowPasswordPrompt(false);
    onSuccess?.();
    changedServerStateRef.current = false;
    const discountFailed = (p.discountApplied || 0) > 0.01 && !p.discountAppliedViaOrderEdit;
    const slow = p.financialOutcome === 'extra' || discountFailed || hasWarning;
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    // A one-time gift-card code must stay on screen until the agent closes the dialog.
    if (keepOpen) return;
    closeTimerRef.current = window.setTimeout(() => { onClose(); }, slow ? 5000 : 2500);
  }, [onSuccess, onClose]);

  /**
   * Process the exchange (unless already processed) and, when Shopify says
   * money is owed back, refund exactly Shopify's netRefundAmount.
   */
  const runFlow = useCallback(async (password: string | null) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setPasswordError(null);
    let p: ProcessedExchange | null = processed;
    let refundWarningText: string | null = null;
    let issuedGiftCardCode: string | null = null;
    try {
      if (password) {
        const check = await verifyRefundPassword(password);
        if (check === 'bad') {
          setPasswordError('Incorrect refund password. Please try again.');
          return;
        }
      }

      if (!p) {
        try {
          p = await runExchangeProcess();
        } catch (err) {
          const described = describeRefundError(err, 'Failed to process the exchange. Please try again.');
          if (described.definitive) exchangeAttemptRef.current = null;
          setShowPasswordPrompt(false);
          setError({
            message: described.unknownOutcome
              ? 'No confirmation from Shopify — the exchange may or may not have been processed. Refresh the page and check the order in Shopify before retrying.'
              : described.message,
            unknownOutcome: described.unknownOutcome,
          });
          return;
        }
      }

      if (!['even', 'refund', 'extra'].includes(String(p.financialOutcome))) {
        // Server could not read Shopify's balance (financialOutcome 'unknown').
        setShowPasswordPrompt(false);
        onSuccess?.();
        setError({
          message: 'The exchange was processed in Shopify, but its balance could not be confirmed. The request is flagged for review — check the order in Shopify before issuing any refund or invoice. Do NOT process it again.',
          unknownOutcome: true,
        });
        return;
      }
      const amount = confirmedRefundAmount(p);
      if (p.financialOutcome === 'refund' && amount <= 0) {
        setShowPasswordPrompt(false);
        setError({ message: 'Shopify reported a refund outcome without an amount. Check the order in Shopify and issue the refund from there if needed.' });
        return;
      }
      if (amount > 0 && !refundDone) {
        if (!password) {
          // Outcome turned out to be a refund (or this is the resumed refund
          // step): ask for the refund password now.
          setPromptMode('refund');
          setShowPasswordPrompt(true);
          return;
        }
        try {
          const refundResult = await runRefund(p, password);
          refundWarningText = refundResult.warning;
          issuedGiftCardCode = refundResult.giftCardCode;
        } catch (err) {
          const described = describeRefundError(err);
          if (described.definitive) refundAttemptRef.current = null;
          if (described.badPassword) {
            setPasswordError(described.message);
            setPromptMode('refund');
            setShowPasswordPrompt(true);
          } else {
            setShowPasswordPrompt(false);
            setError({
              message: `The exchange was processed in Shopify, but the refund failed: ${described.message}`,
              unknownOutcome: described.unknownOutcome,
            });
            if (described.alreadyDone) setRefundDone(true);
          }
          return;
        }
      }
      finishSuccess(p, !!refundWarningText, !!issuedGiftCardCode);
    } catch (err) {
      setError({ message: getApiErrorMessage(err, 'Something went wrong. Please try again.') });
    } finally {
      setSaving(false);
    }
  }, [saving, processed, runExchangeProcess, refundDone, runRefund, finishSuccess, onSuccess]);

  const handleSubmit = () => {
    if (saving || success) return;
    setError(null);
    if (processed) {
      // Refund step (exchange already processed).
      if (confirmedRefundAmount(processed) > 0 && !refundDone) {
        if (!methodAllowed) {
          setError({ message: 'Please choose a refund method you are allowed to use.' });
          return;
        }
        if (!manualDetailsValid) {
          setError({ message: 'Select how the manual refund was paid.' });
          return;
        }
        setPasswordError(null);
        setPromptMode('refund');
        setShowPasswordPrompt(true);
        return;
      }
      finishSuccess(processed);
      return;
    }
    if (!canSubmit) return;
    if (financialOutcome === 'refund') {
      setPasswordError(null);
      setPromptMode('exchange');
      setShowPasswordPrompt(true);
      return;
    }
    void runFlow(null);
  };

  const handleClose = () => {
    if (saving) return;
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    // The exchange may have been processed even if the refund step failed —
    // make sure the page reloads the return in that case.
    if (changedServerStateRef.current) onSuccess?.();
    changedServerStateRef.current = false;
    onClose();
  };

  const effectiveOutcome = processed?.financialOutcome ?? financialOutcome;
  const refundStepAmount = confirmedRefundAmount(processed);
  const inRefundStep = !!processed && !success;
  const refundPending = !!processed && refundStepAmount > 0 && !refundDone;
  const alreadyFullyDone = !!processed && !refundPending && !success;
  const discountInfo = processed && (processed.discountApplied || 0) > 0.01
    ? { requestedPercent: processed.discountApplied, applied: processed.discountAppliedViaOrderEdit, error: processed.discountEditError }
    : null;

  return (
    <>
      <BaseModal isOpen={isOpen} onClose={handleClose} title="Process Unified Order Edit" maxWidth="max-w-5xl" closeDisabled={saving}>
        <div className="space-y-5">
          {!processed && (
            <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-100 rounded-xl text-sm text-blue-800">
              <Info className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" aria-hidden="true" />
              <p>
                This action handles both returns and exchanges together. When confirmed, Shopify will remove all requested items, add the new items, and automatically calculate the final net balance.
              </p>
            </div>
          )}

          {error && (
            <div role="alert" className={`flex items-start gap-3 p-4 border rounded-xl text-sm ${error.unknownOutcome ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-red-50 border-red-200 text-red-700'}`}>
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <p>{error.message}</p>
            </div>
          )}

          {inRefundStep && (
            <div className="p-4 rounded-xl border border-indigo-200 bg-indigo-50 text-sm text-indigo-900 space-y-1">
              <p className="font-semibold flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                {processed!.resumed ? 'This exchange was already processed in Shopify.' : 'Exchange processed in Shopify.'}
              </p>
              <p>
                Shopify outcome:{' '}
                <strong>
                  {processed!.financialOutcome === 'refund'
                    ? `refund due ${formatCurrency(refundStepAmount)}`
                    : processed!.financialOutcome === 'extra'
                      ? `customer to pay ${formatCurrency(processed!.outstandingBalance)}`
                      : 'even — nothing owed either way'}
                </strong>
              </p>
              {refundPending && (
                <p>The refund has not been issued yet. Choose a method below and issue it — the exchange itself will not be processed again.</p>
              )}
              {alreadyFullyDone && <p>Nothing else to do here.</p>}
            </div>
          )}

          {success && (
            <div role="status" className={`flex items-center gap-3 p-4 rounded-xl text-sm border ${
              effectiveOutcome === 'extra' && processed && !processed.invoiceSent
                ? 'bg-amber-50 border-amber-200 text-amber-800'
                : 'bg-emerald-50 border-emerald-200 text-emerald-700'
            }`}>
              {effectiveOutcome === 'extra' && processed && !processed.invoiceSent
                ? <AlertCircle className="w-5 h-5 shrink-0" aria-hidden="true" />
                : <CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden="true" />}
              <p className="font-semibold">
                {effectiveOutcome === 'extra'
                  ? processed?.invoiceSent
                    ? `Order updated! A checkout link for ${formatCurrency(processed.outstandingBalance)} was emailed to the customer.`
                    : `Order updated to ${formatCurrency(processed?.outstandingBalance ?? 0)} owing, but the checkout link could NOT be emailed automatically${processed?.invoiceError ? `: ${processed.invoiceError}` : '.'} Send it manually from the order's Shopify admin page.`
                  : effectiveOutcome === 'refund' && refundedAmount !== null
                    ? `Order updated and ${formatCurrency(refundedAmount)} refunded to the customer!`
                    : 'Order updated — return marked as completed!'}
                {(processed?.unappliableAdjustment || 0) > 0.01 && (
                  <span className="block font-normal text-amber-700 mt-1">
                    Note: {formatCurrency(processed!.unappliableAdjustment || 0)} of the value adjustment couldn't be
                    applied to this amount (it exceeded the available fees) — handle that portion separately if needed.
                  </span>
                )}
                {refundWarning && <span className="block font-normal text-amber-700 mt-1">{refundWarning}</span>}
              </p>
            </div>
          )}

          {success && giftCardCode && (
            <div className="flex justify-center">
              <GiftCardCodeReveal code={giftCardCode} />
            </div>
          )}

          {success && discountInfo && (
            <div className={`flex items-start gap-3 p-4 rounded-xl text-sm border ${
              discountInfo.applied ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-800'
            }`}>
              {discountInfo.applied
                ? <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
                : <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />}
              <p className="font-semibold">
                {discountInfo.applied
                  ? `${discountInfo.requestedPercent.toFixed(1)}% discount applied to the replacement item(s) — already reflected in the balance above.`
                  : `${discountInfo.requestedPercent.toFixed(1)}% discount was requested but did NOT apply on Shopify${discountInfo.error ? `: ${discountInfo.error}` : '.'} The customer is being billed the full, undiscounted amount — apply a manual credit or edit the discount directly from the order's Shopify admin page.`}
              </p>
            </div>
          )}

          {!processed && !success && lineItems.length > 0 && (
            <div className="flex items-center gap-2 px-2 mt-2 mb-4">
              <input
                type="checkbox"
                id="allowOutOfStock"
                checked={allowOutOfStock}
                onChange={e => setAllowOutOfStock(e.target.checked)}
                disabled={saving}
                className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600 cursor-pointer disabled:cursor-not-allowed"
              />
              <label htmlFor="allowOutOfStock" className="text-sm font-medium text-slate-700 cursor-pointer">
                Allow selection of out-of-stock items (Pre-orders)
              </label>
            </div>
          )}

          {!processed && (
            <fieldset disabled={saving || success} className="min-w-0">
              {lineItems.map((li, idx) => (
                <ItemExchangeCard
                  key={li.id}
                  lineItem={li}
                  index={idx}
                  onSearchSku={handleSearchSku}
                  onVariantSelect={handleVariantSelect}
                  onQuantityChange={handleQuantityChange}
                  allowOutOfStock={allowOutOfStock}
                  onRemoveItem={handleRemoveReplacementItem}
                  onToggleCreditOverride={handleToggleCreditOverride}
                  onProcessQuantityChange={handleProcessQuantityChange}
                  onSplitRemainder={handleSplitRemainder}
                  remainingQuantity={li.originalItem ? remainingQuantityFor(li) : 0}
                  onAdjustmentChange={updateLineItemAdjustment}
                  unitValue={getUnitValue(li)}
                />
              ))}

              {!success && (
                <button
                  type="button"
                  onClick={handleAddReplacementItem}
                  className="w-full min-h-[44px] py-3 border-2 border-dashed border-indigo-200 bg-indigo-50/50 hover:bg-indigo-50 text-indigo-600 rounded-xl font-medium text-sm flex items-center justify-center gap-2 transition-colors mt-2"
                >
                  <ShoppingBag className="w-4 h-4" aria-hidden="true" />
                  Add Extra Replacement Item
                </button>
              )}
            </fieldset>
          )}

          {!processed && lineItems.length > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-2.5">
              <div className="flex justify-between items-center mb-3">
                <p className="text-sm font-bold text-slate-800 flex items-center gap-2">
                  <Tag className="w-4 h-4 text-slate-500" aria-hidden="true" />
                  Net Order Balance Summary
                </p>
              </div>

              {(paymentBreakdown.storeCreditTotal > 0 || paymentBreakdown.giftCardTotal > 0) && (
                <div className="mb-4 p-3 bg-white border border-slate-200 rounded-xl space-y-1 text-xs">
                  <p className="font-semibold text-slate-600 uppercase tracking-wide mb-1.5">Original Funding</p>
                  {paymentBreakdown.storeCreditTotal > 0 && (
                    <div className="flex justify-between text-indigo-700"><span>Store Credit Used:</span> <span>{formatCurrency(paymentBreakdown.storeCreditTotal)}</span></div>
                  )}
                  {paymentBreakdown.giftCardTotal > 0 && (
                    <div className="flex justify-between text-purple-700"><span>Gift Card Used:</span> <span>{formatCurrency(paymentBreakdown.giftCardTotal)}</span></div>
                  )}
                  <div className="flex justify-between text-slate-600"><span>Gateway / Cash Paid:</span> <span>{formatCurrency(paymentBreakdown.originalCashTotal)}</span></div>
                </div>
              )}

              <div className="flex justify-between gap-3 text-sm text-slate-600">
                <span>Total true value removed (Returns + Exchanges)</span>
                <span className="font-medium tabular-nums text-emerald-600 shrink-0">- {formatCurrency(priceSummary.originalTotal)}</span>
              </div>
              <div className="flex justify-between gap-3 text-sm text-slate-600">
                <span>Total value added (New Replacements)</span>
                <span className="font-medium tabular-nums text-amber-600 shrink-0">+ {formatCurrency(priceSummary.newTotal)}</span>
              </div>
              <div className="border-t border-slate-200 pt-2.5 flex justify-between text-sm font-bold">
                <span>Product Difference</span>
                <span className={`tabular-nums ${Math.abs(priceSummary.diff) < 0.01 ? 'text-slate-500' : priceSummary.diff > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                  {Math.abs(priceSummary.diff) < 0.01 ? '—' : `${priceSummary.diff > 0 ? '+' : '−'} ${formatCurrency(Math.abs(priceSummary.diff))}`}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 -mt-1.5 mb-0.5">
                {priceSummary.diff > 0.01
                  ? 'Replacement is worth more — added to what the customer owes.'
                  : priceSummary.diff < -0.01
                    ? 'Returned value exceeds the replacement — credited toward the customer.'
                    : ''}
              </p>
              {totalRefundDeductions > 0.01 && (
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Total Fees & Adjustments</span>
                  <span className="font-medium tabular-nums text-red-600">+ {formatCurrency(totalRefundDeductions)}</span>
                </div>
              )}
              {totalValueAdjustment > 0.01 && (
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Value Adjustment ({totalDiscountPercentageToSync.toFixed(1)}% equiv.)</span>
                  <span className="font-medium tabular-nums text-emerald-600">- {formatCurrency(totalValueAdjustment)}</span>
                </div>
              )}

              <div className="border-t-2 border-slate-300 pt-2.5 flex justify-between text-sm font-bold">
                <span>Final Net Balance (your estimate)</span>
                <span className={`tabular-nums ${Math.abs(netBalance) < 0.01 ? 'text-slate-500' : netBalance > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                  {Math.abs(netBalance) < 0.01 ? '—' : formatCurrency(Math.abs(netBalance))}
                </span>
              </div>

              <div className="flex flex-wrap justify-between items-center gap-2 text-xs pt-1">
                <span className="text-slate-500 flex items-center gap-1.5">
                  {previewLoading && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                  Confirmed by Shopify
                </span>
                {previewError ? (
                  <span className="text-red-600">{previewError}</span>
                ) : confirmedNetBalance !== null ? (
                  <span className={`font-semibold tabular-nums ${Math.abs(confirmedNetBalance) < 0.01 ? 'text-slate-500' : confirmedNetBalance > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                    {Math.abs(confirmedNetBalance) < 0.01 ? '—' : formatCurrency(Math.abs(confirmedNetBalance))}
                    {confirmedFinancialOutcome && confirmedFinancialOutcome !== financialOutcome && (
                      <span className="ml-1 text-amber-600">(differs from estimate)</span>
                    )}
                  </span>
                ) : (
                  <span className="text-slate-400">not yet verified</span>
                )}
              </div>

              {unappliableAdjustment > 0.01 && (
                <div className="flex items-start gap-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>
                    {formatCurrency(unappliableAdjustment)} of the adjustment on a plain returned item exceeds
                    the fees it's netted against — Shopify has no discount lever on a return itself, so this
                    portion won't reduce the actual checkout link or refund amount. Enable/raise a fee to
                    offset it, or handle the difference with a separate manual credit.
                  </span>
                </div>
              )}

              {(serverPreview?.estimatedExchangeDiscountTotal || 0) > 0.01 && (
                <div className="flex items-start gap-2 p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>
                    {formatCurrency(serverPreview!.estimatedExchangeDiscountTotal)} of discount on the
                    replacement item(s) WILL reach the customer — applied to Shopify's real order total in a
                    follow-up step right after this exchange is processed.
                  </span>
                </div>
              )}

              <div className="mt-3 pt-3 border-t border-slate-200 space-y-2">
                {lineItems.map((li) => {
                  if (isCreditRow(li)) {
                    return (
                      <div key={li.id} className="flex items-center gap-2 text-xs text-slate-500">
                        <MinusCircle className="w-3 h-3 text-emerald-500 shrink-0" aria-hidden="true" />
                        <span className="flex-1 truncate">{li.originalItem?.title ?? 'Original item'} × {li.processQuantity}</span>
                        <span className="font-medium text-emerald-600">Removed</span>
                      </div>
                    );
                  }
                  if (!li.selectedVariantId || !li.product) return null;
                  const variant = li.product.variants.find(v => v.id === li.selectedVariantId);
                  if (!variant) return null;
                  return (
                    <div key={li.id} className="flex items-center gap-2 text-xs text-slate-500">
                      <Layers className="w-3 h-3 shrink-0" aria-hidden="true" />
                      <span className="flex-1 truncate">{li.originalItem?.title ?? li.product.title}</span>
                      <ArrowRight className="w-3 h-3 shrink-0" aria-hidden="true" />
                      <span className="font-medium text-slate-700 truncate">{variant.title} × {li.quantity}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!processed && lineItems.length > 0 && !success && (
            <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-3 mt-5">
              <p className="text-sm font-bold text-slate-800 mb-1">Fees & Adjustments</p>
              <p className="text-xs text-slate-500 -mt-2 mb-2">
                Restocking, reverse/forward shipment, and value-adjustment fees are set per item above. This summarizes what's currently enabled.
              </p>
              <div className="space-y-1.5 text-sm">
                {combinedAdjustmentTotals.restocking > 0.01 && (
                  <div className="flex justify-between text-slate-600"><span>Restocking fees (all items)</span><span className="font-medium text-red-600">+ {formatCurrency(combinedAdjustmentTotals.restocking)}</span></div>
                )}
                {combinedAdjustmentTotals.reverseShipment > 0.01 && (
                  <div className="flex justify-between text-slate-600"><span>Reverse shipment fees (all items)</span><span className="font-medium text-red-600">+ {formatCurrency(combinedAdjustmentTotals.reverseShipment)}</span></div>
                )}
                {combinedAdjustmentTotals.forwardShipment > 0.01 && (
                  <div className="flex justify-between text-slate-600"><span>Forward shipment fees (all items)</span><span className="font-medium text-red-600">+ {formatCurrency(combinedAdjustmentTotals.forwardShipment)}</span></div>
                )}
                {totalValueAdjustment > 0.01 && (
                  <div className="flex justify-between text-slate-600"><span>Discount (all items, goodwill)</span><span className="font-medium text-emerald-600">− {formatCurrency(totalValueAdjustment)}</span></div>
                )}
                {combinedAdjustmentTotals.total < 0.01 && (
                  <p className="text-xs text-slate-400">No per-item fees enabled yet — toggle them on each item's card above.</p>
                )}
              </div>
              {priceSummary.diff < -0.01 && (
                <div className="pt-2 border-t border-slate-100">
                  <CheckboxWithInput
                    label={`Deduct Taxes from Refund (₹${calculatedTax.toFixed(2)})`}
                    checked={deductTaxes}
                    onChangeCheck={setDeductTaxes}
                    inputValue={taxInput}
                    onChangeInput={setTaxInput}
                    disabled={saving}
                    inputDisabled={!deductTaxes}
                    min={0}
                    max={calculatedTax}
                    showQuantityMultiplier={false}
                  />
                </div>
              )}
            </div>
          )}

          {!processed && financialOutcome === 'extra' && !success && (
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800 mt-5">
              <Mail className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />
              <p>
                The customer owes <strong>{formatCurrency(outstandingBalanceAmount)}</strong>. Once you commit, Shopify will
                automatically email them a secure checkout link to pay the balance — nothing else to do here.
              </p>
            </div>
          )}

          {!processed && financialOutcome === 'even' && !success && (
            <div className="flex items-start gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-800 mt-5">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />
              <p>Values match exactly — nobody owes anything. This return will be marked <strong>completed</strong> automatically.</p>
            </div>
          )}

          {((!processed && financialOutcome === 'refund') || refundPending) && !success && (
            <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-4 mt-5">
              <div className="flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-slate-500" aria-hidden="true" />
                <p className="text-sm font-bold text-slate-800">
                  Refund the customer {formatCurrency(refundPending ? refundStepAmount : finalRefundAmount)}
                  {!refundPending && <span className="font-normal text-slate-500"> (estimate — Shopify's confirmed amount is refunded)</span>}
                </p>
              </div>
              <RefundMethodPicker
                value={refundMethod}
                onChange={setRefundMethod}
                allowOriginalPayment={allowOriginalPayment}
                hasCustomer={hasCustomer}
                disabled={saving}
                showDescriptions={false}
              />
              {refundMethod === 'manual' && (
                <ManualRefundFields
                  method={manualMethod}
                  onMethodChange={setManualMethod}
                  reference={manualReference}
                  onReferenceChange={setManualReference}
                  disabled={saving}
                  idPrefix="exchange-refund-manual"
                />
              )}
              <div className="flex items-center gap-3 pt-1">
                <input
                  type="checkbox"
                  id="exchangeNotifyCustomer"
                  checked={notifyCustomer}
                  onChange={e => setNotifyCustomer(e.target.checked)}
                  disabled={saving}
                  className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
                />
                <label htmlFor="exchangeNotifyCustomer" className="text-sm text-slate-700">
                  Ask Shopify to notify the customer about this refund
                </label>
              </div>
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={saving || showPasswordPrompt}
              className="flex-1 min-h-[44px] px-4 py-3 border-2 border-slate-200 text-slate-700 font-semibold rounded-xl hover:bg-slate-50 transition-colors disabled:opacity-50"
            >
              {success || alreadyFullyDone ? 'Close' : 'Cancel'}
            </button>
            {!alreadyFullyDone && (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={saving || success || showPasswordPrompt || (!processed && !canSubmit) || (refundPending && (!methodAllowed || !manualDetailsValid))}
                className="flex-1 min-h-[44px] px-4 py-3 bg-slate-900 hover:bg-slate-800 text-white font-semibold rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {saving ? (
                  <><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />Processing via Shopify...</>
                ) : success ? (
                  <><CheckCircle2 className="w-4 h-4" aria-hidden="true" />Success!</>
                ) : refundPending ? (
                  <><CreditCard className="w-4 h-4" aria-hidden="true" />Issue Refund {formatCurrency(refundStepAmount)}</>
                ) : (
                  <><RefreshCw className="w-4 h-4" aria-hidden="true" />Commit Order Edit</>
                )}
              </button>
            )}
          </div>
        </div>
      </BaseModal>

      <PasswordPromptModal
        isOpen={showPasswordPrompt}
        onClose={() => { if (!saving) { setShowPasswordPrompt(false); setPasswordError(null); } }}
        onConfirm={(pw) => runFlow(pw)}
        isLoading={saving}
        error={passwordError}
        title={promptMode === 'exchange' ? 'Confirm Exchange & Refund' : 'Verify Refund'}
        confirmLabel={promptMode === 'exchange' ? 'Process & Refund' : `Refund ${formatCurrency(refundStepAmount || finalRefundAmount)}`}
        description={promptMode === 'exchange'
          ? 'The exchange will be processed in Shopify first; then exactly the refund amount Shopify confirms is paid out.'
          : undefined}
      />
    </>
  );
};

export default ExchangeModal;

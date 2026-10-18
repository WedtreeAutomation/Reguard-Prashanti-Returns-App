import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { BaseModal } from './BaseModal';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { ReturnItem, IssueRefundModalProps } from '../Interfaces/types';
import { addShopifyNote, issueRefund, RefundRequest } from '../Interfaces/api';
import { verifyRefundPassword } from '../Interfaces/authApi';
import { newIdempotencyKey } from '../Interfaces/http';
import { canRefundOriginalPayment } from '../Interfaces/permissions';
import {
  REFUND_METHODS,
  RefundMethod,
  RefundMethodPicker,
  SummaryRow,
  PasswordPromptModal,
  formatRefundCurrency as formatCurrency,
  ItemAdjustmentState,
  makeDefaultItemAdjustment,
  computeItemAdjustmentTotals,
  sumItemAdjustmentTotals,
  QuantityDropdown,
  ItemAdjustmentPanel,
  CheckboxWithInput,
  computePaymentBreakdown,
  getPaidUnitValue,
  getUnitTax,
  getOriginalShippingCost,
  toShopifyOrderGid,
  ManualRefundFields,
  ManualRefundMethod,
  MANUAL_REFUND_METHODS,
  GiftCardCodeReveal,
} from './RefundShared';
import {
  describeRefundError,
  toApiRefundMethod,
  REFUND_METHOD_LABELS,
  buildDeductions,
  round2,
} from '../components/Agent/refunds';
import { restockedQtyMap } from '../components/Agent/returnHelpers';

type IssueRefundModalExtraProps = {
  onSuccess?: () => void;
  /** Firestore return doc id (defaults to data.id). */
  returnId?: string;
};

export const IssueRefundModal: React.FC<IssueRefundModalProps & IssueRefundModalExtraProps> = ({
  isOpen,
  onClose,
  orderId,
  data,
  currentUser,
  shopifyOrder,
  onSuccess,
  returnId,
}) => {
  const docId = returnId || data?.id;
  const [loading, setLoading] = useState(false);
  const [refundMethod, setRefundMethod] = useState<RefundMethod>('store_credit');
  const allowOriginalPayment = canRefundOriginalPayment(currentUser?.role);
  const [error, setError] = useState<{ message: string; unknownOutcome?: boolean; alreadyDone?: boolean } | null>(null);
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  const [successData, setSuccessData] = useState<{ show: boolean; message: string; warning?: string; giftCardCode?: string }>({ show: false, message: '' });
  const [manualMethod, setManualMethod] = useState<ManualRefundMethod | ''>('');
  const [manualReference, setManualReference] = useState('');

  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // One idempotency key per attempt: reused while the request is unchanged
  // (so a retry after a timeout can't refund twice), regenerated when the
  // agent changes inputs or after a definitive failure.
  const attemptRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const [processQuantities, setProcessQuantities] = useState<Record<number, number>>({});
  const [itemAdjustments, setItemAdjustments] = useState<Record<number, ItemAdjustmentState>>({});

  const [deductTaxes, setDeductTaxes] = useState(false);
  const [taxInput, setTaxInput] = useState('');

  const [addShippingRefund, setAddShippingRefund] = useState(false);
  const [shippingRefundAmount, setShippingRefundAmount] = useState('0.00');

  const [calculatedTax, setCalculatedTax] = useState(0);
  const [calculatedBaseRefund, setCalculatedBaseRefund] = useState(0);

  const paymentBreakdown = useMemo(() => computePaymentBreakdown(shopifyOrder), [shopifyOrder]);
  const hasCustomer = !!shopifyOrder?.customer?.id;
  const orderTotal = useMemo(() => parseFloat(shopifyOrder?.total_price || '0') || 0, [shopifyOrder]);
  const isOrderUnder2000 = orderTotal > 0 && orderTotal < 2000;
  const originalShippingCost = useMemo(() => getOriginalShippingCost(shopifyOrder), [shopifyOrder]);

  const orderDisplayName = useMemo(
    () => data?.orderId || shopifyOrder?.name || (shopifyOrder?.order_number ? `#${shopifyOrder.order_number}` : orderId),
    [data?.orderId, shopifyOrder, orderId]
  );

  const isExchangeDerived = useMemo(
    () => (data?.actionType === 'exchange' || !!data?.type?.toLowerCase().includes('exchange')) && typeof data?.netRefundAmount === 'number',
    [data?.actionType, data?.type, data?.netRefundAmount]
  );

  // Only plain-return items that weren't rejected are refunded here; exchange
  // items are settled by ExchangeModal. Legacy items without actionType are returns.
  const refundableItems = useMemo(() => {
    if (!Array.isArray(data?.items)) return [];
    const rejectedIds = new Set((data.rejectedItems || []).map((r) => r?.lineItemId));
    return data.items.filter((item) => !!item && (item.actionType || 'return') === 'return' && !rejectedIds.has(item.lineItemId));
  }, [data?.items, data?.rejectedItems]);

  const getItemUnitValue = useCallback((item: ReturnItem) => getPaidUnitValue(shopifyOrder, item), [shopifyOrder]);
  const getItemUnitTax = useCallback((item: ReturnItem) => getUnitTax(shopifyOrder, item), [shopifyOrder]);

  const alreadyRestockedByLineItem = useMemo(() => restockedQtyMap(data), [data]);

  useEffect(() => {
    if (!refundableItems.length) return;
    setProcessQuantities((prev) => {
      const next = { ...prev };
      refundableItems.forEach((item) => {
        if (next[item.lineItemId] === undefined) next[item.lineItemId] = item.quantityReturned;
      });
      return next;
    });
    setItemAdjustments((prev) => {
      const next = { ...prev };
      refundableItems.forEach((item) => {
        if (!next[item.lineItemId]) next[item.lineItemId] = makeDefaultItemAdjustment({ reverseShipmentDefaultOn: true });
      });
      return next;
    });
  }, [refundableItems]);

  const updateItemAdjustment = useCallback((lineItemId: number, next: ItemAdjustmentState) => {
    setItemAdjustments((prev) => ({ ...prev, [lineItemId]: next }));
  }, []);

  const handleProcessQuantityChange = useCallback((lineItemId: number, qty: number, max: number) => {
    setProcessQuantities((prev) => ({ ...prev, [lineItemId]: Math.min(Math.max(1, qty), max) }));
  }, []);

  const totalQuantityReturned = useMemo(
    () => refundableItems.reduce((acc, item) => acc + (item.quantityReturned || 0), 0),
    [refundableItems]
  );

  const adjustmentTotalsByItem = useMemo(() => {
    const map: Record<number, ReturnType<typeof computeItemAdjustmentTotals>> = {};
    refundableItems.forEach((item) => {
      const state = itemAdjustments[item.lineItemId];
      if (!state) return;
      const qty = processQuantities[item.lineItemId] ?? item.quantityReturned;
      map[item.lineItemId] = computeItemAdjustmentTotals(state, getItemUnitValue(item), qty);
    });
    return map;
  }, [refundableItems, itemAdjustments, processQuantities, getItemUnitValue]);

  const combinedAdjustmentTotals = useMemo(
    () => sumItemAdjustmentTotals(Object.values(adjustmentTotalsByItem)),
    [adjustmentTotalsByItem]
  );

  const taxDeduction = deductTaxes ? parseFloat(taxInput || '0') || 0 : 0;
  const totalValueAdjustment = combinedAdjustmentTotals.valueAdjustment;
  const totalShippingAddition = addShippingRefund ? parseFloat(shippingRefundAmount || '0') || 0 : 0;

  const totalDeduction =
    combinedAdjustmentTotals.restocking +
    combinedAdjustmentTotals.reverseShipment +
    combinedAdjustmentTotals.forwardShipment +
    totalValueAdjustment +
    taxDeduction;

  const finalRefundAmount = Math.max(0, round2(calculatedBaseRefund + totalShippingAddition - totalDeduction));

  const hasNothingToRefund = !isExchangeDerived && refundableItems.length === 0;
  const alreadyRefunded = (data?.refundStatus || '').toLowerCase() === 'refunded';

  const validationError = useMemo(() => {
    if (alreadyRefunded) return 'This return has already been refunded.';
    if (hasNothingToRefund) {
      return 'Nothing left to refund on this request — use Process Exchange for the exchange item(s) instead.';
    }
    if (finalRefundAmount <= 0 && refundMethod !== 'manual') return 'Refund amount must be greater than 0';
    if (refundMethod === 'manual' && !manualMethod) return 'Select how the manual refund was paid.';
    const selectedMethod = REFUND_METHODS.find((m) => m.id === refundMethod);
    if (selectedMethod?.requiresCustomer && !hasCustomer) return 'This refund method requires a customer account';
    if (!docId) return 'This return could not be identified. Reload the page and try again.';
    return null;
  }, [alreadyRefunded, hasNothingToRefund, finalRefundAmount, refundMethod, hasCustomer, docId, manualMethod]);

  const isRefundValid = validationError === null;

  useEffect(() => {
    // Agents are never allowed to refund to the original payment method.
    if (refundMethod === 'original' && !allowOriginalPayment) setRefundMethod('store_credit');
  }, [refundMethod, allowOriginalPayment]);

  useEffect(() => {
    if (isExchangeDerived) {
      setCalculatedBaseRefund(data.netRefundAmount as number);
      setCalculatedTax(0);
      setTaxInput('0.00');
      setShippingRefundAmount('0.00');
      setAddShippingRefund(false);
      return;
    }

    if (refundableItems.length > 0) {
      let baseRefund = 0;
      let totalReturnTax = 0;
      refundableItems.forEach((item) => {
        const qty = processQuantities[item.lineItemId] ?? item.quantityReturned;
        baseRefund += getItemUnitValue(item) * qty;
        totalReturnTax += getItemUnitTax(item) * qty;
      });
      setShippingRefundAmount(originalShippingCost.toFixed(2));
      setAddShippingRefund(isOrderUnder2000 && originalShippingCost > 0);
      setCalculatedBaseRefund(baseRefund);
      setCalculatedTax(totalReturnTax);
      setTaxInput(totalReturnTax.toFixed(2));
    } else {
      setCalculatedBaseRefund(0);
      setCalculatedTax(0);
      setTaxInput('0.00');
      setAddShippingRefund(false);
    }
  }, [refundableItems, isExchangeDerived, data?.netRefundAmount, processQuantities, getItemUnitValue, getItemUnitTax, isOrderUnder2000, originalShippingCost]);

  const totalOrderedQuantity = useMemo(
    () => shopifyOrder?.line_items?.reduce((sum, li) => sum + (li.quantity || 0), 0) || 0,
    [shopifyOrder]
  );
  const isFullReturn = totalQuantityReturned >= totalOrderedQuantity && totalOrderedQuantity > 0;

  const lineItems = useMemo(() => refundableItems
    .filter((item) => item.lineItemId)
    .map((item) => {
      const qty = processQuantities[item.lineItemId] ?? item.quantityReturned;
      const alreadyRestocked = Math.min(alreadyRestockedByLineItem.get(item.lineItemId) || 0, qty);
      return {
        lineItemId: `gid://shopify/LineItem/${item.lineItemId}`,
        quantity: qty,
        sku: item.sku,
        // Don't ask Shopify to restock units that were already put back via
        // the inventory adjustment at Mark-Received time.
        alreadyRestockedQuantity: alreadyRestocked,
        restock: alreadyRestocked < qty,
      };
    }), [refundableItems, processQuantities, alreadyRestockedByLineItem]);

  const note = useMemo(() => {
    const parts: string[] = [];
    if (combinedAdjustmentTotals.restocking > 0.01) parts.push('Restocking fee applied');
    if (combinedAdjustmentTotals.reverseShipment > 0.01) parts.push('Reverse shipment cost deducted');
    if (combinedAdjustmentTotals.forwardShipment > 0.01) parts.push('Forward shipment cost deducted');
    if (totalValueAdjustment > 0.01) parts.push('Value adjustment applied');
    if (deductTaxes) parts.push('Taxes deducted');
    if (addShippingRefund && totalShippingAddition > 0) parts.push('Original shipping cost refunded');
    const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    const statusText = isFullReturn
      ? 'Expected Status: Cancelled, Refunded, Unfulfilled (Full Return)'
      : 'Expected Status: Refunded, Partially Fulfilled (Partial Return)';
    return `Refund for return ${orderDisplayName}${suffix}\n${statusText}`;
  }, [orderDisplayName, combinedAdjustmentTotals, totalValueAdjustment, deductTaxes, addShippingRefund, totalShippingAddition, isFullReturn]);

  const buildRequest = useCallback((idempotencyKey: string, refundPassword: string): RefundRequest => ({
    returnId: docId as string,
    idempotencyKey,
    refundPassword,
    orderId: data?.orderId || orderId,
    shopifyOrderId: toShopifyOrderGid(shopifyOrder?.id ?? data?.orderNumericId),
    amount: finalRefundAmount.toFixed(2),
    note,
    lineItems,
    notifyCustomer,
    ...(refundMethod === 'manual'
      ? { manualMethod: manualMethod || 'other', ...(manualReference.trim() ? { manualReference: manualReference.trim().slice(0, 120) } : {}) }
      : {}),
    metadata: {
      orderName: orderDisplayName,
      isFullReturn,
      baseAmount: round2(calculatedBaseRefund),
      shippingRefundAddition: round2(totalShippingAddition),
      deductions: buildDeductions(combinedAdjustmentTotals, totalValueAdjustment, taxDeduction),
      quantityMultiplied: {
        restocking: combinedAdjustmentTotals.restocking > 0.01,
        reverseShipment: combinedAdjustmentTotals.reverseShipment > 0.01,
        forwardShipment: combinedAdjustmentTotals.forwardShipment > 0.01,
        adjustment: totalValueAdjustment > 0.01,
      },
      source: 'refund',
    },
  }), [
    docId, data?.orderId, data?.orderNumericId, orderId, shopifyOrder?.id, finalRefundAmount, note, lineItems, notifyCustomer,
    refundMethod, manualMethod, manualReference,
    orderDisplayName, isFullReturn, calculatedBaseRefund, totalShippingAddition, combinedAdjustmentTotals, totalValueAdjustment, taxDeduction,
  ]);

  // Everything that changes what would be refunded. A change → new attempt key.
  const fingerprint = JSON.stringify([
    refundMethod, finalRefundAmount.toFixed(2), lineItems, notifyCustomer, note,
    refundMethod === 'manual' ? [manualMethod, manualReference.trim()] : null,
  ]);

  const handleIssueRefund = useCallback(() => {
    if (loading || successData.show) return;
    if (!isRefundValid) {
      setError({ message: validationError || 'Refund is not valid' });
      return;
    }
    if (refundMethod === 'original' && !allowOriginalPayment) {
      setError({ message: 'You do not have permission to refund to the original payment method. Please choose store credit, gift card, or manual refund instead.' });
      return;
    }
    setPasswordError(null);
    setShowPasswordPrompt(true);
  }, [loading, successData.show, isRefundValid, validationError, refundMethod, allowOriginalPayment]);

  const processRefundWithPassword = useCallback(async (password: string) => {
    if (loading) return;
    setLoading(true);
    setPasswordError(null);
    setError(null);
    try {
      // Early feedback for a mistyped password (the refund call re-checks it).
      const check = await verifyRefundPassword(password);
      if (check === 'bad') {
        setPasswordError('Incorrect refund password. Please try again.');
        return;
      }
      // 'unavailable' → carry on: the refund endpoint verifies the password again.

      if (!attemptRef.current || attemptRef.current.fingerprint !== fingerprint) {
        attemptRef.current = { fingerprint, key: newIdempotencyKey() };
      }
      const result = await issueRefund(toApiRefundMethod(refundMethod), buildRequest(attemptRef.current.key, password));

      const amount = finalRefundAmount;
      let message = 'Refund processed successfully!';
      const giftCardCode = refundMethod === 'giftcard' && typeof result.giftCardCode === 'string' && result.giftCardCode.trim()
        ? result.giftCardCode.trim()
        : undefined;
      if (refundMethod === 'giftcard') message = `Gift card of ₹${formatCurrency(amount)} created successfully!`;
      else if (refundMethod === 'store_credit') message = `Store credit of ₹${formatCurrency(amount)} issued successfully!`;
      else if (refundMethod === 'original') message = `₹${formatCurrency(amount)} refunded to the original payment method.`;
      else if (refundMethod === 'manual') {
        const label = MANUAL_REFUND_METHODS.find((m) => m.id === manualMethod)?.label || 'Other';
        message = `Refund marked as manually processed (${label}${manualReference.trim() ? ` · ${manualReference.trim()}` : ''}).`;
      }
      if (result.duplicate) message += '\n(This refund had already been completed — no second refund was made.)';

      const warning = refundMethod !== 'manual' && result.emailSent === false
        ? 'The customer confirmation e-mail could not be sent. Please inform the customer manually.'
        : undefined;

      setShowPasswordPrompt(false);
      setSuccessData({ show: true, message, warning, giftCardCode });
      attemptRef.current = null;

      void addShopifyNote(
        data?.orderNumericId || orderId,
        data?.RAN || 'Unknown',
        'Refund Issued',
        `Amount: ₹${amount.toFixed(2)}\nMethod: ${REFUND_METHOD_LABELS[refundMethod]}\nAction by: ${currentUser?.name || currentUser?.email || 'Agent'}`
      );
    } catch (err) {
      const described = describeRefundError(err);
      if (described.definitive) attemptRef.current = null;
      if (described.badPassword) {
        setPasswordError(described.message);
      } else {
        setShowPasswordPrompt(false);
        setError({ message: described.message, unknownOutcome: described.unknownOutcome, alreadyDone: described.alreadyDone });
      }
    } finally {
      setLoading(false);
    }
  }, [loading, fingerprint, refundMethod, buildRequest, finalRefundAmount, data?.orderNumericId, data?.RAN, orderId, currentUser, manualMethod, manualReference]);

  const handleClose = useCallback(() => {
    if (loading) return;
    if (successData.show && onSuccess) onSuccess();
    setError(null);
    setRefundMethod('store_credit');
    setManualMethod('');
    setManualReference('');
    setNotifyCustomer(true);
    setProcessQuantities({});
    setItemAdjustments({});
    setDeductTaxes(false);
    setTaxInput(calculatedTax.toFixed(2));
    setAddShippingRefund(false);
    setShowPasswordPrompt(false);
    setPasswordError(null);
    setSuccessData({ show: false, message: '' });
    attemptRef.current = null;
    onClose();
  }, [loading, onClose, calculatedTax, successData.show, onSuccess]);

  const submitDisabled = loading || !isRefundValid || successData.show || !!error?.alreadyDone;

  return (
    <>
      <BaseModal isOpen={isOpen} onClose={handleClose} title="Issue Refund" maxWidth="max-w-lg" closeDisabled={loading}>
        {successData.show ? (
          <div className="flex flex-col items-center justify-center py-8 text-center space-y-4 animate-in fade-in zoom-in duration-300" role="status">
            <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mb-2 shadow-sm">
              <CheckCircle2 className="w-12 h-12 text-green-600" aria-hidden="true" />
            </div>
            <h3 className="text-xl font-bold text-slate-800">Refund Successful!</h3>
            <p className="text-sm text-slate-600 max-w-sm font-medium leading-relaxed whitespace-pre-wrap break-words">
              {successData.message}
            </p>
            {successData.giftCardCode && <GiftCardCodeReveal code={successData.giftCardCode} />}
            {successData.warning && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 max-w-sm">{successData.warning}</p>
            )}
            <div className="pt-6 w-full">
              <button
                type="button"
                onClick={handleClose}
                className="w-full min-h-[44px] bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg shadow-md transition-all active:scale-[0.98]"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 text-slate-800">
            {error && (
              <div
                role="alert"
                className={`px-4 py-3 rounded-lg text-sm border flex items-start gap-2 ${
                  error.unknownOutcome ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-red-50 border-red-200 text-red-700'
                }`}
              >
                {error.unknownOutcome && <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />}
                <span>
                  <strong className="font-medium">{error.unknownOutcome ? 'Status unknown: ' : 'Error: '}</strong>
                  {error.message}
                </span>
              </div>
            )}

            {validationError && !error && (
              <div className="bg-amber-50 border border-amber-200 text-amber-700 px-4 py-3 rounded-lg text-sm">
                <strong className="font-medium">Notice: </strong>
                {validationError}
              </div>
            )}

            <div className="flex flex-wrap justify-between items-center gap-1 mb-2">
              <p className="text-sm text-slate-700">Order: <span className="font-medium">{orderDisplayName}</span></p>
              {shopifyOrder?.customer?.email && (
                <p className="text-xs text-slate-500 break-all">Customer: {shopifyOrder.customer.email}</p>
              )}
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 mb-6">
              <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Original Order Payment Breakdown</h4>
              <div className="space-y-1.5 text-sm">
                {paymentBreakdown.storeCreditTotal > 0 && (
                  <div className="flex justify-between gap-2 text-indigo-700 font-medium">
                    <span>💳 Store Credit Applied</span>
                    <span>₹{formatCurrency(paymentBreakdown.storeCreditTotal)}</span>
                  </div>
                )}
                {paymentBreakdown.giftCardTotal > 0 && (
                  <div className="flex justify-between gap-2 text-purple-700 font-medium">
                    <span>🎁 Gift Card Applied</span>
                    <span>₹{formatCurrency(paymentBreakdown.giftCardTotal)}</span>
                  </div>
                )}
                <div className="flex justify-between gap-2 text-slate-700">
                  <span>💰 Cash / Gateway (Card, UPI, etc.)</span>
                  <span>₹{formatCurrency(paymentBreakdown.originalCashTotal)}</span>
                </div>
              </div>

              {paymentBreakdown.hasMultipleMethods && refundMethod === 'original' && (
                <div className="mt-3 p-2 bg-blue-50 border border-blue-100 rounded text-xs text-blue-800 flex items-start gap-2">
                  <span className="mt-0.5" aria-hidden="true">ℹ️</span>
                  <p>
                    Because this order used multiple payment methods, Shopify will automatically prioritize refunding the
                    <b> {paymentBreakdown.giftCardTotal > 0 ? 'Gift Card' : 'Store Credit'} </b> first, with the remainder going to the gateway.
                  </p>
                </div>
              )}
            </div>

            <p className="text-sm text-slate-700 mb-2">Select Refund Options</p>
            <div className="mb-6">
              <RefundMethodPicker
                value={refundMethod}
                onChange={setRefundMethod}
                allowOriginalPayment={allowOriginalPayment}
                hasCustomer={hasCustomer}
                disabled={loading}
              />
            </div>

            {refundMethod === 'manual' && (
              <ManualRefundFields
                method={manualMethod}
                onMethodChange={setManualMethod}
                reference={manualReference}
                onReferenceChange={setManualReference}
                disabled={loading}
                idPrefix="issue-refund-manual"
              />
            )}

            {refundMethod === 'original' && (
              <div className="flex items-center gap-3 py-2">
                <input
                  type="checkbox"
                  id="notifyCustomer"
                  checked={notifyCustomer}
                  onChange={(e) => setNotifyCustomer(e.target.checked)}
                  disabled={loading}
                  className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
                />
                <label htmlFor="notifyCustomer" className="text-sm text-slate-700">
                  Ask Shopify to notify the customer about this refund
                </label>
              </div>
            )}

            <div className="space-y-3 pt-2">
              <div className={`p-2 rounded-md border ${isOrderUnder2000 && originalShippingCost > 0 ? 'bg-emerald-50/50 border-emerald-100' : 'bg-slate-50 border-slate-200'}`}>
                <CheckboxWithInput
                  label={`Refund Original Shipping Cost (Order Total: ₹${formatCurrency(orderTotal)})`}
                  checked={addShippingRefund}
                  onChangeCheck={setAddShippingRefund}
                  inputValue={shippingRefundAmount}
                  onChangeInput={setShippingRefundAmount}
                  disabled={loading || !isOrderUnder2000 || originalShippingCost === 0}
                  min={0}
                  max={originalShippingCost}
                  showQuantityMultiplier={false}
                />
                {!isOrderUnder2000 && orderTotal > 0 && (
                  <p className="text-[10px] text-slate-500 ml-7 mt-1">Shipping refund not automatically applied (Order is ₹2000 or more).</p>
                )}
                {originalShippingCost === 0 && orderTotal > 0 && (
                  <p className="text-[10px] text-slate-500 ml-7 mt-1">No shipping charges found on the original Shopify order.</p>
                )}
              </div>

              {!isExchangeDerived && refundableItems.length === 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
                  Nothing left to refund here — every item on this request is either being exchanged or was rejected.
                  Use <strong>Process Exchange</strong> for the exchange item(s) instead; it already nets any returned
                  item's value against the replacement's cost.
                </div>
              )}

              {!isExchangeDerived && refundableItems.length > 0 && (
                <div className="space-y-3">
                  <p className="text-sm font-semibold text-slate-800">Items being refunded</p>
                  {refundableItems.map((item) => {
                    const qty = processQuantities[item.lineItemId] ?? item.quantityReturned;
                    const adjustments = itemAdjustments[item.lineItemId] || makeDefaultItemAdjustment({ reverseShipmentDefaultOn: true });
                    return (
                      <div key={item.lineItemId} className="border border-slate-200 rounded-lg p-3 bg-white space-y-2">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-slate-800 break-words">{item.title}</p>
                            <p className="text-xs text-slate-500">{item.sku && item.sku !== 'N/A' ? item.sku : 'No SKU'} · {item.price} · returned {item.quantityReturned}</p>
                          </div>
                          <QuantityDropdown
                            value={qty}
                            max={item.quantityReturned}
                            onChange={(v) => handleProcessQuantityChange(item.lineItemId, v, item.quantityReturned)}
                            label="Refunding"
                            disabled={loading}
                          />
                        </div>
                        <ItemAdjustmentPanel
                          state={adjustments}
                          onChange={(next) => updateItemAdjustment(item.lineItemId, next)}
                          unitValue={getItemUnitValue(item)}
                          quantity={qty}
                          showReturnFees
                          showForwardShipment={false}
                          showValueAdjustment={false}
                          disabled={loading}
                          compact
                        />
                      </div>
                    );
                  })}
                </div>
              )}

              <CheckboxWithInput
                label={`Deduct Taxes from Refund (₹${formatCurrency(calculatedTax)})`}
                checked={deductTaxes}
                onChangeCheck={setDeductTaxes}
                inputValue={taxInput}
                onChangeInput={setTaxInput}
                disabled={loading}
                inputDisabled={!deductTaxes}
                min={0}
                max={calculatedTax}
                showQuantityMultiplier={false}
              />
            </div>

            <div className="bg-slate-100 p-4 rounded-lg mt-6 space-y-2.5">
              <h4 className="font-medium text-sm text-slate-800 mb-2">Refund Summary</h4>
              <SummaryRow label="Calculated Refund Amount (Items)" value={calculatedBaseRefund} />
              {addShippingRefund && (
                <SummaryRow label="Original Shipping Refund Addition" value={totalShippingAddition} className="text-emerald-600 font-medium" />
              )}
              {combinedAdjustmentTotals.restocking > 0.01 && (
                <SummaryRow label="Restocking fees (all items)" value={-combinedAdjustmentTotals.restocking} className="text-red-600" />
              )}
              {combinedAdjustmentTotals.reverseShipment > 0.01 && (
                <SummaryRow label="Reverse shipment fees (all items)" value={-combinedAdjustmentTotals.reverseShipment} className="text-red-600" />
              )}
              {totalValueAdjustment > 0.01 && (
                <SummaryRow label="Discounts" value={-totalValueAdjustment} className="text-orange-600 font-medium" />
              )}
              {deductTaxes && <SummaryRow label="Tax Deduction" value={-taxDeduction} className="text-red-600" />}
              <div className="border-t border-slate-200 my-2" />
              <SummaryRow label="Total Deductions" value={totalDeduction} className="text-slate-600" />
              <div className="flex justify-between font-bold text-sm text-slate-900 pt-1">
                <span>Final Refund Amount</span>
                <span className="text-green-600">₹{formatCurrency(finalRefundAmount)}</span>
              </div>
            </div>

            <div className="pt-4 pb-2">
              <button
                type="button"
                onClick={handleIssueRefund}
                disabled={submitDisabled}
                className="w-full min-h-[44px] bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Processing...' : error?.unknownOutcome ? `Retry Refund (₹${formatCurrency(finalRefundAmount)})` : `Issue Refund (₹${formatCurrency(finalRefundAmount)})`}
              </button>
            </div>

            {refundMethod === 'manual' && (
              <p className="text-xs text-slate-500 text-center">
                Note: This will mark the refund as completed in the system.
                You are responsible for processing the refund manually outside of Shopify.
              </p>
            )}

            {refundMethod === 'original' && shopifyOrder?.paymentGatewayNames && (
              <p className="text-xs text-slate-500 text-center">
                Refund will be processed through {shopifyOrder.paymentGatewayNames.join(', ')}.
              </p>
            )}
          </div>
        )}
      </BaseModal>

      <PasswordPromptModal
        isOpen={showPasswordPrompt}
        onClose={() => {
          setShowPasswordPrompt(false);
          setPasswordError(null);
        }}
        onConfirm={processRefundWithPassword}
        isLoading={loading}
        error={passwordError}
        confirmLabel={`Refund ₹${formatCurrency(finalRefundAmount)}`}
      />
    </>
  );
};

export default IssueRefundModal;

import React, { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle, Package, PackageX } from 'lucide-react';
import { toast } from 'react-toastify';
import { MarkReceivedModalProps, MarkReceivedItemDecision } from '../Interfaces/types';
import { notifyReturnReceived } from '../Interfaces/api';
import { getApiErrorMessage } from '../Interfaces/http';
import { BaseModal } from './BaseModal';

const CONDITIONS = [
  { value: 'Fresh', label: 'Fresh', description: 'Like new, unused condition' },
  { value: 'Seconds', label: 'Seconds', description: 'Minor defects, slightly used' },
  { value: 'Defect / Damaged Item', label: 'Defect / Damaged', description: 'Significant damage, cannot be resold' }
];

// Track condition per individual quantity
interface QuantityState {
  condition: string;
  restock: boolean;
}

interface ItemState {
  quantities: QuantityState[]; // One entry per quantity
}

export const MarkReceivedModal: React.FC<MarkReceivedModalProps & {
  /** Firestore return doc id — used for the "return received" e-mail. */
  returnId?: string;
}> = ({
  isOpen, onClose, onConfirm, items = [], RAN = '', orderId = '',
  customerName = '', customerEmail = '', returnId
}) => {
  const [itemStates, setItemStates] = useState<Record<number, ItemState>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Reset per-item state whenever the modal opens with a fresh item list
  useEffect(() => {
    if (!isOpen) return;
    const initial: Record<number, ItemState> = {};
    items.forEach(item => {
      const quantity = item.quantityReturned || 0;
      initial[item.lineItemId] = {
        quantities: Array.from({ length: quantity }, () => ({
          condition: '',
          restock: false,
        }))
      };
    });
    setItemStates(initial);
    setError('');
  }, [isOpen, items]);

  const updateQuantityState = (lineItemId: number, qtyIndex: number, patch: Partial<QuantityState>) => {
    setItemStates(prev => {
      const item = prev[lineItemId];
      if (!item) return prev;
      
      const updatedQuantities = [...item.quantities];
      updatedQuantities[qtyIndex] = { ...updatedQuantities[qtyIndex], ...patch };
      
      return {
        ...prev,
        [lineItemId]: {
          ...item,
          quantities: updatedQuantities
        }
      };
    });
  };

  // Check if all quantities for all items have conditions selected
  const allConditionsSelected = items.length > 0 && items.every(item => {
    const state = itemStates[item.lineItemId];
    if (!state) return false;
    return state.quantities.every(q => q.condition !== '');
  });

  const totalItems = items.reduce((sum, item) => sum + (item.quantityReturned || 0), 0);
  const totalValue = items.reduce((sum, item) => {
    const price = parseFloat(item.price?.replace(/[^0-9.]/g, '') || '0');
    return sum + (price * (item.quantityReturned || 0));
  }, 0);
  
  const totalToRestock = items.reduce((sum, item) => {
    const state = itemStates[item.lineItemId];
    if (!state) return sum;
    return sum + state.quantities.filter(q => q.restock).length;
  }, 0);

  // Determine the overall condition for the item (for display purposes)
  const getOverallCondition = (lineItemId: number): string => {
    const state = itemStates[lineItemId];
    if (!state) return 'Not Set';
    
    const conditions = state.quantities.map(q => q.condition).filter(c => c !== '');
    if (conditions.length === 0) return 'Not Set';
    
    // If any is damaged, the overall is damaged
    if (conditions.some(c => c === 'Defect / Damaged Item')) return 'Defect / Damaged Item';
    // If any is seconds, the overall is seconds
    if (conditions.some(c => c === 'Seconds')) return 'Seconds';
    // Otherwise all fresh
    return 'Fresh';
  };

  const handleSubmit = async () => {
    if (!allConditionsSelected) {
      setError('Please select a condition for every quantity');
      return;
    }

    const decisions: MarkReceivedItemDecision[] = items.map(item => {
      const state = itemStates[item.lineItemId];
      if (!state) return null;
      
      // Count how many are marked for restock
      const restockCount = state.quantities.filter(q => q.restock).length;
      
      // Determine the dominant condition for the item (for reporting)
      const conditionCounts: Record<string, number> = {};
      state.quantities.forEach(q => {
        if (q.condition) {
          conditionCounts[q.condition] = (conditionCounts[q.condition] || 0) + 1;
        }
      });
      
      // Find the most common condition
      let dominantCondition = 'Mixed';
      let maxCount = 0;
      Object.entries(conditionCounts).forEach(([cond, count]) => {
        if (count > maxCount) {
          maxCount = count;
          dominantCondition = cond;
        }
      });
      
      return {
        lineItemId: item.lineItemId,
        condition: dominantCondition,
        restock: restockCount > 0,
        restockQuantity: restockCount,
        // Store individual quantity conditions for detailed tracking
        quantityConditions: state.quantities.map(q => q.condition),
        quantityRestockStatus: state.quantities.map(q => q.restock)
      };
    }).filter((d): d is MarkReceivedItemDecision & { quantityConditions: string[]; quantityRestockStatus: boolean[] } => d !== null);

    if (loading) return;
    setLoading(true);
    setError('');

    try {
      // The parent saves the receipt + restock. It THROWS on any failure, in
      // which case we stay open, show the error and send no e-mail.
      await onConfirm(decisions);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to mark the return as received. Please try again.'));
      setLoading(false);
      return;
    }

    // Saved successfully → now (and only now) tell the customer.
    if (returnId) {
      const result = await notifyReturnReceived(returnId);
      if (!result.emailSent) {
        toast.warning(`Return marked as received, but the "return received" e-mail could not be sent${result.error ? `: ${result.error}` : '.'}`);
      }
    }

    setLoading(false);
    setItemStates({});
    onClose();
  };

  const handleClose = () => {
    if (loading) return;
    setItemStates({});
    setError('');
    onClose();
  };

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={handleClose}
      title="Mark as Received"
      subtitle="Set condition & restock per quantity"
      maxWidth="max-w-2xl"
      closeDisabled={loading}
      icon={
        <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
          <CheckCircle2 className="w-5 h-5 text-emerald-600" aria-hidden="true" />
        </div>
      }
      footer={
        <div className="flex flex-col-reverse sm:flex-row gap-3">
          <button type="button" onClick={handleClose} disabled={loading} className="flex-1 min-h-[44px] px-4 py-3 border-2 border-slate-200 hover:border-slate-300 text-slate-700 font-bold rounded-xl transition-all disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading || !allConditionsSelected || !items || items.length === 0}
            className="flex-1 min-h-[44px] px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? (<><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Processing...</>) : `Confirm Receipt (${totalItems} unit${totalItems !== 1 ? 's' : ''})`}
          </button>
        </div>
      }
    >
        <div>
          {RAN && (
            <div className="mb-4 pb-3 border-b border-slate-100">
              <p className="text-xs text-slate-500">Return Authorization Number</p>
              <p className="text-sm font-mono font-semibold text-indigo-600">{RAN}</p>
            </div>
          )}

          {(orderId || customerName || customerEmail) && (
            <div className="mb-4 p-3 bg-slate-50 rounded-lg border border-slate-200">
              {orderId && <div className="flex justify-between text-xs mb-1"><span className="text-slate-500">Order ID:</span><span className="font-medium text-slate-700">{orderId}</span></div>}
              {customerName && <div className="flex justify-between text-xs mb-1"><span className="text-slate-500">Customer:</span><span className="font-medium text-slate-700">{customerName}</span></div>}
              {customerEmail && <div className="flex justify-between text-xs"><span className="text-slate-500">Email:</span><span className="font-medium text-slate-700 truncate max-w-[200px]">{customerEmail}</span></div>}
            </div>
          )}

          {error && (
            <div role="alert" className="mb-6 bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {(!items || items.length === 0) ? (
            <div className="mb-6 bg-amber-50 rounded-xl p-4 border border-amber-200">
              <div className="flex items-start gap-3">
                <PackageX className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-amber-800">No Items to Process</p>
                  <p className="text-xs text-amber-700 mt-1">All items in this return have been rejected or there are no active items to mark as received.</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4 mb-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Package className="w-4 h-4 text-slate-500" />
                  <h3 className="text-sm font-semibold text-slate-700">Items to Receive</h3>
                </div>
                <span className="text-xs font-medium text-slate-500 bg-slate-100 px-2 py-1 rounded-full">{totalItems} units</span>
              </div>

              {items.map((item) => {
                const state = itemStates[item.lineItemId];
                const quantity = item.quantityReturned || 0;
                const quantities = state?.quantities || Array.from({ length: quantity }, () => ({ condition: '', restock: false }));
                const overallCondition = getOverallCondition(item.lineItemId);
                
                return (
                  <div key={item.lineItemId} className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm space-y-3">
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-slate-800 line-clamp-2">{item.title}</p>
                        <p className="text-xs text-slate-500 mt-0.5">SKU: {item.sku || 'N/A'}</p>
                        {overallCondition !== 'Not Set' && (
                          <span className="inline-block mt-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                            Overall: {overallCondition}
                          </span>
                        )}
                      </div>
                      <span className="inline-flex items-center justify-center bg-indigo-100 text-indigo-700 text-xs font-semibold px-2 py-1 rounded-full min-w-[50px]">
                        Qty: {quantity}
                      </span>
                    </div>

                    {item.reason && (
                      <p className="text-[10px] text-slate-400 pb-1 border-b border-slate-100">
                        <span className="font-medium">Return Reason:</span> {item.reason}
                      </p>
                    )}

                    {/* Individual quantity rows */}
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-slate-600">Per Unit Assessment</p>
                      {quantities.map((qtyState, qtyIndex) => (
                        <div key={qtyIndex} className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="text-xs font-bold text-slate-500 bg-slate-200 px-2 py-0.5 rounded-full">
                              Unit #{qtyIndex + 1}
                            </span>
                          </div>
                          
                          <div className="grid grid-cols-1 gap-1.5">
                            {CONDITIONS.map(cond => (
                              <label key={cond.value} className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 min-h-[40px] rounded-lg border cursor-pointer text-xs transition-all ${qtyState.condition === cond.value ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-indigo-300'}`}>
                                <input
                                  type="radio"
                                  name={`condition-${item.lineItemId}-${qtyIndex}`}
                                  value={cond.value}
                                  checked={qtyState.condition === cond.value}
                                  onChange={() => updateQuantityState(item.lineItemId, qtyIndex, { condition: cond.value })}
                                  disabled={loading}
                                  className="text-indigo-600 focus:ring-indigo-500"
                                />
                                <span className="font-medium text-slate-700">{cond.label}</span>
                                <span className="text-slate-400">— {cond.description}</span>
                              </label>
                            ))}
                          </div>

                          <div className="mt-2 pt-1.5 border-t border-slate-100">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={qtyState.restock}
                                onChange={(e) => updateQuantityState(item.lineItemId, qtyIndex, {
                                  restock: e.target.checked
                                })}
                                disabled={loading}
                                className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                              />
                              <span className="text-xs font-medium text-slate-700">Restock this unit</span>
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Quick summary for this item */}
                    <div className="pt-2 border-t border-slate-100 text-[10px] text-slate-500">
                      <span className="font-medium">Summary:</span>{' '}
                      {quantities.map((q, i) => (
                        <span key={i} className="inline-block mr-2">
                          Unit {i+1}: {q.condition || 'Not set'}
                          {q.restock && ' 🔄'}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}

              <div className="pt-3 border-t border-slate-200 space-y-1">
                <div className="flex justify-between items-center text-sm"><span className="text-slate-600 font-medium">Total Quantity Received:</span><span className="font-bold text-slate-800">{totalItems} units</span></div>
                <div className="flex justify-between items-center text-sm"><span className="text-slate-600 font-medium">Total Value:</span><span className="font-bold text-emerald-600">₹{totalValue.toFixed(2)}</span></div>
                <div className="flex justify-between items-center text-sm"><span className="text-slate-600 font-medium">Total to Restock:</span><span className="font-bold text-indigo-600">{totalToRestock} units</span></div>
              </div>
            </div>
          )}

        </div>
    </BaseModal>
  );
};
import React, { useState } from 'react';
import { AlertCircle, Mail, Package, PackageX } from 'lucide-react';
import { RejectRequestModalProps } from '../Interfaces/types';
import { getApiErrorMessage } from '../Interfaces/http';
import { BaseModal } from './BaseModal';

/**
 * Reject a whole request or a single item. The parent's `onConfirm` saves the
 * rejection and triggers the e-mail (`/notify/return-rejected` or
 * `/notify/item-rejected`); it throws on failure, in which case the modal
 * stays open with the error.
 */
export const RejectRequestModal: React.FC<RejectRequestModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  orderId,
  RAN,
  customerEmail,
  customerName,
  itemIdToReject,
  itemToReject
}) => {
  const [reason, setReason] = useState('');
  const [allowResubmit, setAllowResubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const isItemRejection = !!itemIdToReject && !!itemToReject;

  const reset = () => {
    setReason('');
    setAllowResubmit(false);
    setError('');
  };

  const handleSubmit = async () => {
    if (submitting) return;
    if (!reason.trim()) {
      setError('Please enter a reason for rejection');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onConfirm(reason.trim(), allowResubmit, itemIdToReject);
      reset();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to save the rejection. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={handleClose}
      title={isItemRejection ? 'Reject Item' : 'Reject Return Request'}
      subtitle={RAN ? `RAN: ${RAN}` : undefined}
      closeDisabled={submitting}
      icon={
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${isItemRejection ? 'bg-amber-100' : 'bg-red-100'}`}>
          {isItemRejection
            ? <PackageX className="w-4 h-4 text-amber-600" aria-hidden="true" />
            : <AlertCircle className="w-4 h-4 text-red-600" aria-hidden="true" />}
        </div>
      }
      footer={
        <div className="flex flex-col-reverse sm:flex-row gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="flex-1 min-h-[44px] px-4 py-2.5 border-2 border-slate-200 hover:border-slate-300 text-slate-700 font-medium rounded-xl transition-all disabled:opacity-50"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !reason.trim()}
            className={`flex-1 min-h-[44px] px-4 py-2.5 font-medium rounded-xl shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-white ${
              isItemRejection ? 'bg-amber-600 hover:bg-amber-700' : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            {submitting ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" aria-hidden="true" />
                Processing...
              </>
            ) : (
              isItemRejection ? 'Reject Item' : 'Confirm Rejection'
            )}
          </button>
        </div>
      }
    >
      {isItemRejection && itemToReject && (
        <div className="bg-amber-50 rounded-xl p-3 mb-5 border border-amber-200">
          <div className="flex items-start gap-2">
            <div className="w-7 h-7 bg-amber-100 rounded-lg flex items-center justify-center shrink-0">
              <Package className="w-3.5 h-3.5 text-amber-600" aria-hidden="true" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-amber-800 uppercase tracking-wide">Item to Reject</p>
              <p className="text-sm font-semibold text-amber-900 mt-0.5 break-words">{itemToReject.title}</p>
              <div className="flex flex-wrap gap-2 mt-1 text-xs text-amber-700">
                <span>SKU: {itemToReject.sku}</span>
                <span>• Qty: {itemToReject.quantityReturned}</span>
                <span>• {itemToReject.price}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {(orderId || customerName || customerEmail) && (
        <div className="bg-slate-50 rounded-xl p-3 mb-5 border border-slate-200">
          <div className="space-y-1.5 text-sm">
            {orderId && (
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Order:</span>
                <span className="font-medium text-slate-800">{orderId}</span>
              </div>
            )}
            {customerName && (
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Customer:</span>
                <span className="font-medium text-slate-800 truncate max-w-[200px]">{customerName}</span>
              </div>
            )}
            {customerEmail && (
              <div className="flex justify-between gap-2">
                <span className="text-slate-500 flex items-center gap-1">
                  <Mail className="w-3 h-3" aria-hidden="true" /> Email:
                </span>
                <span className="font-medium text-slate-800 truncate max-w-[200px]">{customerEmail}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mb-5">
        <label htmlFor="reject-reason" className="text-sm font-semibold text-slate-700 block mb-2">
          Rejection Reason <span className="text-red-500">*</span>
        </label>
        <textarea
          id="reject-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={isItemRejection
            ? 'E.g., Item shows signs of wear, Wrong item returned, Missing tags'
            : 'E.g., Clear images not provided, Item shows signs of wear, Return window expired'}
          rows={3}
          maxLength={1000}
          data-autofocus
          className="w-full border border-slate-200 rounded-xl p-3 text-sm outline-none focus:ring-2 focus:ring-red-200 focus:border-red-500 transition-all resize-none"
          disabled={submitting}
        />
        <p className="text-xs text-slate-400 mt-1.5">This reason will be shared with the customer</p>
      </div>

      {!isItemRejection && (
        <div className="mb-2">
          <label className="flex items-start gap-2 cursor-pointer group">
            <input
              type="checkbox"
              checked={allowResubmit}
              onChange={(e) => setAllowResubmit(e.target.checked)}
              className="w-4 h-4 mt-0.5 rounded border-slate-300 text-red-600 focus:ring-red-500 focus:ring-offset-0"
              disabled={submitting}
            />
            <span className="flex-1">
              <span className="text-sm font-medium text-slate-700 group-hover:text-slate-900">Allow customer to resubmit</span>
              <span className="block text-xs text-slate-500">
                {allowResubmit
                  ? 'Status will be "Closed" - customer can submit a new return'
                  : 'Status will be "Denied" - customer cannot submit another return'}
              </span>
            </span>
          </label>
        </div>
      )}

      {error && (
        <div role="alert" className="mt-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          {error}
        </div>
      )}
    </BaseModal>
  );
};

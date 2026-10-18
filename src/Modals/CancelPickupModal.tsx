import { useEffect, useState } from 'react';
import { BaseModal } from './BaseModal';
import {
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Truck,
  FileText
} from 'lucide-react';
import { db } from '../Interfaces/firebase';
import { addShopifyNote, addShopifyTag, cancelBlueDartPickup, CancelPickupResponse } from '../Interfaces/api';
import { getApiErrorMessage } from '../Interfaces/http';
import { doc, getDoc, updateDoc, serverTimestamp, addDoc, collection } from 'firebase/firestore';
import { CancelPickupModalProps } from '../Interfaces/types';
import { toNumericOrderId } from '../components/Agent/returnHelpers';

const CANCEL_REASONS = [
  'Customer requested cancellation',
  'Customer not available for pickup',
  'Pickup address / pincode issue',
  'Duplicate pickup',
  'Customer will self-ship',
  'Other',
];

export const CancelPickupModal = ({
  isOpen,
  onClose,
  orderId,
  orderNumericId,
  RAN,
  currentAWB = '',
  currentUser,
  shipmentStatus = '',
  onSuccess,
  returnId,
}: CancelPickupModalProps & {
  shipmentStatus?: string;
  /** Firestore return doc id (orderId is the order name, for display). */
  returnId?: string;
}) => {
  const docId = returnId || orderId;
  const [awbNumber, setAwbNumber] = useState(currentAWB);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');
  const [cancelResponse, setCancelResponse] = useState<CancelPickupResponse | null>(null);
  const [step, setStep] = useState<'input' | 'confirm' | 'result'>('input');
  const [reason, setReason] = useState(CANCEL_REASONS[0]);
  const [notes, setNotes] = useState('');
  const [rescheduleAllowed, setRescheduleAllowed] = useState(true);

  const isSelfShip = shipmentStatus?.toLowerCase() === 'self ship requested';

  useEffect(() => {
    if (isOpen) {
      setAwbNumber(currentAWB);
      setError('');
      setSuccess('');
      setCancelResponse(null);
      setStep('input');
      setReason(CANCEL_REASONS[0]);
      setNotes('');
      setRescheduleAllowed(true);
    }
  }, [isOpen, currentAWB]);

  const handleClose = () => {
    if (!loading) onClose();
  };

  const validateAWB = (awb: string): boolean => {
    if (isSelfShip) return true;
    if (!awb.trim()) {
      setError('Please enter an AWB number');
      return false;
    }
    if (awb.trim().length < 10) {
      setError('AWB number should be at least 10 characters');
      return false;
    }
    return true;
  };

  const handleNext = () => {
    setError('');
    if (validateAWB(awbNumber)) setStep('confirm');
  };

  const handleBack = () => {
    setStep('input');
    setError('');
  };

  const agentName = currentUser?.name || currentUser?.email || 'Agent';
  const fullReason = reason === 'Other' && notes.trim() ? notes.trim() : reason;

  const handleCancelPickup = async () => {
    if (loading || success) return;
    if (!validateAWB(awbNumber)) return;
    if (!docId) {
      setError('This return could not be identified. Reload the page and try again.');
      return;
    }
    if (reason === 'Other' && !notes.trim()) {
      setError('Please describe the reason for cancelling.');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const targetShopifyId = orderNumericId || toNumericOrderId(orderId);

      if (!isSelfShip) {
        // Token / pickup date help Blue Dart cancel the truck pickup as well.
        // Best effort: the server can also look them up from the return id.
        let tokenNumber: string | undefined;
        let pickupDate: string | undefined;
        try {
          const waybillSnap = await getDoc(doc(db, 'returns', docId, 'bluedart_waybills', awbNumber.trim()));
          if (waybillSnap.exists()) {
            const waybill = waybillSnap.data();
            tokenNumber = waybill.tokenNumber;
            pickupDate = waybill.rawResponse?.PickupDate || waybill.rawResponse?.pickupDate;
          }
        } catch {
          /* not readable — the server resolves it */
        }

        // The server updates Firestore and e-mails the customer ONLY after
        // Blue Dart confirms; on failure it answers 502 and nothing changes.
        const data = await cancelBlueDartPickup({
          returnId: docId,
          awbNumber: awbNumber.trim(),
          ran: RAN,
          ...(tokenNumber ? { tokenNumber: String(tokenNumber) } : {}),
          ...(pickupDate ? { pickupDate: String(pickupDate) } : {}),
          reason: fullReason,
          additionalNotes: notes.trim() || undefined,
          rescheduleAllowed,
        });
        setCancelResponse(data);

        if (targetShopifyId) {
          void addShopifyNote(
            targetShopifyId, RAN, 'Pickup Cancelled',
            `Pickup with AWB ${awbNumber.trim()} has been cancelled.\nCancelled by: ${agentName}\nReason: ${fullReason}`
          );
          void addShopifyTag(targetShopifyId, 'Return Pickup Cancelled');
        }

        const emailMsg = data.emailSent === false ? ' The cancellation e-mail to the customer could not be sent.' : '';
        setSuccess(`Pickup cancelled for AWB: ${awbNumber.trim()}.${emailMsg}`);
      } else {
        // Self-ship has no courier booking: the agent updates the request directly.
        await updateDoc(doc(db, 'returns', docId), {
          status: 'Open',
          shipmentStatus: 'Pickup Cancelled',
          cancelledAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        try {
          await addDoc(collection(db, 'returns', docId, 'activities'), {
            type: 'warning',
            title: 'Self Ship Cancelled',
            description: `Self-ship request has been cancelled. Reason: ${fullReason}`,
            timestamp: serverTimestamp(),
            user: agentName,
            metadata: { cancelled: true, reason: fullReason },
          });
        } catch {
          /* activity log is secondary */
        }
        if (targetShopifyId) {
          void addShopifyNote(targetShopifyId, RAN, 'Self Ship Cancelled', `Self-ship request has been cancelled.\nCancelled by: ${agentName}\nReason: ${fullReason}`);
          void addShopifyTag(targetShopifyId, 'Return Self Ship Cancelled');
        }
        setSuccess('Self-ship request cancelled.');
      }

      setStep('result');
      onSuccess?.(isSelfShip ? '' : awbNumber.trim());
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to cancel. Please try again.'));
      setStep('result');
    } finally {
      setLoading(false);
    }
  };

  const renderInputStep = () => (
    <div className="space-y-5">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <Truck className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-blue-800">
              {isSelfShip ? 'Cancel Self Ship Request' : 'Cancel Blue Dart Pickup'}
            </p>
            <p className="text-xs text-blue-600 mt-1">
              {isSelfShip 
                ? "You are about to cancel the customer's self-ship request. This action cannot be undone."
                : "Enter the AWB number of the pickup you want to cancel. This action cannot be undone."}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-slate-100 rounded-lg p-3 border border-slate-200">
        <div className="flex justify-between items-center text-xs">
          <span className="text-slate-500">RAN:</span>
          <span className="font-mono font-semibold text-pink-600">{RAN}</span>
        </div>
        <div className="flex justify-between items-center text-xs mt-1">
          <span className="text-slate-500">Order:</span>
          <span className="font-semibold">{orderId}</span>
        </div>
      </div>

      {!isSelfShip && (
        <>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              AWB Number <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={awbNumber}
              onChange={(e) => setAwbNumber(e.target.value)}
              placeholder="e.g. 58162271215"
              className="w-full min-h-[44px] p-3 border border-slate-200 rounded-lg text-sm outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 font-mono"
              disabled={loading}
              data-autofocus
            />
            <p className="text-[10px] text-slate-400 mt-1">
              Enter the 11-digit AWB number from Blue Dart
            </p>
          </div>

          {currentAWB && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <FileText className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-medium text-amber-800">Current AWB in system</p>
                  <p className="text-xs text-amber-700 font-mono mt-1">{currentAWB}</p>
                  {awbNumber !== currentAWB && (
                    <button
                      onClick={() => setAwbNumber(currentAWB)}
                      className="text-[10px] text-amber-600 hover:text-amber-700 underline mt-1"
                    >
                      Use current AWB
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  const renderConfirmStep = () => (
    <div className="space-y-5">
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-800">Confirm Cancellation</p>
            <p className="text-xs text-amber-700 mt-1">
              Are you sure you want to cancel this {isSelfShip ? 'self-ship request' : 'pickup'}? This action cannot be undone.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-slate-100 rounded-lg p-4 border border-slate-200">
        {!isSelfShip && (
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-500">AWB to cancel:</span>
            <span className="text-sm font-mono font-bold text-slate-800">{awbNumber}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">RAN:</span>
          <span className="text-xs font-semibold text-pink-600">{RAN}</span>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label htmlFor="cancel-reason" className="block text-xs font-semibold text-slate-700 mb-1.5">
            Reason <span className="text-red-500">*</span>
          </label>
          <select
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={loading}
            className="w-full min-h-[44px] p-2.5 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
          >
            {CANCEL_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="cancel-notes" className="block text-xs font-semibold text-slate-700 mb-1.5">
            Notes {reason === 'Other' ? <span className="text-red-500">*</span> : <span className="font-normal text-slate-400">(optional)</span>}
          </label>
          <textarea
            id="cancel-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={500}
            disabled={loading}
            placeholder="Anything the customer should know"
            className="w-full p-2.5 border border-slate-200 rounded-lg text-sm outline-none resize-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
          />
        </div>
        {!isSelfShip && (
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={rescheduleAllowed}
              onChange={(e) => setRescheduleAllowed(e.target.checked)}
              disabled={loading}
              className="w-4 h-4 mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
            />
            <span className="text-sm text-slate-700">
              Customer can reschedule the pickup
              <span className="block text-xs text-slate-500">Mentioned in the cancellation e-mail.</span>
            </span>
          </label>
        )}
      </div>

      {!isSelfShip && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-xs text-red-700">
            <strong>Warning:</strong> Cancelling a pickup will remove the scheduled pickup from Blue Dart's system. 
            You will need to create a new pickup if you still need to ship the return.
          </p>
        </div>
      )}
    </div>
  );

  const renderResultStep = () => (
    <div className="space-y-5">
      {success ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-8 h-8 text-green-600" />
          </div>
          <p className="text-sm font-semibold text-green-800 mb-2" role="status">
            {isSelfShip ? 'Self Ship Cancelled' : 'Pickup Cancelled'}
          </p>
          <p className="text-xs text-green-700 mb-4">{success}</p>
          
          {!isSelfShip && (cancelResponse?.awb_cancellation_status || cancelResponse?.pickup_cancellation_status) && (
            <div className="mb-4 py-2 px-3 bg-blue-100/50 rounded-lg border border-blue-200 text-left space-y-0.5">
              {cancelResponse?.awb_cancellation_status && (
                <p className="text-xs font-medium text-blue-800">Waybill: {cancelResponse.awb_cancellation_status}</p>
              )}
              {cancelResponse?.pickup_cancellation_status && (
                <p className="text-xs font-medium text-blue-800">Truck pickup: {cancelResponse.pickup_cancellation_status}</p>
              )}
            </div>
          )}

          {!isSelfShip && (
            <div className="bg-white rounded-lg p-3 border border-green-200">
              <p className="text-xs text-slate-500 mb-1">Cancelled AWB</p>
              <p className="text-sm font-mono font-bold text-slate-800">{awbNumber}</p>
            </div>
          )}
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <X className="w-8 h-8 text-red-600" />
          </div>
          <p className="text-sm font-semibold text-red-800 mb-2" role="alert">Cancellation Failed</p>
          <p className="text-xs text-red-700 mb-2 break-words">{error}</p>
          {!isSelfShip && (
            <p className="text-xs text-red-700 mb-4">The pickup is still active — nothing was changed.</p>
          )}
          <button
            type="button"
            onClick={() => setStep('confirm')}
            className="min-h-[44px] px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Try Again
          </button>
        </div>
      ) : null}
    </div>
  );

  const renderFooter = () => {
    if (step === 'input') {
      return (
        <button
          onClick={handleNext}
          disabled={(!isSelfShip && !awbNumber.trim()) || loading}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 rounded-lg transition-colors disabled:opacity-50 flex justify-center items-center gap-2 text-sm"
        >
          Next
        </button>
      );
    }

    if (step === 'confirm') {
      return (
        <div className="flex gap-3">
          <button
            onClick={handleBack}
            disabled={loading}
            className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium py-3.5 rounded-lg transition-colors disabled:opacity-50 text-sm"
          >
            Back
          </button>
          <button
            onClick={handleCancelPickup}
            disabled={loading || !!success}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white font-medium py-3.5 rounded-lg transition-colors disabled:opacity-50 flex justify-center items-center gap-2 text-sm"
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" />Cancelling...</>
            ) : (
              'Confirm Cancel'
            )}
          </button>
        </div>
      );
    }

    if (step === 'result') {
      return (
        <button
          onClick={handleClose}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 rounded-lg transition-colors text-sm"
        >
          Close
        </button>
      );
    }

    return null;
  };

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={handleClose}
      closeDisabled={loading}
      title={step === 'input' ? 'Cancel Pickup' : step === 'confirm' ? 'Confirm Cancellation' : 'Cancellation Result'}
      footer={renderFooter()}
    >
      <div className="space-y-5 text-slate-800">
        {error && step !== 'result' && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}

        {step === 'input' && renderInputStep()}
        {step === 'confirm' && renderConfirmStep()}
        {step === 'result' && renderResultStep()}
      </div>
    </BaseModal>
  );
};
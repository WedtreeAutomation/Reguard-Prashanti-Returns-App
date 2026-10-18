import { useState, useEffect } from 'react';
import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { db } from '../Interfaces/firebase';
import { BaseModal } from './BaseModal';
import { ChevronDown, Loader2, MapPin, Package, Truck, AlertCircle } from 'lucide-react';
import { SelfShipModalProps, Warehouse } from '../Interfaces/types';
import { requestSelfShip } from '../Interfaces/api';
import { getApiErrorMessage } from '../Interfaces/http';
import { istToday } from '../utils/dates';
import { toast } from 'react-toastify';

export const SelfShipModal = ({
  isOpen,
  onClose,
  orderId,
  RAN,
  customerEmail,
  requestedMethod = 'gift_card',
  onSuccess,
  returnId,
}: SelfShipModalProps & {
  onSuccess?: () => void;
  /** Firestore return doc id (orderId is the order name, for display). */
  returnId?: string;
}) => {
  const [loading, setLoading] = useState(false);
  const [fetchingWarehouses, setFetchingWarehouses] = useState(true);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [selectedWarehouse, setSelectedWarehouse] = useState<string>('');
  const [instructions, setInstructions] = useState('');
  const [deadline, setDeadline] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const fetchWarehouses = async () => {
      if (!isOpen) return;
      setFetchingWarehouses(true);
      setError('');
      try {
        const snapshot = await getDocs(query(collection(db, 'warehouses'), orderBy('name', 'asc')));
        const list: Warehouse[] = [];
        snapshot.forEach((d) => {
          const data = d.data() as Omit<Warehouse, 'id'>;
          if (data.isActive !== false) list.push({ ...data, id: d.id });
        });
        setWarehouses(list);
        setSelectedWarehouse((prev) => (prev && list.some((w) => w.id === prev) ? prev : list[0]?.id || ''));
      } catch (err) {
        setError(`Failed to load warehouses: ${getApiErrorMessage(err)}`);
      } finally {
        setFetchingWarehouses(false);
      }
    };
    fetchWarehouses();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setSelectedWarehouse(warehouses[0]?.id || '');
      setInstructions('');
      setDeadline('');
      setDone(false);
      setError('');
    }
  }, [isOpen, warehouses]);

  const getSelectedWarehouseDetails = (): Warehouse | undefined => warehouses.find((w) => w.id === selectedWarehouse);

  const formatAddress = (warehouse: Warehouse): string =>
    [warehouse.address1, warehouse.address2, warehouse.address3, warehouse.city, warehouse.state, warehouse.pincode, warehouse.country]
      .filter(Boolean)
      .join(', ');

  const handleConfirm = async () => {
    if (loading || done) return;
    if (!selectedWarehouse) {
      setError('Please select a warehouse');
      return;
    }
    if (!returnId) {
      setError('This return could not be identified. Reload the page and try again.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      // The server loads the warehouse address itself and sends the e-mail.
      const { emailSent } = await requestSelfShip({
        returnId,
        warehouseId: selectedWarehouse,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        ...(deadline ? { deadline } : {}),
      });
      setDone(true);
      if (emailSent) toast.success('Self-ship request confirmed. The customer has been e-mailed the shipping address.');
      else toast.warning('Self-ship request saved, but the e-mail to the customer could not be sent. Please share the address manually.');
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to confirm. Please try again.'));
    } finally {
      setLoading(false);
    }
  };

  const selectedWarehouseDetails = getSelectedWarehouseDetails();

  return (
    <BaseModal isOpen={isOpen} onClose={() => { if (!loading) onClose(); }} title="Self Ship Request" closeDisabled={loading}>
      <div className="space-y-6">
        {/* Info Banner */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <Truck className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-blue-800">Self Ship Instructions</p>
              <p className="text-xs text-blue-600 mt-1">
                Customer will be responsible for shipping the product to our warehouse.
                Refund will be processed via <strong>{requestedMethod === 'gift_card' ? 'Gift Card' : requestedMethod === 'store_credit' ? 'Store Credit' : 'Original Payment Method'}</strong> upon receipt.
              </p>
            </div>
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div role="alert" className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}

        {/* RAN and Order Info */}
        <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-medium text-slate-500">Return Authorization Number</span>
            <span className="text-sm font-bold text-pink-600 font-mono">{RAN}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs font-medium text-slate-500">Order ID</span>
            <span className="text-sm font-semibold text-slate-800">{orderId}</span>
          </div>
          {customerEmail && (
            <div className="flex justify-between items-center mt-2 pt-2 border-t border-slate-200">
              <span className="text-xs font-medium text-slate-500">Customer Email</span>
              <span className="text-sm text-slate-600 break-all text-right">{customerEmail}</span>
            </div>
          )}
        </div>

        {/* Warehouse Selection */}
        {fetchingWarehouses ? (
          <div className="flex justify-center items-center py-8">
            <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
          </div>
        ) : warehouses.length === 0 ? (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-center">
            <AlertCircle className="w-5 h-5 text-amber-600 mx-auto mb-2" />
            <p className="text-sm text-amber-800">No active warehouses found</p>
            <p className="text-xs text-amber-600 mt-1">Please add a warehouse in Settings first</p>
          </div>
        ) : (
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              Select Warehouse <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <select
                value={selectedWarehouse}
                onChange={(e) => setSelectedWarehouse(e.target.value)}
                className="w-full p-3 bg-white border border-slate-200 rounded-xl text-sm outline-none appearance-none cursor-pointer focus:ring-2 focus:ring-indigo-200 focus:border-indigo-500"
                disabled={warehouses.length === 0 || loading}
              >
                {warehouses.length === 0 ? (
                  <option value="">No warehouses available</option>
                ) : (
                  warehouses.map(w => (
                    <option key={w.id} value={w.id}>
                      {w.name} {w.code ? `(${w.code})` : ''}
                    </option>
                  ))
                )}
              </select>
              <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none">
                <ChevronDown className="w-4 h-4 text-slate-500" />
              </div>
            </div>

            {/* Warehouse Details */}
            {selectedWarehouseDetails && (
              <div className="mt-4 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-4 border border-indigo-100">
                <h4 className="text-sm font-semibold text-indigo-800 mb-3 flex items-center gap-2">
                  <MapPin className="w-4 h-4" />
                  Shipping Address
                </h4>
                <div className="space-y-2 text-sm">
                  <p className="text-indigo-900 font-medium">{selectedWarehouseDetails.name}</p>
                  <p className="text-indigo-700">{formatAddress(selectedWarehouseDetails)}</p>
                  {selectedWarehouseDetails.phone && (
                    <p className="text-indigo-600 flex items-center gap-2 text-xs">
                      <span>📞 {selectedWarehouseDetails.phone}</span>
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {warehouses.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label htmlFor="selfship-instructions" className="block text-sm font-semibold text-slate-700 mb-1.5">
                Instructions for the customer <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <textarea
                id="selfship-instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={2}
                maxLength={500}
                disabled={loading}
                placeholder="e.g. Pack securely and write the RAN on the parcel"
                className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none resize-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-500"
              />
            </div>
            <div>
              <label htmlFor="selfship-deadline" className="block text-sm font-semibold text-slate-700 mb-1.5">
                Ship by <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                id="selfship-deadline"
                type="date"
                value={deadline}
                min={istToday()}
                onChange={(e) => setDeadline(e.target.value)}
                disabled={loading}
                className="w-full min-h-[44px] px-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-500"
              />
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 pt-4 border-t border-slate-200">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="min-h-[44px] px-5 py-2.5 border-2 border-slate-200 hover:border-slate-300 rounded-xl text-slate-700 font-medium transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading || done || !selectedWarehouse || warehouses.length === 0}
            className="min-h-[44px] px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <Package className="w-4 h-4" />
                Confirm Self Ship
              </>
            )}
          </button>
        </div>

      </div>
    </BaseModal>
  );
};
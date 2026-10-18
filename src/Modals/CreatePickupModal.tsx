import React, { useState, useEffect, useRef } from 'react';
import { BaseModal } from './BaseModal';
import { ChevronDown, Loader2, MapPin, Package, AlertCircle } from 'lucide-react';
import { db } from '../Interfaces/firebase';
import { addShopifyNote, addShopifyTag, createBlueDartPickup } from '../Interfaces/api';
import { getApiErrorMessage, getApiErrorStatus, newIdempotencyKey } from '../Interfaces/http';
import {
  collection,
  getDocs,
  doc,
  setDoc,
  Timestamp,
} from 'firebase/firestore';
import { Warehouse, PackageTemplate, Dimensions, CreatePickupModalProps } from '../Interfaces/types';
import { priceToNumber } from '../components/Agent/returnHelpers';

const DEFAULT_DIMENSIONS: Dimensions = {
  length: 30,
  width: 25,
  height: 10,
  unit: 'cm',
  weight: 0.5,
  weightUnit: 'kg'
};

const CUSTOM_TEMPLATE_ID = 'custom';

// ==========================================
// MAIN COMPONENT
// ==========================================

export const CreatePickupModal = ({
  isOpen,
  onClose,
  orderId,
  orderNumericId,
  RAN,
  customer,
  shippingAddress,
  currentUser,
  items = [],
  rejectedItems = [],
  onSuccess,
  returnId,
}: CreatePickupModalProps & {
  /** Firestore return doc id (orderId is the order name, for display). */
  returnId?: string;
}) => {
  const [loading, setLoading] = useState(false);
  const [fetchingData, setFetchingData] = useState(true);
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [templates, setTemplates] = useState<PackageTemplate[]>([]);

  const [selectedWarehouse, setSelectedWarehouse] = useState<string>('');
  const [selectedTemplate, setSelectedTemplate] = useState<string>(CUSTOM_TEMPLATE_ID);
  const [dimensions, setDimensions] = useState<Dimensions>(DEFAULT_DIMENSIONS);
  const [addToTemplate, setAddToTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  // One idempotency key per attempt; reused on retry after an unknown outcome.
  const attemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  // Helper to extract numeric order ID from various formats
  const getNumericOrderId = (id: string | number): number | null => {
    if (!id) return null;
    
    if (typeof id === 'number') return id;
    
    if (typeof id === 'string' && id.includes('gid://')) {
      const numericMatch = id.match(/\d+$/);
      if (numericMatch) {
        return parseInt(numericMatch[0]);
      }
    }
    
    if (typeof id === 'string' && !isNaN(Number(id))) {
      return parseInt(id);
    }
    
    return null;
  };

  const normalizedItems = React.useMemo(() => {
    if (!items || !Array.isArray(items) || items.length === 0) return [];
    
    const rejectedItemsArray = rejectedItems ?? [];
    const rejectedIds = new Set(rejectedItemsArray.map(rej => rej?.lineItemId));
    
    const activeItems = (Array.isArray(items) ? items : []).filter(item => !!item && !rejectedIds.has(item.lineItemId));
    
    if (activeItems.length === 0) {
      return [];
    }
    
    return activeItems.map(item => ({
      lineItemId: item.lineItemId || 0,
      title: item.title || 'Unknown Item',
      sku: item.sku || '',
      price: item.price || '0',
      quantityReturned: item.quantityReturned || 1,
      reason: item.reason || 'Customer Return',
      productImage: item.productImage || '',
      note: item.note || '',
      customerImages: item.customerImages || []
    }));
  }, [items, rejectedItems]);

  const isCustomSelected = selectedTemplate === CUSTOM_TEMPLATE_ID;

  const totalValue = normalizedItems.reduce((sum, item) => {
    return sum + priceToNumber(item?.price) * (Number(item?.quantityReturned) || 0);
  }, 0);

  const getCustomerName = (): string => {
    if (customer?.name) return customer.name;
    if (customer?.first_name || customer?.last_name) return `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
    if (shippingAddress) return 'Customer';
    return 'Customer';
  };

  const getCustomerPhone = () => customer?.phone || shippingAddress?.phone || '';
  const getCustomerAddress = () => customer?.address || shippingAddress?.address1 || '';
  const getCustomerCity = () => customer?.city || shippingAddress?.city || '';
  const getCustomerState = () => customer?.state || shippingAddress?.province || '';
  const getCustomerZip = () => customer?.zip || shippingAddress?.zip || '';
  const getCustomerEmail = () => customer?.email || '';

  const rejectedCount = (rejectedItems ?? []).length;

  useEffect(() => {
    const fetchData = async () => {
      if (!isOpen) return;
      setFetchingData(true);
      setError('');

      try {
        const warehousesSnapshot = await getDocs(collection(db, 'warehouses'));
        const warehousesList: Warehouse[] = [];
        warehousesSnapshot.forEach((doc) => {
          const data = doc.data() as Omit<Warehouse, 'id'>;
          if (data.isActive !== false) {
            warehousesList.push({ id: doc.id, ...data });
          }
        });
        warehousesList.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        setWarehouses(warehousesList);
        if (warehousesList.length > 0 && !selectedWarehouse) setSelectedWarehouse(warehousesList[0].id);

        const templatesSnapshot = await getDocs(collection(db, 'templates'));
        const templatesList: PackageTemplate[] = [];
        templatesSnapshot.forEach((doc) => {
          const data = doc.data() as Omit<PackageTemplate, 'id'>;
          if (data.isActive !== false) {
            templatesList.push({ id: doc.id, ...data });
          }
        });
        templatesList.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        setTemplates(templatesList);

      } catch (error) {
        setError(`Failed to load warehouses/templates: ${getApiErrorMessage(error)}`);
      } finally {
        setFetchingData(false);
      }
    };
    fetchData();
  }, [isOpen]);

  useEffect(() => {
    if (selectedTemplate && selectedTemplate !== CUSTOM_TEMPLATE_ID) {
      const template = templates.find(t => t.id === selectedTemplate);
      if (template) {
        setDimensions({
          length: template.length,
          width: template.width,
          height: template.height,
          unit: template.dimensionUnit || 'cm',
          weight: template.weight,
          weightUnit: template.weightUnit || 'kg'
        });
        setAddToTemplate(false);
      }
    } else {
      setDimensions(DEFAULT_DIMENSIONS);
    }
  }, [selectedTemplate, templates]);

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
      attemptRef.current = null;
      setSelectedWarehouse(warehouses[0]?.id || '');
      setSelectedTemplate(CUSTOM_TEMPLATE_ID);
      setDimensions(DEFAULT_DIMENSIONS);
      setAddToTemplate(false);
      setNewTemplateName('');
      setError('');
      setSuccess('');
    }
  }, [isOpen, warehouses]);

  const handleAddToTemplate = async () => {
    if (!newTemplateName.trim()) return setError("Please enter a template name");

    try {
      const docId = newTemplateName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      if (!docId) return setError("Please enter a valid template name");

      if (templates.find(t => t.id === docId)) {
        return setError("A template with this name already exists");
      }

      const templateData: Omit<PackageTemplate, 'id'> = {
        name: newTemplateName,
        length: dimensions.length,
        width: dimensions.width,
        height: dimensions.height,
        dimensionUnit: dimensions.unit,
        weight: dimensions.weight,
        weightUnit: dimensions.weightUnit === 'lb' ? 'kg' : dimensions.weightUnit as 'kg' | 'g',
        isActive: true,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now()
      };

      await setDoc(doc(db, 'templates', docId), templateData);
      setTemplates(prev => [...prev, { id: docId, ...templateData }].sort((a, b) => a.name.localeCompare(b.name)));
      
      setSelectedTemplate(docId);
      setAddToTemplate(false);
      setNewTemplateName('');
      setSuccess("Template added successfully!");
      setTimeout(() => setSuccess(''), 3000);
    } catch (error) {
      setError(`Failed to add template: ${getApiErrorMessage(error)}`);
    }
  };

  const validateInputs = (): boolean => {
    if (!selectedWarehouse) { setError("Please select a warehouse"); return false; }
    if (dimensions.weight <= 0) { setError("Weight must be greater than 0"); return false; }
    if (dimensions.length <= 0 || dimensions.width <= 0 || dimensions.height <= 0) { setError("All dimensions must be > 0"); return false; }
    if (!getCustomerAddress() || !getCustomerZip()) { setError("Customer address incomplete"); return false; }
    if (!getCustomerPhone()) { setError("Customer phone required for pickup"); return false; }
    if (normalizedItems.length === 0) { 
      setError(rejectedCount > 0 ? "No active items to return. All items have been rejected." : "No items to return."); 
      return false; 
    }
    return true;
  };

  const handleSubmit = async () => {
    if (loading || success) return;
    if (!returnId) { setError('This return could not be identified. Reload the page and try again.'); return; }
    if (!validateInputs()) return;
    setLoading(true);
    setError('');

    try {
      const warehouse = warehouses.find(w => w.id === selectedWarehouse);
      if (!warehouse) throw new Error("Warehouse not found");

      const pickupDate = new Date();
      pickupDate.setDate(pickupDate.getDate() + 1);
      if (pickupDate.getDay() === 0) pickupDate.setDate(pickupDate.getDate() + 1);
      pickupDate.setHours(16, 0, 0, 0);

      const pickupDateMs = `/Date(${pickupDate.getTime()})/`;
      const cleanPhone = (phone: string) => phone ? phone.replace(/\D/g, '').slice(-10) : '';

      const customerPhone = cleanPhone(getCustomerPhone());
      const warehousePhone = cleanPhone(warehouse.phone);

      const payload = {
        "Request": {
          "Consignee": {
            "ConsigneeName": warehouse.name.slice(0, 30),
            "ConsigneeAddress1": warehouse.address1.slice(0, 100),
            "ConsigneeAddress2": `${warehouse.city}, ${warehouse.state}`.slice(0, 100),
            "ConsigneePincode": warehouse.pincode,
            "ConsigneeMobile": warehousePhone,
            "ConsigneeAttention": "Returns Dept"
          },
          "Services": {
            "PieceCount": "1",
            "ActualWeight": dimensions.weight,
            "ProductCode": "A",
            "SubProductCode": "P",
            "PackType": "L",
            "ProductType": 1,
            "PickupDate": pickupDateMs,
            "PickupTime": "1600",
            "CreditReferenceNo": RAN,
            "RegisterPickup": true,
            "IsReversePickup": false,
            "DeclaredValue": totalValue,
            "Dimensions": [{
              "Length": dimensions.length,
              "Breadth": dimensions.width,
              "Height": dimensions.height,
              "Count": 1
            }],
            "itemdtl": normalizedItems.map(item => ({
              "ItemID": item.sku.slice(0, 30),
              "ItemName": item.title.slice(0, 100),
              "ItemValue": priceToNumber(item?.price),
              "Itemquantity": item.quantityReturned,
              "ReturnReason": item.reason.slice(0, 100)
            }))
          },
          "Shipper": {
            "CustomerCode": "503705",
            "CustomerName": getCustomerName().slice(0, 30),
            "CustomerAddress1": getCustomerAddress().slice(0, 100),
            "CustomerPincode": getCustomerZip(),
            "CustomerMobile": customerPhone,
            "CustomerEmailID": getCustomerEmail().slice(0, 50),
            "OriginArea": warehouse.code || 'MAA',
            "IsToPayCustomer": true 
          }
        },
        "Metadata": {
          "orderId": orderId,
          "RAN": RAN,
          "agentName": currentUser?.name || 'Unknown Agent',
          "warehouseId": selectedWarehouse,
          "warehouseName": warehouse.name,
          "warehouseCode": warehouse.code,
          "rejectedItemCount": rejectedCount,
          "activeItemCount": normalizedItems.length
        }
      };

      // Same pickup request → same key, so a retry after a timeout can't
      // book a second waybill. Any change (warehouse, package) → new key.
      const fingerprint = JSON.stringify([selectedWarehouse, dimensions, normalizedItems.map(i => [i.lineItemId, i.quantityReturned])]);
      if (!attemptRef.current || attemptRef.current.fingerprint !== fingerprint) {
        attemptRef.current = { fingerprint, key: newIdempotencyKey() };
      }

      let data;
      try {
        data = await createBlueDartPickup({ ...payload, returnId, idempotencyKey: attemptRef.current.key });
      } catch (err) {
        const status = getApiErrorStatus(err);
        const body = (err as { response?: { data?: { code?: string; response?: any } } })?.response?.data;
        if (status === 409 && body?.code === 'awb_exists') {
          attemptRef.current = null;
          throw new Error('This return already has an active pickup (AWB). Cancel the existing pickup before scheduling a new one.');
        }
        const providerDetail = body?.response?.GenerateWayBillResult?.Status?.[0]?.StatusInformation
          || body?.response?.Status?.[0]?.StatusInformation;
        // A definite rejection (4xx) means nothing was booked → next attempt gets a new key.
        if (status !== undefined && status >= 400 && status < 500 && status !== 409 && status !== 429) attemptRef.current = null;
        const base = getApiErrorMessage(err, 'Failed to schedule pickup.');
        throw new Error(providerDetail && !base.includes(providerDetail) ? `${base}: ${providerDetail}` : base);
      }

      attemptRef.current = null;
      const rejectedMsg = rejectedCount > 0
        ? ` (${rejectedCount} rejected item(s) excluded)`
        : '';
      const emailMsg = data.emailSent === false ? ' The pickup e-mail to the customer could not be sent.' : '';
      setSuccess(`Pickup scheduled successfully! AWB: ${data.awbNumber}${rejectedMsg}.${emailMsg}`);

      // --- ADD SHOPIFY NOTE FOR PICKUP CREATION ---
      try {
        const targetShopifyId = orderNumericId || getNumericOrderId(orderId);
        
        if (targetShopifyId) {
          const itemsSummary = normalizedItems
            .map(item => `• ${item.title} (SKU: ${item.sku || 'N/A'}) x${item.quantityReturned}`)
            .join('\n');

          const noteMessage = `Pickup scheduled for ${normalizedItems.length} item(s):\n${itemsSummary}\nAWB: ${data.awbNumber}\nPickup Date: ${pickupDate.toLocaleDateString()}\nScheduled by: ${currentUser?.name || 'System'}`;
          
          // 1. Add the Timeline Note
          await addShopifyNote(targetShopifyId, RAN, "Pickup Created", noteMessage);
          
          // 2. ✅ ADD THE SHOPIFY TAG
          await addShopifyTag(targetShopifyId, "Return Approved Created Pickup");
        }
      } catch {
        // Not blocking: the waybill was already created.
      }

      // Call onSuccess callback to refresh parent
      if (onSuccess) {
        onSuccess();
      }
      
      // Close modal after delay
      closeTimerRef.current = window.setTimeout(() => {
        onClose();
      }, 2500);

    } catch (error) {
      setError(getApiErrorMessage(error, 'Failed to schedule pickup.'));
    } finally {
      setLoading(false);
    }
  };

  const selectedWarehouseDetails = warehouses.find(w => w.id === selectedWarehouse);

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onClose}
      title="Schedule Return Pickup"
      closeDisabled={loading}
      footer={
        <button
          type="button"
          onClick={handleSubmit}
          disabled={loading || !!success || fetchingData || !selectedWarehouse || normalizedItems.length === 0}
          className="w-full min-h-[44px] bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex justify-center items-center gap-2 text-sm shadow-md shadow-indigo-200"
        >
          {loading ? <><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />Processing...</> : success ? 'Pickup Scheduled' : 'Schedule Pickup'}
        </button>
      }
    >
      <div className="space-y-5 text-slate-800">
        <p className="text-xs text-slate-500 -mt-2">Schedule Blue Dart pickup for return</p>

        {rejectedCount > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs font-medium text-amber-800">
                {rejectedCount} item(s) have been rejected and excluded from pickup
              </p>
              <p className="text-[10px] text-amber-700 mt-1">
                Only {normalizedItems.length} active item(s) will be picked up
              </p>
            </div>
          </div>
        )}

        {success && (
          <div role="status" className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-start gap-2">
            <div className="w-4 h-4 bg-green-100 rounded-full flex items-center justify-center mt-0.5">
              <span className="text-[10px] font-bold text-green-600">✓</span>
            </div>
            <p className="text-xs text-green-700 flex-1">{success}</p>
          </div>
        )}

        {error && (
          <div role="alert" className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}

        <div className="bg-slate-100 rounded-lg p-3 border border-slate-200">
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-500">RAN:</span>
            <span className="font-mono font-semibold text-pink-600">{RAN}</span>
          </div>
          <div className="flex justify-between items-center text-xs mt-1">
            <span className="text-slate-500">Order:</span>
            <span className="font-semibold">{orderId}</span>
          </div>
          {normalizedItems.length > 0 && (
            <div className="flex justify-between items-center text-xs mt-1 pt-1 border-t border-slate-200">
              <span className="text-slate-500">Total Value:</span>
              <span className="font-semibold text-emerald-600">₹{totalValue.toFixed(2)}</span>
            </div>
          )}
        </div>

        {fetchingData ? (
          <div className="flex justify-center items-center py-8">
            <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
          </div>
        ) : (
          <>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Destination Warehouse <span className="text-red-500">*</span></label>
              <div className="relative">
                <select
                  value={selectedWarehouse}
                  onChange={(e) => setSelectedWarehouse(e.target.value)}
                  className="w-full p-2.5 bg-white border border-slate-200 rounded-lg text-sm outline-none appearance-none cursor-pointer disabled:bg-slate-50"
                  disabled={warehouses.length === 0 || loading}
                  required
                >
                  {warehouses.length === 0 ?
                    <option value="">No warehouses available</option> :
                    warehouses.map(w => (
                      <option key={w.id} value={w.id}>
                        {`${w.name}${w.code ? ` (${w.code})` : ''}`}
                      </option>
                    ))
                  }
                </select>
                <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none">
                  <ChevronDown className="w-4 h-4 text-slate-500" />
                </div>
              </div>

              {selectedWarehouseDetails && (
                <div className="mt-2 bg-indigo-50 border border-indigo-100 rounded-lg p-2">
                  <div className="flex items-start gap-1.5">
                    <MapPin className="w-3 h-3 text-indigo-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs font-medium text-indigo-800">{selectedWarehouseDetails.name}</p>
                      <p className="text-[10px] text-indigo-600">
                        {selectedWarehouseDetails.address1}, {selectedWarehouseDetails.city} - {selectedWarehouseDetails.pincode}
                      </p>
                      {selectedWarehouseDetails.code && (
                        <p className="text-[10px] text-indigo-600 mt-0.5">Code: {selectedWarehouseDetails.code}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Package Templates</label>
              <div className="relative">
                <select
                  value={selectedTemplate}
                  onChange={(e) => setSelectedTemplate(e.target.value)}
                  className="w-full p-2.5 bg-white border border-slate-200 rounded-lg text-sm outline-none appearance-none cursor-pointer"
                  disabled={loading}
                >
                  <option value={CUSTOM_TEMPLATE_ID}>Custom Package</option>
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>
                      {`${t.name} (${t.weight}${t.weightUnit} | ${t.length}x${t.width}x${t.height}${t.dimensionUnit})`}
                    </option>
                  ))}
                </select>
                <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none">
                  <ChevronDown className="w-4 h-4 text-slate-500" />
                </div>
              </div>
              {!isCustomSelected && <p className="text-xs text-green-600 mt-1">Dimensions auto-filled from template</p>}
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Dimension ({dimensions.unit})</label>
              <div className="grid grid-cols-4 gap-3">
                {(['length', 'width', 'height'] as const).map(dim => (
                  <div key={dim}>
                    <label className="block text-[10px] text-slate-400 mb-1 capitalize">{dim}</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={dimensions[dim]}
                      onChange={(e) => setDimensions({ ...dimensions, [dim]: parseFloat(e.target.value) || 0 })}
                      className="w-full p-2 border border-slate-200 rounded-md text-sm text-center outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                      disabled={!isCustomSelected || loading}
                      readOnly={!isCustomSelected}
                    />
                  </div>
                ))}
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Unit</label>
                  <select
                    value={dimensions.unit}
                    onChange={(e) => setDimensions({ ...dimensions, unit: e.target.value as 'cm' | 'in' })}
                    className="w-full p-2 border border-slate-200 rounded-md text-sm outline-none bg-white focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                    disabled={!isCustomSelected || loading}
                  >
                    <option value="cm">cm</option>
                    <option value="in">in</option>
                  </select>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Weight</label>
              <div className="grid grid-cols-2 gap-3 sm:max-w-[50%]">
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Weight</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={dimensions.weight}
                    onChange={(e) => setDimensions({ ...dimensions, weight: parseFloat(e.target.value) || 0 })}
                    className="w-full p-2 border border-slate-200 rounded-md text-sm text-center outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                    disabled={!isCustomSelected || loading}
                    readOnly={!isCustomSelected}
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Unit</label>
                  <select
                    value={dimensions.weightUnit}
                    onChange={(e) => setDimensions({ ...dimensions, weightUnit: e.target.value as 'kg' | 'g' | 'lb' })}
                    className="w-full p-2 border border-slate-200 rounded-md text-sm outline-none bg-white focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                    disabled={!isCustomSelected || loading}
                  >
                    <option value="kg">kg</option>
                    <option value="g">g</option>
                    <option value="lb">lb</option>
                  </select>
                </div>
              </div>
            </div>

            {isCustomSelected && (
              <div className="space-y-3 pt-1">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="addToTemplate"
                    checked={addToTemplate}
                    onChange={(e) => setAddToTemplate(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
                    disabled={loading}
                  />
                  <label htmlFor="addToTemplate" className="text-sm text-slate-700 cursor-pointer">Save as template</label>
                </div>
                {addToTemplate && (
                  <div className="pl-6">
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">Template Name <span className="text-red-500">*</span></label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newTemplateName}
                        onChange={(e) => setNewTemplateName(e.target.value)}
                        placeholder="e.g. Standard Box"
                        className="flex-1 p-2 border border-slate-200 rounded-lg text-sm outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                        disabled={loading}
                      />
                      <button
                        type="button"
                        onClick={handleAddToTemplate}
                        disabled={!newTemplateName.trim() || loading}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {normalizedItems.length > 0 ? (
              <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                <div className="flex items-center gap-1.5 mb-2">
                  <Package className="w-3.5 h-3.5 text-slate-500" />
                  <span className="text-xs font-medium text-slate-600">
                    Items to Return ({normalizedItems.length})
                    {rejectedCount > 0 && (
                      <span className="text-amber-600 ml-1">(excludes {rejectedCount} rejected)</span>
                    )}
                  </span>
                </div>
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {normalizedItems.map((item, idx) => (
                    <div key={idx} className="text-xs bg-white p-2 rounded border border-slate-100">
                      <div className="flex justify-between items-start">
                        <span className="font-medium text-slate-700 truncate max-w-[180px]" title={item.title}>{item.title}</span>
                        <span className="font-semibold text-indigo-600 ml-2">x{item.quantityReturned}</span>
                      </div>
                      <div className="flex justify-between items-center mt-1 text-[10px]">
                        <span className="text-slate-500">SKU: {item.sku}</span>
                        <span className="text-emerald-600">₹{item.price}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 mt-1 truncate">Reason: {item.reason}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 pt-2 border-t border-slate-200 flex justify-between items-center text-xs">
                  <span className="text-slate-600">Total Items:</span>
                  <span className="font-semibold">{normalizedItems.reduce((sum, item) => sum + item.quantityReturned, 0)} units</span>
                </div>
              </div>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-amber-800">No Active Items</p>
                    <p className="text-[10px] text-amber-700 mt-1">
                      {rejectedCount > 0 
                        ? `All ${rejectedCount} item(s) have been rejected. Pickup cannot be scheduled.`
                        : 'This return request doesn\'t have any items.'}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {(getCustomerName() !== 'Customer' || getCustomerAddress()) && (
              <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                <div className="flex items-center gap-1.5 mb-1">
                  <MapPin className="w-3.5 h-3.5 text-slate-500" />
                  <span className="text-xs font-medium text-slate-600">Pickup Address</span>
                </div>
                <p className="text-xs text-slate-800">{getCustomerName()}</p>
                <p className="text-[10px] text-slate-600">{getCustomerAddress()}</p>
                {getCustomerCity() && (
                  <p className="text-[10px] text-slate-600">
                    {getCustomerCity()}{getCustomerState() ? `, ${getCustomerState()}` : ''} - {getCustomerZip()}
                  </p>
                )}
                <p className="text-[10px] text-slate-600 mt-1">📞 {getCustomerPhone() || 'Not provided'}</p>
              </div>
            )}
          </>
        )}
      </div>
    </BaseModal>
  );
};
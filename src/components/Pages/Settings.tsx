import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'react-toastify';
import {
  Building2,
  Package,
  Plus,
  Trash2,
  Edit2,
  Save,
  Loader2,
  MapPin,
  Calendar,
  Clock,
  ShieldCheck,
  ShieldAlert,
  KeyRound,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { db } from '../../Interfaces/firebase';
import {
  collection,
  doc,
  getDocs,
  deleteDoc,
  deleteField,
  setDoc,
  updateDoc,
  query,
  orderBy,
  getDoc,
  type DocumentData,
  type QuerySnapshot,
} from 'firebase/firestore';
import { Country, State } from 'country-state-city';
import { Warehouse, PackageTemplate, User } from '../../Interfaces/types';
import { canAccessSettings } from '../../Interfaces/permissions';
import { getApiErrorMessage } from '../../Interfaces/http';
import { getRefundPasswordStatus, setRefundPassword } from '../../Interfaces/authApi';
import { Modal } from '../common/Modal';
import { PasswordInput } from '../common/PasswordInput';

type TabType = 'warehouses' | 'packages' | 'returns';

type WarehouseForm = Omit<Warehouse, 'id' | 'createdAt' | 'updatedAt'>;
type PackageForm = Omit<PackageTemplate, 'id' | 'createdAt' | 'updatedAt'>;

// ==========================================
// DEFAULT STATES
// ==========================================
const DEFAULT_WAREHOUSE: WarehouseForm = {
  name: '', code: '', externalId: '', address1: '', address2: '', address3: '',
  country: 'India', state: '', city: '', pincode: '', phone: '', isActive: true,
};

const DEFAULT_PACKAGE: PackageForm = {
  name: '', weight: 0.5, weightUnit: 'kg', length: 10, width: 10, height: 10, dimensionUnit: 'cm',
};

const DEFAULT_RETURN_DAYS = 14;
const MIN_REFUND_PASSWORD = 6;

/** Public part of settings/returnSettings. The refund password is NEVER stored here. */
interface ReturnSettings {
  returnDaysLimit: number;
  updatedAt?: number;
}

type RefundStatus = 'loading' | 'configured' | 'not_configured' | 'unknown';

interface SettingsProps {
  currentUser?: User | null;
}

// ==========================================
// HELPERS
// ==========================================
const generateDocumentId = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : parseFloat(str(v));
  return Number.isFinite(n) ? n : fallback;
};

const toWarehouse = (id: string, d: DocumentData): Warehouse => ({
  id,
  name: str(d.name) || id,
  code: str(d.code),
  externalId: str(d.externalId),
  address1: str(d.address1),
  address2: str(d.address2),
  address3: str(d.address3),
  country: str(d.country) || 'India',
  state: str(d.state),
  city: str(d.city),
  pincode: str(d.pincode),
  phone: str(d.phone),
  isActive: d.isActive !== false,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

const toPackage = (id: string, d: DocumentData): PackageTemplate => ({
  id,
  name: str(d.name) || id,
  weight: num(d.weight, 0),
  weightUnit: d.weightUnit === 'g' ? 'g' : 'kg',
  length: num(d.length, 0),
  width: num(d.width, 0),
  height: num(d.height, 0),
  dimensionUnit: d.dimensionUnit === 'in' ? 'in' : 'cm',
  isActive: d.isActive !== false,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

/** Parse a numeric input; empty / invalid → NaN (validated on submit). */
const parseNumberInput = (value: string): number => (value.trim() === '' ? NaN : parseFloat(value));
const numberInputValue = (n: number): string | number => (Number.isFinite(n) ? n : '');

const inputCls =
  'w-full min-h-[44px] p-3 bg-white border border-slate-200 rounded-xl outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50 disabled:text-slate-500';
const labelCls = 'text-xs font-bold text-slate-500 uppercase mb-1 block';

async function loadCollection<T>(
  name: string,
  map: (id: string, d: DocumentData) => T
): Promise<T[]> {
  let snapshot: QuerySnapshot<DocumentData>;
  try {
    snapshot = await getDocs(query(collection(db, name), orderBy('createdAt', 'desc')));
  } catch (err) {
    // e.g. missing index — fall back to an unordered read.
    console.warn(`Ordered read of ${name} failed, retrying unordered:`, err);
    snapshot = await getDocs(collection(db, name));
  }
  return snapshot.docs.map((d) => map(d.id, d.data() ?? {}));
}

export const Settings = ({ currentUser }: SettingsProps) => {
  const allowed = canAccessSettings(currentUser?.role);

  // --- UI State ---
  const [activeTab, setActiveTab] = useState<TabType>('warehouses');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // --- Data State ---
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [packages, setPackages] = useState<PackageTemplate[]>([]);
  const [returnSettings, setReturnSettings] = useState<ReturnSettings>({ returnDaysLimit: DEFAULT_RETURN_DAYS });
  /** settings/returnSettings still holds a legacy plain-text `refundPassword` field. */
  const [hasLegacyRefundPassword, setHasLegacyRefundPassword] = useState(false);

  // --- Form State ---
  const [warehouseForm, setWarehouseForm] = useState<WarehouseForm>(DEFAULT_WAREHOUSE);
  const [packageForm, setPackageForm] = useState<PackageForm>(DEFAULT_PACKAGE);
  const [editingWarehouseId, setEditingWarehouseId] = useState<string | null>(null);
  const [editingPackageId, setEditingPackageId] = useState<string | null>(null);
  const [showPackageModal, setShowPackageModal] = useState(false);

  // --- Return window ---
  const [tempReturnDays, setTempReturnDays] = useState<string>(String(DEFAULT_RETURN_DAYS));
  const [savingReturnSettings, setSavingReturnSettings] = useState(false);

  // --- Refund password ---
  const [refundStatus, setRefundStatus] = useState<RefundStatus>('loading');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [savingRefundPassword, setSavingRefundPassword] = useState(false);

  // ==========================================
  // DATA FETCHING
  // ==========================================
  const fetchRefundStatus = useCallback(async (): Promise<RefundStatus> => {
    setRefundStatus('loading');
    try {
      const { configured } = await getRefundPasswordStatus();
      const s: RefundStatus = configured ? 'configured' : 'not_configured';
      setRefundStatus(s);
      return s;
    } catch (error) {
      console.error('Error fetching refund password status:', error);
      setRefundStatus('unknown');
      return 'unknown';
    }
  }, []);

  const fetchReturnSettings = useCallback(async () => {
    const snap = await getDoc(doc(db, 'settings', 'returnSettings'));
    const data = snap.exists() ? snap.data() ?? {} : {};
    const days = Math.round(num(data.returnDaysLimit, DEFAULT_RETURN_DAYS));
    setReturnSettings({ returnDaysLimit: days, updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : undefined });
    setTempReturnDays(String(days));
    // Never keep the legacy plain-text value in memory — only remember that it exists.
    setHasLegacyRefundPassword(typeof data.refundPassword === 'string' && data.refundPassword.length > 0);
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [wh, pk, rs] = await Promise.allSettled([
      loadCollection('warehouses', toWarehouse),
      loadCollection('templates', toPackage),
      fetchReturnSettings(),
    ]);
    if (wh.status === 'fulfilled') setWarehouses(wh.value);
    else {
      console.error('Error fetching warehouses:', wh.reason);
      toast.error('Failed to load warehouses.');
    }
    if (pk.status === 'fulfilled') setPackages(pk.value);
    else {
      console.error('Error fetching package templates:', pk.reason);
      toast.error('Failed to load package templates.');
    }
    if (rs.status === 'rejected') {
      console.error('Error fetching return settings:', rs.reason);
      toast.error('Failed to load return settings.');
    }
    setLoading(false);
  }, [fetchReturnSettings]);

  useEffect(() => {
    if (!allowed) return;
    void fetchData();
    void fetchRefundStatus();
  }, [allowed, fetchData, fetchRefundStatus]);

  // ==========================================
  // RETURN WINDOW
  // ==========================================
  const handleSaveReturnSettings = async () => {
    if (savingReturnSettings) return;
    const days = Number(tempReturnDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      toast.warning('Return window must be a whole number between 1 and 365 days');
      return;
    }

    setSavingReturnSettings(true);
    try {
      const payload: Record<string, unknown> = {
        returnDaysLimit: days,
        updatedAt: Date.now(),
      };
      if (currentUser?.email) payload.updatedBy = currentUser.email;

      // Strip a legacy plain-text refund password, but only once the server confirms it
      // holds the hashed copy (it migrates the legacy field itself) — otherwise leave it
      // untouched so the configured password isn't lost.
      if (hasLegacyRefundPassword) {
        const status = refundStatus === 'configured' ? 'configured' : await fetchRefundStatus();
        if (status === 'configured') payload.refundPassword = deleteField();
      }

      await setDoc(doc(db, 'settings', 'returnSettings'), payload, { merge: true });
      setReturnSettings({ returnDaysLimit: days, updatedAt: payload.updatedAt as number });
      if (payload.refundPassword) setHasLegacyRefundPassword(false);
      toast.success('Return window updated');
    } catch (error) {
      console.error('Error saving return settings:', error);
      toast.error(getApiErrorMessage(error, 'Failed to save return settings. Please try again.'));
    } finally {
      setSavingReturnSettings(false);
    }
  };

  const handleDiscardReturnSettings = () => {
    setTempReturnDays(String(returnSettings.returnDaysLimit));
  };

  // ==========================================
  // REFUND PASSWORD (server-side, hashed)
  // ==========================================
  const refundMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  const handleSaveRefundPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingRefundPassword) return;
    if (newPassword.length < MIN_REFUND_PASSWORD) {
      toast.warning(`The refund password must be at least ${MIN_REFUND_PASSWORD} characters.`);
      return;
    }
    if (newPassword.length > 128) {
      toast.warning('The refund password must be at most 128 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.warning("The passwords don't match.");
      return;
    }
    setSavingRefundPassword(true);
    try {
      await setRefundPassword(newPassword);
      setNewPassword('');
      setConfirmPassword('');
      setShowPasswords(false);
      toast.success(refundStatus === 'configured' ? 'Refund password changed' : 'Refund password set');
      await fetchRefundStatus();
    } catch (error) {
      console.error('Error saving refund password:', error);
      toast.error(getApiErrorMessage(error, 'Failed to save the refund password. Please try again.'));
    } finally {
      setSavingRefundPassword(false);
    }
  };

  // ==========================================
  // COUNTRY / STATE LOGIC
  // ==========================================
  const allCountries = Country.getAllCountries();
  const selectedCountryObj = allCountries.find((c) => c.name === warehouseForm.country);
  const statesForCountry = selectedCountryObj ? State.getStatesOfCountry(selectedCountryObj.isoCode) : [];

  // ==========================================
  // WAREHOUSE HANDLERS
  // ==========================================
  const resetWarehouseForm = () => {
    setEditingWarehouseId(null);
    setWarehouseForm(DEFAULT_WAREHOUSE);
  };

  const handleWarehouseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const docId = editingWarehouseId ?? generateDocumentId(warehouseForm.name);
    if (!docId) {
      toast.warning('Please enter a valid warehouse name');
      return;
    }
    if (!editingWarehouseId && warehouses.some((w) => w.id === docId)) {
      toast.warning('A warehouse with this name already exists. Edit it instead.');
      return;
    }

    setSaving(true);
    try {
      const warehouseDocRef = doc(db, 'warehouses', docId);
      const timestamp = Date.now();
      const warehouseData = { ...warehouseForm, name: warehouseForm.name.trim(), updatedAt: timestamp };

      if (editingWarehouseId) {
        await updateDoc(warehouseDocRef, warehouseData);
        toast.success('Warehouse updated successfully!');
      } else {
        await setDoc(warehouseDocRef, { ...warehouseData, createdAt: timestamp });
        toast.success('Warehouse added successfully!');
      }
      resetWarehouseForm();
      await fetchData();
    } catch (error) {
      console.error('Error saving warehouse:', error);
      toast.error(getApiErrorMessage(error, 'Failed to save warehouse.'));
    } finally {
      setSaving(false);
    }
  };

  const editWarehouse = (warehouse: Warehouse) => {
    const { id, createdAt: _c, updatedAt: _u, ...formState } = warehouse;
    setEditingWarehouseId(id);
    setWarehouseForm({ ...DEFAULT_WAREHOUSE, ...formState });
    // On small screens the form is below the list.
    window.setTimeout(() => document.getElementById('warehouse-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };

  const deleteWarehouse = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this warehouse?')) return;
    try {
      await deleteDoc(doc(db, 'warehouses', id));
      setWarehouses((prev) => prev.filter((w) => w.id !== id));
      if (editingWarehouseId === id) resetWarehouseForm();
      toast.success('Warehouse deleted successfully!');
    } catch (error) {
      console.error('Error deleting warehouse:', error);
      toast.error(getApiErrorMessage(error, 'Failed to delete warehouse.'));
    }
  };

  // ==========================================
  // PACKAGE HANDLERS
  // ==========================================
  const resetPackageForm = () => {
    setEditingPackageId(null);
    setPackageForm(DEFAULT_PACKAGE);
  };

  const closePackageModal = () => {
    if (saving) return;
    setShowPackageModal(false);
    resetPackageForm();
  };

  const handlePackageSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const docId = editingPackageId ?? generateDocumentId(packageForm.name);
    if (!docId) {
      toast.warning('Please enter a valid template name');
      return;
    }
    const dims = [packageForm.weight, packageForm.length, packageForm.width, packageForm.height];
    if (dims.some((n) => !Number.isFinite(n) || n <= 0)) {
      toast.warning('Weight and dimensions must be numbers greater than 0');
      return;
    }
    if (!editingPackageId && packages.some((p) => p.id === docId)) {
      toast.warning('A template with this name already exists. Edit it instead.');
      return;
    }

    setSaving(true);
    try {
      const packageDocRef = doc(db, 'templates', docId);
      const timestamp = Date.now();
      const packageData = { ...packageForm, name: packageForm.name.trim(), updatedAt: timestamp };

      if (editingPackageId) {
        await updateDoc(packageDocRef, packageData);
        toast.success('Package template updated successfully!');
      } else {
        await setDoc(packageDocRef, { ...packageData, createdAt: timestamp });
        toast.success('Package template added successfully!');
      }
      setShowPackageModal(false);
      resetPackageForm();
      await fetchData();
    } catch (error) {
      console.error('Error saving package template:', error);
      toast.error(getApiErrorMessage(error, 'Failed to save package template.'));
    } finally {
      setSaving(false);
    }
  };

  const editPackage = (pkg: PackageTemplate) => {
    const { id, createdAt: _c, updatedAt: _u, ...formState } = pkg;
    setEditingPackageId(id);
    setPackageForm({ ...DEFAULT_PACKAGE, ...formState });
    setShowPackageModal(true);
  };

  const deletePackage = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this template?')) return;
    try {
      await deleteDoc(doc(db, 'templates', id));
      setPackages((prev) => prev.filter((p) => p.id !== id));
      if (editingPackageId === id) {
        setShowPackageModal(false);
        resetPackageForm();
      }
      toast.success('Package template deleted successfully!');
    } catch (error) {
      console.error('Error deleting package:', error);
      toast.error(getApiErrorMessage(error, 'Failed to delete package template.'));
    }
  };

  // ==========================================
  // RENDER
  // ==========================================
  if (!allowed) {
    return (
      <div className="flex items-center justify-center py-10">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 sm:p-10 max-w-md w-full text-center">
          <div className="h-16 w-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4 text-red-500">
            <ShieldAlert className="h-8 w-8" aria-hidden="true" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Access Restricted</h2>
          <p className="text-sm text-slate-500">
            You don't have permission to view Settings. Contact an Admin or Super Admin for access.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]" role="status" aria-label="Loading settings">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" aria-hidden="true" />
      </div>
    );
  }

  const tabs: Array<{ id: TabType; label: string; short: string; icon: typeof Building2 }> = [
    { id: 'warehouses', label: 'Warehouses', short: 'Warehouses', icon: Building2 },
    { id: 'packages', label: 'Package Templates', short: 'Packages', icon: Package },
    { id: 'returns', label: 'Return & Security', short: 'Returns', icon: Calendar },
  ];

  const editingWarehouse = !!editingWarehouseId;
  const editingPackage = !!editingPackageId;

  return (
    <div className="max-w-6xl mx-auto font-sans text-slate-900">
      {/* Header */}
      <div className="mb-5 sm:mb-8">
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">Settings</h1>
        <p className="text-sm sm:text-base text-slate-500 mt-1 sm:mt-2">Manage your warehouses, package templates, and return policies.</p>
      </div>

      {/* Tabs */}
      <div role="tablist" aria-label="Settings sections" className="grid grid-cols-3 sm:inline-flex gap-1 bg-slate-200/50 p-1 rounded-xl w-full sm:w-auto mb-5 sm:mb-8">
        {tabs.map(({ id, label, short, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center justify-center gap-1.5 sm:gap-2 px-2 sm:px-5 min-h-[44px] rounded-lg font-bold text-xs sm:text-sm transition-all ${
              activeTab === id ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="sm:hidden truncate">{short}</span>
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* WAREHOUSES TAB */}
      {activeTab === 'warehouses' && (
        <div className="flex flex-col lg:flex-row gap-5 lg:gap-8 items-start">
          <div className="w-full lg:w-1/3 space-y-3">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-bold text-slate-800">Warehouses</h2>
              <button
                type="button"
                onClick={resetWarehouseForm}
                className="text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-3 min-h-[40px] rounded-lg text-sm font-bold flex items-center gap-1 transition-colors"
              >
                <Plus className="w-4 h-4" aria-hidden="true" /> Add New
              </button>
            </div>

            {warehouses.length === 0 ? (
              <div className="bg-white border border-slate-200 border-dashed rounded-2xl p-8 text-center text-slate-500">
                No warehouses added yet.
              </div>
            ) : (
              warehouses.map((warehouse) => {
                const selected = editingWarehouseId === warehouse.id;
                return (
                  <button
                    type="button"
                    key={warehouse.id}
                    onClick={() => editWarehouse(warehouse)}
                    aria-pressed={selected}
                    className={`w-full text-left p-4 rounded-2xl border transition-all ${
                      selected
                        ? 'bg-slate-900 border-slate-900 text-white shadow-lg'
                        : 'bg-white border-slate-200 hover:border-indigo-300 shadow-sm'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className={`mt-1 p-2 rounded-lg shrink-0 ${selected ? 'bg-slate-800' : 'bg-indigo-50 text-indigo-600'}`}>
                          <MapPin className="w-5 h-5" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                          <h3 className={`font-bold break-words ${selected ? 'text-white' : 'text-slate-800'}`}>{warehouse.name}</h3>
                          <p className={`text-xs mt-1 leading-relaxed break-words ${selected ? 'text-slate-300' : 'text-slate-500'}`}>
                            {[warehouse.address1, warehouse.city].filter(Boolean).join(', ')}
                            <br />
                            {[warehouse.state, warehouse.country].filter(Boolean).join(', ')}
                            {warehouse.pincode ? ` - ${warehouse.pincode}` : ''}
                          </p>
                          {warehouse.phone && <p className="text-xs mt-1 text-slate-400">{warehouse.phone}</p>}
                        </div>
                      </div>
                      {!warehouse.isActive && (
                        <span className="text-[10px] uppercase font-bold tracking-wider bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full shrink-0">
                          Inactive
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div id="warehouse-form" className="w-full lg:w-2/3 bg-white border border-slate-200 rounded-2xl p-4 sm:p-6 lg:p-8 shadow-sm scroll-mt-4">
            <div className="flex items-center justify-between gap-3 mb-5 pb-4 border-b border-slate-100">
              <h2 className="text-lg sm:text-xl font-bold text-slate-800">{editingWarehouse ? 'Edit Warehouse' : 'Add New Warehouse'}</h2>
              {editingWarehouseId && (
                <button
                  type="button"
                  onClick={() => void deleteWarehouse(editingWarehouseId)}
                  className="text-red-600 hover:text-red-700 bg-red-50 h-10 w-10 flex items-center justify-center rounded-lg transition-colors"
                  title="Delete warehouse"
                  aria-label="Delete warehouse"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              )}
            </div>

            <form onSubmit={handleWarehouseSubmit} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
                <div className="md:col-span-2">
                  <label htmlFor="wh-name" className={labelCls}>
                    Warehouse Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="wh-name"
                    required
                    type="text"
                    value={warehouseForm.name}
                    onChange={(e) => setWarehouseForm({ ...warehouseForm, name: e.target.value })}
                    className={`${inputCls} ${editingWarehouse ? '' : 'bg-slate-50'}`}
                    placeholder="e.g. Prashanti Sarees"
                    disabled={editingWarehouse}
                  />
                  {editingWarehouse && (
                    <p className="text-xs text-amber-700 mt-1 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" aria-hidden="true" /> Warehouse name cannot be changed
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="wh-code" className={labelCls}>Code (Optional)</label>
                  <input id="wh-code" type="text" value={warehouseForm.code} onChange={(e) => setWarehouseForm({ ...warehouseForm, code: e.target.value })} className={inputCls} placeholder="e.g. WH-001" />
                </div>

                <div>
                  <label htmlFor="wh-ext" className={labelCls}>External ID (Optional)</label>
                  <input id="wh-ext" type="text" value={warehouseForm.externalId} onChange={(e) => setWarehouseForm({ ...warehouseForm, externalId: e.target.value })} className={inputCls} placeholder="Third party ID" />
                </div>

                <div className="md:col-span-2">
                  <label htmlFor="wh-a1" className={labelCls}>Address Line 1 <span className="text-red-500">*</span></label>
                  <input id="wh-a1" required type="text" value={warehouseForm.address1} onChange={(e) => setWarehouseForm({ ...warehouseForm, address1: e.target.value })} className={inputCls} autoComplete="address-line1" />
                </div>

                <div>
                  <label htmlFor="wh-a2" className={labelCls}>Address Line 2</label>
                  <input id="wh-a2" type="text" value={warehouseForm.address2} onChange={(e) => setWarehouseForm({ ...warehouseForm, address2: e.target.value })} className={inputCls} autoComplete="address-line2" />
                </div>

                <div>
                  <label htmlFor="wh-a3" className={labelCls}>Address Line 3</label>
                  <input id="wh-a3" type="text" value={warehouseForm.address3} onChange={(e) => setWarehouseForm({ ...warehouseForm, address3: e.target.value })} className={inputCls} autoComplete="address-line3" />
                </div>

                <div>
                  <label htmlFor="wh-country" className={labelCls}>Country <span className="text-red-500">*</span></label>
                  <select id="wh-country" required value={warehouseForm.country} onChange={(e) => setWarehouseForm({ ...warehouseForm, country: e.target.value, state: '' })} className={inputCls}>
                    <option value="">Select country</option>
                    {allCountries.map((country) => (
                      <option key={country.isoCode} value={country.name}>{country.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="wh-state" className={labelCls}>State <span className="text-red-500">*</span></label>
                  <select
                    id="wh-state"
                    required
                    value={warehouseForm.state}
                    onChange={(e) => setWarehouseForm({ ...warehouseForm, state: e.target.value })}
                    disabled={!warehouseForm.country || statesForCountry.length === 0}
                    className={inputCls}
                  >
                    <option value="">Select state</option>
                    {statesForCountry.map((state) => (
                      <option key={state.isoCode} value={state.name}>{state.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="wh-city" className={labelCls}>City <span className="text-red-500">*</span></label>
                  <input id="wh-city" required type="text" value={warehouseForm.city} onChange={(e) => setWarehouseForm({ ...warehouseForm, city: e.target.value })} className={inputCls} autoComplete="address-level2" />
                </div>

                <div>
                  <label htmlFor="wh-pin" className={labelCls}>Pincode <span className="text-red-500">*</span></label>
                  <input id="wh-pin" required type="text" inputMode="numeric" value={warehouseForm.pincode} onChange={(e) => setWarehouseForm({ ...warehouseForm, pincode: e.target.value })} className={inputCls} autoComplete="postal-code" />
                </div>

                <div className="md:col-span-2">
                  <label htmlFor="wh-phone" className={labelCls}>Phone <span className="text-red-500">*</span></label>
                  <input id="wh-phone" required type="tel" inputMode="tel" value={warehouseForm.phone} onChange={(e) => setWarehouseForm({ ...warehouseForm, phone: e.target.value })} className={inputCls} placeholder="+91 9962505459" />
                </div>

                <div className="flex items-center">
                  <label className="flex items-center gap-3 cursor-pointer min-h-[44px]">
                    <input
                      type="checkbox"
                      checked={warehouseForm.isActive}
                      onChange={(e) => setWarehouseForm({ ...warehouseForm, isActive: e.target.checked })}
                      className="w-5 h-5 accent-indigo-600 rounded border-slate-300"
                    />
                    <span className="font-bold text-slate-700">Active Warehouse</span>
                  </label>
                </div>
              </div>

              <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 pt-4 border-t border-slate-100">
                <button type="button" onClick={resetWarehouseForm} disabled={saving} className="min-h-[44px] px-6 py-3 border-2 border-slate-200 text-slate-600 font-bold rounded-xl hover:bg-slate-50 transition-colors disabled:opacity-60">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="min-h-[44px] flex-1 bg-slate-900 hover:bg-slate-800 text-white font-bold py-3 px-6 rounded-xl transition-all flex justify-center items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> : <Save className="w-5 h-5" aria-hidden="true" />}
                  {editingWarehouse ? 'Update Warehouse' : 'Save Warehouse'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PACKAGES TAB */}
      {activeTab === 'packages' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-4 sm:p-6 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/50">
            <div>
              <h2 className="text-lg font-bold text-slate-800">Package Templates</h2>
              <p className="text-sm text-slate-500 mt-1">Pre-defined package sizes for faster returns processing.</p>
            </div>
            <button
              type="button"
              onClick={() => { resetPackageForm(); setShowPackageModal(true); }}
              className="min-h-[44px] bg-slate-900 hover:bg-slate-800 text-white px-5 py-2.5 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors shadow-sm"
            >
              <Plus className="w-4 h-4" aria-hidden="true" /> New Template
            </button>
          </div>

          {packages.length === 0 ? (
            <div className="p-8 text-center text-slate-500">No package templates configured yet.</div>
          ) : (
            <>
              {/* Mobile list */}
              <ul className="sm:hidden divide-y divide-slate-100">
                {packages.map((pkg) => (
                  <li key={pkg.id} className="p-4 flex items-center gap-3">
                    <Package className="w-5 h-5 text-slate-400 shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-slate-800 break-words">{pkg.name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {pkg.weight} {pkg.weightUnit} · {pkg.length} × {pkg.width} × {pkg.height} {pkg.dimensionUnit}
                      </p>
                    </div>
                    <button type="button" onClick={() => editPackage(pkg)} className="h-10 w-10 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg" aria-label={`Edit ${pkg.name}`}>
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={() => void deletePackage(pkg.id)} className="h-10 w-10 flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg" aria-label={`Delete ${pkg.name}`}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>

              {/* Table (sm+) */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th scope="col" className="p-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Template Name</th>
                      <th scope="col" className="p-4 text-xs font-bold text-slate-500 uppercase tracking-wider text-center">Weight</th>
                      <th scope="col" className="p-4 text-xs font-bold text-slate-500 uppercase tracking-wider text-center">Dimensions (L×W×H)</th>
                      <th scope="col" className="p-4 text-xs font-bold text-slate-500 uppercase tracking-wider text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {packages.map((pkg) => (
                      <tr key={pkg.id} className="hover:bg-slate-50/50 transition-colors">
                        <td className="p-4 font-bold text-slate-800">
                          <div className="flex items-center gap-3">
                            <Package className="w-5 h-5 text-slate-400" aria-hidden="true" />
                            {pkg.name}
                          </div>
                        </td>
                        <td className="p-4 text-center text-slate-600 font-medium">{pkg.weight} {pkg.weightUnit}</td>
                        <td className="p-4 text-center text-slate-600 font-medium">
                          {pkg.length} × {pkg.width} × {pkg.height} {pkg.dimensionUnit}
                        </td>
                        <td className="p-4">
                          <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => editPackage(pkg)} className="h-10 w-10 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all" title="Edit template" aria-label={`Edit ${pkg.name}`}>
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button type="button" onClick={() => void deletePackage(pkg.id)} className="h-10 w-10 flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all" title="Delete template" aria-label={`Delete ${pkg.name}`}>
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* RETURN & SECURITY TAB */}
      {activeTab === 'returns' && (
        <div className="max-w-2xl mx-auto space-y-5 sm:space-y-6">
          {/* Return window */}
          <section className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden" aria-labelledby="return-window-h">
            <div className="p-4 sm:p-6 border-b border-slate-100 bg-gradient-to-r from-indigo-50 to-white flex items-center gap-3">
              <div className="p-2 bg-indigo-100 rounded-xl shrink-0">
                <Clock className="w-6 h-6 text-indigo-600" aria-hidden="true" />
              </div>
              <div>
                <h2 id="return-window-h" className="text-lg sm:text-xl font-bold text-slate-800">Return Window</h2>
                <p className="text-sm text-slate-500 mt-0.5">How long customers have to request a return</p>
              </div>
            </div>
            <div className="p-4 sm:p-6 space-y-4">
              <div>
                <label htmlFor="return-days" className="text-sm font-bold text-slate-700 block mb-2">Allowed Return Period (Days)</label>
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    id="return-days"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={365}
                    step={1}
                    value={tempReturnDays}
                    onChange={(e) => setTempReturnDays(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleSaveReturnSettings();
                    }}
                    className="w-28 min-h-[44px] p-3 bg-white border border-slate-200 rounded-xl outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 text-center font-bold text-lg"
                  />
                  <span className="text-slate-600 text-sm">days from order delivery</span>
                </div>
                <p className="text-xs text-slate-500 mt-2">Customers can only initiate a return within this timeframe.</p>
              </div>
              <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleDiscardReturnSettings}
                  disabled={savingReturnSettings || tempReturnDays === String(returnSettings.returnDaysLimit)}
                  className="min-h-[44px] px-6 py-2.5 border-2 border-slate-200 text-slate-600 font-bold rounded-xl hover:bg-slate-50 transition-colors disabled:opacity-50"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveReturnSettings()}
                  disabled={savingReturnSettings}
                  className="min-h-[44px] flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 px-6 rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingReturnSettings ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> : <Save className="w-5 h-5" aria-hidden="true" />}
                  Save return window
                </button>
              </div>
            </div>
          </section>

          {/* Refund password */}
          <section className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden" aria-labelledby="refund-pw-h">
            <div className="p-4 sm:p-6 border-b border-slate-100 bg-gradient-to-r from-indigo-50 to-white flex items-start sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2 bg-indigo-100 rounded-xl shrink-0">
                  <ShieldCheck className="w-6 h-6 text-indigo-600" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h2 id="refund-pw-h" className="text-lg sm:text-xl font-bold text-slate-800">Refund Approval Password</h2>
                  <p className="text-sm text-slate-500 mt-0.5">Agents enter it to confirm every refund</p>
                </div>
              </div>
              <RefundStatusBadge status={refundStatus} />
            </div>

            <form onSubmit={handleSaveRefundPassword} className="p-4 sm:p-6 space-y-4" noValidate>
              <p className="text-sm text-slate-600" aria-live="polite">
                {refundStatus === 'configured' && 'A refund password is active. Set a new one below to change it — the old password stops working immediately.'}
                {refundStatus === 'not_configured' && 'No refund password is set. Create one to protect refunds.'}
                {refundStatus === 'loading' && 'Checking the current status…'}
                {refundStatus === 'unknown' && (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    Couldn't check whether a refund password is set.
                    <button type="button" onClick={() => void fetchRefundStatus()} className="inline-flex items-center gap-1 font-semibold text-indigo-700 hover:text-indigo-900 min-h-[32px]">
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Retry
                    </button>
                  </span>
                )}
              </p>

              <input type="text" name="username" value="refund-approval" autoComplete="username" readOnly hidden />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="refund-new" className="text-sm font-bold text-slate-700 block mb-2">
                    {refundStatus === 'configured' ? 'New password' : 'Password'}
                  </label>
                  <PasswordInput
                    id="refund-new"
                    value={newPassword}
                    onChange={setNewPassword}
                    visible={showPasswords}
                    onVisibleChange={setShowPasswords}
                    inputClassName={`${inputCls} pl-10 font-medium`}
                    leftIcon={<KeyRound className="w-4 h-4" />}
                    placeholder={`At least ${MIN_REFUND_PASSWORD} characters`}
                    autoComplete="new-password"
                    minLength={MIN_REFUND_PASSWORD}
                    maxLength={128}
                    disabled={savingRefundPassword}
                  />
                </div>
                <div>
                  <label htmlFor="refund-confirm" className="text-sm font-bold text-slate-700 block mb-2">Confirm password</label>
                  <PasswordInput
                    id="refund-confirm"
                    value={confirmPassword}
                    onChange={setConfirmPassword}
                    visible={showPasswords}
                    onVisibleChange={setShowPasswords}
                    inputClassName={`${inputCls} font-medium`}
                    placeholder="Re-enter the password"
                    autoComplete="new-password"
                    disabled={savingRefundPassword}
                    aria-invalid={refundMismatch}
                    aria-describedby={refundMismatch ? 'refund-mismatch' : undefined}
                  />
                  {refundMismatch && (
                    <p id="refund-mismatch" className="text-xs text-red-600 mt-1.5">The passwords don't match.</p>
                  )}
                </div>
              </div>

              <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setNewPassword(''); setConfirmPassword(''); }}
                  disabled={savingRefundPassword || (!newPassword && !confirmPassword)}
                  className="min-h-[44px] px-6 py-2.5 border-2 border-slate-200 text-slate-600 font-bold rounded-xl hover:bg-slate-50 transition-colors disabled:opacity-50"
                >
                  Clear
                </button>
                <button
                  type="submit"
                  disabled={
                    savingRefundPassword ||
                    newPassword.length < MIN_REFUND_PASSWORD ||
                    newPassword !== confirmPassword
                  }
                  className="min-h-[44px] flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 px-6 rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingRefundPassword ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> : <KeyRound className="w-5 h-5" aria-hidden="true" />}
                  {refundStatus === 'configured' ? 'Change refund password' : 'Set refund password'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {/* Package Form Modal */}
      <Modal
        open={showPackageModal}
        onClose={closePackageModal}
        closeDisabled={saving}
        title={editingPackage ? 'Edit Package Template' : 'New Package Template'}
      >
        <form onSubmit={handlePackageSubmit} className="space-y-5">
          <div>
            <label htmlFor="pkg-name" className={labelCls}>
              Template Name <span className="text-red-500">*</span>
            </label>
            <input
              id="pkg-name"
              required
              type="text"
              value={packageForm.name}
              onChange={(e) => setPackageForm({ ...packageForm, name: e.target.value })}
              className={inputCls}
              placeholder="e.g. Standard Box"
              disabled={editingPackage}
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            <div>
              <label htmlFor="pkg-weight" className={labelCls}>Weight <span className="text-red-500">*</span></label>
              <input
                id="pkg-weight"
                required
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={numberInputValue(packageForm.weight)}
                onChange={(e) => setPackageForm({ ...packageForm, weight: parseNumberInput(e.target.value) })}
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="pkg-wunit" className={labelCls}>Unit</label>
              <select
                id="pkg-wunit"
                value={packageForm.weightUnit}
                onChange={(e) => setPackageForm({ ...packageForm, weightUnit: e.target.value === 'g' ? 'g' : 'kg' })}
                className={inputCls}
              >
                <option value="kg">Kilograms (kg)</option>
                <option value="g">Grams (g)</option>
              </select>
            </div>
          </div>

          <fieldset>
            <legend className={labelCls}>Dimensions <span className="text-red-500">*</span></legend>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              {(['length', 'width', 'height'] as const).map((key) => (
                <div key={key}>
                  <label htmlFor={`pkg-${key}`} className="sr-only">{key}</label>
                  <input
                    id={`pkg-${key}`}
                    required
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    min="0"
                    value={numberInputValue(packageForm[key])}
                    onChange={(e) => setPackageForm({ ...packageForm, [key]: parseNumberInput(e.target.value) })}
                    className={`${inputCls} px-2 text-center`}
                    placeholder={key.charAt(0).toUpperCase() + key.slice(1)}
                  />
                  <p className="text-[10px] text-slate-400 text-center mt-1 capitalize" aria-hidden="true">{key}</p>
                </div>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor="pkg-dunit" className={labelCls}>Dimension Unit</label>
            <select
              id="pkg-dunit"
              value={packageForm.dimensionUnit}
              onChange={(e) => setPackageForm({ ...packageForm, dimensionUnit: e.target.value === 'in' ? 'in' : 'cm' })}
              className={inputCls}
            >
              <option value="cm">Centimeters (cm)</option>
              <option value="in">Inches (in)</option>
            </select>
          </div>

          <div className="pt-4 border-t border-slate-100 flex gap-3">
            {editingPackageId && (
              <button
                type="button"
                onClick={() => void deletePackage(editingPackageId)}
                disabled={saving}
                className="min-h-[44px] px-4 py-3 text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 font-bold rounded-xl transition-colors flex items-center gap-2 disabled:opacity-60"
              >
                <Trash2 className="w-5 h-5" aria-hidden="true" /> Delete
              </button>
            )}
            <button
              type="submit"
              disabled={saving}
              className="min-h-[44px] flex-1 bg-slate-900 hover:bg-slate-800 text-white font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> : <Save className="w-5 h-5" aria-hidden="true" />}
              {editingPackage ? 'Update Template' : 'Create Template'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

const RefundStatusBadge = ({ status }: { status: RefundStatus }) => {
  if (status === 'configured') {
    return (
      <span className="flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider bg-green-100 text-green-700 px-2 py-1 rounded-full shrink-0">
        <ShieldCheck className="w-3 h-3" aria-hidden="true" /> Configured
      </span>
    );
  }
  if (status === 'not_configured') {
    return (
      <span className="flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider bg-amber-100 text-amber-800 px-2 py-1 rounded-full shrink-0">
        <ShieldAlert className="w-3 h-3" aria-hidden="true" /> Not set
      </span>
    );
  }
  if (status === 'loading') {
    return <Loader2 className="w-4 h-4 text-slate-400 animate-spin shrink-0" aria-label="Checking status" />;
  }
  return (
    <span className="text-[10px] uppercase font-bold tracking-wider bg-slate-100 text-slate-600 px-2 py-1 rounded-full shrink-0">
      Unknown
    </span>
  );
};

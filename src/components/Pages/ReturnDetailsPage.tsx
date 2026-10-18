import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  X, Mail, ChevronDown, User, Phone, MapPin, Bell,
  FileText, AlertCircle, CheckCircle2, Package, CreditCard,
  RefreshCw, Truck, Plus, Download, ArrowLeft, Gift, ShieldAlert
} from 'lucide-react';
import {
  doc, getDoc, collection, query, orderBy, limit,
  getDocs, addDoc, updateDoc, Timestamp, serverTimestamp, runTransaction, arrayUnion
} from 'firebase/firestore';
import { db } from '../../Interfaces/firebase';
import {
  fetchShopifyOrder, restockShopifyItems, notifyReturnRejected, convertReturnActionType, notifyItemRejected,
  apiClient, addShopifyNote, downloadImageFile, downloadImagesAsZip, reconcileExchangeHold, checkPincodeServiceability,
} from '../../Interfaces/api';
import { getApiErrorMessage } from '../../Interfaces/http';
import { fetchCustomerReturnStats, CustomerReturnStats } from '../Agent/customerReturns';
import { getActiveItems, priceToNumber, formatINR, ReturnDoc } from '../Agent/returnHelpers';
import { ImageZoom } from '../Layout/ImageZoom';
import { RejectRequestModal } from '../../Modals/RejectRequestModal';
import { IssueRefundModal } from '../../Modals/IssueRefundModal';
import { CreatePickupModal } from '../../Modals/CreatePickupModal';
import { MarkReceivedModal } from '../../Modals/MarkReceivedModal';
import { ExchangeModal } from '../../Modals/ExchangeModal';
import { CancelPickupModal } from '../../Modals/CancelPickupModal';
import { SelfShipModal } from '../../Modals/SelfShipModal';
import { RejectedItem, ActivityItem, ReturnItem, ReturnData, MarkReceivedItemDecision } from '../../Interfaces/types';
import { useAuth } from '../common/AuthContext';
import { BaseModal } from '../../Modals/BaseModal';
import { toast } from 'react-toastify';

interface CustomerInfo {
  name: string;
  email: string;
  phone: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

interface StoreCreditAccount {
  id: string;
  balance_amount: number;
  balance_currency: string;
}

interface GiftCard {
  id: string;
  balance_amount: number;
  balance_currency: string;
  code: string;
  customer_id: string | null;
}

interface CustomerBalances {
  customer_found: boolean;
  email: string;
  customer_graphql_id: string;
  customer_legacy_id: string;
  store_credit_accounts: StoreCreditAccount[];
  gift_cards: GiftCard[];
}

/** Blue Dart returns PickupDate as "/Date(1791590400000)/"; ISO strings / dates also accepted. */
const formatPickupDate = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  const ms = /\/Date\((-?\d+)/.exec(raw);
  const d = ms ? new Date(Number(ms[1])) : new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleDateString('en-IN');
};

const ReturnStatusBadge = ({ status }: { status: string }) => {
  const statusConfig: Record<string, { color: string; bg: string; label: string }> = {
    'pending': { color: 'text-amber-700', bg: 'bg-amber-50 border-amber-100', label: 'Pending' },
    'open': { color: 'text-blue-700', bg: 'bg-blue-50 border-blue-100', label: 'Open' },
    'approved': { color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-100', label: 'Approved' },
    'denied': { color: 'text-red-700', bg: 'bg-red-50 border-red-100', label: 'Denied' },
    'closed': { color: 'text-slate-700', bg: 'bg-slate-50 border-slate-100', label: 'Closed' },
    'completed': { color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-100', label: 'Completed' },
    'exchanged_created': { color: 'text-purple-700', bg: 'bg-purple-50 border-purple-100', label: 'Exchange Created' },
    'default': { color: 'text-slate-700', bg: 'bg-slate-50 border-slate-100', label: 'Unknown' }
  };

  const config = statusConfig[status?.toLowerCase()] || statusConfig.default;

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${config.color} ${config.bg}`}>
      {config.label}
    </span>
  );
};

const ShipmentStatusBadge = ({ status }: { status?: string }) => {
  if (!status) return <span className="text-xs text-slate-400">Not Created</span>;

  const statusConfig: Record<string, { color: string; bg: string; icon: React.ReactNode }> = {
    'not created': { color: 'text-slate-600', bg: 'bg-slate-50 border-slate-200', icon: <Package className="w-3 h-3" /> },
    'pickup created': { color: 'text-purple-700', bg: 'bg-purple-50 border-purple-100', icon: <Truck className="w-3 h-3" /> },
    'pickup scheduled': { color: 'text-blue-700', bg: 'bg-blue-50 border-blue-100', icon: <RefreshCw className="w-3 h-3" /> },
    'in transit': { color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-100', icon: <Truck className="w-3 h-3" /> },
    'self ship requested': { color: 'text-blue-700', bg: 'bg-blue-50 border-blue-100', icon: <Package className="w-3 h-3" /> },
    'received': { color: 'text-green-700', bg: 'bg-green-50 border-green-100', icon: <CheckCircle2 className="w-3 h-3" /> },
    'pickup cancelled': { color: 'text-red-700', bg: 'bg-red-50 border-red-100', icon: <X className="w-3 h-3" /> },
    'failed': { color: 'text-red-700', bg: 'bg-red-50 border-red-100', icon: <AlertCircle className="w-3 h-3" /> },
    'default': { color: 'text-slate-700', bg: 'bg-slate-50 border-slate-100', icon: <Package className="w-3 h-3" /> }
  };

  const config = statusConfig[status?.toLowerCase()] || statusConfig.default;

  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${config.color} ${config.bg}`}>
      {config.icon}
      {status}
    </span>
  );
};

const RefundStatusBadge = ({ status, method }: { status?: string; method?: string }) => {
  if (!status) return <span className="text-xs text-slate-400">Not Initiated</span>;

  const statusConfig: Record<string, { color: string; bg: string; icon: React.ReactNode }> = {
    'pending': { color: 'text-amber-700', bg: 'bg-amber-50 border-amber-100', icon: <RefreshCw className="w-3 h-3" /> },
    'processing': { color: 'text-blue-700', bg: 'bg-blue-50 border-blue-100', icon: <RefreshCw className="w-3 h-3" /> },
    'refunded': { color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-100', icon: <CheckCircle2 className="w-3 h-3" /> },
    'failed': { color: 'text-red-700', bg: 'bg-red-50 border-red-100', icon: <AlertCircle className="w-3 h-3" /> },
    'not eligible': { color: 'text-slate-600', bg: 'bg-slate-50 border-slate-200', icon: <X className="w-3 h-3" /> },
    'skipped': { color: 'text-slate-500', bg: 'bg-slate-50 border-slate-200', icon: <X className="w-3 h-3" /> },
    'default': { color: 'text-slate-700', bg: 'bg-slate-50 border-slate-100', icon: <CreditCard className="w-3 h-3" /> }
  };

  const config = statusConfig[status?.toLowerCase()] || statusConfig.default;
  const methodIcon = method === 'gift_card' ? '🎁' : method === 'store_credit' ? '💳' : '💰';

  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${config.color} ${config.bg}`}>
      <span>{methodIcon}</span>
      {status}
    </span>
  );
};

/** Small badge that marks a single item (or the whole request) as a Return or an Exchange. */
const ActionTypeBadge = ({
  actionType, size = 'md'
}: { actionType: 'return' | 'exchange' | 'mixed'; size?: 'sm' | 'md' }) => {
  const config = {
    return: { color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200', icon: '↩', label: 'Return' },
    exchange: { color: 'text-purple-700', bg: 'bg-purple-50 border-purple-200', icon: '↔', label: 'Exchange' },
    mixed: { color: 'text-slate-700', bg: 'bg-gradient-to-r from-blue-50 to-purple-50 border-slate-200', icon: '⇄', label: 'Return & Exchange' }
  } as const;
  const style = config[actionType] || config.return;
  const sizeClasses = size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs';

  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-semibold border shrink-0 ${sizeClasses} ${style.color} ${style.bg}`}>
      <span className={size === 'sm' ? 'text-xs' : 'text-sm'}>{style.icon}</span>
      {style.label}
    </span>
  );
};

/** Reverse-shipment dropdown. Defined at module level so it doesn't remount on every render. */
const ActionMenu = ({
  canCreatePickup, canCancelPickup, onSelect, onDismiss,
}: {
  canCreatePickup: boolean;
  canCancelPickup: boolean;
  onSelect: (action: 'pickup' | 'self' | 'cancel') => void;
  onDismiss: () => void;
}) => {
  const menuActions: Array<{ label: string; icon: React.ReactNode; color: string; action: 'pickup' | 'self' | 'cancel'; disabled: boolean }> = [
    { label: 'Create Pickup', icon: <Truck className="w-3.5 h-3.5" />, color: 'text-blue-600', action: 'pickup', disabled: !canCreatePickup },
    { label: 'Request Self Ship', icon: <Truck className="w-3.5 h-3.5" />, color: 'text-amber-600', action: 'self', disabled: !canCreatePickup },
    { label: 'Cancel Pickup', icon: <X className="w-3.5 h-3.5" />, color: 'text-red-600', action: 'cancel', disabled: !canCancelPickup },
  ];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);
  return (
    <div role="menu" className="absolute top-full left-0 sm:left-auto sm:right-0 mt-2 w-56 max-w-[calc(100vw-2rem)] bg-white rounded-xl shadow-xl border border-slate-200 py-2 z-30 animate-fadeIn">
      {menuActions.map((action) => (
        <button
          key={action.action}
          type="button"
          role="menuitem"
          disabled={action.disabled}
          onClick={() => { if (!action.disabled) onSelect(action.action); }}
          className={`w-full text-left px-4 py-3 min-h-[44px] text-sm flex items-center gap-3 group transition-all duration-200 ${
            action.disabled ? 'opacity-40 cursor-not-allowed text-slate-400' : 'text-slate-700 hover:bg-slate-50'
          }`}
        >
          <div className={`p-1.5 rounded-lg bg-slate-100 group-hover:bg-white ${action.disabled ? '' : action.color}`}>{action.icon}</div>
          <span className="flex-1">{action.label}</span>
          <ChevronDown className="w-3 h-3 text-slate-400 -rotate-90" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
};

/**
 * Firestore doc → ReturnData with the fields the page relies on always present
 * (legacy / hand-edited docs may lack `items` or `customer`). The doc id is authoritative.
 */
const normalizeReturnDoc = (docId: string, raw: Record<string, unknown> | undefined): ReturnData => {
  const d = (raw ?? {}) as Partial<ReturnData>;
  return {
    ...d,
    id: docId,
    items: Array.isArray(d.items) ? d.items.filter(Boolean) : [],
    customer: (d.customer && typeof d.customer === 'object' ? d.customer : {}) as ReturnData['customer'],
  } as ReturnData;
};

/** Σ price × quantityReturned, tolerant of missing / malformed fields. */
const itemsValue = (items: ReturnItem[] | null | undefined): number =>
  (items ?? []).reduce((acc, item) => acc + priceToNumber(item?.price) * (Number(item?.quantityReturned) || 0), 0);

/** Small stat tile for the customer panel. `value === undefined` → loading, `null` → failed/unavailable. */
/** One "label …… value" row of the customer history list (labels never truncate). */
const CustomerStatTile = ({ icon, label, value, className = '', unavailableHint = 'Could not be loaded' }: {
  icon: React.ReactNode; label: string; value: string | null | undefined; className?: string; unavailableHint?: string;
}) => (
  <div className={`flex items-center justify-between gap-3 px-3 py-2.5 ${className}`}>
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0">{icon}</span>
      <span className="text-sm text-slate-600 leading-snug">{label}</span>
    </div>
    {value === undefined ? (
      <div className="h-5 w-14 shrink-0 bg-slate-200 rounded animate-pulse" aria-label="Loading" />
    ) : (
      <span className="shrink-0 whitespace-nowrap text-sm font-bold text-slate-800 tabular-nums" title={value === null ? unavailableHint : undefined}>
        {value === null ? '—' : value}
      </span>
    )}
  </div>
);

const formatAddress = (customer: CustomerInfo | null | undefined): string => {
  if (!customer) return 'Not provided';
  const parts = [customer.address, customer.city, customer.state, customer.zip, customer.country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Not provided';
};

const InfoCard = ({ icon, label, value, isLink = false, color = 'slate' }: { icon: React.ReactNode; label: string; value: string; isLink?: boolean; color?: string; }) => {
  const colorClasses = {
    indigo: 'bg-indigo-50 text-indigo-700',
    blue: 'bg-blue-50 text-blue-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    slate: 'bg-slate-50 text-slate-700'
  };

  return (
    <div className="flex items-start gap-3 p-2.5 rounded-lg hover:bg-slate-50 transition-colors">
      <div className={`p-2 rounded-lg flex-shrink-0 ${colorClasses[color as keyof typeof colorClasses]}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-slate-500 mb-0.5">{label}</div>
        {isLink ? (
          <a href={label === 'Email' ? `mailto:${value}` : `tel:${value}`} className="text-sm text-slate-800 hover:text-indigo-600 block break-all hover:underline" title={value}>
            {value}
          </a>
        ) : (
          <p className="text-sm text-slate-800 break-words whitespace-pre-wrap" title={value}>{value}</p>
        )}
      </div>
    </div>
  );
};

const HorizontalActivityItem = ({ type, title, description, time, timestamp, user }: { type: 'success' | 'info' | 'processing' | 'warning' | 'note' | 'notification'; title: string; description: string; time: string; timestamp: string; user?: string; }) => {
  const typeConfig = {
    success: { color: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
    info: { color: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', icon: <Bell className="w-3.5 h-3.5" /> },
    processing: { color: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', icon: <RefreshCw className="w-3.5 h-3.5" /> },
    warning: { color: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', icon: <AlertCircle className="w-3.5 h-3.5" /> },
    note: { color: 'bg-slate-50', text: 'text-slate-700', border: 'border-slate-200', icon: <FileText className="w-3.5 h-3.5" /> },
    notification: { color: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200', icon: <Bell className="w-3.5 h-3.5" /> }
  };
  const config = typeConfig[type] || typeConfig.info;

  return (
    <div className={`min-w-[250px] p-4 rounded-lg border ${config.border} ${config.color} hover:shadow-md transition-shadow duration-200`}>
      <div className="flex items-start gap-3 mb-3">
        <div className={`p-2 rounded-lg ${config.color} ${config.text}`}>{config.icon}</div>
        <div className="flex-1">
          <div className="flex justify-between items-start">
            <span className="text-sm font-semibold text-slate-800">{title}</span>
            <span className={`px-2 py-0.5 ${config.color} ${config.text} text-[10px] font-medium rounded-full flex items-center gap-1 whitespace-nowrap`}>
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </span>
          </div>
          <p className="text-xs text-slate-600 mt-1 break-words">{description}</p>
          {user && <p className="text-[10px] font-medium text-slate-500 mt-1">by {user}</p>}
        </div>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-slate-400">
        <span className="truncate">{time}</span>
        <span className="w-1 h-1 bg-slate-300 rounded-full flex-shrink-0"></span>
        <span className="whitespace-nowrap">{timestamp}</span>
      </div>
    </div>
  );
};

const ItemComparisonCard = ({
  item, index, RAN, orderName, actionType, onRejectClick, onConvertActionType, convertDisabled, isConverting
}: {
  item: ReturnItem; index: number; RAN: string; orderName: string; actionType: 'return' | 'exchange';
  onRejectClick: (itemId: number, item: ReturnItem) => void;
  /** Flip just THIS item's actionType, independent of the rest of the request. */
  onConvertActionType?: (newActionType: 'return' | 'exchange') => void;
  convertDisabled?: boolean;
  isConverting?: boolean;
}) => {
  const [selectedImageIdx, setSelectedImageIdx] = useState(0);
  const [isExpanded, setIsExpanded] = useState(true);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [downloadingProduct, setDownloadingProduct] = useState(false);

  const handleDownloadAll = async () => {
    if (!item.customerImages || item.customerImages.length === 0) return;
    setDownloadingAll(true);
    try {
      const images = item.customerImages.map((url, i) => ({
        url,
        filename: `${item.sku || 'item'}_${i + 1}.jpg`
      }));
      await downloadImagesAsZip(images, `${orderName}_${RAN}_${item.sku || 'item'}_images`);
    } catch (error) {
      toast.error(`Failed to download customer images: ${getApiErrorMessage(error)}`);
    } finally {
      setDownloadingAll(false);
    }
  };

  const handleDownloadProductImage = async () => {
    if (!item.productImage) return;
    setDownloadingProduct(true);
    try {
      await downloadImageFile(item.productImage, `${RAN}_${item.sku || 'item'}_product.jpg`);
    } catch (error) {
      toast.error(`Failed to download product image: ${getApiErrorMessage(error)}`);
    } finally {
      setDownloadingProduct(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-300">
      <div className="bg-gradient-to-r from-slate-50 to-white px-4 sm:px-5 py-3 border-b border-slate-200 flex flex-wrap sm:flex-nowrap justify-between items-center gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="w-6 h-6 bg-indigo-100 text-indigo-600 rounded-md flex items-center justify-center text-xs font-semibold shrink-0">{index + 1}</div>
          <span className="text-sm font-semibold text-slate-700 break-words min-w-0" title={item.title}>{item.title}</span>
          <ActionTypeBadge actionType={actionType} size="sm" />
          {onConvertActionType && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onConvertActionType(actionType === 'exchange' ? 'return' : 'exchange');
              }}
              disabled={convertDisabled}
              title={`Convert this item to ${actionType === 'exchange' ? 'Return' : 'Exchange'}`}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border shrink-0 transition-colors ${
                convertDisabled
                  ? 'opacity-40 cursor-not-allowed border-slate-200 text-slate-400 bg-slate-50'
                  : 'border-slate-300 text-slate-600 bg-white hover:border-indigo-400 hover:text-indigo-600'
              }`}
            >
              <RefreshCw className={`w-3 h-3 ${isConverting ? 'animate-spin' : ''}`} />
              {isConverting ? 'Converting…' : `To ${actionType === 'exchange' ? 'Return' : 'Exchange'}`}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <button 
            onClick={(e) => {
              e.stopPropagation();
              onRejectClick(item.lineItemId, item);
            }} 
            className="px-2.5 sm:px-3 py-1.5 bg-white border border-red-200 text-red-600 hover:bg-red-50 text-xs font-medium rounded-lg flex items-center gap-1.5 shadow-sm transition-colors whitespace-nowrap"
          >
            <X className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Reject Item</span><span className="sm:hidden">Reject</span>
          </button>
          
          <button onClick={() => setIsExpanded(!isExpanded)} className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-50 transition-colors shrink-0">
            <ChevronDown className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      <div className={isExpanded ? 'block' : 'hidden'}>
        <div className="p-3 sm:p-5">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6">
            <div className="lg:col-span-6 space-y-3 sm:space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-800 flex items-center gap-2 text-sm sm:text-base"><span className="w-2 h-2 bg-amber-500 rounded-full shrink-0"></span>Uploaded Images</h3>
                <button onClick={handleDownloadAll} disabled={downloadingAll} className="text-xs text-indigo-600 hover:text-indigo-700 font-medium flex items-center gap-1 px-2 py-1 hover:bg-indigo-50 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap">
                  <Download className="w-3 h-3" /> {downloadingAll ? 'Zipping…' : 'Download All'}
                </button>
              </div>

              <div className="relative w-full h-56 sm:h-64 md:h-72 bg-gradient-to-br from-slate-50 to-white rounded-xl overflow-hidden border border-slate-200">
                {item.customerImages && item.customerImages.length > 0 ? (
                  <>
                    <ImageZoom src={item.customerImages[selectedImageIdx]} alt="Uploaded by customer" />
                    <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded-md backdrop-blur-sm">
                      {selectedImageIdx + 1} / {item.customerImages.length}
                    </div>
                  </>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-slate-400">
                    <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mb-2"><Package className="w-5 h-5" /></div>
                    <p className="text-sm">No Image Uploaded</p>
                  </div>
                )}
              </div>

              <div>
                <p className="font-medium text-slate-900 text-sm mb-2 break-words">{item.title}</p>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="bg-slate-100 text-slate-700 px-2 py-1 rounded-md font-medium">SKU: {item.sku}</span>
                  <span className="text-slate-400">•</span>
                  <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded-md font-medium">Qty: {item.quantityReturned}</span>
                  <span className="text-slate-400">•</span>
                  <span className="bg-amber-50 text-amber-700 px-2 py-1 rounded-md font-medium">{item.reason}</span>
                </div>
              </div>

              {item.customerImages && item.customerImages.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {item.customerImages.map((img, i) => (
                    <div key={i} onClick={() => setSelectedImageIdx(i)} className={`relative w-16 h-16 border-2 rounded-lg cursor-pointer transition-all shrink-0 overflow-hidden ${selectedImageIdx === i ? 'ring-2 ring-indigo-500 border-indigo-500 shadow-md' : 'border-slate-200 hover:border-indigo-300'}`}>
                      <img src={img} className="w-full h-full object-cover hover:scale-110 transition-transform duration-300" alt={`thumb-${i}`} />
                      {selectedImageIdx === i && (
                        <div className="absolute inset-0 bg-indigo-500/20 flex items-center justify-center">
                          <div className="w-6 h-6 bg-indigo-500 rounded-full flex items-center justify-center"><CheckCircle2 className="w-3 h-3 text-white" /></div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Divider: vertical line on desktop, horizontal line with icon on mobile/tablet */}
            <div className="hidden lg:flex lg:col-span-1 items-center justify-center relative">
              <div className="w-px h-64 bg-gradient-to-b from-transparent via-slate-300 to-transparent"></div>
              <div className="absolute"><RefreshCw className="w-6 h-6 text-slate-400 bg-white p-1 rounded-full" /></div>
            </div>
            <div className="flex lg:hidden items-center justify-center relative py-1">
              <div className="w-full h-px bg-gradient-to-r from-transparent via-slate-300 to-transparent"></div>
              <div className="absolute bg-white border border-slate-200 rounded-full p-1.5 shadow-sm"><RefreshCw className="w-4 h-4 text-slate-400" /></div>
            </div>

            <div className="lg:col-span-5 space-y-3 sm:space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-800 flex items-center gap-2 text-sm sm:text-base"><span className="w-2 h-2 bg-emerald-500 rounded-full shrink-0"></span>Original Product</h3>
                <button onClick={handleDownloadProductImage} disabled={downloadingProduct} className="text-xs text-slate-600 hover:text-slate-800 font-medium flex items-center gap-1 px-2 py-1 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap">
                  <Download className="w-3 h-3" /> {downloadingProduct ? 'Downloading…' : 'Download'}
                </button>
              </div>

              <div className="relative w-full h-56 sm:h-64 md:h-72 bg-gradient-to-br from-emerald-50 to-white rounded-xl overflow-hidden border border-slate-200">
                <ImageZoom src={item.productImage} alt="Original Catalog" />
              </div>

              <div>
                <p className="font-medium text-slate-900 text-sm mb-2 break-words">{item.title}</p>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500">Price:</span>
                    <span className="font-semibold text-slate-800">{item.price}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500">{actionType === 'exchange' ? 'Item Value:' : 'Return Value:'}</span>
                    <span className="font-bold text-emerald-600">₹{(priceToNumber(item?.price) * (Number(item?.quantityReturned) || 0)).toFixed(2)}</span>
                  </div>
                  {item.note && (
                    <div className={`mt-3 p-3.5 bg-indigo-50 border-l-4 border-indigo-500 rounded-r-lg shadow-sm ${isExpanded ? 'block' : 'hidden'}`}>
                      <div className="flex items-start gap-2">
                        <FileText className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
                        <p className="text-sm text-indigo-900">
                          <span className="font-bold uppercase tracking-wider text-xs text-indigo-700 block mb-0.5">Customer Note</span>
                          <span className="font-semibold">{item.note}</span>
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const ReturnDetailsPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  
  const [data, setData] = useState<ReturnData | null>(null);
  const [shopifyOrderData, setShopifyOrderData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [noteText, setNoteText] = useState('');
  const [addingNote, setAddingNote] = useState(false);
  const [isServiceable, setIsServiceable] = useState<boolean | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [activeActivityTab, setActiveActivityTab] = useState<'all' | 'notes' | 'notifications'>('all');
  const [converting, setConverting] = useState(false);
  const [convertingItemId, setConvertingItemId] = useState<number | null>(null);
  const [isRejectModalOpen, setIsRejectModalOpen] = useState(false);
  const [isMarkReceivedModalOpen, setIsMarkReceivedModalOpen] = useState(false);
  const [isIssueRefundModalOpen, setIsIssueRefundModalOpen] = useState(false);
  const [labelPreview, setLabelPreview] = useState<string | null>(null);
  const [isExchangeModalOpen, setIsExchangeModalOpen] = useState(false);
  const [isCancelPickupModalOpen, setIsCancelPickupModalOpen] = useState(false);
  const [itemToReject, setItemToReject] = useState<{ id: number; item: ReturnItem } | undefined>(undefined);

  // undefined = loading / not started, null = failed
  const [customerOrderCount, setCustomerOrderCount] = useState<number | null | undefined>(undefined);
  const [customerTotalSpent, setCustomerTotalSpent] = useState<number | null | undefined>(undefined);
  const [customerReturnStats, setCustomerReturnStats] = useState<CustomerReturnStats | null | undefined>(undefined);

  const [customerBalances, setCustomerBalances] = useState<CustomerBalances | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);

  // Role / identity come from the auth context (server-verified profile), never from localStorage.
  const { user: currentUser } = useAuth();

  /**
   * Bumped on every (re)load and whenever :id changes. Async results carry the token
   * they were started with and are dropped when it is no longer current, so a slow
   * response for a previous return can never overwrite the one on screen.
   */
  const loadSeqRef = useRef(0);
  const idRef = useRef(id);
  idRef.current = id;
  /** Customer return stats: rank 1 = Firestore contact details, rank 2 = + Shopify order contacts (superset). */
  const statsRef = useRef<{ applied: number; latestStarted: number }>({ applied: 0, latestStarted: 0 });
  const closeMenu = useCallback(() => setIsMenuOpen(false), []);

  const getAgentName = (): string => {
    if (currentUser?.name) {
      return currentUser.name;
    }
    if (currentUser?.email) {
      return currentUser.email.split('@')[0];
    }
    return 'Unknown Agent';
  };

  const checkServiceability = async (zipCode: string, isCurrent: () => boolean) => {
    const zip = String(zipCode || '').trim();
    if (!zip) return;
    try {
      const results = await checkPincodeServiceability([zip]);
      if (!isCurrent()) return;
      if (zip in results) setIsServiceable(results[zip] === true);
    } catch {
      if (!isCurrent()) return;
      // Unknown → no warning shown (we never claim "not serviceable" without an answer).
      setIsServiceable(null);
    }
  };

  const fetchCustomerBalances = async (identifier: string, identifierType: 'email' | 'phone' = 'email'): Promise<CustomerBalances | null> => {
    try {
      const response = await apiClient.post('/customer/balances', {
        identifier: identifier.trim(),
        identifierType: identifierType
      });
      return response.data;
    } catch {
      return null;
    }
  };

  const fetchCustomerOrderSummary = async (identifier: string, isCurrent: () => boolean) => {
    if (!identifier) return;
    setCustomerOrderCount(undefined);
    setCustomerTotalSpent(undefined);
    try {
      const response = await apiClient.post('/orders/customer', { identifier: identifier.trim() });
      if (!isCurrent()) return;
      const orders = Array.isArray(response.data?.orders) ? response.data.orders : [];
      setCustomerOrderCount(orders.length);
      setCustomerTotalSpent(orders.reduce((sum: number, order: { total_price?: string }) => sum + priceToNumber(order?.total_price), 0));
    } catch {
      if (!isCurrent()) return;
      // Never show 0 for "unknown".
      setCustomerOrderCount(null);
      setCustomerTotalSpent(null);
    }
  };

  const loadCustomerBalances = async (identifier: string, identifierType: 'email' | 'phone', isCurrent: () => boolean) => {
    setLoadingBalances(true);
    const balances = await fetchCustomerBalances(identifier, identifierType);
    if (!isCurrent()) return;
    setCustomerBalances(balances);
    setLoadingBalances(false);
  };

  /**
   * Two lookups may run concurrently (rank 1 from the return doc, rank 2 adding the Shopify
   * order's contacts). A result is applied only if no higher-ranked result is already shown,
   * so the smaller rank-1 count can never overwrite the fuller rank-2 count (no undercount).
   */
  const loadCustomerReturnStats = async (
    emails: Array<string | undefined>,
    phones: Array<string | undefined>,
    current: { id: string; data: Partial<ReturnData> },
    rank: 1 | 2,
    isCurrent: () => boolean
  ) => {
    if (rank === 1) {
      statsRef.current = { applied: 0, latestStarted: 1 };
      setCustomerReturnStats(undefined);
    } else {
      statsRef.current.latestStarted = Math.max(statsRef.current.latestStarted, rank);
    }
    try {
      const stats = await fetchCustomerReturnStats({ emails, phones }, current);
      if (!isCurrent() || rank < statsRef.current.applied) return;
      statsRef.current.applied = rank;
      setCustomerReturnStats(stats);
    } catch {
      if (!isCurrent()) return;
      // Keep any earlier result; show "—" only when nothing else can still arrive.
      if (statsRef.current.applied === 0 && rank === statsRef.current.latestStarted) setCustomerReturnStats(null);
    }
  };

  const resetPerReturnState = () => {
    setData(null);
    setShopifyOrderData(null);
    setError('');
    setActivities([]);
    setNoteText('');
    setIsServiceable(null);
    setActiveAction(null);
    setIsMenuOpen(false);
    setActiveActivityTab('all');
    setConverting(false);
    setConvertingItemId(null);
    setIsRejectModalOpen(false);
    setIsMarkReceivedModalOpen(false);
    setIsIssueRefundModalOpen(false);
    setLabelPreview(null);
    setIsExchangeModalOpen(false);
    setIsCancelPickupModalOpen(false);
    setItemToReject(undefined);
    setCustomerOrderCount(undefined);
    setCustomerTotalSpent(undefined);
    setCustomerReturnStats(undefined);
    setCustomerBalances(null);
    setLoadingBalances(false);
    statsRef.current = { applied: 0, latestStarted: 0 };
  };

  useEffect(() => {
    // New :id → wipe everything that belonged to the previous return, then load.
    void fetchReturnDetails({ reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /**
   * Load (reset: true — full-page loader, used when :id changes) or silently refresh
   * (after an action; keeps the page and any open dialog mounted) the return.
   */
  const fetchReturnDetails = async (opts: { reset?: boolean } = {}) => {
    const returnId = id;
    if (!returnId) return;
    const token = ++loadSeqRef.current;
    const isCurrent = () => token === loadSeqRef.current && idRef.current === returnId;
    if (opts.reset) {
      resetPerReturnState();
      setLoading(true);
    }
    try {
      const docSnap = await getDoc(doc(db, 'returns', returnId));
      if (!isCurrent()) return;

      if (!docSnap.exists()) {
        setData(null);
        setError('Return request not found.');
        setLoading(false);
        return;
      }

      const firestoreData = normalizeReturnDoc(docSnap.id, docSnap.data());
      setError('');
      setData(firestoreData);
      setLoading(false);

      // Fallback for a webhook that may never have fired
      if (firestoreData.awaitingCustomerPayment && firestoreData.orderNumericId) {
        reconcileExchangeHold(firestoreData.orderNumericId)
          .then(result => {
            if (!isCurrent()) return;
            if (result?.released && result.released.length > 0) {
              void fetchActivities(returnId, isCurrent);
              setData(prev => prev ? { ...prev, awaitingCustomerPayment: false } : prev);
            }
          })
          .catch(() => { /* best-effort fallback check */ });
      }

      // Check pincode serviceability
      if (firestoreData.customer?.zip) {
        void checkServiceability(firestoreData.customer?.zip, isCurrent);
      }

      void fetchActivities(returnId, isCurrent);

      // Initial lookups use the return doc's e-mail and/or phone.
      const initialEmail = firestoreData.customer?.email || undefined;
      const initialPhone = firestoreData.customer?.phone || undefined;
      const initialIdentifier = initialEmail || initialPhone;
      const statsCurrent = { id: docSnap.id, data: firestoreData };

      if (initialIdentifier) {
        void loadCustomerBalances(initialIdentifier, initialEmail ? 'email' : 'phone', isCurrent);
        void fetchCustomerOrderSummary(initialIdentifier, isCurrent);
      } else {
        setCustomerOrderCount(null);
        setCustomerTotalSpent(null);
        setCustomerBalances(null);
        setLoadingBalances(false);
      }

      // Total Returns / Total Return Value (by e-mail OR phone). Refined below
      // once the Shopify order adds its own contact details.
      void loadCustomerReturnStats([initialEmail], [initialPhone], statsCurrent, 1, isCurrent);

      if (firestoreData.orderId) {
        fetchShopifyOrder(firestoreData.orderId)
          .then(shopifyOrder => {
            if (!isCurrent() || !shopifyOrder) return;
            setShopifyOrderData(shopifyOrder);

            const shipping = shopifyOrder.shipping_address;
            const customer = shopifyOrder.customer;

            const shippingPhone = shipping?.phone || customer?.phone || shopifyOrder.phone || firestoreData.customer?.phone;
            const shippingEmail = shopifyOrder.contact_email || shopifyOrder.email || customer?.email || firestoreData.customer?.email;

            setData(prev => {
              if (!prev) return prev;
              const prevCustomer = prev.customer ?? ({} as ReturnData['customer']);
              return {
                ...prev,
                customer: {
                  ...prevCustomer,
                  email: shippingEmail,
                  phone: shippingPhone,
                  address: shipping ? [shipping.address1, shipping.address2].filter(Boolean).join(', ') : prevCustomer.address,
                  city: shipping?.city || prevCustomer.city,
                  state: shipping?.province || prevCustomer.state,
                  zip: shipping?.zip || prevCustomer.zip,
                  country: shipping?.country || prevCustomer.country,
                }
              };
            });

            const shippingIdentifier = shippingEmail || shippingPhone;

            if ((shippingEmail && shippingEmail !== initialEmail) || (shippingPhone && shippingPhone !== initialPhone)) {
              void loadCustomerReturnStats([initialEmail, shippingEmail], [initialPhone, shippingPhone], statsCurrent, 2, isCurrent);
            }

            if (!initialIdentifier && shippingIdentifier) {
              void loadCustomerBalances(shippingIdentifier, shippingEmail ? 'email' : 'phone', isCurrent);
              void fetchCustomerOrderSummary(shippingIdentifier, isCurrent);
            }
          })
          .catch(() => { /* order panel stays on Firestore data */ });
      }

    } catch (err) {
      if (!isCurrent()) return;
      const message = `Failed to load return details: ${getApiErrorMessage(err)}`;
      if (opts.reset) {
        setError(message);
      } else {
        // Silent refresh failed: keep showing what we have.
        toast.error(message);
      }
      setLoading(false);
    }
  };

  /** Re-load after an action (keeps the page and open dialogs mounted). */
  const refreshReturn = () => { void fetchReturnDetails(); };

  const fetchActivities = async (returnId: string, isCurrent?: () => boolean) => {
    try {
      const activitiesRef = collection(db, 'returns', returnId, 'activities');
      const q = query(activitiesRef, orderBy('timestamp', 'desc'), limit(50));
      const querySnapshot = await getDocs(q);
      if (isCurrent ? !isCurrent() : idRef.current !== returnId) return;
      const activityList: ActivityItem[] = [];
      querySnapshot.forEach((doc) => activityList.push({ id: doc.id, ...doc.data() } as ActivityItem));
      setActivities(activityList);
    } catch {
      // Timeline stays empty; the page itself still works.
    }
  };

  const addNote = async () => {
    if (!noteText.trim() || !data) return;
    setAddingNote(true);
    try {
      const activitiesRef = collection(db, 'returns', data.id, 'activities');
      await addDoc(activitiesRef, { 
        type: 'note', 
        title: 'Note Added', 
        description: noteText, 
        timestamp: Timestamp.now(), 
        user: getAgentName()
      });
      await fetchActivities(data.id);
      setNoteText('');
      toast.success('Note added successfully.');
    } catch (error) {
      toast.error(`Failed to add note: ${getApiErrorMessage(error)}`);
    } finally {
      setAddingNote(false);
    }
  };

  /**
   * Saves a whole-request or single-item rejection, then asks the server to
   * e-mail the customer. THROWS on failure so RejectRequestModal stays open.
   */
  const handleRejectConfirm = async (reason: string, allowResubmit: boolean, itemIdToReject?: number) => {
    if (!id || !data) throw new Error('Return not loaded yet.');

    const docRef = doc(db, 'returns', id);
    const agentName = getAgentName();

    if (itemIdToReject) {
      const itemToReject = (data.items ?? []).find(item => item?.lineItemId === itemIdToReject);
      if (!itemToReject) throw new Error('Item not found on this return.');

      const newRejectedItem: RejectedItem & { rejectedByEmail?: string } = {
        lineItemId: itemToReject.lineItemId,
        title: itemToReject.title,
        sku: itemToReject.sku,
        quantityReturned: itemToReject.quantityReturned,
        price: itemToReject.price,
        reason,
        rejectedAt: Timestamp.now(),
        rejectedBy: agentName,
        rejectedByName: currentUser?.name || agentName,
        ...(currentUser?.email ? { rejectedByEmail: currentUser.email } : {}),
      };

      // Transaction + arrayUnion: never rebuild the array from (possibly stale)
      // page state, and never reject the same line item twice.
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists()) throw new Error('Return not found.');
        const existing = (snap.data()?.rejectedItems || []) as RejectedItem[];
        if (existing.some(r => r.lineItemId === itemToReject.lineItemId)) {
          throw new Error('This item has already been rejected.');
        }
        tx.update(docRef, { rejectedItems: arrayUnion(newRejectedItem), updatedAt: serverTimestamp() });
      });

      const rejectedItemValue = priceToNumber(itemToReject?.price) * (Number(itemToReject?.quantityReturned) || 0);
      try {
        await addDoc(collection(db, 'returns', id, 'activities'), {
          type: 'warning',
          title: 'Item Rejected',
          description: `Item "${itemToReject.title}" (SKU: ${itemToReject.sku}, worth ₹${rejectedItemValue.toFixed(2)}) was rejected. Reason: ${reason}`,
          timestamp: Timestamp.now(),
          user: agentName,
          metadata: { lineItemId: itemIdToReject, sku: itemToReject.sku, title: itemToReject.title, reason, amount: rejectedItemValue }
        });
      } catch {
        /* activity log is secondary */
      }

      const mail = await notifyItemRejected(id, itemToReject.lineItemId, reason);
      void addShopifyNote(
        data.orderNumericId || data.orderId,
        data.RAN,
        'Item Rejected',
        `Item: ${itemToReject.title} (SKU: ${itemToReject.sku})\nReason: ${reason}\nAction by: ${agentName}`
      );

      toast.info(`Item "${itemToReject.title}" has been rejected. It will be excluded from pickup and received processes.`);
      if (!mail.emailSent) toast.warning(`The item-rejection e-mail could not be sent${mail.error ? `: ${mail.error}` : '.'}`);
    } else {
      const statusUpdate = allowResubmit ? 'Closed' : 'Denied';

      await updateDoc(docRef, {
        status: statusUpdate,
        rejectionReason: reason,
        allowResubmit,
        rejectedBy: agentName,
        updatedAt: serverTimestamp()
      });

      try {
        await addDoc(collection(db, 'returns', id, 'activities'), {
          type: allowResubmit ? 'info' : 'warning',
          title: `Request ${statusUpdate}`,
          description: `Reason: ${reason || 'No reason provided'}. ${allowResubmit ? 'User can reapply.' : 'Denied permanently.'}`,
          timestamp: Timestamp.now(),
          user: agentName
        });
      } catch {
        /* activity log is secondary */
      }

      const mail = await notifyReturnRejected(id, reason, allowResubmit);
      void addShopifyNote(
        data.orderNumericId || data.orderId,
        data.RAN,
        'Return Request Rejected',
        `Reason: ${reason}\nAction by: ${agentName}`
      );

      try {
        await updateDoc(docRef, {
          [allowResubmit ? 'ClosedMailSent' : 'DeniedMailSent']: mail.emailSent,
          lastEmailAttempt: serverTimestamp(),
          ...(mail.emailSent ? { emailSentAt: serverTimestamp() } : {})
        });
      } catch {
        /* bookkeeping only */
      }

      toast.success(`Request ${statusUpdate.toLowerCase()}.`);
      if (!mail.emailSent) toast.warning(`The rejection e-mail could not be sent${mail.error ? `: ${mail.error}` : '.'}`);
    }

    setIsRejectModalOpen(false);
    setItemToReject(undefined);
    refreshReturn();
  };

  /**
   * Restock (server) → save receipt (Firestore) → activity/note. THROWS on any
   * failure of the first two steps so MarkReceivedModal stays open and does
   * NOT send the "return received" e-mail.
   */
  const handleMarkReceivedConfirm = async (decisions: MarkReceivedItemDecision[]) => {
    if (!id || !data) throw new Error('Return not loaded yet.');

    const docRef = doc(db, 'returns', id);
    const agentName = getAgentName();
    const activeItems = getActiveItems(data.items, data.rejectedItems);
    if (activeItems.length === 0) throw new Error('No active items to process. All items have been rejected.');

    const decisionMap = new Map(decisions.map(d => [d.lineItemId, d]));

    const itemConditions: Record<number, string> = {};
    activeItems.forEach(item => {
      itemConditions[item.lineItemId] = decisionMap.get(item.lineItemId)?.condition || 'Unknown';
    });
    const uniqueConditions = Array.from(new Set(Object.values(itemConditions)));
    const overallCondition = uniqueConditions.length === 1 ? uniqueConditions[0] : 'Mixed';

    const itemsToRestock = activeItems
      .map(item => {
        const decision = decisionMap.get(item.lineItemId);
        if (!decision || !decision.restock || decision.restockQuantity <= 0) return null;
        return {
          lineItemId: item.lineItemId,
          quantityReturned: Math.min(decision.restockQuantity, item.quantityReturned),
          sku: item.sku,
          title: item.title,
          condition: decision.condition,
          productImage: item.productImage,
          customerImages: item.customerImages,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const restockDecisions: Record<number, boolean> = {};
    activeItems.forEach(item => {
      const decision = decisionMap.get(item.lineItemId);
      restockDecisions[item.lineItemId] = !!(decision?.restock && (decision.restockQuantity ?? 0) > 0);
    });

    // 1. Restock first — the server adjusts inventory, writes restock_history
    //    and the restock fields on the return doc (isRestocked, restockStatus, …).
    let restockedUnits = 0;
    let skippedNote = '';
    if (itemsToRestock.length > 0) {
      try {
        const result = await restockShopifyItems(id, data.orderNumericId || data.orderId, itemsToRestock, overallCondition);
        restockedUnits = result.restocked.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
        if (result.skipped.length > 0) {
          skippedNote = ` ${result.skipped.length} item(s) were not restocked (${result.skipped.map(sk => sk.reason).filter(Boolean).join('; ') || 'already restocked'}).`;
        }
      } catch (restockError) {
        throw new Error(`Restock failed: ${getApiErrorMessage(restockError)} — the return has NOT been marked as received. Fix the issue or untick "Restock" to continue.`);
      }
    }

    // 2. Save the receipt.
    const now = Timestamp.now();
    const updateData: Record<string, unknown> = {
      shipmentStatus: 'Received',
      itemCondition: overallCondition,
      itemConditions,
      restockDecisions,
      returned_product_received: true,
      receivedAt: now,
      receivedBy: agentName,
      updatedAt: now,
    };
    if (itemsToRestock.length === 0) {
      updateData.isRestocked = false;
      updateData.restockStatus = 'Skipped';
    }
    try {
      await updateDoc(docRef, updateData);
    } catch (saveError) {
      throw new Error(
        `Could not save the receipt: ${getApiErrorMessage(saveError)}${itemsToRestock.length > 0 ? ' (Inventory was already restocked — retrying will not restock twice.)' : ''}`
      );
    }

    // 3. Activity + Shopify note (best effort).
    const conditionBreakdown = activeItems.map(item => `${item.title}: ${itemConditions[item.lineItemId]}`).join('; ');
    const receivedItemsValue = itemsValue(activeItems);
    const restockMsg = itemsToRestock.length > 0
      ? `Restocked ${restockedUnits} unit(s): ${itemsToRestock.map(i => `${i.title} x${i.quantityReturned}`).join(', ')}.${skippedNote}`
      : 'No items were restocked.';
    try {
      await addDoc(collection(db, 'returns', id, 'activities'), {
        type: 'success',
        title: 'Return Received',
        description: `${activeItems.length} item(s) worth ₹${receivedItemsValue.toFixed(2)} marked as received. ${restockMsg}`,
        timestamp: now,
        user: agentName,
        metadata: {
          itemConditions,
          restocked: restockedUnits > 0,
          shipmentStatus: 'Received',
          totalQuantityRestocked: restockedUnits,
          processedItemCount: activeItems.length,
          rejectedItemCount: (data.rejectedItems?.length || 0),
          amount: receivedItemsValue
        }
      });
    } catch {
      /* activity log is secondary */
    }
    void addShopifyNote(
      data.orderNumericId || data.orderId, data.RAN, 'Returned Product Received',
      `Condition breakdown: ${conditionBreakdown}\n${restockMsg}\nAction by: ${agentName}`
    );

    setIsMarkReceivedModalOpen(false);
    toast.success(`Return marked as received. Processed ${activeItems.length} item(s). ${restockMsg}`);
    refreshReturn();
  };

  const calculateTotal = (items: ReturnItem[] | null | undefined) => itemsValue(items).toFixed(2);

  const formatDate = (timestamp: any) => {
    if (!timestamp) return { month: '---', day: '--', full: 'N/A', time: '--:--', relative: '' };
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
    return {
      month: date.toLocaleString('default', { month: 'short' }),
      day: date.getDate().toString().padStart(2, '0'),
      full: date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      time: date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      relative: diffDays === 0 ? 'Today' : diffDays === 1 ? 'Yesterday' : `${diffDays} days ago`
    };
  };

  const filteredActivities = activities.filter(activity => 
    activeActivityTab === 'all' || 
    (activeActivityTab === 'notes' && activity.type === 'note') || 
    (activeActivityTab === 'notifications' && activity.type === 'notification')
  );

  // `data.id !== id`: the route param just changed and the reset effect hasn't run yet —
  // never render the previous return under the new URL.
  if (loading || (data && id && data.id !== id)) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white flex flex-col items-center justify-center p-4">
        <div className="relative">
          <div className="w-16 h-16 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
          <div className="absolute inset-0 flex items-center justify-center"><Package className="w-6 h-6 text-indigo-600 animate-pulse" /></div>
        </div>
        <p className="mt-4 text-slate-600 font-medium">Loading return details...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white p-4 sm:p-8 flex justify-center">
        <div className="bg-white p-6 sm:p-8 rounded-2xl border border-slate-200 text-center max-w-md shadow-lg w-full">
          <div className="w-16 h-16 bg-gradient-to-br from-red-50 to-pink-50 rounded-full flex items-center justify-center mx-auto mb-4"><AlertCircle className="w-8 h-8 text-red-500" /></div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Unable to Load Details</h2>
          <p className="text-sm text-slate-500 mb-6">{error}</p>
          <button onClick={() => navigate('/returns')} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-medium">Go Back to Returns</button>
        </div>
      </div>
    );
  }

  const dateObj = formatDate(data.createdAt);
  const items = data.items ?? [];
  const totalAmount = calculateTotal(items);

  // Total Balance = store credit + gift-card balances (null → "—" while loading / unavailable).
  const totalBalance: number | null = (() => {
    if (loadingBalances || !customerBalances || !customerBalances.customer_found) return null;
    const credit = (customerBalances.store_credit_accounts ?? []).reduce((sum, a) => sum + (Number(a?.balance_amount) || 0), 0);
    const cards = (customerBalances.gift_cards ?? []).reduce((sum, c) => sum + (Number(c?.balance_amount) || 0), 0);
    return Math.round((credit + cards) * 100) / 100;
  })();

  // Gift card issued for this return: docs keep only the last 4 (legacy docs may still hold the full code → mask it).
  const giftCardLast4 = (() => {
    const rd = data as ReturnData & { giftCardLast4?: string | null; giftCardCode?: string | null };
    const last4 = String(rd.giftCardLast4 ?? '').trim();
    if (last4) return last4.slice(-4);
    const legacy = String(rd.giftCardCode ?? '').replace(/\s+/g, '');
    return legacy.length >= 4 ? legacy.slice(-4) : '';
  })();

  const statusLower = (data.status || '').toLowerCase();
  const shipmentLower = (data.shipmentStatus || '').toLowerCase();
  const actionTypeLower = (data?.actionType || (data?.type?.toLowerCase().includes('exchange') ? 'exchange' : 'return')).toLowerCase();
  const isRefundCompleted = data.refundStatus?.toLowerCase() === 'refunded';
  const isTerminal = ['completed', 'closed', 'denied'].includes(statusLower);
  const isShipmentActive = ['pickup created', 'pickup scheduled', 'in transit', 'self ship requested'].includes(shipmentLower);
  const isProductReached = shipmentLower === 'product reached' && !isTerminal;
  const isReceivedStage = shipmentLower === 'received' && !isTerminal;
  const isSelfShipRequested = shipmentLower === 'self ship requested' && !isTerminal;

  // A single request can contain a mix of return and exchange items, so the
  // request-level actionType ('return' | 'exchange' | 'mixed') is only a
  // starting point — every item carries its own actionType too.
  const getItemActionType = (item: ReturnItem): 'return' | 'exchange' =>
    item.actionType === 'exchange' ? 'exchange'
      : item.actionType === 'return' ? 'return'
      : (actionTypeLower === 'exchange' ? 'exchange' : 'return');

  // Use ACTIVE items only (excluding rejected ones) so a rejected exchange
  // item doesn't keep blocking "Issue Refund", and a rejected return item
  // doesn't keep it wrongly enabled either.
  const activeItemsForFlags = getActiveItems(data.items, data.rejectedItems);
  const hasReturnItems = activeItemsForFlags.some(item => getItemActionType(item) === 'return');
  const hasExchangeItems = activeItemsForFlags.some(item => getItemActionType(item) === 'exchange');
  const isMixedOrder = actionTypeLower === 'mixed' || (hasReturnItems && hasExchangeItems);
  const overallActionType: 'return' | 'exchange' | 'mixed' = isMixedOrder ? 'mixed' : (hasExchangeItems ? 'exchange' : 'return');

  const oppositeActionType: 'return' | 'exchange' = actionTypeLower === 'exchange' ? 'return' : 'exchange';
  // Bulk-converting doesn't make sense once a request has both return and exchange
  // items, since there's no single "opposite" type to convert everything to.
  // (Per-item conversion via each item's own "To Return/Exchange" button covers
  // that case instead -- see ItemComparisonCard.)
  const canConvertAction = !!data && !converting && !isTerminal && !isRefundCompleted && !isMixedOrder;

  const isExchangedCreated = statusLower === 'exchanged_created';

  const canReject = !isReceivedStage && !isTerminal && !isProductReached;
  const canCreatePickup = !isShipmentActive && !isProductReached && !isReceivedStage && !isTerminal;
  const canCancelPickup = isShipmentActive || isProductReached;
  const canMarkReceived = (statusLower === 'approved' || statusLower === 'open') && (isProductReached || isSelfShipRequested) && !data.isRestocked;
  // An exchange processed in Shopify whose refund step didn't finish must stay
  // reachable so the agent can complete the refund (ExchangeModal resumes it).
  const storedExchange = (data as ReturnDoc).exchangeResult;
  const exchangeRefundPending = !!storedExchange && storedExchange.financialOutcome === 'refund' && !isRefundCompleted;
  const canExchange = hasExchangeItems && ((isReceivedStage && !isExchangedCreated) || exchangeRefundPending);

  // "Process Exchange" nets EVERY item in the request together (return items
  // included, as credit) into one combined settlement -- see ExchangeModal's
  // initLineItems, which pulls in the whole item list regardless of type. So
  // once a request has any active exchange item, that unified flow is the
  // only correct way to settle it; a separate "Issue Refund" for its return
  // item(s) would be recalculating (and potentially double-processing) value
  // that's already accounted for there. Issue Refund is only for requests
  // that are pure returns with no exchange items at all.
  const canRefund = hasReturnItems && !hasExchangeItems && isReceivedStage && !isRefundCompleted;

  const handleConvertActionType = async (newActionType: 'return' | 'exchange') => {
    const currentActionType = (data?.actionType || (data?.type?.toLowerCase().includes('exchange') ? 'exchange' : 'return')).toLowerCase();
    
    if (!data || converting || newActionType === currentActionType) return;
    
    const previous = data;
    setConverting(true);

    setData(prev => prev && {
      ...prev,
      actionType: newActionType,
      type: newActionType === 'exchange' ? 'Exchange' : 'Return',
      items: (prev.items ?? []).map(item => ({ ...item, actionType: newActionType })),
    });

    try {
      const result = await convertReturnActionType(data.id, newActionType);
      
      setData(prev => prev && {
        ...prev,
        actionType: result.actionType ?? newActionType,
        type: result.type ?? prev.type,
        items: Array.isArray(result.items) ? result.items : prev.items,
      });
      
      toast.success(`Converted to ${newActionType === 'exchange' ? 'Exchange' : 'Return'}.`);
    } catch (err) {
      setData(previous); 
      toast.error(`Failed to convert request type: ${getApiErrorMessage(err)}`);
    } finally {
      setConverting(false);
    }
  };

  // Flip a SINGLE item's actionType, independent of the rest of the request --
  // this is what lets a request stay "return item A + exchange item B" (or
  // move an item from one to the other) instead of forcing the whole request
  // to convert at once.
  const handleConvertItemActionType = async (lineItemId: number, newActionType: 'return' | 'exchange') => {
    if (!data || convertingItemId !== null) return;
    const previous = data;
    setConvertingItemId(lineItemId);

    setData(prev => prev && {
      ...prev,
      items: (prev.items ?? []).map(item =>
        item.lineItemId === lineItemId ? { ...item, actionType: newActionType } : item
      ),
    });

    try {
      const result = await convertReturnActionType(data.id, newActionType, lineItemId);

      setData(prev => prev && {
        ...prev,
        actionType: result.actionType ?? prev.actionType,
        type: result.type ?? prev.type,
        items: Array.isArray(result.items) ? result.items : prev.items,
      });

      toast.success(`Item converted to ${newActionType === 'exchange' ? 'Exchange' : 'Return'}.`);
    } catch (err) {
      setData(previous);
      toast.error(`Failed to convert item: ${getApiErrorMessage(err)}`);
    } finally {
      setConvertingItemId(null);
    }
  };

  // Determine if pincode is not serviceable
  const isNotServiceable = isServiceable === false && data?.customer?.zip;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white p-3 sm:p-6 overflow-x-hidden">
      <div className="mb-8">
        
        <button 
          onClick={() => navigate('/returns')} 
          className="flex items-center gap-2 text-sm text-slate-500 hover:text-indigo-600 transition-colors mb-6 font-medium w-fit group"
        >
          <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
          Back to Returns
        </button>

        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 mb-6">
          <div className="flex items-center gap-4 flex-wrap min-w-0 flex-1">
            <div className="relative flex-shrink-0">
              <div className="w-14 h-14 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex flex-col items-center justify-center text-white shadow-lg">
                <span className="text-[11px] font-semibold uppercase tracking-wider">{dateObj.month}</span>
                <span className="text-xl font-bold leading-none">{dateObj.day}</span>
              </div>
              <div className="absolute -bottom-2 -right-2 w-6 h-6 bg-emerald-500 rounded-full border-2 border-white flex items-center justify-center"><Package className="w-3 h-3 text-white" /></div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-2">
                <span>Request Submitted • {dateObj.relative}</span><span className="w-1.5 h-1.5 bg-slate-400 rounded-full"></span><span>{dateObj.time}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl sm:text-2xl font-bold text-slate-900 truncate">{data.RAN}</h1>
                <span className="hidden sm:inline text-slate-300">|</span>
                <span className="text-sm text-slate-500 truncate">Order {data.orderId}</span>

                {/* Not Serviceable Warning - Compact version */}
                {isNotServiceable && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200 rounded-lg shadow-sm whitespace-nowrap">
                    <ShieldAlert className="w-4 h-4 text-amber-600 flex-shrink-0" />
                    <span className="text-xs font-medium text-amber-700">
                      Pincode {data.customer?.zip} not serviceable
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
            {!isMixedOrder && (
              <button
                onClick={() => handleConvertActionType(oppositeActionType)}
                disabled={!canConvertAction || converting}
                className={`min-h-[40px] px-3 py-2 bg-gradient-to-r from-slate-600 to-slate-800 hover:from-slate-700 hover:to-slate-900 text-white text-xs font-medium rounded-lg flex items-center gap-1 shadow-md whitespace-nowrap ${(!canConvertAction || converting) ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${converting ? 'animate-spin' : ''}`} />
                Convert to {oppositeActionType.charAt(0).toUpperCase() + oppositeActionType.slice(1)}
              </button>
            )}
            
            <button
              onClick={() => canReject && setIsRejectModalOpen(true)}
              disabled={!canReject}
              className={`min-h-[40px] px-3 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-red-50 hover:text-red-600 text-xs font-medium rounded-lg flex items-center gap-1 shadow-sm whitespace-nowrap ${!canReject ? 'opacity-40 cursor-not-allowed hover:bg-white hover:text-slate-700' : ''}`}
            >
              <X className="w-3.5 h-3.5" /> Reject
            </button>
            
            <div className="relative">
              <button
                onClick={() => (canCreatePickup || canCancelPickup) && setIsMenuOpen(!isMenuOpen)}
                disabled={!canCreatePickup && !canCancelPickup}
                className={`min-h-[40px] px-3 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white text-xs font-medium rounded-lg flex items-center gap-1 shadow-md whitespace-nowrap ${(!canCreatePickup && !canCancelPickup) ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <Truck className="w-3.5 h-3.5" /> Reverse Shipment <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {isMenuOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setIsMenuOpen(false)} aria-hidden="true" />
                  <ActionMenu
                    canCreatePickup={canCreatePickup}
                    canCancelPickup={canCancelPickup}
                    onDismiss={closeMenu}
                    onSelect={(action) => {
                      if (action === 'cancel') setIsCancelPickupModalOpen(true);
                      else setActiveAction(action);
                      setIsMenuOpen(false);
                    }}
                  />
                </>
              )}
            </div>

            <button
              onClick={() => canMarkReceived && setIsMarkReceivedModalOpen(true)}
              disabled={!canMarkReceived}
              className={`min-h-[40px] px-3 py-2 bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-700 hover:to-green-700 text-white text-xs font-medium rounded-lg flex items-center gap-1 shadow-md whitespace-nowrap ${!canMarkReceived ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" /> Mark Received
            </button>

            {/* Shown whenever any item in the request is an exchange — a request can
                contain exchange items alongside return items at the same time. */}
            {hasExchangeItems && (
              <button
                onClick={() => setIsExchangeModalOpen(true)}
                disabled={!canExchange}
                className={`min-h-[40px] px-3 py-2 text-xs font-medium rounded-lg flex items-center gap-1 whitespace-nowrap transition-colors ${
                  !canExchange 
                    ? 'bg-slate-200 text-slate-500 cursor-not-allowed border border-slate-300'
                    : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white shadow-md'
                }`}
              >
                <RefreshCw className="w-3.5 h-3.5" /> {exchangeRefundPending ? 'Finish Exchange Refund' : 'Process Exchange'}
              </button>
            )}

            {/* Shown only for requests with no active exchange items -- once any
                item is being exchanged, "Process Exchange" is the single
                correct path that settles the whole request (return items
                included, as credit), so Issue Refund stays hidden rather
                than lingering as a redundant/duplicate action. */}
            {hasReturnItems && !hasExchangeItems && (
              <button
                onClick={() => setIsIssueRefundModalOpen(true)}
                disabled={!canRefund}
                className={`min-h-[40px] px-3 py-2 text-xs font-medium rounded-lg flex items-center gap-1 whitespace-nowrap transition-colors ${
                  !canRefund 
                    ? 'bg-slate-200 text-slate-500 cursor-not-allowed border border-slate-300'
                    : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white shadow-md'
                }`}
              >
                <CreditCard className="w-3.5 h-3.5" /> Issue Refund
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          <div className={`bg-white rounded-xl p-4 border shadow-sm ${isNotServiceable ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200'}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Return Status</div>
              <Package className="w-4 h-4 text-slate-400" />
            </div>
            <div className="flex items-center gap-2">
              <ReturnStatusBadge status={data.status} />
              {data.status === 'Completed' && (
                <span className="text-xs text-emerald-600 font-medium">✓ Completed</span>
              )}
            </div>
            {data.completedAt && (
              <div className="mt-2 text-[10px] text-slate-400">
                Completed: {formatDate(data.completedAt).full}
              </div>
            )}
          </div>

          <div className={`bg-white rounded-xl p-4 border shadow-sm ${isNotServiceable ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200'}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Shipment Status</div>
              <Truck className="w-4 h-4 text-slate-400" />
            </div>
            <div className="flex items-center gap-2">
              <ShipmentStatusBadge status={data.shipmentStatus} />
              {data.awb && (
                <span className="text-xs font-mono text-slate-500">{data.awb}</span>
              )}
            </div>
            {isNotServiceable && (
              <div className="mt-2 text-[10px] text-amber-600 font-medium flex items-center gap-1">
                <ShieldAlert className="w-3 h-3" />
                Pickup unavailable - pincode not serviceable
              </div>
            )}
            {data.receivedAt ? (
              <div className="mt-2 text-[10px] text-slate-400">
                Received: {formatDate(data.receivedAt).full}
              </div>
            ) : data.pickupDate && (
              <div className="mt-2 text-[10px] text-slate-400">
                Pickup: {formatPickupDate(data.pickupDate)}
              </div>
            )}
          </div>

          <div className={`bg-white rounded-xl p-4 border shadow-sm ${isNotServiceable ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200'}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Refund Status</div>
              <CreditCard className="w-4 h-4 text-slate-400" />
            </div>
            <div className="flex items-center gap-2">
              <RefundStatusBadge status={data.refundStatus} method={data.requestedMethod} />
              <span className="text-xs text-slate-500 capitalize">{data.requestedMethod?.replace('_', ' ') || 'Original Payment'}</span>
            </div>
            {giftCardLast4 && (
              <div className="mt-2 text-xs text-purple-700 font-medium">
                Gift card •••• {giftCardLast4}
              </div>
            )}
            {data.refundedAt ? (
              <div className="mt-2 text-[10px] text-slate-400">
                Refunded: {formatDate(data.refundedAt).full}
              </div>
            ) : data.refundStatus === 'Processing' && (
              <div className="mt-2 text-[10px] text-amber-600">
                Processing refund...
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className={`bg-white rounded-xl p-4 border shadow-sm ${isNotServiceable ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200'}`}>
            <div className="text-xs text-slate-500 mb-1">Total Value</div>
            <div className="text-xl font-bold text-slate-900">₹{totalAmount}</div>
            <div className="text-xs text-slate-400 mt-1">for {items.length} item{items.length === 1 ? '' : 's'}</div>
          </div>
          <div className={`bg-white rounded-xl p-4 border shadow-sm ${isNotServiceable ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200'}`}>
            <div className="text-xs text-slate-500 mb-1">Refund Method</div>
            <div className="text-lg font-semibold text-slate-900 capitalize">{data.requestedMethod?.replace('_', ' ') || 'Original Payment'}</div>
            <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><CreditCard className="w-3 h-3" /> {data.paymentMethod || 'Prepaid'}</div>
          </div>
          <div className={`bg-white rounded-xl p-4 border shadow-sm ${isNotServiceable ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200'}`}>
            <div className="text-xs text-slate-500 mb-1">AWB Tracking</div>
            <div className="text-lg font-semibold text-slate-900">
              {data.awb || 'Not assigned'}
            </div>
            {data.shippingLabelUrl && (
              <button
                onClick={() => setLabelPreview(data.shippingLabelUrl ?? null)}
                className="mt-2 px-3 py-1.5 bg-slate-900 hover:bg-black text-white text-xs font-medium rounded-lg flex items-center gap-1.5 shadow-md whitespace-nowrap"
              >
                <FileText className="w-3.5 h-3.5" />
                View Shipping Label
              </button>
            )}
          </div>
          <div className={`bg-white rounded-xl p-4 border shadow-sm ${isNotServiceable ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200'}`}>
            <div className="text-xs text-slate-500 mb-1">Customer Contact</div>
            <div className="text-sm font-semibold text-slate-900 break-words" title={data.customer?.name}>{data.customer?.name || '—'}</div>
            <div className="text-xs text-slate-400 mt-1 break-all" title={data.customer?.email}>{data.customer?.email || ''}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6 items-start">
        <div className="lg:col-span-3 space-y-4 sm:space-y-6">
          <div className={`bg-white rounded-xl p-4 sm:p-5 border shadow-sm ${isNotServiceable ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200'}`}>
            <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
              <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
              Request Details
            </h3>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-500 block mb-1">Request Type</label>
                <ActionTypeBadge actionType={overallActionType} />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-500 block mb-1">Return Status</label>
                <ReturnStatusBadge status={data.status} />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-500 block mb-1">Shipment Status</label>
                <ShipmentStatusBadge status={data.shipmentStatus} />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-500 block mb-1">Refund Status</label>
                <RefundStatusBadge status={data.refundStatus} method={data.requestedMethod} />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-500 block mb-1">Return Reason(s)</label>
                <div className="text-sm text-slate-800">
                  {items.length > 0 ? (
                    Array.from(new Set(items.map(item => item?.reason).filter(Boolean))).map((reason, index, array) => (
                      <span key={index}>
                        {reason}{index < array.length - 1 ? <span className="text-slate-400 mx-1">•</span> : ''}
                      </span>
                    ))
                  ) : (
                    'Not specified'
                  )}
                </div>
              </div>
              {data.refundEligibility && (
                <div>
                  <label className="text-xs font-medium text-slate-500 block mb-1">Refund Eligibility</label>
                  <span className={`px-2 py-1 text-xs font-medium rounded-full ${data.refundEligibility === 'Eligible' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{data.refundEligibility}</span>
                </div>
              )}
              {isNotServiceable && (
                <div className="pt-2 border-t border-amber-200">
                  <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                    <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-medium text-amber-700">Pincode Not Serviceable</p>
                      <p className="text-xs text-amber-600 mt-0.5">Blue Dart does not service pincode {data.customer?.zip}. Customer may need to self-ship.</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl p-4 sm:p-5 border border-slate-200 shadow-sm">
            <h3 className="font-semibold text-slate-800 flex items-center gap-2 mb-4">
              <div className="w-8 h-8 bg-gradient-to-br from-indigo-100 to-purple-100 rounded-lg flex items-center justify-center">
                <User className="w-4 h-4 text-indigo-600" />
              </div>
              Customer Info
            </h3>
            <div className="space-y-3">
              <InfoCard icon={<User className="w-4 h-4" />} label="Name" value={data.customer?.name || 'Not provided'} color="indigo" />
              {data.customer?.email ? (
                <InfoCard icon={<Mail className="w-4 h-4" />} label="Email" value={data.customer?.email ?? ""} isLink={true} color="blue" />
              ) : (
                <InfoCard icon={<Mail className="w-4 h-4" />} label="Email" value="Not provided" color="blue" />
              )}
              <InfoCard icon={<Phone className="w-4 h-4" />} label="Phone" value={data.customer?.phone || 'Not provided'} color="emerald" />
              <InfoCard icon={<MapPin className="w-4 h-4" />} label="Address" value={formatAddress(data.customer)} color="amber" />
              
              {/* --- CUSTOMER HISTORY (orders + returns) --- */}
              <div className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-slate-50" aria-label="Customer history">
                <CustomerStatTile
                  icon={<Package className="w-4 h-4 text-slate-500" aria-hidden="true" />}
                  label="Total Orders"
                  value={customerOrderCount === undefined ? undefined : customerOrderCount === null ? null : String(customerOrderCount)}
                />
                <CustomerStatTile
                  icon={<CreditCard className="w-4 h-4 text-slate-500" aria-hidden="true" />}
                  label="Total Spent"
                  value={customerTotalSpent === undefined ? undefined : customerTotalSpent === null ? null : formatINR(customerTotalSpent)}
                />
                <CustomerStatTile
                  icon={<RefreshCw className="w-4 h-4 text-slate-500" aria-hidden="true" />}
                  label="Total Returns"
                  value={customerReturnStats === undefined ? undefined : customerReturnStats === null ? null : String(customerReturnStats.count)}
                />
                <CustomerStatTile
                  icon={<Gift className="w-4 h-4 text-slate-500" aria-hidden="true" />}
                  label="Total Return Value"
                  value={customerReturnStats === undefined ? undefined : customerReturnStats === null ? null : formatINR(customerReturnStats.value)}
                />
                <CustomerStatTile
                  icon={<CreditCard className="w-4 h-4 text-slate-500" aria-hidden="true" />}
                  label="Total Balance"
                  value={totalBalance === null ? null : formatINR(totalBalance)}
                  unavailableHint={loadingBalances ? 'Loading…' : 'Balance unavailable'}
                />
              </div>
              {/* --- END NEW ORDER SUMMARY UI --- */}
              
              {isNotServiceable && (
                <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg">
                  <p className="text-xs text-amber-700 flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3" />
                    Pincode {data.customer?.zip} not serviceable
                  </p>
                </div>
              )}
              
              {customerBalances && customerBalances.customer_found && (
                <div className="mt-4 pt-4 border-t border-slate-200">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-6 h-6 bg-gradient-to-br from-emerald-100 to-green-100 rounded-lg flex items-center justify-center">
                      <Gift className="w-3.5 h-3.5 text-emerald-600" />
                    </div>
                    <h4 className="text-sm font-semibold text-slate-700">Customer Balances</h4>
                  </div>
                  
                  {customerBalances.store_credit_accounts && customerBalances.store_credit_accounts.length > 0 && (
                    <div className="mb-3 p-3 bg-gradient-to-r from-emerald-50 to-green-50 rounded-xl border border-emerald-100">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-emerald-700 uppercase tracking-wide">💰 Store Credit</span>
                        <span className="text-[10px] text-emerald-600 bg-white px-2 py-0.5 rounded-full">
                          {customerBalances.store_credit_accounts.length} account{customerBalances.store_credit_accounts.length > 1 ? 's' : ''}
                        </span>
                      </div>
                      {customerBalances.store_credit_accounts.map((account, i) => (
                        <div key={account?.id ?? i} className="flex justify-between items-center">
                          <span className="text-sm text-emerald-800 font-medium">
                            {formatINR(Number(account?.balance_amount) || 0)}
                          </span>
                          <span className="text-[10px] text-emerald-600 bg-white/70 px-2 py-0.5 rounded-md font-mono">
                            {account.balance_currency}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  
                  {customerBalances.gift_cards && customerBalances.gift_cards.length > 0 && (
                    <div className="p-3 bg-gradient-to-r from-purple-50 to-pink-50 rounded-xl border border-purple-100">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-purple-700 uppercase tracking-wide">🎁 Gift Cards</span>
                        <span className="text-[10px] text-purple-600 bg-white px-2 py-0.5 rounded-full">
                          {customerBalances.gift_cards.length} card{customerBalances.gift_cards.length > 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {customerBalances.gift_cards.map((card, i) => (
                          <div key={card?.id ?? i} className="bg-white/50 rounded-lg p-2">
                            <div className="flex justify-between items-center mb-1">
                              <span className="text-xs font-mono text-purple-700">
                                {card.code || '•••• •••• ••••'}
                              </span>
                              <span className="text-xs font-semibold text-purple-800">
                                {formatINR(Number(card?.balance_amount) || 0)}
                              </span>
                            </div>
                            <div className="text-[10px] text-purple-500">
                              {card.balance_currency}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {(!customerBalances.store_credit_accounts || customerBalances.store_credit_accounts.length === 0) &&
                  (!customerBalances.gift_cards || customerBalances.gift_cards.length === 0) && (
                    <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-center">
                      <p className="text-xs text-slate-500">No active gift cards or store credit available</p>
                    </div>
                  )}
                </div>
              )}
              
              {loadingBalances && (
                <div className="mt-4 pt-4 border-t border-slate-200">
                  <div className="flex items-center justify-center p-3">
                    <div className="w-5 h-5 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
                    <span className="ml-2 text-xs text-slate-500">Loading balances...</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-9 space-y-4 sm:space-y-6">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-slate-900">Items Comparison</h2>
              <span className="text-sm text-slate-500">
                {items.length} item{items.length === 1 ? '' : 's'}
                {isMixedOrder && (
                  <span className="ml-1">
                    ({items.filter(i => getItemActionType(i) === 'return').length} return, {items.filter(i => getItemActionType(i) === 'exchange').length} exchange)
                  </span>
                )}
              </span>
            </div>
            {items.map((item, index) => (
              <ItemComparisonCard 
                key={index} item={item} index={index} RAN={data.RAN} orderName={data.orderId}
                actionType={getItemActionType(item)}
                onRejectClick={(itemId, item) => { setItemToReject({ id: itemId, item }); setIsRejectModalOpen(true); }}
                onConvertActionType={(newType) => handleConvertItemActionType(item.lineItemId, newType)}
                convertDisabled={isTerminal || isRefundCompleted || convertingItemId === item.lineItemId}
                isConverting={convertingItemId === item.lineItemId}
              />
            ))}
          </div>

          <div className="bg-white rounded-xl p-4 sm:p-5 border border-slate-200 shadow-sm">
            <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-3">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <div className="w-8 h-8 bg-gradient-to-br from-amber-100 to-orange-100 rounded-lg flex items-center justify-center shrink-0"><Bell className="w-4 h-4 text-amber-600" /></div>
                Activity Timeline
              </h3>
              <div className="flex gap-1 bg-slate-100 p-1 rounded-lg overflow-x-auto max-w-full">
                {['all', 'notes', 'notifications'].map((tab) => (
                  <button key={tab} onClick={() => setActiveActivityTab(tab as any)} className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 whitespace-nowrap shrink-0 ${activeActivityTab === tab ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}>
                    {tab === 'notes' && <FileText className="w-3 h-3" />}{tab === 'notifications' && <Bell className="w-3 h-3" />}
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    {tab === 'notes' && <span className="ml-1 px-1.5 py-0.5 bg-white text-xs rounded-full">{activities.filter(a => a.type === 'note').length}</span>}
                  </button>
                ))}
              </div>
            </div>

            {filteredActivities.length > 0 ? (
              <div className="overflow-x-auto pb-4 -mx-4 px-4 sm:-mx-5 sm:px-5">
                <div className="flex gap-4 min-w-max">
                  {filteredActivities.map((activity, index) => (
                    <React.Fragment key={activity.id}>
                      <HorizontalActivityItem 
                        type={activity.type as any} 
                        title={activity.title} 
                        description={activity.description} 
                        time={formatDate(activity.timestamp).full} 
                        timestamp={formatDate(activity.timestamp).time} 
                        user={activity.user || (activity.type === 'note' ? 'System' : undefined)}
                      />
                      {index < filteredActivities.length - 1 && <div className="w-px bg-gradient-to-b from-transparent via-slate-300 to-transparent"></div>}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-3"><Bell className="w-6 h-6 text-slate-400" /></div>
                <p className="text-sm text-slate-500">No activities yet</p>
              </div>
            )}

            <div className="mt-6 pt-6 border-t border-slate-100">
              <div className="flex items-center gap-2 mb-3"><Plus className="w-4 h-4 text-slate-400" /><label className="text-sm font-medium text-slate-700">Add Note</label></div>
              <div className="flex flex-col sm:flex-row gap-3">
                <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Type your note here..." className="flex-1 border border-slate-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-indigo-200 outline-none resize-none h-20" rows={2} />
                <div className="flex flex-row sm:flex-col gap-2">
                  <button onClick={addNote} disabled={addingNote || !noteText.trim()} className="flex-1 sm:flex-none px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 whitespace-nowrap">{addingNote ? 'Adding...' : 'Save Note'}</button>
                  <button onClick={() => setNoteText('')} className="flex-1 sm:flex-none px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded-lg whitespace-nowrap">Cancel</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <CreatePickupModal
        isOpen={activeAction === 'pickup'}
        onClose={() => setActiveAction(null)}
        returnId={data.id}
        orderId={data.orderId}
        orderNumericId={data.orderNumericId}
        RAN={data.RAN}
        customer={(data.customer ?? {}) as any}
        items={items}
        rejectedItems={data.rejectedItems}
        currentUser={currentUser}
        onSuccess={refreshReturn}
      />

      <SelfShipModal
        isOpen={activeAction === 'self'}
        onClose={() => setActiveAction(null)}
        returnId={data.id}
        orderId={data?.orderId || ''}
        orderNumericId={data?.orderNumericId}
        RAN={data?.RAN || ''}
        customerEmail={data?.customer?.email}
        customerName={data?.customer?.name}
        requestedMethod={data?.requestedMethod as 'gift_card' | 'store_credit' | 'refund' | undefined}
        currentUser={currentUser}
        onSuccess={refreshReturn}
      />

      <RejectRequestModal
        isOpen={isRejectModalOpen}
        onClose={() => {
          setIsRejectModalOpen(false);
          setItemToReject(undefined);
        }}
        onConfirm={handleRejectConfirm}
        orderId={data?.orderId}
        RAN={data?.RAN}
        customerName={data?.customer?.name}
        customerEmail={data?.customer?.email}
        currentUser={currentUser}
        itemIdToReject={itemToReject?.id}
        itemToReject={itemToReject?.item}
      />

      <ExchangeModal
        isOpen={isExchangeModalOpen}
        onClose={() => setIsExchangeModalOpen(false)}
        returnId={data.id}
        orderId={data.orderId}
        data={data}
        currentUser={currentUser}
        onSuccess={refreshReturn}
        shopifyOrder={shopifyOrderData}
      />

      <MarkReceivedModal
        isOpen={isMarkReceivedModalOpen}
        onClose={() => setIsMarkReceivedModalOpen(false)}
        onConfirm={handleMarkReceivedConfirm}
        returnId={data.id}
        currentUser={currentUser}
        items={getActiveItems(items, data?.rejectedItems)}
        RAN={data?.RAN}
        orderId={data?.orderId}
        customerName={data?.customer?.name}
        customerEmail={data?.customer?.email}
        requestedMethod={data?.requestedMethod}
      />

      <IssueRefundModal
        isOpen={isIssueRefundModalOpen}
        onClose={() => setIsIssueRefundModalOpen(false)}
        returnId={data.id}
        orderId={data.orderId}
        data={data}
        shopifyOrder={shopifyOrderData}
        currentUser={currentUser}
        onSuccess={refreshReturn}
      />

      <CancelPickupModal
        isOpen={isCancelPickupModalOpen}
        onClose={() => setIsCancelPickupModalOpen(false)}
        returnId={data.id}
        orderId={data.orderId}
        orderNumericId={data.orderNumericId}
        RAN={data.RAN}
        currentAWB={data.awb}
        customerEmail={data.customer?.email}
        currentUser={currentUser}
        shipmentStatus={data.shipmentStatus}
        onSuccess={refreshReturn}
      />

      <BaseModal
        isOpen={!!labelPreview}
        onClose={() => setLabelPreview(null)}
        title="Shipping label"
        subtitle={data.awb ? `AWB ${data.awb}` : undefined}
        maxWidth="max-w-5xl"
        closeOnBackdrop
        footer={labelPreview ? (
          <a
            href={labelPreview}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full sm:w-auto min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-slate-900 hover:bg-black text-white text-sm font-medium"
          >
            <Download className="w-4 h-4" aria-hidden="true" /> Open / download label
          </a>
        ) : undefined}
      >
        {labelPreview && (
          <iframe
            src={labelPreview}
            title="Shipping label"
            className="w-full h-[65dvh] rounded-lg border border-slate-200 bg-white"
          />
        )}
      </BaseModal>
    </div>
  );
};
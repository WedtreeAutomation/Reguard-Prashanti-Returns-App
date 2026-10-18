import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  Search,
  ChevronDown,
  Package,
  CreditCard,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  Loader2,
  Filter,
  X
} from 'lucide-react';
import {
  collection, onSnapshot, query, orderBy, limit, doc, updateDoc, where, getDocs, serverTimestamp,
  QueryConstraint, QueryDocumentSnapshot, DocumentData,
} from 'firebase/firestore';
import { db } from '../../Interfaces/firebase';
import { checkPincodeServiceability, fetchBlueDartTracking, fetchReturnTabCounts, type ReturnTabCounts } from '../../Interfaces/api';
import { getApiErrorMessage } from '../../Interfaces/http';
import { extractShipment, mapBlueDartStatus } from '../Agent/tracking';

interface ReturnRequest {
  id: string;
  RAN: string;
  orderId: string;
  orderNumericId?: number;
  awb?: string;
  type: string;
  status: 'Open' | 'Approved' | 'Denied' | 'Closed' | 'Completed' | 'Pending';
  shipmentStatus?: 'Not Created' | 'Pickup Created' | 'Pickup Scheduled' | 'In Transit' | 'Product Reached' | 'Pickup Exception' | 'Received' | 'Pickup Cancelled' | 'Failed';
  courierStatus?: string;
  refundStatus?: 'Pending' | 'Processing' | 'Refunded' | 'Failed' | 'Not Eligible' | 'Skipped';
  /** Optional: legacy/odd docs may lack it — always read with `?.` / `?? []`. */
  items?: {
    title: string;
    productImage: string;
    reason: string;
    quantityReturned: number;
    price?: string;
  }[];
  customer?: {
    zip?: string;
    [key: string]: any;
  };
  requestedMethod?: 'refund' | 'gift_card' | 'store_credit' | 'manual';
  createdAt: any;
  completedAt?: any;
  refundedAt?: any;
  itemCondition?: 'Fresh' | 'Seconds' | 'Defect / Damaged Item';
  isRestocked?: boolean;
  actionType?: 'return' | 'exchange';
}

type TabId = 'all' | 'open' | 'active' | 'product_received' | 'received' | 'completed' | 'rejected' | 'failed';

/** Newest N docs are live; "Load more" grows the live window by this much. */
const PAGE_SIZE = 100;

const withLower = (values: string[]) => Array.from(new Set(values.flatMap((v) => [v, v.toLowerCase()])));

/**
 * Server-side pre-filter per tab (Firestore `in`). The client still applies the
 * exact tab rule on top. Tabs that need an OR across fields (failed) or extra
 * conditions are filtered client-side only.
 * Needs composite indexes (status|shipmentStatus + createdAt desc); if one is
 * missing the page falls back to client-side filtering automatically.
 */
const TAB_SERVER_FILTER: Partial<Record<TabId, { field: string; values: string[] }>> = {
  open: { field: 'status', values: withLower(['Open', 'Pending', 'Approved']) },
  active: { field: 'shipmentStatus', values: withLower(['Pickup Created', 'Pickup Scheduled', 'In Transit', 'Pickup Exception', 'Self Ship Requested']) },
  product_received: { field: 'shipmentStatus', values: withLower(['Product Reached']) },
  received: { field: 'shipmentStatus', values: withLower(['Received']) },
  completed: { field: 'status', values: withLower(['Completed', 'Exchanged_Created']).concat(['Exchanged_created']) },
  rejected: { field: 'status', values: withLower(['Denied', 'Closed', 'Rejected']) },
};

const TRACKABLE_STATUSES = ['Pickup Created', 'Pickup Scheduled', 'In Transit', 'Pickup Exception'];

/** createdAt window for the date filter (null = no limit). Local calendar days. */
const dateRangeFor = (dateFilter: string, customStart: string, customEnd: string): { start: Date | null; end: Date | null } | null => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = (n: number) => new Date(startOfToday.getTime() - n * 86400000);
  switch (dateFilter) {
    case 'today': return { start: startOfToday, end: null };
    case 'yesterday': return { start: daysAgo(1), end: startOfToday };
    case '7days': return { start: new Date(now.getTime() - 7 * 86400000), end: null };
    case '30days': return { start: new Date(now.getTime() - 30 * 86400000), end: null };
    case '90days': return { start: new Date(now.getTime() - 90 * 86400000), end: null };
    case 'custom': {
      const start = customStart ? new Date(`${customStart}T00:00:00`) : null;
      const end = customEnd ? new Date(new Date(`${customEnd}T00:00:00`).getTime() + 86400000) : null;
      if (!start && !end) return null;
      return { start, end };
    }
    default: return null;
  }
};

/** Run async jobs with limited parallelism. */
const runPool = async <T,>(items: T[], size: number, job: (item: T) => Promise<void>) => {
  let index = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await job(current);
    }
  });
  await Promise.all(workers);
};

const toRequest = (d: QueryDocumentSnapshot<DocumentData>) => ({ ...d.data(), id: d.id } as ReturnRequest);

export const Returns = () => {
  const navigate = useNavigate();

  const [liveDocs, setLiveDocs] = useState<ReturnRequest[]>([]);
  const [searchDocs, setSearchDocs] = useState<ReturnRequest[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [serviceablePincodes, setServiceablePincodes] = useState<Record<string, boolean>>({});
  const [checkingPincodes, setCheckingPincodes] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(25);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const [activeTab, setActiveTab] = useState<TabId>('open');
  const [searchTerm, setSearchTerm] = useState('');
  const [dateFilter, setDateFilter] = useState<string>('all');
  const [shipmentFilter, setShipmentFilter] = useState<string>('all');
  const [refundFilter, setRefundFilter] = useState<string>('all');
  const [refundTypeFilter, setRefundTypeFilter] = useState<string>('all');
  const [actionTypeFilter, setActionTypeFilter] = useState<string>('all');
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
  const [sortField, setSortField] = useState<'createdAt' | 'RAN' | 'status'>('createdAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  // Cache for pincode results to prevent re-fetching (only real answers are cached)
  const pincodeCache = useRef<Record<string, boolean>>({});
  const pincodeFailed = useRef<Set<string>>(new Set());

  // ── Paged, live, server-filtered loading ───────────────────────────────────
  const range = useMemo(() => dateRangeFor(dateFilter, customStartDate, customEndDate), [dateFilter, customStartDate, customEndDate]);
  const queryKey = `${activeTab}|${range?.start?.getTime() ?? ''}|${range?.end?.getTime() ?? ''}`;
  // Window size + fallback mode are tied to the filter they were set for, so a
  // tab/date change starts again at PAGE_SIZE with full server filtering.
  const [windowState, setWindowState] = useState<{ key: string; size: number }>({ key: queryKey, size: PAGE_SIZE });
  const [fallbackState, setFallbackState] = useState<{ key: string; mode: 'full' | 'dateOnly' | 'none' }>({ key: queryKey, mode: 'full' });
  const windowSize = windowState.key === queryKey ? windowState.size : PAGE_SIZE;
  const queryMode = fallbackState.key === queryKey ? fallbackState.mode : 'full';

  useEffect(() => {
    setLoading(true);
    setLoadError('');
    const constraints: QueryConstraint[] = [];
    const tabFilter = TAB_SERVER_FILTER[activeTab];
    if (queryMode === 'full' && tabFilter) constraints.push(where(tabFilter.field, 'in', tabFilter.values));
    if (queryMode !== 'none' && range) {
      if (range.start) constraints.push(where('createdAt', '>=', range.start));
      if (range.end) constraints.push(where('createdAt', '<', range.end));
    }
    const q = query(collection(db, 'returns'), ...constraints, orderBy('createdAt', 'desc'), limit(windowSize));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      setLiveDocs(snapshot.docs.map(toRequest));
      setHasMore(snapshot.size >= windowSize);
      setLoading(false);
    }, (error) => {
      // Typically a missing composite index → degrade to client-side filtering.
      if (queryMode === 'full' && (tabFilter || range)) {
        setFallbackState({ key: queryKey, mode: tabFilter && range ? 'dateOnly' : 'none' });
        return;
      }
      if (queryMode === 'dateOnly') {
        setFallbackState({ key: queryKey, mode: 'none' });
        return;
      }
      setLoadError(`Could not load returns: ${getApiErrorMessage(error)}`);
      setLoading(false);
    });

    return () => unsubscribe();
    // queryKey captures activeTab + range
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, windowSize, queryMode]);

  const loadMore = () => setWindowState({ key: queryKey, size: windowSize + PAGE_SIZE });

  // ── Counts for every tab (one cheap server call; refreshed when the list changes) ──
  const [tabCounts, setTabCounts] = useState<{ key: string; counts: ReturnTabCounts; capped: boolean } | null>(null);
  const countsKey = `${range?.start?.getTime() ?? ''}|${range?.end?.getTime() ?? ''}`;
  const countsSeq = useRef(0);
  useEffect(() => {
    const seq = ++countsSeq.current;
    // Small delay: live snapshot updates arrive in bursts.
    const handle = window.setTimeout(async () => {
      try {
        const res = await fetchReturnTabCounts(range?.start ?? null, range?.end ?? null);
        if (seq === countsSeq.current) setTabCounts({ key: countsKey, ...res });
      } catch {
        /* keep the previous counts; the active tab still shows its own count */
      }
    }, 600);
    return () => window.clearTimeout(handle);
    // liveDocs: refetch when the live list changes (status updates, new requests)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countsKey, liveDocs]);

  // Exact lookups so old returns can be found by RAN / order / AWB even when
  // they are outside the loaded window.
  useEffect(() => {
    const term = searchTerm.trim();
    if (term.length < 3) {
      setSearchDocs([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      const upper = term.toUpperCase();
      const orderName = upper.replace(/^#/, '');
      const lookups = [
        query(collection(db, 'returns'), where('RAN', '==', upper), limit(10)),
        query(collection(db, 'returns'), where('orderId', '==', orderName), limit(10)),
        query(collection(db, 'returns'), where('orderId', '==', `#${orderName}`), limit(10)),
        query(collection(db, 'returns'), where('awb', '==', term), limit(10)),
      ];
      const results = await Promise.allSettled(lookups.map((lq) => getDocs(lq)));
      if (cancelled) return;
      const found = new Map<string, ReturnRequest>();
      results.forEach((r) => {
        if (r.status === 'fulfilled') r.value.docs.forEach((d) => found.set(d.id, toRequest(d)));
      });
      setSearchDocs(Array.from(found.values()));
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [searchTerm]);

  const returns = useMemo(() => {
    if (searchDocs.length === 0) return liveDocs;
    const byId = new Map(liveDocs.map((r) => [r.id, r]));
    searchDocs.forEach((r) => { if (!byId.has(r.id)) byId.set(r.id, r); });
    return Array.from(byId.values());
  }, [liveDocs, searchDocs]);

  const handleSyncTracking = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      // All active shipments (not just the loaded page).
      let candidates: ReturnRequest[];
      try {
        const snap = await getDocs(query(collection(db, 'returns'), where('shipmentStatus', 'in', withLower(TRACKABLE_STATUSES)), limit(500)));
        candidates = snap.docs.map(toRequest);
      } catch {
        candidates = liveDocs.filter((r) => TRACKABLE_STATUSES.map((s) => s.toLowerCase()).includes((r.shipmentStatus || '').toLowerCase()));
      }
      const activeReturns = candidates.filter((r) => !!r.awb);

      if (activeReturns.length === 0) {
        toast.info('No active shipments to sync.');
        return;
      }

      let updated = 0;
      let unchanged = 0;
      let failed = 0;
      await runPool(activeReturns, 5, async (ret) => {
        try {
          const shipment = extractShipment(await fetchBlueDartTracking(String(ret.awb)));
          if (!shipment) { failed += 1; return; }
          const statusDescription = String(shipment.Status || '').toUpperCase();
          const mapped = mapBlueDartStatus(shipment.StatusType, statusDescription);
          const newShipmentStatus = mapped ?? ret.shipmentStatus;
          if (newShipmentStatus !== ret.shipmentStatus || statusDescription !== (ret.courierStatus || '')) {
            await updateDoc(doc(db, 'returns', ret.id), {
              ...(newShipmentStatus ? { shipmentStatus: newShipmentStatus } : {}),
              courierStatus: statusDescription,
              courierStatusType: String(shipment.StatusType || ''),
              trackingSyncedAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            updated += 1;
          } else {
            unchanged += 1;
          }
        } catch {
          failed += 1;
        }
      });

      const summary = `Tracking sync: ${updated} updated, ${unchanged} unchanged${failed ? `, ${failed} failed` : ''} (of ${activeReturns.length}).`;
      if (failed === activeReturns.length) toast.error(`Tracking sync failed for all ${failed} shipment(s). Please try again later.`);
      else if (failed > 0) toast.warning(summary);
      else toast.success(summary);
    } catch (error) {
      toast.error(`Failed to sync tracking: ${getApiErrorMessage(error)}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleForceProductReached = useCallback(async (e: React.MouseEvent, returnId: string, ran: string) => {
    e.stopPropagation();
    if (!window.confirm(`Mark RAN ${ran} as "Product Reached"?`)) return;
    try {
      await updateDoc(doc(db, 'returns', returnId), {
        shipmentStatus: 'Product Reached',
        updatedAt: serverTimestamp()
      });
      toast.success(`RAN ${ran} marked as "Product Reached"`);
    } catch (error) {
      toast.error(`Failed to mark as product reached: ${getApiErrorMessage(error)}`);
    }
  }, []);

  const statusHelpers = useMemo(() => ({
    isStatusOpen: (r: ReturnRequest) => {
      const s = r.status?.toLowerCase();
      const shipStatus = r.shipmentStatus?.toLowerCase();
      const hasOpenStatus = s === 'open' || s === 'pending' || s === 'approved';
      const shipmentNotStarted = !shipStatus || shipStatus === 'not created' || shipStatus === 'pickup cancelled';
      return hasOpenStatus && shipmentNotStarted;
    },
    isShipmentActive: (r: ReturnRequest) => {
      const shipStatus = r.shipmentStatus?.toLowerCase();
      return shipStatus === 'pickup created' || 
             shipStatus === 'pickup scheduled' || 
             shipStatus === 'in transit' ||
             shipStatus === 'pickup exception' ||
             shipStatus === 'self ship requested';
    },
    isProductReached: (r: ReturnRequest) => {
      const shipStatus = r.shipmentStatus?.toLowerCase();
      const mainStatus = r.status?.toLowerCase();
      return shipStatus === 'product reached' && 
             mainStatus !== 'completed' &&
             mainStatus !== 'exchanged_created' &&
             mainStatus !== 'closed' &&
             mainStatus !== 'denied';
    },
    isReceived: (r: ReturnRequest) => {
      const mainStatus = r.status?.toLowerCase();
      return r.shipmentStatus?.toLowerCase() === 'received' && 
             mainStatus !== 'completed' &&
             mainStatus !== 'exchanged_created' &&
             mainStatus !== 'closed' &&
             mainStatus !== 'denied';
    },
    isCompleted: (r: ReturnRequest) => {
      const mainStatus = r.status?.toLowerCase();
      return mainStatus === 'completed' || 
             mainStatus === 'exchanged_created' || 
             (r.shipmentStatus?.toLowerCase() === 'received' && 
              r.refundStatus?.toLowerCase() === 'refunded');
    },
    isRejected: (r: ReturnRequest) => {
      const mainStatus = r.status?.toLowerCase();
      return mainStatus === 'denied' || mainStatus === 'closed';
    },
    isFailed: (r: ReturnRequest) => {
      const shipStatus = r.shipmentStatus?.toLowerCase();
      const refundStatus = r.refundStatus?.toLowerCase();
      return shipStatus === 'failed' || 
             shipStatus === 'cancelled' || 
             refundStatus === 'failed';
    }
  }), []);

  // Efficient Filtering
  const filteredData = useMemo(() => {
    const searchLower = searchTerm ? searchTerm.toLowerCase() : '';
    const shipFilterLower = shipmentFilter !== 'all' ? shipmentFilter.toLowerCase() : '';
    const refundFilterLower = refundFilter !== 'all' ? refundFilter.toLowerCase() : '';
    const refundTypeFilterLower = refundTypeFilter !== 'all' ? refundTypeFilter.toLowerCase() : '';
    const actionTypeFilterLower = actionTypeFilter !== 'all' ? actionTypeFilter.toLowerCase() : '';

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);

    let cutoffDate: Date | null = null;
    if (dateFilter === '7days') {
      cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 7);
    } else if (dateFilter === '30days') {
      cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 30);
    } else if (dateFilter === '90days') {
      cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 90);
    }

    let customStart: Date | null = null;
    let customEnd: Date | null = null;
    if (dateFilter === 'custom') {
      if (customStartDate) {
        customStart = new Date(customStartDate);
        customStart.setHours(0, 0, 0, 0);
      }
      if (customEndDate) {
        customEnd = new Date(customEndDate);
        customEnd.setHours(23, 59, 59, 999);
      }
    }

    const filtered = returns.filter(r => {
      // Tab Filter
      if (activeTab === 'open' && !statusHelpers.isStatusOpen(r)) return false;
      if (activeTab === 'active' && !statusHelpers.isShipmentActive(r)) return false;
      if (activeTab === 'product_received' && !statusHelpers.isProductReached(r)) return false;
      if (activeTab === 'received' && !statusHelpers.isReceived(r)) return false;
      if (activeTab === 'completed' && !statusHelpers.isCompleted(r)) return false;
      if (activeTab === 'rejected' && !statusHelpers.isRejected(r)) return false;
      if (activeTab === 'failed' && !statusHelpers.isFailed(r)) return false;

      // Search
      if (searchLower) {
        const matchRAN = r.RAN?.toLowerCase().includes(searchLower);
        const matchOrder = r.orderId?.toLowerCase().includes(searchLower);
        const matchAWB = r.awb?.toLowerCase().includes(searchLower);
        if (!matchRAN && !matchOrder && !matchAWB) return false;
      }

      // Shipment Status
      if (shipFilterLower && r.shipmentStatus?.toLowerCase() !== shipFilterLower) return false;

      // Refund Status
      if (refundFilterLower && r.refundStatus?.toLowerCase() !== refundFilterLower) return false;

      // Refund Type
      if (refundTypeFilterLower) {
        const method = r.requestedMethod?.toLowerCase() || 'refund';
        if (refundTypeFilterLower === 'original_payment' && method !== 'refund') return false;
        if (refundTypeFilterLower !== 'original_payment' && method !== refundTypeFilterLower) return false;
      }

      // Action Type
      if (actionTypeFilterLower) {
        const actionType = r.actionType?.toLowerCase() || (r.type?.toLowerCase().includes('exchange') ? 'exchange' : 'return');
        if (actionType !== actionTypeFilterLower) return false;
      }

      // Date Range
      if (dateFilter !== 'all') {
        if (!r.createdAt) return false;
        const itemDate = r.createdAt.toDate ? r.createdAt.toDate() : new Date(r.createdAt);

        if (dateFilter === 'today') {
          if (itemDate < startOfToday) return false;
        } else if (dateFilter === 'yesterday') {
          if (itemDate < startOfYesterday || itemDate >= startOfToday) return false;
        } else if (cutoffDate) {
          if (itemDate < cutoffDate) return false;
        } else if (dateFilter === 'custom') {
          if (customStart && itemDate < customStart) return false;
          if (customEnd && itemDate > customEnd) return false;
        }
      }
      return true;
    });

    // Sort
    return filtered.sort((a, b) => {
      let aVal: any, bVal: any;
      if (sortField === 'createdAt') {
        aVal = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
        bVal = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
      } else if (sortField === 'RAN') {
        aVal = a.RAN || '';
        bVal = b.RAN || '';
      } else {
        aVal = a.status || '';
        bVal = b.status || '';
      }
      
      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [returns, activeTab, searchTerm, dateFilter, shipmentFilter, refundFilter, refundTypeFilter, actionTypeFilter, customStartDate, customEndDate, sortField, sortDirection, statusHelpers]);

  // Pagination
  const totalPages = Math.ceil(filteredData.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const currentItems = filteredData.slice(startIndex, startIndex + itemsPerPage);

  // Pagination handlers
  const goToPage = useCallback((page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  }, [totalPages]);

  const goToPreviousPage = useCallback(() => {
    goToPage(currentPage - 1);
  }, [currentPage, goToPage]);

  const goToNextPage = useCallback(() => {
    goToPage(currentPage + 1);
  }, [currentPage, goToPage]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, searchTerm, dateFilter, shipmentFilter, refundFilter, refundTypeFilter, actionTypeFilter, sortField, sortDirection]);

  // Optimized pincode checking with caching and batching
  useEffect(() => {
    const checkPincodes = async () => {
      // Get unique pincodes from current items that have zip and not in cache
      const pincodesToCheck = Array.from(new Set(
        currentItems
          .filter(item => item.customer?.zip)
          .map(item => String(item.customer!.zip).trim())
          .filter(zip => {
            // Check if already in cache or currently being checked
            if (pincodeCache.current[zip] !== undefined) return false;
            if (pincodeFailed.current.has(zip)) return false;
            if (checkingPincodes.has(zip)) return false;
            return true;
          })
      ));

      if (pincodesToCheck.length === 0) return;

      // Mark as checking
      setCheckingPincodes(prev => new Set([...prev, ...pincodesToCheck]));

      try {
        const results = await checkPincodeServiceability(pincodesToCheck);
        Object.entries(results).forEach(([zip, isServiceable]) => {
          pincodeCache.current[zip] = isServiceable === true;
        });
        setServiceablePincodes(prev => ({ ...prev, ...results }));
      } catch {
        // Unknown ≠ not serviceable: don't flag rows, just don't retry this session.
        pincodesToCheck.forEach(zip => pincodeFailed.current.add(zip));
      } finally {
        // Remove from checking set
        setCheckingPincodes(prev => {
          const newSet = new Set(prev);
          pincodesToCheck.forEach(zip => newSet.delete(zip));
          return newSet;
        });
      }
    };

    checkPincodes();
  }, [currentItems]);

  // Every tab shows its server-side count (date filter applied). If counts are
  // unavailable, the active tab falls back to the loaded list ("+" = more on the server).
  const activeCountLabel = loading ? '…' : `${filteredData.length}${hasMore ? '+' : ''}`;
  const serverCounts = tabCounts && tabCounts.key === countsKey ? tabCounts : null;
  const narrowingFilters = searchTerm !== '' || shipmentFilter !== 'all' || refundFilter !== 'all' || refundTypeFilter !== 'all' || actionTypeFilter !== 'all';
  const tabCount = (tab: TabId): string | undefined => {
    // With extra filters on, the open tab shows what's actually listed.
    if (narrowingFilters && activeTab === tab) return activeCountLabel;
    if (serverCounts) return `${serverCounts.counts[tab] ?? 0}${serverCounts.capped ? '+' : ''}`;
    return activeTab === tab ? activeCountLabel : undefined;
  };

  const hasActiveFilters = searchTerm !== '' || dateFilter !== 'all' || shipmentFilter !== 'all' || refundFilter !== 'all' || refundTypeFilter !== 'all' || actionTypeFilter !== 'all';

  const handleClearAll = () => {
    setSearchTerm('');
    setDateFilter('all');
    setShipmentFilter('all');
    setRefundFilter('all');
    setRefundTypeFilter('all');
    setActionTypeFilter('all');
    setCustomStartDate('');
    setCustomEndDate('');
    setMobileFiltersOpen(false);
  };

  const formatRefundType = (method?: string) => {
    switch (method) {
      case 'store_credit': return 'Store Credit';
      case 'gift_card': return 'Gift Card';
      case 'manual': return 'Manual Refund';
      case 'refund':
      default: return 'Original Payment';
    }
  };

  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const SortableHeader = ({ field, label }: { field: typeof sortField; label: string }) => (
    <th 
      className="p-3 cursor-pointer hover:bg-slate-100 transition-colors select-none"
      onClick={() => toggleSort(field)}
    >
      <div className="flex items-center gap-1">
        <span>{label}</span>
        <ArrowUpDown className={`w-3 h-3 ${sortField === field ? 'text-indigo-600' : 'text-slate-400'}`} />
      </div>
    </th>
  );

  // Visibility for filters
  const showShipmentFilter = ['all', 'failed', 'active'].includes(activeTab);
  const showRefundFilters = ['all', 'received', 'completed', 'failed', 'product_received'].includes(activeTab);

  // Check if a pincode is being checked
  const isCheckingPincode = useCallback((zip: string) => {
    return checkingPincodes.has(zip);
  }, [checkingPincodes]);

  // Mobile responsive filter component
  const MobileFilters = () => (
    <div className="lg:hidden fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" onClick={() => setMobileFiltersOpen(false)}>
      <div className="absolute right-0 top-0 h-full w-full max-w-sm bg-white shadow-xl overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-200 p-4 flex justify-between items-center">
          <h3 className="font-semibold text-slate-900">Filters</h3>
          <button onClick={() => setMobileFiltersOpen(false)} className="p-2 hover:bg-slate-100 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          {/* Search */}
          <div>
            <label className="text-sm font-medium text-slate-700 block mb-1">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input 
                type="text" 
                placeholder="Search RAN, Order, AWB..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
              />
            </div>
          </div>

          {/* Date Filter */}
          <div>
            <label className="text-sm font-medium text-slate-700 block mb-1">Date Range</label>
            <select 
              value={dateFilter}
              onChange={(e) => {
                setDateFilter(e.target.value);
                if (e.target.value !== 'custom') {
                  setCustomStartDate('');
                  setCustomEndDate('');
                }
              }}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
            >
              <option value="all">All Dates</option>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="7days">Last 7 days</option>
              <option value="30days">Last 30 days</option>
              <option value="90days">Last 90 days</option>
              <option value="custom">Custom Range</option>
            </select>
          </div>

          {dateFilter === 'custom' && (
            <div className="space-y-2">
              <input 
                type="date" 
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
                placeholder="Start Date"
              />
              <input 
                type="date" 
                value={customEndDate}
                min={customStartDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
                placeholder="End Date"
              />
            </div>
          )}

          {showShipmentFilter && (
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">Shipment Status</label>
              <select 
                value={shipmentFilter}
                onChange={(e) => setShipmentFilter(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
              >
                <option value="all">All Shipments</option>
                <option value="pickup created">Pickup Created</option>
                <option value="pickup scheduled">Pickup Scheduled</option>
                <option value="pickup exception">Pickup Exception</option>
                <option value="in transit">In Transit</option>
                <option value="product reached">Product Reached</option>
                <option value="received">Received</option>
                <option value="pickup cancelled">Cancelled</option>
                <option value="failed">Failed</option>
                <option value="self ship requested">Self Ship</option>
              </select>
            </div>
          )}

          {showRefundFilters && (
            <>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Refund Status</label>
                <select 
                  value={refundFilter}
                  onChange={(e) => setRefundFilter(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
                >
                  <option value="all">All Status</option>
                  <option value="pending">Pending</option>
                  <option value="processing">Processing</option>
                  <option value="refunded">Refunded</option>
                  <option value="failed">Failed</option>
                  <option value="not eligible">Not Eligible</option>
                </select>
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Refund Type</label>
                <select 
                  value={refundTypeFilter}
                  onChange={(e) => setRefundTypeFilter(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
                >
                  <option value="all">All Types</option>
                  <option value="store_credit">Store Credit</option>
                  <option value="gift_card">Gift Card</option>
                  <option value="original_payment">Original Payment</option>
                  <option value="manual">Manual Refund</option>
                </select>
              </div>
            </>
          )}

          <div>
            <label className="text-sm font-medium text-slate-700 block mb-1">Action Type</label>
            <select 
              value={actionTypeFilter}
              onChange={(e) => setActionTypeFilter(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
            >
              <option value="all">All Types</option>
              <option value="return">Return</option>
              <option value="exchange">Exchange</option>
            </select>
          </div>

          <div className="flex gap-2 pt-2">
            <button 
              onClick={handleClearAll} 
              className="flex-1 px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50"
            >
              Clear All
            </button>
            <button 
              onClick={() => setMobileFiltersOpen(false)} 
              className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"
            >
              Apply Filters
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-6 space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:justify-between md:items-start gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-slate-900">Returns & Exchanges</h1>
          <p className="text-slate-500 text-sm mt-1">Track and manage all return requests</p>
        </div>
        <button 
          onClick={handleSyncTracking}
          disabled={syncing}
          className="flex items-center justify-center gap-2 px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors disabled:opacity-50 shadow-sm w-full md:w-auto"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin text-indigo-600' : 'text-slate-500'}`} />
          {syncing ? 'Syncing...' : 'Sync Tracking'}
        </button>
      </div>

      {/* Main Card */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        
        {/* Tabs - Horizontal scroll on mobile */}
        <div className="flex border-b border-slate-200 overflow-x-auto custom-scrollbar">
          <TabButton label="All" count={tabCount('all')} active={activeTab === 'all'} onClick={() => setActiveTab('all')} />
          <TabButton label="Open" count={tabCount('open')} active={activeTab === 'open'} onClick={() => setActiveTab('open')} />
          <TabButton label="Active" count={tabCount('active')} active={activeTab === 'active'} onClick={() => setActiveTab('active')} />
          <TabButton label="Reached" count={tabCount('product_received')} active={activeTab === 'product_received'} onClick={() => setActiveTab('product_received')} />
          <TabButton label="Received" count={tabCount('received')} active={activeTab === 'received'} onClick={() => setActiveTab('received')} />
          <TabButton label="Completed" count={tabCount('completed')} active={activeTab === 'completed'} onClick={() => setActiveTab('completed')} />
          <TabButton label="Rejected" count={tabCount('rejected')} active={activeTab === 'rejected'} onClick={() => setActiveTab('rejected')} />
          <TabButton label="Failed" count={tabCount('failed')} active={activeTab === 'failed'} onClick={() => setActiveTab('failed')} />
        </div>

        {/* Compact Filter Toolbar - Desktop */}
        <div className="hidden lg:flex p-3 flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/50">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Search RAN, Order, AWB..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 bg-white border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
            />
          </div>
          
          {/* Date Filter */}
          <div className="relative">
            <select 
              value={dateFilter}
              onChange={(e) => {
                setDateFilter(e.target.value);
                if (e.target.value !== 'custom') {
                  setCustomStartDate('');
                  setCustomEndDate('');
                }
              }}
              className="appearance-none pr-7 pl-3 py-1.5 border border-slate-300 bg-white text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 focus:outline-none focus:border-indigo-400 cursor-pointer min-w-[110px]"
            >
              <option value="all">All Dates</option>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="7days">Last 7 days</option>
              <option value="30days">Last 30 days</option>
              <option value="90days">Last 90 days</option>
              <option value="custom">Custom Range</option>
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
          </div>

          {dateFilter === 'custom' && (
            <div className="flex items-center gap-2">
              <input 
                type="date" 
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="py-1.5 px-2.5 border border-slate-300 bg-white text-slate-600 rounded-lg text-sm focus:outline-none focus:border-indigo-400"
              />
              <span className="text-slate-400 text-sm">to</span>
              <input 
                type="date" 
                value={customEndDate}
                min={customStartDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="py-1.5 px-2.5 border border-slate-300 bg-white text-slate-600 rounded-lg text-sm focus:outline-none focus:border-indigo-400"
              />
            </div>
          )}

          {showShipmentFilter && (
            <div className="relative">
              <select 
                value={shipmentFilter}
                onChange={(e) => setShipmentFilter(e.target.value)}
                className="appearance-none pr-7 pl-3 py-1.5 border border-slate-300 bg-white text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 focus:outline-none focus:border-indigo-400 cursor-pointer min-w-[120px]"
              >
                <option value="all">All Shipments</option>
                <option value="pickup created">Pickup Created</option>
                <option value="pickup scheduled">Pickup Scheduled</option>
                <option value="pickup exception">Pickup Exception</option>
                <option value="in transit">In Transit</option>
                <option value="product reached">Product Reached</option>
                <option value="received">Received</option>
                <option value="pickup cancelled">Cancelled</option>
                <option value="failed">Failed</option>
                <option value="self ship requested">Self Ship</option>
              </select>
              <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            </div>
          )}

          {showRefundFilters && (
            <>
              <div className="relative">
                <select 
                  value={refundFilter}
                  onChange={(e) => setRefundFilter(e.target.value)}
                  className="appearance-none pr-7 pl-3 py-1.5 border border-slate-300 bg-white text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 focus:outline-none focus:border-indigo-400 cursor-pointer min-w-[120px]"
                >
                  <option value="all">Refund Status</option>
                  <option value="pending">Pending</option>
                  <option value="processing">Processing</option>
                  <option value="refunded">Refunded</option>
                  <option value="failed">Failed</option>
                  <option value="not eligible">Not Eligible</option>
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
              </div>

              <div className="relative">
                <select 
                  value={refundTypeFilter}
                  onChange={(e) => setRefundTypeFilter(e.target.value)}
                  className="appearance-none pr-7 pl-3 py-1.5 border border-slate-300 bg-white text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 focus:outline-none focus:border-indigo-400 cursor-pointer min-w-[120px]"
                >
                  <option value="all">Refund Type</option>
                  <option value="store_credit">Store Credit</option>
                  <option value="gift_card">Gift Card</option>
                  <option value="original_payment">Original Payment</option>
                  <option value="manual">Manual Refund</option>
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
              </div>
            </>
          )}

          <div className="relative">
            <select 
              value={actionTypeFilter}
              onChange={(e) => setActionTypeFilter(e.target.value)}
              className="appearance-none pr-7 pl-3 py-1.5 border border-slate-300 bg-white text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 focus:outline-none focus:border-indigo-400 cursor-pointer min-w-[110px]"
            >
              <option value="all">All Types</option>
              <option value="return">Return</option>
              <option value="exchange">Exchange</option>
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
          </div>
          
          {hasActiveFilters && (
            <button 
              onClick={handleClearAll} 
              className="text-sm text-indigo-600 font-medium hover:underline transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {/* Mobile Filter Bar */}
        <div className="lg:hidden p-3 border-b border-slate-100 bg-slate-50/50">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input 
                type="text" 
                placeholder="Search..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
              />
            </div>
            <button 
              onClick={() => setMobileFiltersOpen(true)}
              className="px-3 py-2 bg-white border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
            >
              <Filter className="w-4 h-4" />
              <span className="text-sm">Filters</span>
              {hasActiveFilters && (
                <span className="w-2 h-2 bg-indigo-600 rounded-full ml-1"></span>
              )}
            </button>
          </div>
          {hasActiveFilters && (
            <button 
              onClick={handleClearAll} 
              className="mt-2 text-sm text-indigo-600 font-medium hover:underline"
            >
              Clear all filters
            </button>
          )}
        </div>

        {/* Mobile Filters Modal */}
        {mobileFiltersOpen && <MobileFilters />}

        {/* Table - Mobile responsive */}
        <div className="overflow-x-auto min-h-[400px]">
          {/* Desktop Table */}
          <table className="w-full text-left border-collapse text-sm hidden lg:table">
            <thead className="bg-slate-50/50 border-b border-slate-200 text-slate-500 uppercase tracking-wider">
              <tr>
                <SortableHeader field="createdAt" label="Date" />
                <SortableHeader field="RAN" label="RAN" />
                <th className="p-3">Order</th>
                <th className="p-3">AWB</th>
                <th className="p-3">Product</th>
                <th className="p-3">Type</th>
                <th className="p-3">Return</th>
                <th className="p-3">Shipment</th>
                <th className="p-3">Courier</th>
                <th className="p-3">Refund Type</th>
                <th className="p-3">Refund</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={11} className="p-8 text-center text-slate-500">
                    <div className="flex justify-center items-center gap-2">
                      <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                      Loading...
                    </div>
                  </td>
                </tr>
              ) : currentItems.length === 0 ? (
                <tr>
                  <td colSpan={11} className="p-8 text-center text-slate-500">
                    No return requests found.
                  </td>
                </tr>
              ) : (
                currentItems.map((req) => {
                  const zipCode = req.customer?.zip ? String(req.customer.zip).trim() : '';
                  const isNotServiceable = zipCode && serviceablePincodes[zipCode] === false;
                  const isChecking = zipCode && isCheckingPincode(zipCode);
                  const rowClass = `hover:bg-slate-50 transition-colors group cursor-pointer ${
                    isNotServiceable ? 'bg-amber-50/60 hover:bg-amber-100/60' : ''
                  }`;

                  return (
                    <tr 
                      key={req.id} 
                      onClick={() => navigate(`/returns/${req.id}`)}
                      className={rowClass}
                    >
                      <td className="p-3 whitespace-nowrap text-slate-600">
                        {formatTimestamp(req.createdAt)}
                      </td>
                      <td className="p-3 font-medium text-indigo-600">
                        {req.RAN}
                        {isChecking && (
                          <span className="ml-1.5 inline-block">
                            <Loader2 className="w-3 h-3 animate-spin text-amber-500" />
                          </span>
                        )}
                        {isNotServiceable && (
                          <span className="ml-1.5 text-amber-600" title={`Pincode ${zipCode} is not serviceable by Blue Dart`}>
                            ⚠️
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-slate-800 font-medium">{req.orderId}</td>
                      <td className="p-3 text-slate-500 font-mono text-xs">{req.awb || '-'}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <div className="w-10 h-12 bg-slate-100 rounded overflow-hidden border border-slate-200 shrink-0">
                            {req.items?.[0]?.productImage ? (
                              <img src={req.items?.[0]?.productImage} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <div className="flex items-center justify-center h-full text-slate-300">
                                <Package className="w-5 h-5"/>
                              </div>
                            )}
                          </div>
                          <span className="text-slate-500 text-xs">{req.items?.length ?? 0}</span>
                        </div>
                      </td>
                      <td className="p-3">
                        <ActionTypeBadge actionType={req.actionType || (req.type?.toLowerCase().includes('exchange') ? 'exchange' : 'return')} />
                      </td>
                      <td className="p-3"><ReturnStatusBadge status={req.status} /></td>
                      <td className="p-3">
                        <div className="flex flex-col gap-1 items-start">
                          <ShipmentStatusBadge status={req.shipmentStatus} />
                          
                          {activeTab === 'failed' && (
                            <button
                              onClick={(e) => handleForceProductReached(e, req.id, req.RAN)}
                              className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium bg-teal-50 text-teal-700 border border-teal-200 rounded hover:bg-teal-100 transition-colors"
                            >
                              <Package className="w-3 h-3" />
                              Mark Reached
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        <div 
                          className="text-[10px] leading-tight font-medium text-slate-500 max-w-[120px] truncate" 
                          title={req.courierStatus || 'Waiting for sync'}
                        >
                          {req.courierStatus || '-'}
                        </div>
                      </td>
                      <td className="p-3">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200">
                          <CreditCard className="w-3.5 h-3.5 text-slate-500" />
                          {formatRefundType(req.requestedMethod)}
                        </span>
                      </td>
                      <td className="p-3"><RefundStatusBadge status={req.refundStatus} /></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>

          {/* Mobile Cards */}
          <div className="lg:hidden divide-y divide-slate-100">
            {loading ? (
              <div className="p-8 text-center text-slate-500">
                <div className="flex justify-center items-center gap-2">
                  <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                  Loading...
                </div>
              </div>
            ) : currentItems.length === 0 ? (
              <div className="p-8 text-center text-slate-500">
                No return requests found.
              </div>
            ) : (
              currentItems.map((req) => {
                const zipCode = req.customer?.zip ? String(req.customer.zip).trim() : '';
                const isNotServiceable = zipCode && serviceablePincodes[zipCode] === false;
                const isChecking = zipCode && isCheckingPincode(zipCode);
                const cardClass = `p-4 hover:bg-slate-50 transition-colors cursor-pointer ${
                  isNotServiceable ? 'bg-amber-50/60' : ''
                }`;

                return (
                  <div 
                    key={req.id}
                    onClick={() => navigate(`/returns/${req.id}`)}
                    className={cardClass}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-indigo-600 text-sm">{req.RAN}</span>
                          {isChecking && (
                            <Loader2 className="w-3 h-3 animate-spin text-amber-500" />
                          )}
                          {isNotServiceable && (
                            <span className="text-amber-600 text-sm" title={`Pincode ${zipCode} is not serviceable`}>⚠️</span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {formatTimestamp(req.createdAt)}
                        </div>
                      </div>
                      <ReturnStatusBadge status={req.status} />
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <span className="text-slate-500 text-xs">Order</span>
                        <div className="font-medium text-slate-800">{req.orderId}</div>
                      </div>
                      <div>
                        <span className="text-slate-500 text-xs">AWB</span>
                        <div className="font-mono text-xs text-slate-500">{req.awb || '-'}</div>
                      </div>
                      <div>
                        <span className="text-slate-500 text-xs">Products</span>
                        <div className="flex items-center gap-1.5">
                          <div className="w-8 h-10 bg-slate-100 rounded overflow-hidden border border-slate-200 shrink-0">
                            {req.items?.[0]?.productImage ? (
                              <img src={req.items?.[0]?.productImage} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <div className="flex items-center justify-center h-full text-slate-300">
                                <Package className="w-4 h-4"/>
                              </div>
                            )}
                          </div>
                          <span className="text-slate-500 text-xs">{req.items?.length ?? 0} item{(req.items?.length ?? 0) === 1 ? '' : 's'}</span>
                        </div>
                      </div>
                      <div>
                        <span className="text-slate-500 text-xs">Type</span>
                        <div><ActionTypeBadge actionType={req.actionType || (req.type?.toLowerCase().includes('exchange') ? 'exchange' : 'return')} /></div>
                      </div>
                      <div>
                        <span className="text-slate-500 text-xs">Shipment</span>
                        <div><ShipmentStatusBadge status={req.shipmentStatus} /></div>
                      </div>
                      <div>
                        <span className="text-slate-500 text-xs">Refund</span>
                        <div><RefundStatusBadge status={req.refundStatus} /></div>
                      </div>
                    </div>

                    {activeTab === 'failed' && (
                      <button
                        onClick={(e) => handleForceProductReached(e, req.id, req.RAN)}
                        className="mt-2 flex items-center gap-1 px-2 py-1 text-xs font-medium bg-teal-50 text-teal-700 border border-teal-200 rounded hover:bg-teal-100 transition-colors w-full justify-center"
                      >
                        <Package className="w-3 h-3" />
                        Mark Reached
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
        
        {loadError && (
          <div role="alert" className="m-3 p-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">{loadError}</div>
        )}

        {!loading && hasMore && (
          <div className="p-3 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-center gap-2 text-sm">
            <span className="text-slate-500 text-center">
              Showing the newest {liveDocs.length} {activeTab === 'all' ? '' : 'matching '}requests{range ? ' in this period' : ''}.
            </span>
            <button
              type="button"
              onClick={loadMore}
              className="min-h-[40px] px-4 py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 font-medium hover:bg-indigo-100"
            >
              Load {PAGE_SIZE} more
            </button>
          </div>
        )}

        {/* Pagination */}
        {!loading && filteredData.length > 0 && (
          <div className="p-4 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row flex-wrap justify-between items-center gap-3 text-sm text-slate-500">
            <div className="flex items-center gap-4 flex-wrap justify-center">
              <span>{startIndex + 1}-{Math.min(startIndex + itemsPerPage, filteredData.length)} of {filteredData.length}</span>
              {hasMore && (
                <span className="text-xs text-slate-400">Newest {liveDocs.length} loaded</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={goToPreviousPage}
                disabled={currentPage === 1}
                className={`p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  currentPage === 1 ? 'opacity-40 cursor-not-allowed' : ''
                }`}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              
              <div className="flex items-center gap-1">
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  let pageNumber;
                  if (totalPages <= 5) {
                    pageNumber = i + 1;
                  } else if (currentPage <= 3) {
                    pageNumber = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNumber = totalPages - 4 + i;
                  } else {
                    pageNumber = currentPage - 2 + i;
                  }
                  
                  return (
                    <button
                      key={i}
                      onClick={() => goToPage(pageNumber)}
                      className={`px-3 py-1 rounded-lg text-sm font-medium transition-colors ${
                        currentPage === pageNumber
                          ? 'bg-indigo-600 text-white'
                          : 'bg-white text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {pageNumber}
                    </button>
                  );
                })}
                
                {totalPages > 5 && currentPage < totalPages - 2 && (
                  <span className="px-1 text-slate-400">…</span>
                )}
                {totalPages > 5 && currentPage < totalPages - 1 && (
                  <button
                    onClick={() => goToPage(totalPages)}
                    className={`px-3 py-1 rounded-lg text-sm font-medium transition-colors ${
                      currentPage === totalPages
                        ? 'bg-indigo-600 text-white'
                        : 'bg-white text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {totalPages}
                  </button>
                )}
              </div>
              
              <button
                onClick={goToNextPage}
                disabled={currentPage === totalPages}
                className={`p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  currentPage === totalPages ? 'opacity-40 cursor-not-allowed' : ''
                }`}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const ReturnStatusBadge = ({ status }: { status: string }) => {
  const s = status?.toLowerCase() || 'pending';
  const isCompleted = s === 'completed' || s === 'exchanged_created';

  const config: Record<string, { color: string; bg: string }> = {
    'open': { color: 'text-orange-700', bg: 'bg-orange-50 border-orange-200' },
    'pending': { color: 'text-orange-700', bg: 'bg-orange-50 border-orange-200' },
    'approved': { color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
    'denied': { color: 'text-red-700', bg: 'bg-red-50 border-red-200' },
    'closed': { color: 'text-slate-700', bg: 'bg-slate-50 border-slate-200' },
    'completed': { color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
    'exchanged_created': { color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' }
  };
  const style = config[s] || config.pending;

  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${style.color} ${style.bg}`}>
      {isCompleted ? 'Completed' : (status || 'Pending')}
    </span>
  );
};

const ShipmentStatusBadge = ({ status }: { status?: string }) => {
  if (!status) return <span className="text-xs text-slate-400">-</span>;
  const config: Record<string, { color: string; bg: string }> = {
    'pickup created': { color: 'text-purple-700', bg: 'bg-purple-50 border-purple-200' },
    'pickup scheduled': { color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
    'in transit': { color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-200' },
    'pickup exception': { color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' },
    'self ship requested': { color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
    'product reached': { color: 'text-teal-700', bg: 'bg-teal-50 border-teal-200' },
    'received': { color: 'text-green-700', bg: 'bg-green-50 border-green-200' },
    'pickup cancelled': { color: 'text-red-700', bg: 'bg-red-50 border-red-200' },
    'failed': { color: 'text-red-700', bg: 'bg-red-50 border-red-200' }
  };
  const style = config[status?.toLowerCase()] || { color: 'text-slate-700', bg: 'bg-slate-50 border-slate-200' };
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${style.color} ${style.bg}`}>
      {status}
    </span>
  );
};

const RefundStatusBadge = ({ status }: { status?: string }) => {
  if (!status) return <span className="text-xs text-slate-400">-</span>;
  const config: Record<string, { color: string; bg: string }> = {
    'pending': { color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' },
    'processing': { color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
    'refunded': { color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
    'failed': { color: 'text-red-700', bg: 'bg-red-50 border-red-200' },
    'not eligible': { color: 'text-slate-700', bg: 'bg-slate-50 border-slate-200' },
    'skipped': { color: 'text-slate-500', bg: 'bg-slate-50 border-slate-200' }
  };
  const style = config[status?.toLowerCase()] || config.pending;
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${style.color} ${style.bg} inline-flex items-center`}>
      {status}
    </span>
  );
};

const ActionTypeBadge = ({ actionType }: { actionType: 'return' | 'exchange' }) => {
  const config = {
    'return': { 
      color: 'text-blue-700', 
      bg: 'bg-blue-50 border-blue-200',
      icon: '↩'
    },
    'exchange': { 
      color: 'text-purple-700', 
      bg: 'bg-purple-50 border-purple-200',
      icon: '↔'
    }
  };
  const style = config[actionType] || config.return;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border ${style.color} ${style.bg}`}>
      <span className="text-sm">{style.icon}</span>
      {actionType.charAt(0).toUpperCase() + actionType.slice(1)}
    </span>
  );
};

const TabButton = ({ label, count, active, onClick }: { label: string; count?: string; active: boolean; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`
      flex items-center gap-2 min-h-[44px] px-3 md:px-6 py-3 md:py-4 text-xs md:text-sm font-medium border-b-2 transition-all whitespace-nowrap
      ${active 
        ? 'border-indigo-600 text-indigo-700 bg-indigo-50/30' 
        : 'border-transparent text-slate-600 hover:text-slate-800 hover:bg-slate-50'}
    `}
  >
    <span className="hidden sm:inline">{label}</span>
    <span className="sm:hidden">{label.slice(0, 3)}</span>
    {count !== undefined && (
      <span className={`text-xs px-1.5 py-0.5 rounded-full ${active ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-200 text-slate-600'}`}>
        {count}
      </span>
    )}
  </button>
);

const formatTimestamp = (timestamp: any) => {
  if (!timestamp) return '-';
  try {
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('en-GB', { 
      day: '2-digit', month: 'short', year: 'numeric'
    });
  } catch (e) {
    return '-';
  }
};
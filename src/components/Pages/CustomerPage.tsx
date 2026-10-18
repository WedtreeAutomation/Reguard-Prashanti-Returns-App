/**
 * Public return / exchange request wizard.
 *
 * Everything security-relevant happens on the server (CONTRACT §3):
 *   verifyOrder  -> order + eligibility + existing requests + customer token
 *   submitReturn -> creates the request, returns the server RAN + uploadToken
 *   uploadReturnImages (per item) -> finalizeReturn -> confirmation step
 * Client-side checks below exist only to guide the customer.
 */
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  PackageOpen, ArrowRight, Check, AlertCircle, ArrowLeft, Wallet, Info, Search, CreditCard,
  Loader2, Edit2, Gift, Menu, X, RotateCcw, RefreshCw,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import { getApiErrorMessage, getApiErrorStatus } from '../../Interfaces/http';
import {
  ExistingReturnSummary, OrderEligibility, ProductDetails, PublicOrder, RequestedMethod,
  SubmitReturnItem, finalizeReturn, getProductDetails, getPublicSettings, normalizeOrderName,
  submitReturn, uploadReturnImages, validateVerificationInput, verifyOrder,
} from '../../Interfaces/publicApi';
import { CUSTOMER_PAGE_CSS } from '../Customer/customerPageStyles';
import {
  DEFECT_REASONS, ItemDetails, MANDATORY_IMAGES, MAX_IMAGES, MAX_UPLOAD_FILE_SIZE, MIN_NOTE_WORDS,
  STEPS, STEP_LABELS, SelectedImage, Step, compressImage, countWords, daysBetween,
  emptySlots, formatCurrency, formatDate, getRequestTypeName, isCustomizedItem, isNoteRequired,
  isTerminalStatus, isValidAdditionalNote, methodDestination, methodLabel, parsePrice, validateInputFile,
} from '../Customer/customerUtils';
import { ImageCarousel, IneligibleModal, IneligibleState, StepBar, SubmittingOverlay } from '../Customer/WizardParts';
import { ItemCard, ItemLock } from '../Customer/ItemCard';
import { CustomerInfoSections } from '../Customer/CustomerInfoSections';

type ReturnMethod = RequestedMethod;
type ImagesState = Record<number, (SelectedImage | null)[]>;

interface ReviewItem {
  id: number;
  title: string;
  sku: string;
  price: string;
  quantity: number;
  reason: string;
  note: string;
  images: string[];
  productImage: string;
  actionType: 'return' | 'exchange';
}

interface ReviewData {
  items: ReviewItem[];
  returnItems: ReviewItem[];
  exchangeItems: ReviewItem[];
  customerInfo: { name: string; email: string; phone: string; city: string; state: string };
  totalAmount: number;
  returnAmount: number;
  exchangeAmount: number;
  isReturnOnly: boolean;
  isExchangeOnly: boolean;
  isMixed: boolean;
}

interface ConfirmationData {
  returnId: string;
  RAN: string;
  failedPhotos: { title: string; count: number }[];
  /** false when finalize failed or the server could not send the e-mail */
  emailConfirmed: boolean;
}

const CLOSED_MODAL: IneligibleState = { show: false, orderName: '', type: 'custom' };
const DEFAULT_DETAILS: ItemDetails = { qty: 1, reason: '', note: '', actionType: '' };
/** Shared placeholder for unselected items (stable identity for the memoised ItemCard). */
const NO_IMAGES: (SelectedImage | null)[] = emptySlots();

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Runs `fn`, retrying once after a short pause. */
const withOneRetry = async <T,>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch {
    await sleep(1200);
    return fn();
  }
};

const omitKey = <T,>(obj: Record<number, T>, key: number): Record<number, T> => {
  const next = { ...obj };
  delete next[key];
  return next;
};

// ==========================================
// MAIN COMPONENT
// ==========================================
export const ReturnPortalSplit = () => {
  // --- UI state ---
  const [step, setStep] = useState<Step>('LOGIN');
  const [error, setError] = useState('');
  const [submitError, setSubmitError] = useState<{ message: string; activeReturn: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitStage, setSubmitStage] = useState('');
  const [submitProgress, setSubmitProgress] = useState(0);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isSpecificLoading, setSpecificLoading] = useState(false);
  const [returnDaysLimit, setReturnDaysLimit] = useState<number>(14);
  const [ineligibleModal, setIneligibleModal] = useState<IneligibleState>(CLOSED_MODAL);

  // --- inputs ---
  const [specificOrderId, setSpecificOrderId] = useState('');
  const [specificEmail, setSpecificEmail] = useState('');

  // --- order data (from the server) ---
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [existingReturns, setExistingReturns] = useState<ExistingReturnSummary[]>([]);
  const [eligibility, setEligibility] = useState<OrderEligibility | null>(null);
  const [productDetails, setProductDetails] = useState<Record<number, ProductDetails>>({});

  // --- selection ---
  const [selectedItems, setSelectedItems] = useState<number[]>([]);
  const [returnDetails, setReturnDetails] = useState<Record<number, ItemDetails>>({});
  const [images, setImages] = useState<ImagesState>({});
  const [processingImages, setProcessingImages] = useState<Record<number, boolean>>({});
  const [selectedMethod, setSelectedMethod] = useState<ReturnMethod>('store_credit');
  const [reviewData, setReviewData] = useState<ReviewData | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationData | null>(null);

  const mountedRef = useRef(true);
  const submittingRef = useRef(false);
  const imagesRef = useRef<ImagesState>({});
  const liveUrlsRef = useRef<Set<string>>(new Set());

  // ==========================================
  // EFFECTS
  // ==========================================
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Return window for copy shown before an order is verified.
  useEffect(() => {
    const controller = new AbortController();
    getPublicSettings(controller.signal)
      .then((s) => { if (!controller.signal.aborted) setReturnDaysLimit(s.returnDaysLimit); })
      .catch(() => { /* keep default; the server decides eligibility anyway */ });
    return () => controller.abort();
  }, []);

  // Revoke preview object URLs that are no longer referenced.
  useEffect(() => {
    const now = new Set<string>();
    Object.values(images).forEach((slots) => slots.forEach((s) => { if (s) now.add(s.url); }));
    liveUrlsRef.current.forEach((url) => { if (!now.has(url)) URL.revokeObjectURL(url); });
    liveUrlsRef.current = now;
  }, [images]);
  useEffect(() => () => {
    liveUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    liveUrlsRef.current = new Set();
  }, []);

  // Warn before closing the tab while the request / photos are being sent.
  useEffect(() => {
    if (!submitting) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [submitting]);

  useEffect(() => {
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* old browsers */ }
  }, [step]);

  /** Single writer for the photo state (keeps a synchronous ref for async handlers). */
  const commitImages = useCallback((updater: (prev: ImagesState) => ImagesState) => {
    const next = updater(imagesRef.current);
    imagesRef.current = next;
    setImages(next);
  }, []);

  const closeIneligibleModal = useCallback(() => setIneligibleModal(CLOSED_MODAL), []);
  const showIneligibleModal = useCallback((orderName: string, type: IneligibleState['type']) => {
    setIneligibleModal({ show: true, orderName, type });
  }, []);

  // ==========================================
  // DERIVED DATA
  // ==========================================
  const effectiveDaysLimit = eligibility?.returnDaysLimit || returnDaysLimit;

  /** Non-terminal request status per line item (from the server's existingReturns). */
  const activeStatusByLine = useMemo(() => {
    const map: Record<number, string> = {};
    existingReturns.forEach((r) => {
      if (isTerminalStatus(r.status)) return;
      (r.items || []).forEach((it) => { if (it?.lineItemId) map[it.lineItemId] = r.status || 'In progress'; });
    });
    return map;
  }, [existingReturns]);

  const locks = useMemo(() => {
    const map: Record<number, ItemLock> = {};
    (order?.line_items || []).forEach((item) => {
      const active = activeStatusByLine[item.id];
      if (active) map[item.id] = { kind: 'active', status: active };
      else if (isCustomizedItem(item, productDetails)) map[item.id] = { kind: 'custom' };
      else if (typeof item.returnableQuantity === 'number' && item.returnableQuantity <= 0) map[item.id] = { kind: 'exhausted' };
      else map[item.id] = { kind: 'none' };
    });
    return map;
  }, [order, activeStatusByLine, productDetails]);

  const maxQtyFor = useCallback((lineItemId: number): number => {
    const item = order?.line_items.find((i) => i.id === lineItemId);
    if (!item) return 1;
    const ordered = Math.max(1, item.quantity || 1);
    return typeof item.returnableQuantity === 'number' ? Math.max(0, Math.min(ordered, item.returnableQuantity)) : ordered;
  }, [order]);

  const daysLeft = useMemo((): number | null => {
    if (!order) return null;
    const since = typeof eligibility?.daysSinceDelivery === 'number'
      ? eligibility.daysSinceDelivery
      : daysBetween(order.delivered_at || order.created_at);
    return since >= effectiveDaysLimit - 2 && since <= effectiveDaysLimit ? effectiveDaysLimit - since : null;
  }, [order, eligibility, effectiveDaysLimit]);

  const productImageFor = useCallback((item: { product_id?: number | null; image?: string | null }) =>
    (item.product_id ? productDetails[item.product_id]?.image : null) || item.image || null, [productDetails]);

  const hasDefectiveItems = useMemo(() => selectedItems.some((id) =>
    returnDetails[id]?.actionType === 'return' && DEFECT_REASONS.includes(returnDetails[id]?.reason || '')
  ), [selectedItems, returnDetails]);

  const hasExchangeItems = selectedItems.some((id) => returnDetails[id]?.actionType === 'exchange');
  const hasReturnItems = selectedItems.some((id) => returnDetails[id]?.actionType === 'return');
  const isExchangeOnly = hasExchangeItems && !hasReturnItems;
  const isMixedRequest = hasReturnItems && hasExchangeItems;
  const requestTypeName = getRequestTypeName(hasReturnItems, hasExchangeItems);
  const stepIndex = STEPS.indexOf(step);
  const anyProcessing = Object.values(processingImages).some(Boolean);

  // ==========================================
  // RESET / NAVIGATION
  // ==========================================
  const clearSelection = useCallback(() => {
    setSelectedItems([]);
    setReturnDetails({});
    commitImages(() => ({}));
    setProcessingImages({});
    setReviewData(null);
    setSelectedMethod('store_credit');
    setSubmitError(null);
  }, [commitImages]);

  const resetForm = useCallback(() => {
    if (submittingRef.current) return;
    clearSelection();
    setStep('LOGIN');
    setSpecificOrderId('');
    setSpecificEmail('');
    setOrder(null);
    setExistingReturns([]);
    setEligibility(null);
    setProductDetails({});
    setConfirmation(null);
    setError('');
    setIneligibleModal(CLOSED_MODAL);
  }, [clearSelection]);

  const handleBackFromSelect = useCallback(() => {
    clearSelection();
    setStep('LOGIN');
    setOrder(null);
    setExistingReturns([]);
    setEligibility(null);
    setProductDetails({});
  }, [clearSelection]);

  const handleBackToSelection = useCallback(() => {
    setStep('SELECT');
    setReviewData(null);
  }, []);

  const handleEditDetails = useCallback(() => {
    if (submittingRef.current) return;
    setStep((reviewData?.returnItems.length ?? 0) > 0 ? 'METHOD' : 'SELECT');
    setReviewData(null);
    setSubmitError(null);
  }, [reviewData]);

  // ==========================================
  // ORDER LOOKUP
  // ==========================================
  const handleSpecificSearch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSpecificLoading) return;
    const orderName = normalizeOrderName(specificOrderId);
    if (!orderName) { setError('Please enter your order number (e.g. P123456).'); return; }
    const inputError = validateVerificationInput(specificEmail);
    if (inputError) { setError(inputError); return; }

    setSpecificLoading(true);
    setError('');
    try {
      const res = await verifyOrder(orderName, specificEmail);
      if (!mountedRef.current) return;
      const data = res.order;
      if (!data || !Array.isArray(data.line_items)) throw new Error('We could not read this order. Please try again.');
      const elig = res.eligibility;
      if (elig.returnDaysLimit) setReturnDaysLimit(elig.returnDaysLimit);

      if (!elig.eligible) {
        const name = data.name || orderName;
        switch (elig.reason) {
          case 'time_window': showIneligibleModal(name, 'time_window'); break;
          case 'final_sale': showIneligibleModal(name, 'custom'); break;
          case 'international': showIneligibleModal(name, 'international'); break;
          case 'active_return': showIneligibleModal(name, 'active_return'); break;
          case 'not_fulfilled': setError('This order has not been delivered yet. You can request a return once it is delivered.'); break;
          default: setError('This order is not eligible for a return or exchange.');
        }
        setOrder(null);
        return;
      }

      // Product images / tags: use what the server sent, fetch the rest.
      const details: Record<number, ProductDetails> = {};
      Object.entries(data.product_details || {}).forEach(([key, value]) => {
        const id = parseInt(key, 10);
        if (Number.isFinite(id) && value) details[id] = { image: value.image ?? null, tags: Array.isArray(value.tags) ? value.tags : [] };
      });
      const missing = [...new Set(data.line_items.map((i) => i.product_id).filter((id): id is number => !!id && !details[id]))];
      if (missing.length) {
        const fetched = await Promise.all(missing.map(async (id) => ({ id, d: await getProductDetails(id) })));
        fetched.forEach(({ id, d }) => { details[id] = d; });
      }
      if (!mountedRef.current) return;

      clearSelection();
      setProductDetails(details);
      setExistingReturns(res.existingReturns);
      setEligibility(elig);
      setOrder(data);
      setConfirmation(null);
      setStep('SELECT');
    } catch (err) {
      if (!mountedRef.current) return;
      const status = getApiErrorStatus(err);
      if (status === 403) setError("The email or phone number doesn't match this order. Please use the details from checkout.");
      else if (status === 404) setError('Order not found, details incorrect, or order not fulfilled.');
      else setError(getApiErrorMessage(err, 'We could not look up your order. Please try again.'));
    } finally {
      if (mountedRef.current) setSpecificLoading(false);
    }
  }, [isSpecificLoading, specificOrderId, specificEmail, showIneligibleModal, clearSelection]);

  // ==========================================
  // ITEM SELECTION & DETAILS
  // ==========================================
  const toggleItem = useCallback((lineItemId: number) => {
    const lock = locks[lineItemId];
    if (lock?.kind === 'active') {
      toast.warning(`This item has an active request (${lock.status}). You can only reapply after the current request is closed.`);
      return;
    }
    if (lock?.kind === 'custom') { toast.warning('This item is customized/bespoke and cannot be returned.'); return; }
    if (lock?.kind === 'exhausted') { toast.warning('All units of this item have already been requested.'); return; }
    // The three pieces of selection state always toggle together, so each
    // pure updater can decide from its own previous value.
    setSelectedItems((prev) => (prev.includes(lineItemId) ? prev.filter((id) => id !== lineItemId) : [...prev, lineItemId]));
    setReturnDetails((prev) => (prev[lineItemId] ? omitKey(prev, lineItemId) : { ...prev, [lineItemId]: { ...DEFAULT_DETAILS } }));
    commitImages((prev) => (prev[lineItemId] ? omitKey(prev, lineItemId) : { ...prev, [lineItemId]: emptySlots() }));
  }, [locks, commitImages]);

  const updateDetail = useCallback((lineItemId: number, field: keyof ItemDetails, value: string | number) => {
    setReturnDetails((prev) => ({
      ...prev,
      [lineItemId]: { ...(prev[lineItemId] || DEFAULT_DETAILS), [field]: value },
    }));
  }, []);

  const handleFiles = useCallback(async (lineItemId: number, files: File[]) => {
    const slots = imagesRef.current[lineItemId];
    if (!slots) return;
    const free = slots.filter((s) => !s).length;
    if (free === 0) { toast.warning(`Maximum ${MAX_IMAGES} images allowed.`); return; }

    const warnings: string[] = [];
    const accepted: File[] = [];
    files.forEach((file) => {
      const problem = validateInputFile(file);
      if (problem) warnings.push(`Skipped ${file.name}: ${problem}`);
      else accepted.push(file);
    });
    let overflow = Math.max(0, accepted.length - free);
    const toProcess = accepted.slice(0, free);

    let prepared: File[] = [];
    if (toProcess.length) {
      setProcessingImages((p) => ({ ...p, [lineItemId]: true }));
      try {
        prepared = await Promise.all(toProcess.map((f) => compressImage(f)));
      } catch {
        prepared = toProcess;
      } finally {
        if (mountedRef.current) setProcessingImages((p) => ({ ...p, [lineItemId]: false }));
      }
    }
    if (!mountedRef.current) return;

    const fitting = prepared.filter((f) => {
      if (f.size <= MAX_UPLOAD_FILE_SIZE) return true;
      warnings.push(`Skipped ${f.name}: photo must be under 8 MB`);
      return false;
    });

    if (fitting.length) {
      // The item may have been deselected (or slots filled) while compressing.
      const current = imagesRef.current[lineItemId];
      if (!current) return;
      const nextSlots = [...current];
      fitting.forEach((file) => {
        const idx = nextSlots.findIndex((s) => !s);
        if (idx < 0) { overflow += 1; return; }
        nextSlots[idx] = { file, url: URL.createObjectURL(file) };
      });
      commitImages((prev) => (prev[lineItemId] ? { ...prev, [lineItemId]: nextSlots } : prev));
    }

    warnings.forEach((w) => toast.warning(w));
    if (overflow > 0) toast.warning(`Only up to ${MAX_IMAGES} images allowed. Some files were skipped.`);
  }, [commitImages]);

  const removeImage = useCallback((lineItemId: number, index: number) => {
    commitImages((prev) => {
      if (!prev[lineItemId]) return prev;
      const nextSlots = [...prev[lineItemId]];
      nextSlots[index] = null;
      // keep filled slots first so "required" slots stay at the front
      const compacted = [...nextSlots.filter(Boolean), ...nextSlots.filter((s) => !s)];
      return { ...prev, [lineItemId]: compacted };
    });
  }, [commitImages]);

  // ==========================================
  // VALIDATION / REVIEW
  // ==========================================
  const validateReturn = useCallback((): boolean => {
    if (!order || selectedItems.length === 0) { toast.error('Please select at least one item.'); return false; }
    if (anyProcessing) { toast.info('Please wait until your photos are ready.'); return false; }
    for (const itemId of selectedItems) {
      const d = returnDetails[itemId];
      const title = order.line_items.find((i) => i.id === itemId)?.title || 'the selected item';
      if (!d?.actionType) { toast.error('Please select whether you want to Return or Exchange for all selected items.'); return false; }
      if (!d.reason) { toast.error('Please select a reason for all items.'); return false; }
      if (isNoteRequired(d.reason) && !isValidAdditionalNote(d.note)) {
        const words = countWords(d.note);
        toast.error(`Please describe the issue with "${title}" in at least ${MIN_NOTE_WORDS} words. (Current: ${words} word${words !== 1 ? 's' : ''})`);
        return false;
      }
      const max = maxQtyFor(itemId);
      if (d.qty < 1 || d.qty > max) { toast.error(`You can request at most ${max} unit(s) of "${title}".`); return false; }
      if ((imagesRef.current[itemId] || []).filter(Boolean).length < MANDATORY_IMAGES) {
        toast.error(`Please upload at least ${MANDATORY_IMAGES} images for all selected items.`);
        return false;
      }
    }
    return true;
  }, [order, selectedItems, returnDetails, anyProcessing, maxQtyFor]);

  const prepareReviewData = useCallback((): ReviewData | null => {
    if (!order) return null;
    const shipping = order.shipping_address;
    const items: ReviewItem[] = selectedItems.map((itemId) => {
      const item = order.line_items.find((i) => i.id === itemId);
      const details = returnDetails[itemId] || DEFAULT_DETAILS;
      return {
        id: itemId,
        title: item?.title || 'Item',
        sku: item?.sku || 'N/A',
        price: item?.price || '0',
        quantity: details.qty,
        reason: details.reason,
        note: details.note?.trim() || '',
        images: (images[itemId] || []).filter((s): s is SelectedImage => !!s).map((s) => s.url),
        productImage: (item && productImageFor(item)) || '',
        actionType: (details.actionType || 'return') as 'return' | 'exchange',
      };
    });
    const amountOf = (list: ReviewItem[]) => list.reduce((sum, i) => sum + parsePrice(i.price) * i.quantity, 0);
    const returnItems = items.filter((i) => i.actionType === 'return');
    const exchangeItems = items.filter((i) => i.actionType === 'exchange');
    return {
      items, returnItems, exchangeItems,
      customerInfo: {
        name: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || 'N/A',
        email: order.email || order.customer?.email || 'N/A',
        phone: shipping?.phone || order.phone || order.customer?.phone || 'N/A',
        city: shipping?.city || 'N/A',
        state: shipping?.province || 'N/A',
      },
      totalAmount: amountOf(items),
      returnAmount: amountOf(returnItems),
      exchangeAmount: amountOf(exchangeItems),
      isReturnOnly: returnItems.length > 0 && exchangeItems.length === 0,
      isExchangeOnly: exchangeItems.length > 0 && returnItems.length === 0,
      isMixed: returnItems.length > 0 && exchangeItems.length > 0,
    };
  }, [order, selectedItems, returnDetails, images, productImageFor]);

  const handleContinueAction = useCallback(() => {
    if (!validateReturn()) return;
    if (isExchangeOnly) {
      setSelectedMethod('none');
      const review = prepareReviewData();
      if (review) { setReviewData(review); setSubmitError(null); setStep('REVIEW'); }
      return;
    }
    if (hasReturnItems) {
      if (hasDefectiveItems) setSelectedMethod('refund');
      else if (selectedMethod === 'refund' || selectedMethod === 'none') setSelectedMethod('store_credit');
      setStep('METHOD');
    }
  }, [validateReturn, isExchangeOnly, hasReturnItems, hasDefectiveItems, selectedMethod, prepareReviewData]);

  const handleMethodContinue = useCallback(() => {
    const review = prepareReviewData();
    if (review) { setReviewData(review); setSubmitError(null); setStep('REVIEW'); }
  }, [prepareReviewData]);

  // ==========================================
  // SUBMISSION
  // ==========================================
  const handleSubmitReturn = useCallback(async () => {
    if (!order || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitStage('Creating your request…');
    setSubmitProgress(0.05);

    const requestedMethod: ReturnMethod = hasReturnItems ? selectedMethod : 'none';
    const photosByItem = selectedItems.map((itemId) => ({
      itemId,
      title: order.line_items.find((i) => i.id === itemId)?.title || 'Item',
      files: (imagesRef.current[itemId] || []).filter((s): s is SelectedImage => !!s).map((s) => s.file).slice(0, MAX_IMAGES),
    }));
    const items: SubmitReturnItem[] = selectedItems.map((itemId) => {
      const d = returnDetails[itemId] || DEFAULT_DETAILS;
      return {
        lineItemId: itemId,
        quantity: d.qty,
        reason: d.reason,
        note: (d.note || '').trim(),
        actionType: (d.actionType || 'return') as 'return' | 'exchange',
        imageCount: photosByItem.find((p) => p.itemId === itemId)?.files.length || 0,
      };
    });
    // No pickupAddress: there is no address editor here, and the server builds
    // the pickup/customer block from the Shopify shipping address itself
    // (sending it would only add a stricter validation path — e.g. a missing
    // shipping phone or a spaced PIN would reject the whole request).

    const finish = () => {
      submittingRef.current = false;
      if (!mountedRef.current) return;
      setSubmitting(false);
      setSubmitStage('');
      setSubmitProgress(0);
    };

    // 1) Create the request (server validates everything and assigns the RAN).
    let created: { returnId: string; RAN: string; uploadToken: string };
    try {
      created = await submitReturn({ items, requestedMethod });
    } catch (err) {
      const status = getApiErrorStatus(err);
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      let msg: string;
      const activeReturn = status === 409 && (code === 'active_return' || !code);
      if (activeReturn) {
        msg = 'This order already has a return or exchange request in progress. If you just submitted, it was received — you can track it on the status page.';
        showIneligibleModal(order.name, 'active_return');
      } else if (status === 401) {
        msg = 'Your session has expired. Please start over and look up your order again — nothing was submitted.';
      } else {
        msg = getApiErrorMessage(err, 'Failed to submit request. Please try again.');
      }
      if (mountedRef.current) setSubmitError({ message: msg, activeReturn });
      toast.error(msg);
      finish();
      return;
    }

    // 2) Upload photos per item (retry once; never lose the request itself).
    const totalPhotos = photosByItem.reduce((n, p) => n + p.files.length, 0);
    const failedPhotos: { title: string; count: number }[] = [];
    let donePhotos = 0;
    const showUploadStage = (inFlight: number) => {
      if (!mountedRef.current || totalPhotos === 0) return;
      const shown = Math.min(totalPhotos, donePhotos + inFlight + 1);
      setSubmitStage(`Uploading photos ${shown}/${totalPhotos}…`);
      setSubmitProgress(0.1 + 0.8 * ((donePhotos + inFlight) / totalPhotos));
    };
    for (const batch of photosByItem) {
      if (!batch.files.length) continue;
      showUploadStage(0);
      try {
        await withOneRetry(() => uploadReturnImages({
          returnId: created.returnId,
          uploadToken: created.uploadToken,
          lineItemId: batch.itemId,
          files: batch.files,
          onProgress: (fraction) => showUploadStage(Math.min(batch.files.length - 1, Math.floor(fraction * batch.files.length))),
        }));
      } catch {
        failedPhotos.push({ title: batch.title, count: batch.files.length });
      }
      donePhotos += batch.files.length;
    }

    // 3) Finalize (idempotent: Shopify note + confirmation e-mail).
    if (mountedRef.current) { setSubmitStage('Finalising your request…'); setSubmitProgress(0.95); }
    let emailConfirmed = false;
    let finalRAN = created.RAN;
    try {
      const fin = await withOneRetry(() => finalizeReturn(created.returnId, created.uploadToken));
      emailConfirmed = fin.success && fin.emailSent;
      if (fin.RAN) finalRAN = fin.RAN;
    } catch {
      emailConfirmed = false;
    }

    if (mountedRef.current) {
      setConfirmation({ returnId: created.returnId, RAN: finalRAN, failedPhotos, emailConfirmed });
      setStep('CONFIRMATION');
      if (failedPhotos.length) toast.warning('Your request was created, but some photos could not be uploaded.');
    }
    finish();
  }, [order, hasReturnItems, selectedMethod, selectedItems, returnDetails, showIneligibleModal]);

  // ==========================================
  // RENDER
  // ==========================================
  const trackUrl = order ? `/ReturnStatusPage?order=${encodeURIComponent(order.name)}` : '/ReturnStatusPage';

  return (
    <>
      <style>{CUSTOMER_PAGE_CSS}</style>

      <div className="rg-root">
        <div className="rg-announcement">
          <strong>Free shipping above ₹1,999/–</strong> · 3 Days Return · Support for every Prashanti order
        </div>

        {/* DESKTOP HEADER */}
        <header className="rg-header">
          <div className="rg-navbar">
            <Link to="/CustomerPage" className="rg-brand" aria-label="Re-guard by Prashanti — start a return">
              <img src="/reguard-logo.png" alt="Re-guard by Prashanti" style={{ height: 64, objectFit: 'contain' }} />
            </Link>
            <nav className="rg-nav-links" aria-label="Main navigation">
              <a href="#how-it-works">How it works</a>
              <a href="#help">Support</a>
              <a href="#faq">FAQs</a>
            </nav>
            <div className="rg-nav-actions">
              <Link to="/ReturnStatusPage" className="rg-btn-ghost">
                <Search size={14} aria-hidden="true" /> Track Return
              </Link>
              <a className="rg-btn-solid" href="https://www.prashantisarees.com/account" target="_blank" rel="noopener noreferrer">
                My account
              </a>
            </div>
          </div>
        </header>

        {/* MOBILE HEADER */}
        <div className="rg-mobile-header">
          <div className="rg-mobile-top">
            <Link to="/CustomerPage" className="rg-mobile-brand">
              <img src="/reguard-logo-bg.png" alt="Re-guard by Prashanti" style={{ height: 36, objectFit: 'contain' }} />
            </Link>
            <div style={{ display: 'flex', gap: 4 }}>
              <Link to="/ReturnStatusPage" className="rg-mobile-icon-link" aria-label="Track return status">
                <Search size={16} aria-hidden="true" />
              </Link>
              <button
                type="button"
                className="rg-mobile-menu-btn"
                onClick={() => setIsMobileMenuOpen((open) => !open)}
                aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={isMobileMenuOpen}
                aria-controls="rg-mobile-menu"
              >
                {isMobileMenuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
              </button>
            </div>
          </div>
          <div className="rg-mobile-progress">
            <span className="rg-mobile-progress-label">Step {stepIndex + 1}/{STEPS.length}</span>
            <div className="rg-mobile-progress-bar" aria-hidden="true">
              <div className="rg-mobile-progress-fill" style={{ width: `${(stepIndex + 1) * 20}%` }} />
            </div>
            <span className="rg-mobile-progress-label" style={{ color: '#fff', fontWeight: 700 }}>{STEP_LABELS[step]}</span>
          </div>
          {isMobileMenuOpen && (
            <nav className="rg-mobile-dropdown" id="rg-mobile-menu" aria-label="Menu">
              <Link to="/ReturnStatusPage" onClick={() => setIsMobileMenuOpen(false)}>
                <Search size={16} aria-hidden="true" /> Track Return Status
              </Link>
              {step !== 'LOGIN' && !submitting && (
                <button type="button" onClick={() => { resetForm(); setIsMobileMenuOpen(false); }}>
                  <ArrowLeft size={16} aria-hidden="true" /> Start Over
                </button>
              )}
            </nav>
          )}
        </div>

        <IneligibleModal state={ineligibleModal} returnDaysLimit={effectiveDaysLimit} onClose={closeIneligibleModal} />
        {submitting && <SubmittingOverlay stage={submitStage} progress={submitProgress} />}

        {/* ===== HERO (LOGIN STEP) ===== */}
        {step === 'LOGIN' && (
          <>
            <section className="rg-hero">
              <div className="rg-hero-grid">
                <div>
                  <div className="rg-eyebrow">
                    <span className="rg-eyebrow-dot" />
                    The Re-guard return concierge
                  </div>
                  <h1>Thoughtful care for every <em>Prashanti</em> order.</h1>
                  <p className="rg-hero-copy">
                    A simple, guided way to return or exchange your Prashanti saree. Find your order to get started.
                  </p>
                  <div className="rg-confidence">
                    <span>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                      Easy online process
                    </span>
                    <span>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                      Secure &amp; private
                    </span>
                    <span>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                      3-day return window
                    </span>
                  </div>
                </div>

                <div>
                  <div className="rg-return-card">
                    <div className="rg-card-top">
                      <div>
                        <div className="rg-card-kicker">Return portal</div>
                        <h2 className="rg-card-title">Start your return</h2>
                        <p className="rg-card-subtitle">For Prashanti Sarees orders placed online.</p>
                      </div>
                      <span className="rg-secure-pill">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
                        Secure
                      </span>
                    </div>

                    <StepBar step={step} />

                    <form onSubmit={handleSpecificSearch} noValidate aria-describedby={error ? 'rg-login-error' : undefined}>
                      <label className="rg-field-label" htmlFor="order-id">Find your Prashanti order</label>
                      <div className="rg-input-wrap">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
                        <input
                          id="order-id"
                          className="rg-input"
                          value={specificOrderId}
                          onChange={(e) => setSpecificOrderId(e.target.value)}
                          placeholder="Order ID (e.g. P123456)"
                          disabled={isSpecificLoading}
                          required
                          autoComplete="off"
                          autoCapitalize="characters"
                          spellCheck={false}
                        />
                      </div>
                      <label className="rg-sr-only" htmlFor="order-contact">Email or phone number used at checkout</label>
                      <div className="rg-input-wrap">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></svg>
                        <input
                          id="order-contact"
                          className="rg-input"
                          type="text"
                          value={specificEmail}
                          onChange={(e) => setSpecificEmail(e.target.value)}
                          placeholder="Email or phone number"
                          disabled={isSpecificLoading}
                          required
                          autoComplete="email"
                          spellCheck={false}
                        />
                      </div>

                      {error && (
                        <div className="rg-error-banner" role="alert" id="rg-login-error">
                          <AlertCircle size={14} aria-hidden="true" />
                          <span>{error}</span>
                        </div>
                      )}

                      <button className="rg-btn-gold" type="submit" disabled={isSpecificLoading}>
                        {isSpecificLoading
                          ? <><Loader2 size={16} className="rg-spin" aria-hidden="true" /> Searching…</>
                          : <>Find my order <ArrowRight size={16} aria-hidden="true" /></>}
                      </button>
                    </form>

                    <p className="rg-card-note">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 10v6M12 7h.01" /></svg>
                      We'll use these details only to locate your eligible order.
                    </p>
                  </div>

                  <div className="rg-quick-links">
                    <a className="rg-quick-link" href="https://www.prashantisarees.com/account" target="_blank" rel="noopener noreferrer">
                      <span className="rg-quick-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3h12v18H6z" /><path d="M9 7h6M9 11h6M9 15h4" /></svg></span>
                      <span>My orders<small>View purchase history</small></span>
                      <span className="rg-quick-arrow" aria-hidden="true">↗</span>
                    </a>
                    <Link className="rg-quick-link" to="/ReturnStatusPage">
                      <span className="rg-quick-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></svg></span>
                      <span>Track a return<small>Check return status</small></span>
                      <span className="rg-quick-arrow" aria-hidden="true">→</span>
                    </Link>
                    <a className="rg-quick-link" href="https://www.prashantisarees.com/account/login" target="_blank" rel="noopener noreferrer">
                      <span className="rg-quick-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20c.8-3.5 3.3-5.3 7.5-5.3s6.7 1.8 7.5 5.3" /></svg></span>
                      <span>Sign in<small>Manage your account</small></span>
                      <span className="rg-quick-arrow" aria-hidden="true">↗</span>
                    </a>
                  </div>
                </div>
              </div>
            </section>

            <CustomerInfoSections />
          </>
        )}

        {/* ===== MULTI-STEP PORTAL ===== */}
        {step !== 'LOGIN' && (
          <div className="rg-portal">
            <div className="rg-portal-grid">
              {/* LEFT PANEL */}
              <aside className="rg-left-panel" aria-label="Request summary">
                <div className="rg-left-panel-top">
                  <div style={{ fontSize: 11, color: 'rgba(var(--gold-rgb), .9)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 8 }}>
                    {requestTypeName} Request
                  </div>
                  <h2>{step === 'SELECT' ? 'Select items' : step === 'METHOD' ? 'Refund method' : step === 'REVIEW' ? 'Review details' : 'Submitted!'}</h2>
                  <p>
                    {step === 'SELECT' ? 'Choose items to return or exchange.' : step === 'METHOD' ? 'How would you like your refund?' : step === 'REVIEW' ? 'Verify all details before submitting.' : 'Your request has been received.'}
                  </p>
                </div>
                <div className="rg-left-panel-body">
                  {order && (
                    <div className="rg-order-info">
                      <div className="rg-order-info-label">Active order</div>
                      <div className="rg-order-num">{order.name}</div>
                      {order.email && <div className="rg-order-email">{order.email}</div>}
                      <div className="rg-order-date">{formatDate(order.created_at)}</div>
                    </div>
                  )}
                  {step === 'SELECT' && (
                    <div style={{ marginTop: 4 }}>
                      {selectedItems.length > 0 && (
                        <div className="rg-method-summary">
                          <div className="rg-method-summary-label">Selected</div>
                          <div className="rg-method-summary-val">{selectedItems.length} item{selectedItems.length !== 1 ? 's' : ''}</div>
                        </div>
                      )}
                      <button type="button" className="rg-back-btn" onClick={handleBackFromSelect}>
                        <ArrowLeft size={14} aria-hidden="true" /> Start Over
                      </button>
                    </div>
                  )}
                  {step === 'METHOD' && (
                    <div style={{ marginTop: 4 }}>
                      <div className="rg-method-summary">
                        <div className="rg-method-summary-label">{requestTypeName} items</div>
                        <div className="rg-method-summary-val">{selectedItems.length} item{selectedItems.length !== 1 ? 's' : ''} selected</div>
                      </div>
                      <button type="button" className="rg-back-btn" onClick={handleBackToSelection}>
                        <ArrowLeft size={14} aria-hidden="true" /> Back to items
                      </button>
                    </div>
                  )}
                  {step === 'REVIEW' && (
                    <div style={{ marginTop: 4 }}>
                      {reviewData && (
                        <>
                          <div className="rg-method-summary">
                            <div className="rg-method-summary-label">Refund method</div>
                            <div className="rg-method-summary-val">{reviewData.isExchangeOnly ? 'Exchange — no refund' : methodLabel(selectedMethod)}</div>
                          </div>
                          <div className="rg-order-info">
                            <div className="rg-order-info-label">Estimated total</div>
                            <div className="rg-order-num" style={{ fontSize: 16 }}>{formatCurrency(reviewData.totalAmount)}</div>
                          </div>
                        </>
                      )}
                      <button type="button" className="rg-back-btn" onClick={handleEditDetails} disabled={submitting}>
                        <ArrowLeft size={14} aria-hidden="true" /> Edit details
                      </button>
                    </div>
                  )}
                  {step === 'CONFIRMATION' && confirmation && (
                    <div style={{ marginTop: 4 }}>
                      <div className="rg-method-summary">
                        <div className="rg-method-summary-label">RAN</div>
                        <div className="rg-ran-code" style={{ fontSize: 14 }}>{confirmation.RAN}</div>
                      </div>
                      <button type="button" className="rg-back-btn" onClick={resetForm}>
                        <RotateCcw size={14} aria-hidden="true" /> Start new request
                      </button>
                    </div>
                  )}

                  <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
                    <StepBar step={step} />
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 2, marginTop: 6 }} aria-hidden="true">
                      {['Find', 'Select', 'Method', 'Review', 'Done'].map((label, i) => (
                        <div key={label} style={{ textAlign: 'center', fontSize: 9, color: i <= stepIndex ? 'var(--plum)' : 'var(--muted)', fontWeight: i === stepIndex ? 800 : 550 }}>
                          {label}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8, fontWeight: 700 }}>Need help?</div>
                    <a href="mailto:support@prashantisarees.in" style={{ display: 'block', color: 'var(--plum)', fontSize: 12, textDecoration: 'none', fontWeight: 700, marginBottom: 4 }}>support@prashantisarees.in</a>
                    <a href="https://wa.me/919962505459" target="_blank" rel="noopener noreferrer" style={{ display: 'block', color: 'var(--muted)', fontSize: 11, textDecoration: 'none' }}>WhatsApp: +91 99625 05459</a>
                  </div>
                </div>
              </aside>

              {/* RIGHT PANEL */}
              <main className="rg-right-panel">
                {/* SELECT STEP */}
                {step === 'SELECT' && order && (
                  <>
                    <div className="rg-right-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                        <button type="button" onClick={handleBackFromSelect} className="rg-icon-back" aria-label="Back to order search">
                          <ArrowLeft size={14} aria-hidden="true" />
                        </button>
                        <h2>Select items to {requestTypeName.toLowerCase()}</h2>
                      </div>
                      <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
                        Order {order.name} · {order.line_items.length} item{order.line_items.length !== 1 ? 's' : ''}
                      </span>
                    </div>

                    <div className="rg-right-body">
                      {order.line_items.map((item) => (
                        <ItemCard
                          key={item.id}
                          item={item}
                          currency={order.currency || 'INR'}
                          productImage={productImageFor(item)}
                          isSelected={selectedItems.includes(item.id)}
                          details={returnDetails[item.id] || DEFAULT_DETAILS}
                          images={images[item.id] || NO_IMAGES}
                          lock={locks[item.id] || { kind: 'none' }}
                          maxQty={maxQtyFor(item.id)}
                          daysLeft={daysLeft}
                          processingImages={!!processingImages[item.id]}
                          onToggle={toggleItem}
                          onUpdate={updateDetail}
                          onFiles={handleFiles}
                          onRemoveImage={removeImage}
                        />
                      ))}
                    </div>

                    {selectedItems.length > 0 && (
                      <div className="rg-continue-bar rg-sticky-bar">
                        <div className="rg-continue-count" aria-live="polite">
                          <span className="rg-count-num">{selectedItems.length}</span>
                          <span>item{selectedItems.length !== 1 ? 's' : ''} selected</span>
                          {hasDefectiveItems && <span className="rg-badge amber"><AlertCircle size={11} aria-hidden="true" /> Defective</span>}
                        </div>
                        <button type="button" className="rg-btn-solid" onClick={handleContinueAction} disabled={submitting || anyProcessing} style={{ padding: '12px 24px', fontSize: 14 }}>
                          {anyProcessing
                            ? <><Loader2 size={16} className="rg-spin" aria-hidden="true" /> Preparing photos…</>
                            : <>Continue <ArrowRight size={16} aria-hidden="true" /></>}
                        </button>
                      </div>
                    )}
                  </>
                )}

                {/* METHOD STEP */}
                {step === 'METHOD' && order && (
                  <>
                    <div className="rg-right-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                        <button type="button" onClick={handleBackToSelection} className="rg-icon-back" aria-label="Back to item selection">
                          <ArrowLeft size={14} aria-hidden="true" />
                        </button>
                        <h2>{hasDefectiveItems ? 'How would you like your refund?' : 'How to receive your credit?'}</h2>
                      </div>
                    </div>

                    <div className="rg-right-body">
                      {isMixedRequest && (
                        <div className="rg-info-box blue" style={{ marginTop: 0, marginBottom: 18 }}>
                          <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                          <span>This choice applies only to the item(s) you're returning. Exchange item(s) are handled separately.</span>
                        </div>
                      )}

                      {hasDefectiveItems && (
                        <div className="rg-defective-note">
                          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                          <div>
                            <strong>Defective item detected.</strong> Refund to the original payment method has been pre-selected as it's the applicable resolution.
                          </div>
                        </div>
                      )}

                      <div role="radiogroup" aria-label="Refund method">
                        {([
                          ...(!hasDefectiveItems ? [
                            { value: 'store_credit' as const, icon: <Wallet size={20} />, name: 'Store Credit', desc: 'Receive credit to your store account instantly. Use it on any future Prashanti purchase.' },
                            { value: 'gift_card' as const, icon: <Gift size={20} />, name: 'Gift Card', desc: 'Receive a gift card code to your email. Can be shared or used for any future order.' },
                          ] : []),
                          { value: 'refund' as const, icon: <CreditCard size={20} />, name: 'Refund to Original Payment', desc: 'Refund to the original payment method. Processing may take 7–10 working days after approval.' },
                        ]).map((m) => (
                          <label key={m.value} className={`rg-method-card${selectedMethod === m.value ? ' active' : ''}`}>
                            <input
                              type="radio"
                              name="refund-method"
                              value={m.value}
                              checked={selectedMethod === m.value}
                              onChange={() => setSelectedMethod(m.value)}
                              className="rg-sr-only"
                            />
                            <div className="rg-method-inner">
                              <div className="rg-method-icon" aria-hidden="true">{m.icon}</div>
                              <div className="rg-method-body">
                                <div className="rg-method-header">
                                  <span className="rg-method-name">{m.name}</span>
                                  {selectedMethod === m.value && <span className="rg-method-check" aria-hidden="true"><Check size={14} /></span>}
                                </div>
                                <p className="rg-method-desc">{m.desc}</p>
                              </div>
                            </div>
                          </label>
                        ))}
                      </div>

                      <div className="rg-continue-bar rg-sticky-bar" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }}>
                        <button type="button" onClick={handleBackToSelection} className="rg-btn-ghost">
                          <ArrowLeft size={14} aria-hidden="true" /> Back
                        </button>
                        <button type="button" className="rg-btn-solid" onClick={handleMethodContinue} style={{ padding: '12px 28px', fontSize: 14 }}>
                          Continue <ArrowRight size={16} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {/* REVIEW STEP */}
                {step === 'REVIEW' && order && reviewData && (
                  <>
                    <div className="rg-right-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                        <button type="button" onClick={handleEditDetails} className="rg-icon-back" aria-label="Edit details" disabled={submitting}>
                          <ArrowLeft size={14} aria-hidden="true" />
                        </button>
                        <h2>Review your {requestTypeName.toLowerCase()}</h2>
                      </div>
                    </div>

                    <div className="rg-right-body">
                      <div style={{ marginBottom: 22, padding: 16, background: 'var(--soft)', border: '1px solid var(--line)', borderRadius: 12 }}>
                        <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 10 }}>Shipping details</div>
                        <div className="rg-review-contact">
                          {[
                            { label: 'Name', val: reviewData.customerInfo.name },
                            { label: 'Email', val: reviewData.customerInfo.email },
                            { label: 'Phone', val: reviewData.customerInfo.phone },
                            { label: 'City', val: `${reviewData.customerInfo.city}, ${reviewData.customerInfo.state}` },
                          ].map(({ label, val }) => (
                            <div key={label}>
                              <span style={{ color: 'var(--muted)' }}>{label}:</span>{' '}
                              <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{val}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--muted)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em' }}>Items</div>
                      {reviewData.items.map((item) => (
                        <div key={item.id} className="rg-review-item">
                          <div className="rg-review-img">
                            {item.productImage ? <img src={item.productImage} alt={item.title} /> : <PackageOpen size={20} style={{ color: '#c4b8c4' }} aria-hidden="true" />}
                          </div>
                          <div className="rg-review-info">
                            <p className="rg-review-title">{item.title}</p>
                            <p className="rg-review-meta">SKU: {item.sku} · Qty: {item.quantity}</p>
                            <p className="rg-review-meta">Reason: {item.reason}</p>
                            {item.note && <p className="rg-review-meta" style={{ fontStyle: 'italic' }}>{item.note}</p>}
                            <span className={`rg-type-pill ${item.actionType}`}>
                              {item.actionType === 'return' ? <RotateCcw size={10} aria-hidden="true" /> : <RefreshCw size={10} aria-hidden="true" />}
                              {item.actionType === 'return' ? 'Return' : 'Exchange'}
                            </span>
                            {item.images.length > 0 && (
                              <div style={{ marginTop: 10 }}>
                                <ImageCarousel images={item.images} title={item.title} />
                              </div>
                            )}
                          </div>
                          <div>
                            <p className="rg-review-price">{formatCurrency(parsePrice(item.price) * item.quantity)}</p>
                          </div>
                        </div>
                      ))}

                      <div className="rg-summary-box">
                        <div className="rg-summary-row">
                          <span className="rg-summary-label">Total item value</span>
                          <span className="rg-summary-val">{formatCurrency(reviewData.totalAmount)}</span>
                        </div>
                        {!reviewData.isExchangeOnly && (
                          <div className="rg-summary-row">
                            <span className="rg-summary-label">Refund method</span>
                            <span className="rg-summary-val plum">{methodLabel(selectedMethod)}</span>
                          </div>
                        )}
                        <div className="rg-summary-row">
                          <span className="rg-summary-label">Estimated processing</span>
                          <span className="rg-summary-val">5–7 business days</span>
                        </div>
                      </div>

                      {reviewData.isReturnOnly && (
                        <div className="rg-info-box blue">
                          <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                          <p style={{ margin: 0 }}>
                            <strong>Important:</strong> Your refund will be processed to your {methodDestination(selectedMethod)}. Please allow 5–7 business days.
                          </p>
                        </div>
                      )}
                      {reviewData.isExchangeOnly && (
                        <div className="rg-info-box plum">
                          <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                          <p style={{ margin: 0 }}>
                            <strong>Exchange request logged.</strong> Our team will review the details and initiate the replacement process shortly.
                          </p>
                        </div>
                      )}
                      {reviewData.isMixed && (
                        <>
                          <div className="rg-info-box blue">
                            <RotateCcw size={16} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                            <p style={{ margin: 0 }}>
                              <strong>Returned items:</strong> Refund to your {methodDestination(selectedMethod)}. Allow 5–7 business days.
                            </p>
                          </div>
                          <div className="rg-info-box plum">
                            <RefreshCw size={16} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                            <p style={{ margin: 0 }}>
                              <strong>Exchanged items:</strong> Our team will review the details and initiate replacement shortly.
                            </p>
                          </div>
                        </>
                      )}

                      {submitError && (
                        <div className="rg-error-banner" role="alert" style={{ marginTop: 18, marginBottom: 0 }}>
                          <AlertCircle size={14} aria-hidden="true" />
                          <span>
                            {submitError.message}{' '}
                            {submitError.activeReturn && <Link to={trackUrl}>Track your request</Link>}
                          </span>
                        </div>
                      )}

                      <div className="rg-action-row">
                        <button type="button" onClick={handleEditDetails} className="rg-btn-ghost" disabled={submitting}>
                          <Edit2 size={14} aria-hidden="true" /> Edit Details
                        </button>
                        <button type="button" onClick={handleSubmitReturn} disabled={submitting} className="rg-btn-solid" aria-busy={submitting}>
                          {submitting
                            ? <><Loader2 size={16} className="rg-spin" aria-hidden="true" /> {submitStage || 'Submitting…'}</>
                            : <><Check size={16} aria-hidden="true" /> Confirm &amp; Submit</>}
                        </button>
                      </div>

                      <p style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 12 }}>
                        By submitting, you confirm all information is accurate.
                      </p>
                    </div>
                  </>
                )}

                {/* CONFIRMATION STEP */}
                {step === 'CONFIRMATION' && order && confirmation && (
                  <div className="rg-right-body" style={{ textAlign: 'center', padding: '40px 20px' }}>
                    <div className="rg-confirm-icon" aria-hidden="true">
                      <Check size={32} />
                    </div>
                    <h2 style={{ fontFamily: 'Georgia, serif', fontSize: 28, fontWeight: 500, color: 'var(--plum-deep)', letterSpacing: '-.04em', marginBottom: 8 }}>
                      {requestTypeName} Request Submitted!
                    </h2>
                    <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 28 }}>
                      Your {requestTypeName.toLowerCase()} request has been received successfully.
                    </p>

                    <div style={{ background: 'var(--soft)', border: '1px solid var(--line)', borderRadius: 16, padding: 20, textAlign: 'left', marginBottom: 20 }}>
                      <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 14 }}>
                        {requestTypeName} Details
                      </div>
                      {[
                        { label: `${requestTypeName} Authorization Number`, val: <span className="rg-ran-code">{confirmation.RAN}</span> },
                        { label: 'Order Number', val: order.name },
                        ...(!isExchangeOnly ? [{ label: `Refund Method${isMixedRequest ? ' (returned items)' : ''}`, val: selectedMethod === 'refund' ? 'Refund to Original Payment' : methodLabel(selectedMethod) }] : []),
                        ...(isMixedRequest ? [{ label: 'Exchange Items', val: 'Handled separately · no refund' }] : []),
                        { label: 'Estimated Processing', val: '5–7 business days' },
                      ].map(({ label, val }) => (
                        <div key={label} className="rg-summary-row" style={{ gap: 12 }}>
                          <span className="rg-summary-label">{label}</span>
                          <span className="rg-summary-val" style={{ textAlign: 'right', overflowWrap: 'anywhere' }}>{val}</span>
                        </div>
                      ))}

                      {!isExchangeOnly && (
                        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)', fontSize: 11, color: 'var(--muted)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                          <Info size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                          <span>
                            Final refund amount is subject to deductions for shipping charges, taxes, and applicable discounts.
                            {isMixedRequest ? ' This applies only to the returned item(s).' : ''}
                          </span>
                        </div>
                      )}
                    </div>

                    {confirmation.failedPhotos.length > 0 && (
                      <div className="rg-notice" role="alert">
                        <AlertCircle size={16} aria-hidden="true" />
                        <p>
                          <strong>Some photos could not be uploaded</strong> ({confirmation.failedPhotos.map((f) => `${f.title} – ${f.count} photo${f.count !== 1 ? 's' : ''}`).join('; ')}).
                          Your request has been created. Please send these photos to{' '}
                          <a href="mailto:support@prashantisarees.in" style={{ color: 'inherit', fontWeight: 800 }}>support@prashantisarees.in</a> or on{' '}
                          <a href="https://wa.me/919962505459" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', fontWeight: 800 }}>WhatsApp</a>{' '}
                          quoting RAN {confirmation.RAN}.
                        </p>
                      </div>
                    )}
                    {!confirmation.emailConfirmed && (
                      <div className="rg-notice" role="status">
                        <Info size={16} aria-hidden="true" />
                        <p>Your request is saved, but the confirmation e-mail may be delayed. Please note your RAN <strong>{confirmation.RAN}</strong> — you can track the request at any time.</p>
                      </div>
                    )}

                    {reviewData?.isReturnOnly && (
                      <div className="rg-info-box blue" style={{ textAlign: 'left' }}>
                        <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                        <p style={{ margin: 0, fontSize: 12 }}>
                          <strong>Important:</strong> Your refund will be processed to your {methodDestination(selectedMethod)}. Please allow 5–7 business days.
                        </p>
                      </div>
                    )}
                    {reviewData?.isExchangeOnly && (
                      <div className="rg-info-box plum" style={{ textAlign: 'left' }}>
                        <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                        <p style={{ margin: 0, fontSize: 12 }}>
                          <strong>Important:</strong> Your exchange request has been logged. Our team will review the details and initiate the replacement process shortly.
                        </p>
                      </div>
                    )}

                    <div className="rg-confirm-actions">
                      <Link to={trackUrl} className="rg-btn-ghost">
                        <Search size={15} aria-hidden="true" /> Track this request
                      </Link>
                      <button type="button" onClick={resetForm} className="rg-btn-solid">
                        <RotateCcw size={15} aria-hidden="true" /> Start New Request
                      </button>
                    </div>
                    <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 14 }}>
                      Need help? <a href="mailto:support@prashantisarees.in" style={{ color: 'var(--plum)', fontWeight: 700 }}>support@prashantisarees.in</a>
                    </p>
                  </div>
                )}
              </main>
            </div>
          </div>
        )}

        {/* FOOTER */}
        <footer className="rg-footer">
          <div className="rg-footer-inner">
            <div className="rg-footer-top">
              <div>
                <Link to="/CustomerPage" className="rg-brand" style={{ marginBottom: 0 }}>
                  <img src="/reguard-logo.png" alt="Re-guard by Prashanti" style={{ height: 36, objectFit: 'contain' }} />
                </Link>
                <p className="rg-footer-tagline">Traditional &amp; contemporary sarees for today's women — with thoughtful care from purchase to return.</p>
              </div>
              <nav className="rg-footer-links" aria-label="Footer">
                <div>
                  <h4>Navigate</h4>
                  <a href="#how-it-works">How it works</a>
                  <Link to="/ReturnStatusPage">Track a return</Link>
                  <a href="https://www.prashantisarees.com/account" target="_blank" rel="noopener noreferrer">My orders</a>
                  <a href="https://www.prashantisarees.com/pages/faq" target="_blank" rel="noopener noreferrer">FAQs</a>
                </div>
                <div>
                  <h4>Customer care</h4>
                  <a href="https://www.prashantisarees.com/account/login" target="_blank" rel="noopener noreferrer">Log in</a>
                  <a href="https://www.prashantisarees.com/account" target="_blank" rel="noopener noreferrer">My account</a>
                  <a href="mailto:support@prashantisarees.in">Email support</a>
                </div>
              </nav>
            </div>
            <div className="rg-footer-bottom">
              <span>© 2026 Re-guard by Prashanti. All rights reserved.</span>
              <span>
                <a href="https://www.prashantisarees.com/en-us/pages/return-policy" target="_blank" rel="noopener noreferrer">Return policy</a>
                {' · '}
                <a href="https://www.prashantisarees.com/pages/faq" target="_blank" rel="noopener noreferrer">FAQs</a>
                {' · '}
                <a href="https://wa.me/919962505459" target="_blank" rel="noopener noreferrer">WhatsApp</a>
              </span>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
};

export default ReturnPortalSplit;

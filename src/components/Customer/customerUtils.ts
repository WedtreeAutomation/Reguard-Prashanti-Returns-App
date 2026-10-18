/**
 * Constants and pure helpers for the public return/exchange wizard.
 * The server re-validates everything; these checks only drive the UX.
 */
import type { PublicLineItem, ProductDetails, RequestedMethod } from '../../Interfaces/publicApi';

export const RETURN_REASONS = [
  'Wrong item shipped',
  'Color mismatch',
  'Size/fit issue',
  'Product quality issue',
  'I received a defective item',
  'Delivery was delayed',
  'Other reason',
] as const;

export const OTHER_REASON = 'Other reason';
/** Reasons that qualify for a refund to the original payment method. */
export const DEFECT_REASONS: readonly string[] = ['I received a defective item', 'Wrong item shipped'];
export const MIN_NOTE_WORDS = 3;
/** Backend accepts 1–5 photos per item (CONTRACT §3). */
export const MAX_IMAGES = 5;
export const MANDATORY_IMAGES = 2;
/** Largest photo we accept from the device (it is compressed before upload). */
export const MAX_INPUT_FILE_SIZE = 20 * 1024 * 1024;
/** Server limit per uploaded photo. */
export const MAX_UPLOAD_FILE_SIZE = 8 * 1024 * 1024;
export const ALLOWED_FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

export const CUSTOM_KEYWORDS = [
  'custom', 'tailoring', 'bespoke', 'bspoke', 'stitching',
  'blouse', 'fall', 'pico', 'measurements', 'saree finishing', 'tassels',
];

/** Statuses after which a request no longer blocks a new one (CONTRACT §2). */
export const TERMINAL_STATUSES = ['closed', 'denied', 'rejected', 'completed', 'exchanged_created', 'cancelled'];
export const isTerminalStatus = (status?: string | null) => TERMINAL_STATUSES.includes((status || '').trim().toLowerCase());

export type Step = 'LOGIN' | 'SELECT' | 'METHOD' | 'REVIEW' | 'CONFIRMATION';
export const STEPS: Step[] = ['LOGIN', 'SELECT', 'METHOD', 'REVIEW', 'CONFIRMATION'];
export const STEP_LABELS: Record<Step, string> = {
  LOGIN: 'Find Order',
  SELECT: 'Select Items',
  METHOD: 'Refund Method',
  REVIEW: 'Review',
  CONFIRMATION: 'Done',
};

export type IneligibleType = 'custom' | 'active_return' | 'international' | 'time_window';

export interface ItemDetails {
  qty: number;
  reason: string;
  note: string;
  actionType: 'return' | 'exchange' | '';
}

/** One selected photo; `url` is an object URL used for previews. */
export interface SelectedImage {
  file: File;
  url: string;
}

export const emptySlots = (): (SelectedImage | null)[] => Array(MAX_IMAGES).fill(null);

const isGibberishWord = (word: string): boolean => /^(.{1,3})\1{2,}$/i.test(word);

export const countWords = (note: string): number => (note || '').trim().split(/\s+/).filter(Boolean).length;

export const isValidAdditionalNote = (note: string): boolean => {
  if (!note || note.trim().length === 0) return false;
  const words = note.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length < MIN_NOTE_WORDS) return false;
  return words.every((word) => word.length >= 2 && !isGibberishWord(word));
};

/** The note is mandatory for "Other reason" and for defective / wrong-item claims. */
export const isNoteRequired = (reason: string) => reason === OTHER_REASON || DEFECT_REASONS.includes(reason);

export const getRequestTypeName = (hasReturnItems: boolean, hasExchangeItems: boolean): string => {
  if (hasExchangeItems && hasReturnItems) return 'Return & Exchange';
  if (hasExchangeItems) return 'Exchange';
  return 'Return';
};

export const methodLabel = (method: RequestedMethod): string =>
  method === 'refund' ? 'Original payment' : method === 'store_credit' ? 'Store credit' : method === 'gift_card' ? 'Gift card' : 'No refund';

export const methodDestination = (method: RequestedMethod): string =>
  method === 'refund' ? 'original payment method' : method === 'store_credit' ? 'store account' : 'email as a gift card';

export const parsePrice = (price: string | number | null | undefined): number => {
  if (typeof price === 'number') return Number.isFinite(price) ? price : 0;
  const n = parseFloat(String(price ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

export const formatCurrency = (amount: string | number): string =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(parsePrice(amount));

export const isCustomizedItem = (item: PublicLineItem, productDetails: Record<number, ProductDetails>): boolean => {
  const has = (text: unknown) => {
    const lower = String(text ?? '').toLowerCase();
    return !!lower && CUSTOM_KEYWORDS.some((k) => lower.includes(k));
  };
  const tags = item.product_id ? productDetails[item.product_id]?.tags || [] : [];
  if (tags.some(has)) return true;
  if (has(item.title)) return true;
  if (Array.isArray(item.properties) && item.properties.some((p) => has(p?.name) || has(p?.value))) return true;
  if (has(item.variant_title)) return true;
  if (item.sku && /-CUST|-BSP/i.test(item.sku)) return true;
  return false;
};

const isHeic = (file: File) => file.type === 'image/heic' || (!file.type && /\.heic$/i.test(file.name));

export const validateInputFile = (file: File): string => {
  if (!ALLOWED_FILE_TYPES.includes(file.type) && !isHeic(file)) return 'Only JPEG, PNG, WebP and HEIC photos are allowed';
  if (file.size > MAX_INPUT_FILE_SIZE) return 'Photo is larger than 20 MB';
  return '';
};

/**
 * Downscales a photo to at most `maxDim` px on its longest side and re-encodes
 * it as JPEG. Formats the browser cannot decode (e.g. HEIC outside Safari) are
 * returned unchanged.
 */
export const compressImage = (file: File, maxDim = 1600, quality = 0.8): Promise<File> =>
  new Promise((resolve) => {
    if (typeof document === 'undefined') { resolve(file); return; }
    let objectUrl = '';
    try {
      objectUrl = URL.createObjectURL(file);
    } catch {
      resolve(file);
      return;
    }
    const img = new Image();
    const done = (result: File) => {
      URL.revokeObjectURL(objectUrl);
      resolve(result);
    };
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) { done(file); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (blob && blob.size > 0 && blob.size < file.size) {
            done(new File([blob], file.name.replace(/\.[^/.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: Date.now() }));
          } else {
            done(file);
          }
        }, 'image/jpeg', quality);
      } catch {
        done(file);
      }
    };
    img.onerror = () => done(file);
    img.src = objectUrl;
  });

export const daysBetween = (fromIso: string | null | undefined, to = new Date()): number => {
  const t = fromIso ? new Date(fromIso).getTime() : NaN;
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((to.getTime() - t) / 86400000));
};

export const formatDate = (iso: string | null | undefined, withTime = false): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', withTime
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { day: 'numeric', month: 'long', year: 'numeric' });
};

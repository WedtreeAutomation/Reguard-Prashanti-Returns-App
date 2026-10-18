/**
 * HTTP clients for the Re-Guard backend.
 *
 * - `apiClient`   : staff (agent/admin) calls. Attaches the signed-in Firebase
 *                   user's ID token as `Authorization: Bearer …`.
 * - `publicClient`: customer-portal calls. Attaches the short-lived customer
 *                   token (scoped to one order) as `X-Customer-Token` when one
 *                   has been issued by /public/orders/verify.
 *
 * No shared secret is shipped in the bundle any more.
 */
import axios, { AxiosError, AxiosInstance } from 'axios';
import { auth } from './firebase';

export const API_BASE_URL: string = (import.meta.env.VITE_FLASK_API_URL as string | undefined) || '/api';

/** Fired when the backend says the staff session is no longer valid. */
export const SESSION_EXPIRED_EVENT = 'reguard:session-expired';

const withDefaults = (client: AxiosInstance): AxiosInstance => {
  client.defaults.headers.common['Content-Type'] = 'application/json';
  return client;
};

export const apiClient = withDefaults(axios.create({ baseURL: API_BASE_URL, timeout: 90000 }));

apiClient.interceptors.request.use(async (config) => {
  const user = auth.currentUser;
  if (user) {
    const token = await user.getIdToken();
    config.headers = config.headers ?? {};
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<{ code?: string }>) => {
    const status = error.response?.status;
    const code = error.response?.data?.code;
    // One silent retry with a force-refreshed token (covers a token that
    // expired between the request being built and reaching the server).
    const cfg = error.config as (typeof error.config & { _retried?: boolean }) | undefined;
    if (status === 401 && code === 'session_expired' && cfg && !cfg._retried && auth.currentUser) {
      cfg._retried = true;
      try {
        const fresh = await auth.currentUser.getIdToken(true);
        cfg.headers = cfg.headers ?? {};
        cfg.headers['Authorization'] = `Bearer ${fresh}`;
        return apiClient.request(cfg);
      } catch {
        /* fall through */
      }
    }
    if (status === 401 && (code === 'session_expired' || code === 'auth_required' || code === 'account_missing')) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    }
    return Promise.reject(error);
  }
);

// ---------------------------------------------------------------------------
// Customer token (public portal)
// ---------------------------------------------------------------------------
const CUSTOMER_TOKEN_KEY = 'reguard_customer_token';
let customerTokenMemory: string | null = null;

export const setCustomerToken = (token: string | null) => {
  customerTokenMemory = token;
  try {
    if (token) sessionStorage.setItem(CUSTOMER_TOKEN_KEY, token);
    else sessionStorage.removeItem(CUSTOMER_TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) — memory copy still works */
  }
};

export const getCustomerToken = (): string | null => {
  if (customerTokenMemory) return customerTokenMemory;
  try {
    customerTokenMemory = sessionStorage.getItem(CUSTOMER_TOKEN_KEY);
  } catch {
    customerTokenMemory = null;
  }
  return customerTokenMemory;
};

export const publicClient = withDefaults(axios.create({ baseURL: API_BASE_URL, timeout: 90000 }));

publicClient.interceptors.request.use((config) => {
  const token = getCustomerToken();
  if (token) {
    config.headers = config.headers ?? {};
    config.headers['X-Customer-Token'] = token;
  }
  return config;
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
/**
 * Human-readable message for any error thrown by axios or our own code.
 * Prefers the backend's `{ error }` body, then status-based fallbacks.
 */
export const getApiErrorMessage = (err: unknown, fallback = 'Something went wrong. Please try again.'): string => {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string; message?: string } | undefined;
    if (data?.error) return data.error;
    if (data?.message) return data.message;
    if (err.code === 'ECONNABORTED') return 'The request timed out. Please try again.';
    if (!err.response) return 'Network error. Please check your connection.';
    switch (err.response.status) {
      case 401: return 'Your session has expired. Please sign in again.';
      case 403: return 'You do not have permission to perform this action.';
      case 404: return 'The requested item was not found.';
      case 409: return 'This action is already in progress or was already completed.';
      case 429: return 'Too many attempts. Please wait a few minutes and try again.';
      default: return fallback;
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
};

/** HTTP status of an axios error (undefined for network/other errors). */
export const getApiErrorStatus = (err: unknown): number | undefined =>
  axios.isAxiosError(err) ? err.response?.status : undefined;

/** Random idempotency key for money-moving calls (one per user attempt). */
export const newIdempotencyKey = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
};

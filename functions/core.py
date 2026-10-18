"""
Shared configuration, clients and small helpers for the Re-Guard backend.

Everything here is import-safe without credentials (tests run against stubs):
Firebase / Shopify clients are created only when configured and every helper
degrades gracefully.

Environment variables (see CONTRACT.md §8). New names win; the old
``VITE_``-prefixed names are still read as a fallback and log a one-time
deprecation warning.
"""
import base64
import hashlib
import hmac
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

import requests
from dotenv import load_dotenv

import firebase_admin
from firebase_admin import credentials, firestore, storage as fb_storage

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("reguard")


# ==========================================================
# ENVIRONMENT
# ==========================================================
_deprecation_lock = threading.Lock()
_deprecation_warned: set = set()


def env(name: str, default: Optional[str] = None, legacy: Optional[str] = None) -> Optional[str]:
    """Read ``name``; fall back to the legacy (``VITE_<name>`` by default) name.

    A deprecation warning is logged once per legacy variable actually used.
    Empty strings count as unset.
    """
    value = os.environ.get(name)
    if value not in (None, ""):
        return value
    legacy_name = legacy or f"VITE_{name}"
    legacy_value = os.environ.get(legacy_name)
    if legacy_value not in (None, ""):
        with _deprecation_lock:
            if legacy_name not in _deprecation_warned:
                _deprecation_warned.add(legacy_name)
                logger.warning(f"Environment variable {legacy_name} is deprecated; rename it to {name}.")
        return legacy_value
    return default


def env_int(name: str, default: int) -> int:
    try:
        return int(env(name, str(default)) or default)
    except (TypeError, ValueError):
        return default


# ==========================================================
# FIREBASE INITIALIZATION
# ==========================================================
db = None
bucket = None
STORAGE_BUCKET = env("STORAGE_BUCKET") or ""


def _init_firebase():
    """Initialise firebase_admin once. Uses explicit service-account env vars,
    or Application Default Credentials when running on Google Cloud."""
    fb_client_email = os.getenv("FB_CLIENT_EMAIL")
    fb_project_id = os.getenv("FB_PROJECT_ID")
    fb_private_key = os.getenv("FB_PRIVATE_KEY")
    options = {"storageBucket": STORAGE_BUCKET} if STORAGE_BUCKET else {}
    if getattr(firebase_admin, "_apps", None):
        return firestore.client(), (fb_storage.bucket() if STORAGE_BUCKET else None)
    if fb_client_email and fb_project_id and fb_private_key:
        cred = credentials.Certificate({
            "type": "service_account",
            "project_id": fb_project_id,
            "private_key": fb_private_key.replace('\\n', '\n'),
            "client_email": fb_client_email,
            "token_uri": "https://oauth2.googleapis.com/token",
        })
        firebase_admin.initialize_app(cred, options)
    elif os.getenv("K_SERVICE") or os.getenv("FUNCTION_TARGET"):
        # Running on Cloud Functions / Cloud Run: use the runtime service account.
        firebase_admin.initialize_app(options=options or None)
    else:
        logger.warning("Firebase credentials missing (FB_CLIENT_EMAIL / FB_PROJECT_ID / FB_PRIVATE_KEY)")
        return None, None
    return firestore.client(), (fb_storage.bucket() if STORAGE_BUCKET else None)


try:
    db, bucket = _init_firebase()
    if db is not None and bucket is None:
        logger.warning("STORAGE_BUCKET is not configured; image uploads are disabled")
except Exception as e:  # never crash at import time
    logger.error(f"Failed to initialize Firebase: {type(e).__name__}: {e}")
    db, bucket = None, None


# ==========================================================
# SHOPIFY CONFIGURATION
# ==========================================================
SHOPIFY_STORE = (env('SHOPIFY_SHOP_DOMAIN') or '').strip().replace('https://', '').rstrip('/')
SHOPIFY_ACCESS_TOKEN = env('SHOPIFY_ACCESS_TOKEN') or ''
SHOPIFY_API_VERSION = env('SHOPIFY_API_VERSION') or '2025-01'
SHOPIFY_WEBHOOK_SECRET = env('SHOPIFY_WEBHOOK_SECRET') or ''
SHOPIFY_BASE_URL = f"https://{SHOPIFY_STORE}/admin/api/{SHOPIFY_API_VERSION}"
SHOPIFY_GRAPHQL_URL = f"https://{SHOPIFY_STORE}/admin/api/{SHOPIFY_API_VERSION}/graphql.json"

DEFAULT_PUBLIC_APP_URL = 'https://prashantireturns.web.app'
PUBLIC_APP_URL = (os.environ.get('PUBLIC_APP_URL') or DEFAULT_PUBLIC_APP_URL).rstrip('/')
WEBHOOK_CALLBACK_PATH = '/api/webhooks/shopify/orders-paid'

shopify_session = requests.Session()
shopify_session.headers.update({
    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json',
})


# ==========================================================
# BRAND / NOTIFICATION CONFIG
# ==========================================================
BRAND_NAME = os.environ.get('BRAND_NAME') or 'Prashanti Sarees'
BRAND_LOGO_URL = os.environ.get('BRAND_LOGO_URL') or f'{PUBLIC_APP_URL}/reguard-logo.png'
BRAND_PRIMARY_COLOR = '#560835'
SUPPORT_EMAIL = os.environ.get('SUPPORT_EMAIL') or 'support@prashantisarees.in'
SUPPORT_PHONE = os.environ.get('SUPPORT_PHONE') or '+91 99625 05459'
STORE_WEBSITE_URL = (os.environ.get('STORE_WEBSITE_URL') or 'https://www.prashantisarees.com').rstrip('/')
RETURN_POLICY_URL = os.environ.get('RETURN_POLICY_URL') or f'{STORE_WEBSITE_URL}/pages/cancellation-and-refund'

N8N_WEBHOOK_TOKEN = os.environ.get('N8N_WEBHOOK_TOKEN') or ''
N8N_NOTIFY_WEBHOOK = os.environ.get('N8N_NOTIFY_WEBHOOK') or ''
N8N_OTP_WEBHOOK = os.environ.get('N8N_OTP_WEBHOOK')
N8N_EXCHANGE_PROCESSED_WEBHOOK = os.environ.get('N8N_EXCHANGE_PROCESSED_WEBHOOK')
N8N_RETURN_APPLIED_WEBHOOK = os.environ.get('N8N_RETURN_APPLIED_WEBHOOK')
N8N_EXCHANGE_APPLIED_WEBHOOK = os.environ.get('N8N_EXCHANGE_APPLIED_WEBHOOK')
N8N_MIXED_APPLIED_WEBHOOK = os.environ.get('N8N_MIXED_APPLIED_WEBHOOK')
N8N_REJECTION_WEBHOOK = os.environ.get('N8N_REJECTION_WEBHOOK')
N8N_CLOSED_WEBHOOK = os.environ.get('N8N_CLOSED_WEBHOOK')
N8N_SELF_SHIP_WEBHOOK = os.environ.get('N8N_SELF_SHIP_WEBHOOK')
N8N_REFUND_DONE_WEBHOOK = os.environ.get('N8N_REFUND_DONE_WEBHOOK')
N8N_PICKUP_CREATED_WEBHOOK = os.environ.get('N8N_PICKUP_CREATED_WEBHOOK')
N8N_PICKUP_CANCELLED_WEBHOOK = os.environ.get('N8N_PICKUP_CANCELLED_WEBHOOK')
N8N_RETURN_RECEIVED_WEBHOOK = os.environ.get('N8N_RETURN_RECEIVED_WEBHOOK')
N8N_ITEM_REJECTION_WEBHOOK = os.environ.get('N8N_ITEM_REJECTION_WEBHOOK')


# ==========================================================
# RETURN STATUS RULES
# ==========================================================
TERMINAL_STATUSES = frozenset({'closed', 'denied', 'rejected', 'completed', 'exchanged_created', 'cancelled'})
# Requests in these states no longer "hold" the items they asked for.
RELEASED_STATUSES = frozenset({'closed', 'denied', 'rejected', 'cancelled'})


def is_terminal_status(status: Any) -> bool:
    return str(status or '').strip().lower() in TERMINAL_STATUSES


# ==========================================================
# TIME / MONEY HELPERS
# ==========================================================
IST = timezone(timedelta(hours=5, minutes=30), name='IST')
_MS_DATE_RE = re.compile(r'^/Date\((-?\d+)([+-]\d{4})?\)/$')


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def now_ms() -> int:
    return int(utcnow().timestamp() * 1000)


def to_datetime(value: Any) -> Optional[datetime]:
    """Best-effort conversion of Firestore timestamps, datetimes, ISO strings,
    epoch numbers (s or ms), BlueDart ``/Date(ms)/`` strings and
    ``{_seconds|seconds}`` dicts to an aware UTC datetime."""
    if value is None or value == '':
        return None
    try:
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            seconds = value / 1000.0 if value > 1e11 else float(value)
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        if isinstance(value, dict):
            secs = value.get('_seconds', value.get('seconds'))
            return datetime.fromtimestamp(float(secs), tz=timezone.utc) if secs is not None else None
        if hasattr(value, 'timestamp') and callable(value.timestamp):
            return datetime.fromtimestamp(value.timestamp(), tz=timezone.utc)
        if isinstance(value, str):
            s = value.strip()
            m = _MS_DATE_RE.match(s)
            if m:
                return datetime.fromtimestamp(int(m.group(1)) / 1000.0, tz=timezone.utc)
            if s.endswith('Z'):
                s = s[:-1] + '+00:00'
            dt = datetime.fromisoformat(s)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None
    return None


def iso_utc(value: Any) -> Optional[str]:
    dt = to_datetime(value)
    return dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z') if dt else None


def ist_display(value: Any, with_time: bool = True) -> Optional[str]:
    """'9 Oct 2026, 1:30 PM IST' (or '9 Oct 2026' when with_time is False)."""
    dt = to_datetime(value)
    if not dt:
        return None
    local = dt.astimezone(IST)
    date_part = f"{local.day} {local.strftime('%b %Y')}"
    if not with_time:
        return date_part
    hour = local.hour % 12 or 12
    return f"{date_part}, {hour}:{local.strftime('%M')} {'AM' if local.hour < 12 else 'PM'} IST"


def money(value: Any) -> float:
    """Round an amount to 2 dp (CONTRACT §0)."""
    return round(parse_amount(value) + 1e-9, 2)


def parse_amount(value: Any) -> float:
    """Parse '₹2,499.00', '2499', 2499.0, None -> float (0.0 on failure)."""
    if value is None or isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    cleaned = re.sub(r'[^0-9.\-]', '', str(value))
    try:
        return float(cleaned) if cleaned not in ('', '-', '.') else 0.0
    except ValueError:
        return 0.0


def safe_int(value: Any, default: Optional[int] = None) -> Optional[int]:
    try:
        if isinstance(value, bool):
            return default
        if isinstance(value, str) and '/' in value:  # Shopify GID
            value = value.rsplit('/', 1)[-1]
        return int(value)
    except (TypeError, ValueError):
        return default


# ==========================================================
# SHOPIFY WEBHOOK VERIFICATION
# ==========================================================
def verify_shopify_webhook(req) -> bool:
    """Verify an incoming Shopify webhook's HMAC signature (the only gate on
    the public orders/paid webhook)."""
    if not SHOPIFY_WEBHOOK_SECRET:
        logger.error("SHOPIFY_WEBHOOK_SECRET is not configured -- refusing to process webhook.")
        return False
    hmac_header = req.headers.get('X-Shopify-Hmac-Sha256', '')
    if not hmac_header:
        return False
    digest = hmac.new(SHOPIFY_WEBHOOK_SECRET.encode('utf-8'), req.get_data(), hashlib.sha256).digest()
    computed_hmac = base64.b64encode(digest).decode('utf-8')
    return hmac.compare_digest(computed_hmac, hmac_header)


# ==========================================================
# CUSTOMER IDENTITY HELPERS
# ==========================================================
EMAIL_RE = re.compile(r'^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$')


def normalize_phone(phone: Any) -> str:
    """Digits only, last 10 (Indian mobile without country code)."""
    if not phone:
        return ''
    return re.sub(r'\D', '', str(phone))[-10:]


def is_valid_email(value: Any) -> bool:
    return isinstance(value, str) and len(value) <= 254 and bool(EMAIL_RE.match(value.strip()))


def verify_order_ownership(order: Dict[str, Any], verification_input: Any) -> bool:
    """True when ``verification_input`` is the order's e-mail (exact,
    case-insensitive) or, for inputs with at least 10 digits, the last 10
    digits equal a phone on the order. Empty values never match."""
    if not order or not isinstance(verification_input, str):
        return False
    supplied = verification_input.strip().lower()
    if not supplied:
        return False
    customer = order.get('customer') or {}
    shipping = order.get('shipping_address') or {}
    billing = order.get('billing_address') or {}

    if '@' in supplied:
        emails = {(order.get('email') or '').strip().lower(), (customer.get('email') or '').strip().lower()}
        emails.discard('')
        return any(hmac.compare_digest(supplied, e) for e in emails)

    digits = re.sub(r'\D', '', supplied)
    if len(digits) < 10:
        return False
    supplied_phone = digits[-10:]
    phones = {normalize_phone(p) for p in (order.get('phone'), customer.get('phone'),
                                           shipping.get('phone'), billing.get('phone'))}
    phones = {p for p in phones if len(p) == 10}
    return any(hmac.compare_digest(supplied_phone, p) for p in phones)


def make_json_serializable(data):
    """Recursively converts Firestore timestamps / datetimes to ISO strings."""
    if isinstance(data, dict):
        return {k: make_json_serializable(v) for k, v in data.items()}
    if isinstance(data, (list, tuple)):
        return [make_json_serializable(v) for v in data]
    if hasattr(data, 'isoformat'):
        return data.isoformat()
    return data


# ==========================================================
# SHOPIFY HELPERS
# ==========================================================
class ShopifyError(Exception):
    """Raised when a Shopify call fails (message is safe to log, not to show)."""


def shopify_headers():
    """Headers for Shopify Admin API requests."""
    return {'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json'}


def shopify_configured() -> bool:
    return bool(SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN)


def shopify_graphql(query: str, variables: Optional[Dict[str, Any]] = None, timeout: int = 15) -> Dict[str, Any]:
    """POST a GraphQL query; returns ``data`` or raises ShopifyError."""
    if not shopify_configured():
        raise ShopifyError("Shopify is not configured")
    try:
        resp = shopify_session.post(SHOPIFY_GRAPHQL_URL, json={"query": query, "variables": variables or {}},
                                    timeout=timeout)
    except requests.RequestException as e:
        raise ShopifyError(f"Shopify request failed: {type(e).__name__}") from e
    if resp.status_code != 200:
        raise ShopifyError(f"Shopify HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError as e:
        raise ShopifyError("Shopify returned invalid JSON") from e
    if payload.get('errors'):
        messages = [str(err.get('message', err)) if isinstance(err, dict) else str(err) for err in payload['errors']]
        raise ShopifyError("GraphQL error: " + "; ".join(messages)[:500])
    return payload.get('data') or {}


def shopify_timeline_note(order_id: Any, ran: str, title: str, message: str) -> bool:
    """Push an entry to the order timeline.

    Delegates to ``ShopifyService.add_timeline_note``: the merchant's note is
    read first (nothing is written if it cannot be read), overwritten with the
    message (creating a timeline event) and restored with retries -- so the
    merchant note is never wiped by a single failed restore.
    """
    numeric_id = safe_int(order_id)
    if not numeric_id or not shopify_configured():
        return False
    try:
        from shopify_service import get_shopify_service  # local: shopify_service imports core
        return bool(get_shopify_service().add_timeline_note(numeric_id, f"📦 [RAN: {ran}] {title}\n{message}"[:5000]))
    except Exception as e:
        logger.error(f"Timeline note failed for order {numeric_id}: {type(e).__name__}")
        return False


def shopify_add_tag(order_id: Any, tag: str) -> bool:
    """Append ``tag`` to the order's tags (no-op if present). Returns success."""
    numeric_id = safe_int(order_id)
    tag = (tag or '').strip()[:255]
    if not numeric_id or not tag or not shopify_configured():
        return False
    url = f"{SHOPIFY_BASE_URL}/orders/{numeric_id}.json"
    try:
        resp = shopify_session.get(url, params={'fields': 'id,tags'}, timeout=10)
        if resp.status_code != 200:
            return False
        current = (resp.json().get('order') or {}).get('tags') or ''
        tags = [t.strip() for t in current.split(',') if t.strip()]
        if tag in tags:
            return True
        tags.append(tag)
        upd = shopify_session.put(url, json={"order": {"id": numeric_id, "tags": ", ".join(tags)}}, timeout=10)
        return upd.status_code == 200
    except (requests.RequestException, ValueError) as e:
        logger.error(f"Adding tag to order {numeric_id} failed: {type(e).__name__}")
        return False


# ==========================================================
# OUTBOUND WEBHOOKS (n8n)
# ==========================================================
def trigger_webhook(url, payload, log_context, timeout: int = 25, retries: int = 1) -> bool:
    """POST ``payload`` as JSON synchronously and return True only on a 2xx.

    Synchronous on purpose: Cloud Functions may freeze background threads as
    soon as the response is sent. Adds ``X-Reguard-Token`` when
    N8N_WEBHOOK_TOKEN is configured.

    Retries (once) only when the request certainly did not produce an e-mail:
    a connection failure before the request was sent, or a 5xx / 429 reply
    (the n8n workflow answers after the Gmail node, so 5xx means not sent).
    A read timeout is NOT retried: n8n may still be sending the e-mail and a
    retry could deliver it twice.
    """
    if not url:
        logger.warning(f"{log_context}: webhook URL not configured; notification skipped")
        return False
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if N8N_WEBHOOK_TOKEN:
        headers['X-Reguard-Token'] = N8N_WEBHOOK_TOKEN
    for attempt in range(retries + 1):
        try:
            response = requests.post(url, json=payload, headers=headers, timeout=(5, timeout))
            if 200 <= response.status_code < 300:
                logger.info(f"{log_context}: webhook delivered")
                return True
            logger.warning(f"{log_context}: webhook returned HTTP {response.status_code} (attempt {attempt + 1})")
            if response.status_code < 500 and response.status_code != 429:
                return False
        except requests.exceptions.ReadTimeout:
            logger.warning(f"{log_context}: webhook timed out waiting for n8n; not retrying to avoid duplicate e-mails")
            return False
        except requests.RequestException as e:
            logger.warning(f"{log_context}: webhook failed ({type(e).__name__}, attempt {attempt + 1})")
        if attempt < retries:
            time.sleep(1.5)
    return False


# ==========================================================
# DOWNLOAD PROXY HOST ALLOW-LIST
# ==========================================================
def _is_allowed_download_url(parsed) -> bool:
    """Exact allow-list for the image download proxy (SSRF guard).

    * cdn.shopify.com
    * firebasestorage.googleapis.com (only our bucket when one is configured)
    * storage.googleapis.com/<our bucket>/...
    * the configured *.myshopify.com store domain
    """
    if parsed.scheme != 'https' or parsed.port not in (None, 443) or parsed.username or parsed.password:
        return False
    host = (parsed.hostname or '').lower().rstrip('.')
    path = parsed.path or ''
    if host == 'cdn.shopify.com':
        return True
    if host == 'firebasestorage.googleapis.com':
        return not STORAGE_BUCKET or path.startswith(f'/v0/b/{STORAGE_BUCKET}/')
    if host == 'storage.googleapis.com':
        return bool(STORAGE_BUCKET) and path.startswith(f'/{STORAGE_BUCKET}/')
    if SHOPIFY_STORE and host == SHOPIFY_STORE.lower() and host.endswith('.myshopify.com'):
        return True
    return False


def _is_allowed_download_host(hostname: Optional[str]) -> bool:
    """Backward-compatible host-only check (prefer _is_allowed_download_url)."""
    host = (hostname or '').lower()
    return host in {'cdn.shopify.com', 'firebasestorage.googleapis.com'} or (
        bool(SHOPIFY_STORE) and host == SHOPIFY_STORE.lower())


def _safe_filename(name: str, fallback: str = 'file') -> str:
    name = (name or '').strip()
    name = re.sub(r'[^A-Za-z0-9_.\-]', '_', name)[:120].lstrip('.')
    return name or fallback


def process_return_submission(return_data):
    """Derive the overall actionType ('return' | 'exchange' | 'mixed') from items."""
    try:
        items = return_data.get('items', []) or []
        action_types = {str(i.get('actionType')).lower() for i in items if i.get('actionType')}
        if 'return' in action_types and 'exchange' in action_types:
            overall = 'mixed'
        elif 'exchange' in action_types:
            overall = 'exchange'
        else:
            overall = 'return'
        return_data['actionType'] = overall
        for item in items:
            item['actionType'] = item.get('actionType', 'return')
        return return_data
    except (AttributeError, TypeError) as e:
        logger.error(f"Error processing return submission: {e}")
        return return_data


# ==========================================================
# REFUND CLASSES (used by shopify_service / routes_refunds)
# ==========================================================
class RefundMethod(Enum):
    """Enum for refund methods"""
    GIFT_CARD = "giftcard"
    STORE_CREDIT = "store_credit"
    ORIGINAL_PAYMENT = "original"
    MANUAL = "manual"


@dataclass
class RefundResult:
    """Data class for refund results"""
    success: bool
    refund_method: RefundMethod
    refund_id: Optional[str] = None
    transaction_id: Optional[str] = None
    amount: Optional[str] = None
    currency: Optional[str] = None
    customer_id: Optional[str] = None
    customer_email: Optional[str] = None
    gift_card_code: Optional[str] = None
    raw_response: Optional[Dict] = None
    error_message: Optional[str] = None
    transactions: Optional[List[Dict]] = None
    order_name: Optional[str] = None
    store_credit_transaction_id: Optional[str] = None
    account_balance: Optional[Dict] = None
    firebase_updated: bool = False
    firebase_error: Optional[str] = None

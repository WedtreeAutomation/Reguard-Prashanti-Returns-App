"""
Authentication, authorization and abuse-protection helpers.

Staff (agents / admins / super admins)
--------------------------------------
* Agents log in through /api/auth/login. On success the backend mints a
  Firebase *custom token* (uid = lower-cased email, developer claims
  ``staff=True`` and ``role``). The browser signs in with it
  (``signInWithCustomToken``) and from then on sends the Firebase **ID token**
  on every API call as ``Authorization: Bearer <id token>``.
* ``require_staff`` verifies that ID token, then loads the agent's Firestore
  record on every request, so a role change, deactivation or deletion takes
  effect immediately (the role inside the token is never trusted on its own).
* The same custom claims let Firestore security rules tell staff apart from
  anonymous visitors (see firestore.rules).

Customers (public return portal)
--------------------------------
* A customer proves ownership of an order with order number + the email or
  phone on that order (/api/public/orders/verify). The backend then issues a
  short-lived, HMAC-signed *customer token* scoped to that single order.
* ``require_customer`` validates that token on the customer endpoints.

Also here: password hashing (scrypt, stdlib only), a Firestore-backed rate
limiter that works across Cloud Function instances, and small request
helpers.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from functools import wraps
from typing import Any, Dict, Iterable, Optional

from flask import g, jsonify, request
from firebase_admin import auth as fb_auth
from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from core import db, logger

STAFF_ROLES = ("agent", "admin", "super_admin")
ADMIN_ROLES = ("admin", "super_admin")
SUPER_ADMIN_ROLES = ("super_admin",)

APP_SECRET_KEY = os.environ.get("APP_SECRET_KEY", "")
CUSTOMER_TOKEN_TTL_SECONDS = int(os.environ.get("CUSTOMER_TOKEN_TTL_SECONDS", "3600"))


# ==========================================================
# REQUEST HELPERS
# ==========================================================
def json_body() -> Dict[str, Any]:
    """Return the JSON body as a dict (never None, never a list)."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _trusted_proxy_hops() -> int:
    try:
        return max(0, int(os.environ.get("TRUSTED_PROXY_HOPS", "2")))
    except ValueError:
        return 2


def client_ip() -> str:
    """Best client IP for rate limiting.

    ``X-Forwarded-For`` is a list every proxy APPENDS to: anything a client
    sends itself ends up at the LEFT, so the first entry is attacker-chosen
    and must never be trusted (the old behaviour). The trustworthy value is
    the entry appended by the outermost proxy we control: counting from the
    RIGHT, the client address is the entry at position
    ``-TRUSTED_PROXY_HOPS``.

    Default ``2``: this API is reached through the Firebase Hosting rewrite
    (``/api/** -> function``). Hosting's CDN appends the visitor address,
    then Google's front end in front of Cloud Run appends the CDN hop, so the
    right-most entry is a shared Google/Fastly edge address (using it would
    put every customer behind one rate-limit bucket) and the visitor is the
    second entry from the right.
    * ``1``: the function is called directly (Cloud Run / Functions URL,
      no Hosting in front).
    * ``0``: ignore the header and use the socket peer address.
    Verify once after deploying (log a request from a known IP) before
    changing it: a too-large value re-opens spoofing, a too-small one
    merges users. Restrict the function's ingress to Hosting/internal traffic
    so the header cannot be forged by calling the Cloud Run URL directly.
    """
    hops = _trusted_proxy_hops()
    fwd = request.headers.get("X-Forwarded-For", "")
    entries = [e.strip() for e in fwd.split(",") if e.strip()] if hops else []
    if entries:
        return entries[-hops] if len(entries) >= hops else entries[0]
    return request.remote_addr or "unknown"


def error_response(message: str, status: int = 400, **extra):
    """Uniform error body: {"success": false, "error": "..."}."""
    body = {"success": False, "error": message}
    body.update(extra)
    return jsonify(body), status


def normalize_email(email: Optional[str]) -> str:
    return (email or "").strip().lower()


# ==========================================================
# PASSWORD HASHING (scrypt, constant-time verify)
# ==========================================================
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2 ** 14, 8, 1


def hash_password(password: str) -> str:
    if not isinstance(password, str) or not password:
        raise ValueError("Password must be a non-empty string")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=32)
    return "scrypt${}${}${}${}${}".format(
        _SCRYPT_N, _SCRYPT_R, _SCRYPT_P,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, stored: Optional[str]) -> bool:
    """Verify ``password`` against a hash produced by ``hash_password``.

    Never accepts plain-text stored values; callers that still hold legacy
    plain-text passwords must migrate them explicitly (see routes_auth).
    """
    if not password or not stored or not stored.startswith("scrypt$"):
        return False
    try:
        _, n, r, p, salt_b64, hash_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=int(n), r=int(r), p=int(p), dklen=len(expected))
        return hmac.compare_digest(digest, expected)
    except Exception:
        return False


def is_password_hash(value: Optional[str]) -> bool:
    return bool(value) and str(value).startswith("scrypt$")


def validate_new_password(password: str) -> Optional[str]:
    """Return an error message if the password is too weak, else None."""
    if not isinstance(password, str) or len(password) < 8:
        return "Password must be at least 8 characters long."
    if len(password) > 128:
        return "Password must be at most 128 characters long."
    if password.isdigit() or password.isalpha():
        return "Password must contain both letters and numbers."
    return None


# ==========================================================
# AGENT LOOKUP
# ==========================================================
def get_agent_by_email(email: str, scan_fallback: bool = True):
    """Return (doc_snapshot, data) for the agent with this email, or (None, None).

    Matches on the normalised ``emailLower`` field first, then falls back to the
    raw ``email`` field (older records written before emailLower existed).
    ``scan_fallback=False`` (public auth endpoints) skips the slow full
    collection scan, so unknown e-mails cost the same as known ones.
    """
    if not db or not email:
        return None, None
    email_l = normalize_email(email)
    try:
        docs = list(db.collection("agents").where(filter=FieldFilter("emailLower", "==", email_l)).limit(1).stream())
        if not docs:
            docs = list(db.collection("agents").where(filter=FieldFilter("email", "==", email.strip())).limit(1).stream())
        if not docs and email.strip() != email_l:
            docs = list(db.collection("agents").where(filter=FieldFilter("email", "==", email_l)).limit(1).stream())
        if not docs and scan_fallback:
            # Legacy records without emailLower and stored with different casing
            # (the agents collection is small; scripts/migrate_agents.py backfills emailLower).
            docs = [d for d in db.collection("agents").stream()
                    if normalize_email((d.to_dict() or {}).get("email")) == email_l][:1]
        if docs:
            return docs[0], docs[0].to_dict() or {}
    except Exception as e:
        logger.error(f"Agent lookup failed: {e}")
    return None, None


def agent_public_profile(doc_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """The only agent fields ever returned to a browser."""
    return {
        "id": doc_id,
        "email": data.get("email"),
        "name": data.get("name"),
        "role": data.get("role", "agent") if data.get("role") in STAFF_ROLES else "agent",
        "phone": data.get("phone", ""),
        "profilePic": data.get("profilePic", ""),
        "active": data.get("active", True) is not False,
    }


def mint_staff_custom_token(email: str, role: str, name: str) -> str:
    """Firebase custom token for an authenticated agent."""
    uid = normalize_email(email)[:128]
    claims = {"staff": True, "role": role if role in STAFF_ROLES else "agent", "name": (name or "")[:100]}
    token = fb_auth.create_custom_token(uid, developer_claims=claims)
    return token.decode("utf-8") if isinstance(token, bytes) else str(token)


def invalidate_agent_sessions(doc_ref, email: Optional[str] = None) -> None:
    """Force every existing session of this agent to re-login.

    Sets ``sessionsValidAfter`` (epoch seconds) which ``require_staff`` compares
    against the ID token's ``auth_time``, and best-effort revokes Firebase
    refresh tokens.
    """
    try:
        doc_ref.update({"sessionsValidAfter": int(time.time())})
    except Exception as e:
        logger.error(f"Could not set sessionsValidAfter: {e}")
    if email:
        forget_cached_agent(email)
        _revoke_firebase_tokens(normalize_email(email))


def _revoke_firebase_tokens(uid: str) -> None:
    try:
        fb_auth.revoke_refresh_tokens(uid)
    except getattr(fb_auth, "UserNotFoundError", ()):
        logger.info("No Firebase user to revoke (agent never signed in)")
    except Exception as e:
        logger.error(f"Could not revoke Firebase refresh tokens: {type(e).__name__}")


# ==========================================================
# STAFF ACCESS (read by firestore.rules / storage.rules)
# ==========================================================
STAFF_ACCESS_COLLECTION = "staff_access"


def staff_uid(email: Optional[str]) -> str:
    """Firebase uid of an agent = lower-cased e-mail (see mint_staff_custom_token)."""
    return normalize_email(email)[:128]


def sync_staff_access(email: Optional[str], role: Optional[str], active: bool = True) -> bool:
    """Write ``staff_access/{uid} = {active, role, updatedAt}``.

    Firestore / Storage rules authorise staff from THIS server-maintained
    document (not from token claims), so deactivation, deletion and role
    changes take effect at once instead of when the ID token expires.
    Never raises; returns success.
    """
    uid = staff_uid(email)
    if not db or not uid:
        return False
    forget_cached_agent(email)
    try:
        db.collection(STAFF_ACCESS_COLLECTION).document(uid).set({
            "active": bool(active),
            "role": role if role in STAFF_ROLES else "agent",
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        return True
    except Exception as e:
        logger.error(f"Could not write staff_access for an agent: {type(e).__name__}")
        return False


def revoke_staff_access(email: Optional[str], delete: bool = False) -> None:
    """Deactivate (or delete) ``staff_access/{uid}``, clear persistent custom
    claims and revoke refresh tokens. Best effort; failures are logged."""
    uid = staff_uid(email)
    if not uid:
        return
    forget_cached_agent(email)
    if db:
        try:
            ref = db.collection(STAFF_ACCESS_COLLECTION).document(uid)
            if delete:
                ref.delete()
            else:
                ref.set({"active": False, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
        except Exception as e:
            logger.error(f"Could not revoke staff_access: {type(e).__name__}")
    try:
        fb_auth.set_custom_user_claims(uid, None)
    except getattr(fb_auth, "UserNotFoundError", ()):
        logger.info("No Firebase user to clear claims for (agent never signed in)")
    except Exception as e:
        logger.error(f"Could not clear Firebase custom claims: {type(e).__name__}")
    _revoke_firebase_tokens(uid)


# ==========================================================
# STAFF AUTH DECORATOR
# ==========================================================
# Short-lived per-instance cache of agent records for require_staff. Every staff
# API call used to cost 1-3 Firestore queries just to load the agent; caching for
# a few seconds removes that latency from rapid UI calls. Admin changes on this
# instance clear the entry at once; other instances pick them up within the TTL.
# Set AGENT_CACHE_SECONDS=0 to disable.
AGENT_CACHE_SECONDS = max(0, int(os.environ.get("AGENT_CACHE_SECONDS", "30") or 0))
_agent_cache: Dict[str, Any] = {}
_agent_cache_lock = threading.Lock()


def _cached_agent(email: str):
    key = normalize_email(email)
    if AGENT_CACHE_SECONDS:
        with _agent_cache_lock:
            hit = _agent_cache.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1], hit[2]
    snap, data = get_agent_by_email(email)
    if snap and AGENT_CACHE_SECONDS:
        with _agent_cache_lock:
            if len(_agent_cache) > 500:
                _agent_cache.clear()
            _agent_cache[key] = (time.monotonic() + AGENT_CACHE_SECONDS, snap, data)
    return snap, data


def forget_cached_agent(email: Optional[str]) -> None:
    """Drop an agent from the require_staff cache (call after changing the agent)."""
    if not email:
        return
    with _agent_cache_lock:
        _agent_cache.pop(normalize_email(email), None)


def require_staff(*roles: str):
    """Require a valid Firebase ID token belonging to an active agent.

    Usage::

        @bp.route('/api/refund/manual', methods=['POST'])
        @require_staff()                      # any staff role
        def refund_manual(): ...

        @require_staff('admin', 'super_admin')  # restricted

    On success ``g.agent`` is set to the agent's public profile (dict with id,
    email, name, role, phone, profilePic).
    """
    allowed = tuple(roles) if roles else STAFF_ROLES

    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            if request.method == "OPTIONS":
                return "", 204
            header = request.headers.get("Authorization", "")
            if not header.startswith("Bearer "):
                return error_response("Authentication required. Please sign in again.", 401, code="auth_required")
            token = header[7:].strip()
            try:
                decoded = fb_auth.verify_id_token(token)
            except Exception as e:  # invalid / expired / malformed
                logger.info(f"Rejected ID token: {type(e).__name__}")
                return error_response("Your session has expired. Please sign in again.", 401, code="session_expired")
            if not decoded.get("staff"):
                return error_response("Authentication required. Please sign in again.", 401, code="auth_required")
            email = decoded.get("uid") or decoded.get("user_id") or decoded.get("sub")
            snap, data = _cached_agent(email)
            if not snap:
                return error_response("Your account no longer exists. Contact an administrator.", 401, code="account_missing")
            if data.get("active", True) is False:
                return error_response("Your account has been deactivated.", 403, code="account_disabled")
            valid_after = data.get("sessionsValidAfter")
            auth_time = decoded.get("auth_time") or decoded.get("iat") or 0
            if valid_after and int(auth_time) < int(valid_after):
                return error_response("Your session has expired. Please sign in again.", 401, code="session_expired")
            profile = agent_public_profile(snap.id, data)
            if profile["role"] not in allowed:
                return error_response("You do not have permission to perform this action.", 403, code="forbidden")
            g.agent = profile
            g.agent_ref = snap.reference
            return f(*args, **kwargs)
        wrapper._auth = "staff:" + ",".join(allowed)
        return wrapper
    return decorator


def current_agent() -> Dict[str, Any]:
    """The authenticated agent for this request (set by require_staff)."""
    return getattr(g, "agent", None) or {"id": None, "email": None, "name": "System", "role": None}


# ==========================================================
# CUSTOMER TOKENS (HMAC-signed, scoped to one order)
# ==========================================================
def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _signing_key() -> Optional[bytes]:
    if not APP_SECRET_KEY or len(APP_SECRET_KEY) < 32:
        return None
    return APP_SECRET_KEY.encode("utf-8")


def issue_customer_token(order_name: str, order_numeric_id: Optional[int], email: str = "", phone: str = "",
                         ttl_seconds: int = CUSTOMER_TOKEN_TTL_SECONDS) -> str:
    key = _signing_key()
    if not key:
        raise RuntimeError("APP_SECRET_KEY is not configured (needs at least 32 characters)")
    payload = {
        "o": order_name,
        "oid": order_numeric_id,
        "e": normalize_email(email),
        "p": "".join(ch for ch in (phone or "") if ch.isdigit())[-10:],
        "exp": int(time.time()) + int(ttl_seconds),
        "n": secrets.token_hex(4),
    }
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = _b64e(hmac.new(key, body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_customer_token(token: str) -> Optional[Dict[str, Any]]:
    key = _signing_key()
    if not key or not token or "." not in token:
        return None
    try:
        body, sig = token.split(".", 1)
        expected = _b64e(hmac.new(key, body.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(_b64d(body))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return {
            "orderName": payload.get("o"),
            "orderNumericId": payload.get("oid"),
            "email": payload.get("e", ""),
            "phone": payload.get("p", ""),
            "exp": payload.get("exp"),
        }
    except Exception:
        return None


def require_customer(f):
    """Require a valid ``X-Customer-Token`` header. Sets ``g.customer``."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if request.method == "OPTIONS":
            return "", 204
        if not _signing_key():
            logger.error("APP_SECRET_KEY missing or too short; customer endpoints disabled")
            return error_response("Service temporarily unavailable.", 503)
        claims = verify_customer_token(request.headers.get("X-Customer-Token", ""))
        if not claims:
            return error_response("Your session has expired. Please look up your order again.", 401, code="customer_session_expired")
        g.customer = claims
        return f(*args, **kwargs)
    wrapper._auth = "customer"
    return wrapper


def public_endpoint(reason: str):
    """Mark a route as intentionally unauthenticated (documented reason).

    tests/test_smoke.py fails if an /api route has neither require_staff,
    require_customer nor public_endpoint, so nothing is left open by accident.
    """
    def decorator(f):
        f._auth = "public:" + reason
        return f
    return decorator


# ==========================================================
# RATE LIMITING (Firestore-backed, shared across instances)
# ==========================================================
def rate_limit(key: str, limit: int, window_seconds: int) -> bool:
    """Fixed-window counter. Returns True if the call is allowed.

    Fails open (returns True) if Firestore is unavailable so an outage of the
    limiter never locks everyone out; failures are logged.
    Documents carry ``expireAt`` so a Firestore TTL policy can purge them.
    """
    if not db:
        return True
    doc_id = hashlib.sha256(key.encode("utf-8")).hexdigest()
    ref = db.collection("rate_limits").document(doc_id)
    now = int(time.time())

    @firestore.transactional
    def _txn(transaction):
        snap = ref.get(transaction=transaction)
        data = snap.to_dict() if snap.exists else None
        if not data or now - int(data.get("windowStart", 0)) >= window_seconds:
            transaction.set(ref, {"count": 1, "windowStart": now,
                                  "expireAt": _ts(now + window_seconds * 2)})
            return True
        if int(data.get("count", 0)) >= limit:
            return False
        transaction.update(ref, {"count": int(data.get("count", 0)) + 1})
        return True

    try:
        return _txn(db.transaction())
    except Exception as e:
        logger.error(f"Rate limiter unavailable ({e}); allowing request")
        return True


def rate_limited(key_parts: Iterable[str], limit: int, window_seconds: int):
    """Return an error response tuple if the limit is exceeded, else None."""
    key = "|".join(str(p) for p in key_parts)
    if rate_limit(key, limit, window_seconds):
        return None
    return error_response("Too many attempts. Please wait a few minutes and try again.", 429, code="rate_limited")


def _failure_ref(key_parts: Iterable[str]):
    key = "fail|" + "|".join(str(p) for p in key_parts)
    return db.collection("rate_limits").document(hashlib.sha256(key.encode("utf-8")).hexdigest())


def failure_budget_exhausted(key_parts: Iterable[str], limit: int, window_seconds: int) -> bool:
    """True when ``limit`` failures were recorded for this key in the current
    window. Read-only (successful attempts are never counted). Fails open."""
    if not db:
        return False
    try:
        snap = _failure_ref(key_parts).get()
        data = snap.to_dict() if snap.exists else None
        if not data or int(time.time()) - int(data.get("windowStart", 0)) >= window_seconds:
            return False
        return int(data.get("count", 0)) >= limit
    except Exception as e:
        logger.error(f"Failure counter unavailable ({type(e).__name__}); allowing request")
        return False


def record_failure(key_parts: Iterable[str], window_seconds: int) -> None:
    """Count one failure for this key (fixed window, transactional). Never raises."""
    if not db:
        return
    ref = _failure_ref(key_parts)
    now = int(time.time())

    @firestore.transactional
    def _txn(transaction):
        snap = ref.get(transaction=transaction)
        data = snap.to_dict() if snap.exists else None
        if not data or now - int(data.get("windowStart", 0)) >= window_seconds:
            transaction.set(ref, {"count": 1, "windowStart": now, "expireAt": _ts(now + window_seconds * 2)})
        else:
            transaction.update(ref, {"count": int(data.get("count", 0)) + 1})

    try:
        _txn(db.transaction())
    except Exception as e:
        logger.error(f"Could not record a failure ({type(e).__name__})")


def _ts(epoch_seconds: int):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(epoch_seconds, tz=timezone.utc)


# ==========================================================
# OTP HELPERS
# ==========================================================
def generate_otp(digits: int = 6) -> str:
    return "".join(str(secrets.randbelow(10)) for _ in range(digits))


def hash_secret(value: str) -> str:
    """Keyed hash for short-lived secrets (OTPs, reset tokens, upload tokens)."""
    key = (APP_SECRET_KEY or "reguard-dev-only").encode("utf-8")
    return hmac.new(key, value.encode("utf-8"), hashlib.sha256).hexdigest()


def new_opaque_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)

"""
Staff authentication (CONTRACT §1.1).

Flow: /auth/login -> Firebase custom token -> browser signInWithCustomToken ->
Firebase ID token on every call (verified by security.require_staff).

Firestore (server-only collections):
    agent_credentials/{emailLower}  {passwordHash, updatedAt}
    password_resets/{emailLower}    {otpHash, expiresAt, attempts} then
                                    {resetTokenHash, resetExpiresAt}
"""
import hmac
from datetime import timedelta
from typing import Any, Dict, Optional, Tuple

from firebase_admin import firestore
from flask import Blueprint, g, jsonify

from core import db, is_valid_email, logger, to_datetime, utcnow
from notifications import notify_agent_otp
from security import (agent_public_profile, client_ip, current_agent, error_response, failure_budget_exhausted,
                      generate_otp, get_agent_by_email, hash_password, hash_secret, invalidate_agent_sessions,
                      json_body, mint_staff_custom_token, new_opaque_token, normalize_email, public_endpoint,
                      rate_limited, record_failure, require_staff, sync_staff_access, validate_new_password,
                      verify_password)
from settings_store import refund_password_configured, verify_refund_password

bp = Blueprint('auth', __name__)

OTP_TTL_MINUTES = 10
OTP_MAX_ATTEMPTS = 5
RESET_TOKEN_TTL_MINUTES = 15
WINDOW_15_MIN = 15 * 60
WINDOW_1_HOUR = 60 * 60
# One message for unknown e-mail, wrong password and never-set password (no enumeration).
INVALID_LOGIN = "Invalid email or password. First time? Use 'Forgot / set password'."
# Wrong OTPs per e-mail per 24 h across every issued OTP (review M6).
OTP_DAILY_MAX_FAILURES = 15
WINDOW_24_HOURS = 24 * 60 * 60
# Shared with routes_refunds (review M1).
REFUND_PASSWORD_MAX_FAILURES = 10
GENERIC_OTP_MESSAGE = "If the email is registered, an OTP has been sent."
LEGACY_SECRET_FIELDS = ("password", "resetOtp", "otp", "otpExpiry", "otpCreatedAt", "otpAttempts")
# Verified against when the e-mail is unknown, so response timing doesn't reveal registered e-mails.
_DUMMY_HASH = hash_password("reguard-timing-equaliser")


# ==========================================================
# HELPERS
# ==========================================================
def _credentials_ref(email_l: str):
    return db.collection("agent_credentials").document(email_l)


def _resets_ref(email_l: str):
    return db.collection("password_resets").document(email_l)


def _read_email(body: Dict[str, Any]) -> str:
    email = body.get("email")
    return normalize_email(email) if isinstance(email, str) else ""


def _get_agent(email_l: str):
    """(snapshot, data) for the agent, or (None, None).

    Indexed lookups only (emailLower, legacy exact ``email``): no full
    collection scan, so unknown e-mails are as fast as known ones.
    scripts/migrate_agents.py backfills emailLower for older records.
    """
    return get_agent_by_email(email_l, scan_fallback=False)


def _legacy_cleanup_fields(email_l: str) -> Dict[str, Any]:
    update = {f: firestore.DELETE_FIELD for f in LEGACY_SECRET_FIELDS}
    update.update({"emailLower": email_l, "hasSetPassword": True})
    return update


def _check_credentials(email_l: str, password: str) -> bool:
    """Verify against ``agent_credentials`` only.

    Plain-text / legacy ``agents.password`` values are NOT accepted here any
    more (review M4): run scripts/migrate_agents.py, which hashes them into
    agent_credentials so nobody loses access. Accounts without credentials
    get the same generic answer as a wrong password.
    """
    cred_snap = _credentials_ref(email_l).get()
    stored = (cred_snap.to_dict() or {}).get("passwordHash") if cred_snap.exists else None
    if stored:
        return verify_password(password, stored)
    verify_password(password, _DUMMY_HASH)
    return False


def _login_response(agent_snap, agent: Dict[str, Any]):
    profile = agent_public_profile(agent_snap.id, agent)
    # Firestore/Storage rules authorise from staff_access/{uid} (review M5).
    sync_staff_access(profile["email"], profile["role"], profile["active"])
    token = mint_staff_custom_token(profile["email"] or "", profile["role"], profile["name"] or "")
    return jsonify({"success": True, "customToken": token, "agent": profile})


# ==========================================================
# LOGIN
# ==========================================================
@bp.route('/api/auth/login', methods=['POST'])
@public_endpoint("Staff login: credentials are checked here; rate limited per e-mail and IP")
def login_agent():
    """Authenticate an agent and return a Firebase custom token."""
    body = json_body()
    email_l = _read_email(body)
    password = body.get("password") if isinstance(body.get("password"), str) else ""
    if not email_l or not password or len(password) > 256:
        return error_response(INVALID_LOGIN, 401, code="invalid_credentials")
    limited = (rate_limited(["login-email", email_l], 10, WINDOW_15_MIN)
               or rate_limited(["login-ip", client_ip()], 30, WINDOW_15_MIN))
    if limited:
        return limited
    if not db:
        return error_response("Service temporarily unavailable.", 503)
    try:
        agent_snap, agent = _get_agent(email_l)
        if not agent_snap:
            verify_password(password, _DUMMY_HASH)
            return error_response(INVALID_LOGIN, 401, code="invalid_credentials")
        valid = _check_credentials(email_l, password)
        if not valid:
            return error_response(INVALID_LOGIN, 401, code="invalid_credentials")
        if agent.get("active", True) is False:
            return error_response("Your account has been deactivated. Contact an administrator.", 403,
                                  code="account_disabled")
        try:
            agent_snap.reference.update({"lastLoginAt": firestore.SERVER_TIMESTAMP, "emailLower": email_l})
        except Exception as e:
            logger.warning(f"Could not update lastLoginAt: {type(e).__name__}")
        return _login_response(agent_snap, agent)
    except Exception as e:
        logger.error(f"Login error: {type(e).__name__}: {e}")
        return error_response("Login is temporarily unavailable. Please try again.", 500)


# ==========================================================
# OTP / PASSWORD RESET
# ==========================================================
@bp.route('/api/auth/send-otp', methods=['POST'])
@public_endpoint("Password reset request: always answers the same way (no enumeration); rate limited")
def send_otp():
    """E-mail a one-time code to a registered, active agent."""
    body = json_body()
    email_l = _read_email(body)
    ok_response = jsonify({"success": True, "message": GENERIC_OTP_MESSAGE})
    if not is_valid_email(email_l):
        return error_response("Please enter a valid email address.", 400, code="invalid_email")
    limited = (rate_limited(["otp-email", email_l], 5, WINDOW_1_HOUR)
               or rate_limited(["otp-ip", client_ip()], 20, WINDOW_1_HOUR))
    if limited:
        return limited
    if not db:
        return error_response("Service temporarily unavailable.", 503)
    try:
        agent_snap, agent = _get_agent(email_l)
        if not agent_snap or agent.get("active", True) is False:
            return ok_response
        otp = generate_otp()
        _resets_ref(email_l).set({
            "otpHash": hash_secret(otp),
            "expiresAt": utcnow() + timedelta(minutes=OTP_TTL_MINUTES),
            "attempts": 0,
            "createdAt": firestore.SERVER_TIMESTAMP,
        })
        if any(f in agent for f in ("resetOtp", "otpExpiry")):
            agent_snap.reference.update({"resetOtp": firestore.DELETE_FIELD, "otpExpiry": firestore.DELETE_FIELD})
        if not notify_agent_otp(agent.get("email") or email_l, agent.get("name") or "", otp, OTP_TTL_MINUTES):
            logger.error("OTP e-mail could not be delivered (n8n webhook failed or not configured)")
        return ok_response
    except Exception as e:
        logger.error(f"Send OTP error: {type(e).__name__}: {e}")
        return error_response("Could not send the code right now. Please try again.", 500)


def _consume_otp(email_l: str, otp: str) -> Tuple[str, Optional[str]]:
    """Check an OTP inside a transaction. Returns (status, reset_token).

    status: 'ok' | 'invalid' | 'expired' | 'locked'
    """
    ref = _resets_ref(email_l)
    reset_token = new_opaque_token()

    @firestore.transactional
    def _txn(transaction):
        snap = ref.get(transaction=transaction)
        data = (snap.to_dict() or {}) if snap.exists else {}
        if not data.get("otpHash"):
            return "invalid"
        expires = to_datetime(data.get("expiresAt"))
        if not expires or expires < utcnow():
            transaction.delete(ref)
            return "expired"
        attempts = int(data.get("attempts") or 0)
        if attempts >= OTP_MAX_ATTEMPTS:
            transaction.delete(ref)
            return "locked"
        if not hmac.compare_digest(str(data["otpHash"]), hash_secret(otp)):
            if attempts + 1 >= OTP_MAX_ATTEMPTS:
                transaction.delete(ref)
                return "locked"
            transaction.update(ref, {"attempts": attempts + 1})
            return "invalid"
        transaction.set(ref, {
            "resetTokenHash": hash_secret(reset_token),
            "resetExpiresAt": utcnow() + timedelta(minutes=RESET_TOKEN_TTL_MINUTES),
            "createdAt": firestore.SERVER_TIMESTAMP,
        })
        return "ok"

    status = _txn(db.transaction())
    return status, (reset_token if status == "ok" else None)


@bp.route('/api/auth/verify-otp', methods=['POST'])
@public_endpoint("Password reset: OTP check with per-OTP attempt cap; rate limited")
def verify_otp():
    """Exchange a valid OTP for a single-use, 15-minute reset token."""
    body = json_body()
    email_l = _read_email(body)
    otp = str(body.get("otp") or "").strip()
    if not email_l or not otp.isdigit() or len(otp) != 6:
        return error_response("Invalid or expired code.", 400, code="invalid_otp")
    limited = (rate_limited(["verify-otp-email", email_l], 15, WINDOW_15_MIN)
               or rate_limited(["verify-otp-ip", client_ip()], 40, WINDOW_15_MIN))
    if limited:
        return limited
    if not db:
        return error_response("Service temporarily unavailable.", 503)
    daily_key = ["otp-daily", email_l]
    if failure_budget_exhausted(daily_key, OTP_DAILY_MAX_FAILURES, WINDOW_24_HOURS):
        return error_response("Too many incorrect codes today. Please try again tomorrow or contact an administrator.",
                              429, code="otp_daily_limit")
    try:
        status, reset_token = _consume_otp(email_l, otp)
    except Exception as e:
        logger.error(f"Verify OTP error: {type(e).__name__}: {e}")
        return error_response("Could not verify the code right now. Please try again.", 500)
    if status in ("invalid", "locked"):
        # Persists across newly issued OTPs: requesting a fresh code does not
        # reset the daily budget.
        record_failure(daily_key, WINDOW_24_HOURS)
    if status == "ok":
        return jsonify({"success": True, "resetToken": reset_token})
    if status == "locked":
        return error_response("Too many incorrect attempts. Please request a new code.", 400, code="otp_locked")
    if status == "expired":
        return error_response("This code has expired. Please request a new one.", 400, code="otp_expired")
    return error_response("Invalid or expired code.", 400, code="invalid_otp")


def _consume_reset_token(email_l: str, token: str) -> bool:
    """Validate and delete (single use) the reset token. Returns validity."""
    ref = _resets_ref(email_l)

    @firestore.transactional
    def _txn(transaction):
        snap = ref.get(transaction=transaction)
        data = (snap.to_dict() or {}) if snap.exists else {}
        stored = data.get("resetTokenHash")
        expires = to_datetime(data.get("resetExpiresAt"))
        if not stored or not expires or expires < utcnow():
            return False
        if not hmac.compare_digest(str(stored), hash_secret(token)):
            return False
        transaction.delete(ref)
        return True

    return bool(_txn(db.transaction()))


@bp.route('/api/auth/setup-password', methods=['POST'])
@public_endpoint("Password setup: requires the single-use reset token from verify-otp; rate limited")
def setup_password():
    """Set a new password with a reset token and log the agent in."""
    body = json_body()
    email_l = _read_email(body)
    reset_token = body.get("resetToken") if isinstance(body.get("resetToken"), str) else ""
    password = body.get("password") if isinstance(body.get("password"), str) else ""
    if not email_l or not reset_token:
        return error_response("Your reset link has expired. Please request a new code.", 400,
                              code="invalid_reset_token")
    problem = validate_new_password(password)
    if problem:
        return error_response(problem, 400, code="weak_password")
    limited = rate_limited(["setup-password-ip", client_ip()], 20, WINDOW_15_MIN)
    if limited:
        return limited
    if not db:
        return error_response("Service temporarily unavailable.", 503)
    try:
        agent_snap, agent = _get_agent(email_l)
        if not agent_snap or not _consume_reset_token(email_l, reset_token):
            return error_response("Your reset link has expired. Please request a new code.", 400,
                                  code="invalid_reset_token")
        if agent.get("active", True) is False:
            return error_response("Your account has been deactivated. Contact an administrator.", 403,
                                  code="account_disabled")
        _credentials_ref(email_l).set({"passwordHash": hash_password(password),
                                       "updatedAt": firestore.SERVER_TIMESTAMP})
        cleanup = _legacy_cleanup_fields(email_l)
        cleanup["lastLoginAt"] = firestore.SERVER_TIMESTAMP
        cleanup["passwordUpdatedAt"] = firestore.SERVER_TIMESTAMP
        agent_snap.reference.update(cleanup)
        invalidate_agent_sessions(agent_snap.reference, agent.get("email") or email_l)
        return _login_response(agent_snap, agent)
    except Exception as e:
        logger.error(f"Setup password error: {type(e).__name__}: {e}")
        return error_response("Could not set your password right now. Please try again.", 500)


# ==========================================================
# SIGNED-IN STAFF
# ==========================================================
@bp.route('/api/auth/me', methods=['GET'])
@require_staff()
def auth_me():
    """Profile of the signed-in agent."""
    return jsonify({"success": True, "agent": current_agent()})


@bp.route('/api/auth/change-password', methods=['POST'])
@require_staff()
def change_password():
    """Change own password (requires the current one). Returns a fresh customToken
    because every existing session (including this one) is invalidated."""
    body = json_body()
    current = body.get("currentPassword") if isinstance(body.get("currentPassword"), str) else ""
    new = body.get("newPassword") if isinstance(body.get("newPassword"), str) else ""
    agent = current_agent()
    email_l = normalize_email(agent.get("email"))
    problem = validate_new_password(new)
    if problem:
        return error_response(problem, 400, code="weak_password")
    if hmac.compare_digest(current.encode("utf-8"), new.encode("utf-8")):
        return error_response("The new password must be different from the current one.", 400,
                              code="weak_password")
    limited = rate_limited(["change-password", email_l], 10, WINDOW_15_MIN)
    if limited:
        return limited
    try:
        cred_snap = _credentials_ref(email_l).get()
        stored = (cred_snap.to_dict() or {}).get("passwordHash") if cred_snap.exists else None
        if not current or not verify_password(current, stored):
            return error_response("Your current password is incorrect.", 403, code="invalid_credentials")
        _credentials_ref(email_l).set({"passwordHash": hash_password(new), "updatedAt": firestore.SERVER_TIMESTAMP})
        g.agent_ref.update({"passwordUpdatedAt": firestore.SERVER_TIMESTAMP, "hasSetPassword": True})
        invalidate_agent_sessions(g.agent_ref, agent.get("email"))
        sync_staff_access(agent.get("email"), agent.get("role") or "agent", True)
        token = mint_staff_custom_token(agent.get("email") or "", agent.get("role") or "agent", agent.get("name") or "")
        return jsonify({"success": True, "customToken": token, "agent": agent})
    except Exception as e:
        logger.error(f"Change password error: {type(e).__name__}: {e}")
        return error_response("Could not change your password right now. Please try again.", 500)


@bp.route('/api/auth/verify-refund-password', methods=['POST'])
@require_staff()
def verify_refund_password_route():
    """Early feedback for refund modals: is the refund password correct?"""
    body = json_body()
    password = body.get("password") if isinstance(body.get("password"), str) else ""
    agent = current_agent()
    limited = rate_limited(["refund-password", normalize_email(agent.get("email"))], 10, WINDOW_15_MIN)
    if limited:
        return limited
    if not refund_password_configured():
        return jsonify({"success": True, "configured": False})
    # Same per-agent failure budget as the refund endpoints (routes_refunds).
    failure_key = ["refund-password", normalize_email(agent.get("email"))]
    if failure_budget_exhausted(failure_key, REFUND_PASSWORD_MAX_FAILURES, WINDOW_15_MIN):
        return error_response("Too many incorrect refund passwords. Please wait 15 minutes and try again.", 429,
                              code="rate_limited")
    if verify_refund_password(password):
        return jsonify({"success": True, "configured": True})
    record_failure(failure_key, WINDOW_15_MIN)
    return error_response("Incorrect refund password.", 403, code="bad_refund_password")

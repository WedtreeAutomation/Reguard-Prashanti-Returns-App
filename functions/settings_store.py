"""
Settings access (server side).

INTERFACE (stable — other modules import these):
    get_return_settings() -> dict             # settings/returnSettings with defaults (no secrets)
    refund_password_configured() -> bool
    verify_refund_password(password) -> bool  # constant-time; migrates legacy plain value
    set_refund_password(new_password, updated_by) -> None

Storage (CONTRACT §4.1):
    settings/returnSettings      public-ish settings (staff read, admin write)
    settings_private/refund      {passwordHash, updatedAt, updatedBy} — server only
Legacy: a plain ``refundPassword`` field inside settings/returnSettings is
hashed into settings_private/refund on first use and then deleted.
"""
import hmac
from typing import Any, Dict, Optional

from firebase_admin import firestore

from core import db, logger
from security import hash_password, is_password_hash, verify_password

DEFAULT_RETURN_SETTINGS: Dict[str, Any] = {"returnDaysLimit": 14}
RETURN_DAYS_MIN, RETURN_DAYS_MAX = 1, 365
REFUND_PASSWORD_MIN_LENGTH = 6
REFUND_PASSWORD_MAX_LENGTH = 128
_SECRET_FIELDS = {"refundPassword"}


def _settings_ref():
    return db.collection("settings").document("returnSettings") if db else None


def _refund_ref():
    return db.collection("settings_private").document("refund") if db else None


def coerce_return_settings(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Merge ``raw`` over the defaults, strip secrets and coerce known types.

    ``returnDaysLimit`` must be an integer in [1, 365]; anything else falls
    back to the default.
    """
    result = dict(DEFAULT_RETURN_SETTINGS)
    for key, value in (raw or {}).items():
        if key in _SECRET_FIELDS:
            continue
        result[key] = value
    try:
        days = int(float(result.get("returnDaysLimit")))
        if not RETURN_DAYS_MIN <= days <= RETURN_DAYS_MAX:
            raise ValueError
        result["returnDaysLimit"] = days
    except (TypeError, ValueError):
        result["returnDaysLimit"] = DEFAULT_RETURN_SETTINGS["returnDaysLimit"]
    return result


def get_return_settings() -> Dict[str, Any]:
    """settings/returnSettings merged over defaults (never contains secrets)."""
    ref = _settings_ref()
    if ref is None:
        return dict(DEFAULT_RETURN_SETTINGS)
    try:
        snap = ref.get()
        return coerce_return_settings(snap.to_dict() if snap.exists else None)
    except Exception as e:
        logger.error(f"Could not read return settings ({type(e).__name__}); using defaults")
        return dict(DEFAULT_RETURN_SETTINGS)


def _migrate_legacy_refund_password() -> Optional[str]:
    """Move a plain settings/returnSettings.refundPassword into settings_private.

    Returns the stored hash (or None when there is nothing to migrate).
    """
    sref, rref = _settings_ref(), _refund_ref()
    if sref is None or rref is None:
        return None
    snap = sref.get()
    legacy = (snap.to_dict() or {}).get("refundPassword") if snap.exists else None
    if not isinstance(legacy, str) or not legacy:
        return None
    stored = legacy if is_password_hash(legacy) else hash_password(legacy)
    rref.set({"passwordHash": stored, "updatedAt": firestore.SERVER_TIMESTAMP,
              "updatedBy": "migration:returnSettings"})
    sref.update({"refundPassword": firestore.DELETE_FIELD})
    logger.info("Migrated legacy refund password to settings_private/refund")
    return stored


def migrate_legacy_refund_password_field(dry_run: bool = False) -> str:
    """One-off cleanup used by scripts/migrate_agents.py.

    Returns 'none' (no plain ``refundPassword`` field), 'migrated' (hashed into
    settings_private/refund, plain field deleted) or 'removed' (a hash already
    existed; only the plain field was deleted). With ``dry_run`` nothing is
    written and the would-be action is returned.
    """
    sref, rref = _settings_ref(), _refund_ref()
    if sref is None or rref is None:
        raise RuntimeError("Database not available")
    snap = sref.get()
    if not snap.exists or "refundPassword" not in (snap.to_dict() or {}):
        return "none"
    has_hash = rref.get().exists and bool((rref.get().to_dict() or {}).get("passwordHash"))
    action = "removed" if has_hash else "migrated"
    if dry_run:
        return action
    if has_hash:
        sref.update({"refundPassword": firestore.DELETE_FIELD})
    elif _migrate_legacy_refund_password() is None:
        # Present but empty / not a string: just drop it.
        sref.update({"refundPassword": firestore.DELETE_FIELD})
    return action


def _stored_refund_hash() -> Optional[str]:
    """Current hash, migrating the legacy plain value if needed. Raises on DB errors."""
    rref = _refund_ref()
    if rref is None:
        return None
    snap = rref.get()
    stored = (snap.to_dict() or {}).get("passwordHash") if snap.exists else None
    if stored:
        return stored
    return _migrate_legacy_refund_password()


def refund_password_configured() -> bool:
    try:
        return bool(_stored_refund_hash())
    except Exception as e:
        # Fail closed for the callers: "configured" means a password will be demanded.
        logger.error(f"Could not read refund password state ({type(e).__name__})")
        return True


def verify_refund_password(password: str) -> bool:
    """Constant-time check of the agent-entered refund password. Never raises."""
    if not isinstance(password, str) or not password or len(password) > REFUND_PASSWORD_MAX_LENGTH:
        return False
    try:
        stored = _stored_refund_hash()
    except Exception as e:
        logger.error(f"Refund password verification unavailable ({type(e).__name__})")
        return False
    if not stored:
        return False
    if is_password_hash(stored):
        return verify_password(password, stored)
    return hmac.compare_digest(stored.encode("utf-8"), password.encode("utf-8"))


def validate_refund_password(new_password: Any) -> Optional[str]:
    if not isinstance(new_password, str) or len(new_password.strip()) < REFUND_PASSWORD_MIN_LENGTH:
        return f"Refund password must be at least {REFUND_PASSWORD_MIN_LENGTH} characters."
    if len(new_password) > REFUND_PASSWORD_MAX_LENGTH:
        return f"Refund password must be at most {REFUND_PASSWORD_MAX_LENGTH} characters."
    return None


def set_refund_password(new_password: str, updated_by: str) -> None:
    """Hash and store a new refund password; removes any legacy plain field.

    Raises ValueError for an invalid password and RuntimeError when the
    database is unavailable.
    """
    problem = validate_refund_password(new_password)
    if problem:
        raise ValueError(problem)
    rref, sref = _refund_ref(), _settings_ref()
    if rref is None:
        raise RuntimeError("Database not available")
    rref.set({"passwordHash": hash_password(new_password), "updatedAt": firestore.SERVER_TIMESTAMP,
              "updatedBy": (updated_by or "unknown")[:200]})
    try:
        snap = sref.get()
        if snap.exists and "refundPassword" in (snap.to_dict() or {}):
            sref.update({"refundPassword": firestore.DELETE_FIELD})
    except Exception as e:
        logger.error(f"Could not remove legacy refundPassword field ({type(e).__name__})")

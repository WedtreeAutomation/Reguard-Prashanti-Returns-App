"""
Administration endpoints (CONTRACT §4.4): agent management and the refund
password. Agent records live in ``agents/{id}``; credentials in the
server-only ``agent_credentials/{emailLower}``.
"""
import re
import secrets
from typing import Any, Dict, Optional, Tuple

from firebase_admin import firestore
from flask import Blueprint, g, jsonify

from google.cloud.firestore_v1.base_query import FieldFilter

from core import db, iso_utc, is_valid_email, logger
from security import (STAFF_ROLES, agent_public_profile, current_agent, error_response, get_agent_by_email,
                      invalidate_agent_sessions, json_body, normalize_email, require_staff, revoke_staff_access,
                      sync_staff_access)
from settings_store import refund_password_configured, set_refund_password, validate_refund_password

bp = Blueprint('admin', __name__)

MAX_NAME_LENGTH = 100
MAX_PROFILE_PIC_LENGTH = 2048
UPDATABLE_FIELDS = ("name", "phone", "role", "active", "profilePic")


# ==========================================================
# VALIDATION HELPERS (pure)
# ==========================================================
def agent_doc_id(email: str) -> str:
    """Slug of the e-mail local part + 6 random chars, e.g. 'priya-sharma-a1b2c3'."""
    local = normalize_email(email).split("@", 1)[0]
    slug = re.sub(r"[^a-z0-9]+", "-", local).strip("-")[:40] or "agent"
    return f"{slug}-{secrets.token_hex(3)}"


def clean_agent_fields(body: Dict[str, Any], partial: bool) -> Tuple[Dict[str, Any], Optional[str]]:
    """Validate agent fields from a request body. Returns (fields, error)."""
    out: Dict[str, Any] = {}
    if "name" in body or not partial:
        name = body.get("name")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > MAX_NAME_LENGTH:
            return {}, f"Name is required (max {MAX_NAME_LENGTH} characters)."
        out["name"] = name.strip()
    if "phone" in body or not partial:
        phone = body.get("phone")
        phone = "" if phone is None else str(phone).strip()
        if phone and len(re.sub(r"\D", "", phone)) < 10:
            return {}, "Phone number must have at least 10 digits."
        out["phone"] = phone[:20]
    if "role" in body or not partial:
        role = body.get("role", "agent")
        if role not in STAFF_ROLES:
            return {}, f"Role must be one of: {', '.join(STAFF_ROLES)}."
        out["role"] = role
    if "active" in body:
        if not isinstance(body.get("active"), bool):
            return {}, "'active' must be true or false."
        out["active"] = body["active"]
    if "profilePic" in body:
        pic = body.get("profilePic") or ""
        if not isinstance(pic, str) or len(pic) > MAX_PROFILE_PIC_LENGTH or (pic and not pic.startswith("https://")):
            return {}, "Profile picture must be an https URL."
        out["profilePic"] = pic
    return out, None


def _admin_profile(doc_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
    profile = agent_public_profile(doc_id, data)
    profile.update({
        "hasSetPassword": bool(data.get("hasSetPassword")),
        "createdAt": iso_utc(data.get("createdAt")),
        "lastLoginAt": iso_utc(data.get("lastLoginAt")),
    })
    return profile


def _active_super_admin_ids(transaction=None) -> set:
    query = db.collection("agents").where(filter=FieldFilter("role", "==", "super_admin"))
    docs = query.stream(transaction=transaction) if transaction is not None else query.stream()
    return {d.id for d in docs if (d.to_dict() or {}).get("active", True) is not False}


def _would_remove_last_super_admin(target_id: str, target: Dict[str, Any], new_role: Optional[str],
                                   new_active: Optional[bool], deleting: bool, transaction=None) -> bool:
    if target.get("role") != "super_admin" or target.get("active", True) is False:
        return False
    loses_power = deleting or (new_role is not None and new_role != "super_admin") or new_active is False
    if not loses_power:
        return False
    return not (_active_super_admin_ids(transaction) - {target_id})


class _AdminConflict(Exception):
    def __init__(self, message: str, code: str, status: int = 409):
        super().__init__(message)
        self.message, self.code, self.status = message, code, status


def _guarded_agent_write(ref, agent_id: str, check, write) -> Dict[str, Any]:
    """Re-read the target and the active super admins INSIDE a transaction,
    run ``check(target, transaction)`` (raises _AdminConflict) and then
    ``write(transaction)``: two super admins demoting/deleting each other at
    the same time can no longer both succeed (review LOW e)."""

    @firestore.transactional
    def _txn(transaction):
        snap = ref.get(transaction=transaction)
        if not snap.exists:
            raise _AdminConflict("Agent not found.", "not_found", 404)
        target = snap.to_dict() or {}
        check(target, transaction)
        write(transaction)
        return target

    return _txn(db.transaction())


# ==========================================================
# AGENTS
# ==========================================================
@bp.route('/api/admin/agents', methods=['GET'])
@require_staff('super_admin')
def list_agents():
    """All agents with login status (never credentials)."""
    if not db:
        return error_response("Service temporarily unavailable.", 503)
    try:
        agents = [_admin_profile(d.id, d.to_dict() or {}) for d in db.collection("agents").stream()]
        agents.sort(key=lambda a: (a.get("name") or "").lower())
        return jsonify({"success": True, "agents": agents})
    except Exception as e:
        logger.error(f"List agents failed: {type(e).__name__}: {e}")
        return error_response("Could not load agents.", 500)


@bp.route('/api/admin/agents', methods=['POST'])
@require_staff('super_admin')
def create_agent():
    """Create an agent; they set a password through the OTP flow."""
    body = json_body()
    fields, problem = clean_agent_fields(body, partial=False)
    if problem:
        return error_response(problem, 400, code="validation_error")
    email = body.get("email")
    if not is_valid_email(email):
        return error_response("A valid email address is required.", 400, code="validation_error")
    if not db:
        return error_response("Service temporarily unavailable.", 503)
    email = email.strip()
    try:
        existing, _ = get_agent_by_email(email)
        if existing:
            return error_response("An agent with this email already exists.", 409, code="agent_exists")
        doc_id = agent_doc_id(email)
        data = dict(fields)
        data.update({
            "email": email,
            "emailLower": normalize_email(email),
            "hasSetPassword": False,
            "active": fields.get("active", True),
            "profilePic": fields.get("profilePic", ""),
            "createdAt": firestore.SERVER_TIMESTAMP,
            "createdBy": current_agent().get("email"),
        })
        db.collection("agents").document(doc_id).set(data)
        sync_staff_access(email, data.get("role"), data.get("active", True) is not False)
        snap = db.collection("agents").document(doc_id).get()
        return jsonify({"success": True, "agent": _admin_profile(doc_id, snap.to_dict() or data)}), 201
    except Exception as e:
        logger.error(f"Create agent failed: {type(e).__name__}: {e}")
        return error_response("Could not create the agent.", 500)


def _load_agent(agent_id: str):
    if not re.fullmatch(r"[A-Za-z0-9_\-.@]{1,128}", agent_id or ""):
        return None, None
    ref = db.collection("agents").document(agent_id)
    snap = ref.get()
    return (ref, snap.to_dict() or {}) if snap.exists else (None, None)


@bp.route('/api/admin/agents/<agent_id>', methods=['PUT'])
@require_staff('super_admin')
def update_agent(agent_id):
    """Merge-update name/phone/role/active/profilePic (email is immutable)."""
    body = json_body()
    if "email" in body or "emailLower" in body:
        return error_response("Email cannot be changed. Delete the agent and create a new one.", 400,
                              code="email_immutable")
    fields, problem = clean_agent_fields({k: body[k] for k in UPDATABLE_FIELDS if k in body}, partial=True)
    if problem:
        return error_response(problem, 400, code="validation_error")
    if not fields:
        return error_response("Nothing to update.", 400, code="validation_error")
    if not db:
        return error_response("Service temporarily unavailable.", 503)
    try:
        ref, _ = _load_agent(agent_id)
        if not ref:
            return error_response("Agent not found.", 404, code="not_found")
        is_self = agent_id == g.agent.get("id")
        fields["updatedAt"] = firestore.SERVER_TIMESTAMP

        def check(target, transaction):
            if is_self and (fields.get("role", target.get("role")) != target.get("role") or fields.get("active") is False):
                raise _AdminConflict("You cannot change your own role or deactivate yourself.", "self_change")
            if _would_remove_last_super_admin(agent_id, target, fields.get("role"), fields.get("active"), False,
                                              transaction):
                raise _AdminConflict("At least one active super admin must remain.", "last_super_admin")

        try:
            target = _guarded_agent_write(ref, agent_id, check, lambda t: t.update(ref, fields))
        except _AdminConflict as c:
            return error_response(c.message, c.status, code=c.code)
        role_changed = "role" in fields and fields["role"] != target.get("role")
        active_changed = "active" in fields and fields["active"] != (target.get("active", True) is not False)
        merged = dict(target)
        merged.update({k: v for k, v in fields.items() if k != "updatedAt"})
        new_active = merged.get("active", True) is not False
        if role_changed or active_changed:
            invalidate_agent_sessions(ref, target.get("email"))
        if not new_active:
            revoke_staff_access(target.get("email"))
        else:
            sync_staff_access(target.get("email"), merged.get("role"), True)
        return jsonify({"success": True, "agent": _admin_profile(agent_id, merged)})
    except Exception as e:
        logger.error(f"Update agent failed: {type(e).__name__}: {e}")
        return error_response("Could not update the agent.", 500)


@bp.route('/api/admin/agents/<agent_id>', methods=['DELETE'])
@require_staff('super_admin')
def delete_agent(agent_id):
    """Delete an agent and their credentials; their sessions end immediately."""
    if not db:
        return error_response("Service temporarily unavailable.", 503)
    try:
        ref, _ = _load_agent(agent_id)
        if not ref:
            return error_response("Agent not found.", 404, code="not_found")
        if agent_id == g.agent.get("id"):
            return error_response("You cannot delete your own account.", 409, code="self_change")

        def check(target, transaction):
            if _would_remove_last_super_admin(agent_id, target, None, None, True, transaction):
                raise _AdminConflict("At least one active super admin must remain.", "last_super_admin")

        try:
            target = _guarded_agent_write(ref, agent_id, check, lambda t: t.delete(ref))
        except _AdminConflict as c:
            return error_response(c.message, c.status, code=c.code)
        email_l = normalize_email(target.get("email"))
        revoke_staff_access(target.get("email"), delete=True)
        if email_l:
            db.collection("agent_credentials").document(email_l).delete()
            db.collection("password_resets").document(email_l).delete()
        return jsonify({"success": True})
    except Exception as e:
        logger.error(f"Delete agent failed: {type(e).__name__}: {e}")
        return error_response("Could not delete the agent.", 500)


# ==========================================================
# REFUND PASSWORD
# ==========================================================
@bp.route('/api/admin/settings/refund-password', methods=['POST'])
@require_staff('admin', 'super_admin')
def update_refund_password():
    """Set / change the refund password (stored hashed)."""
    new_password = json_body().get("newPassword")
    problem = validate_refund_password(new_password)
    if problem:
        return error_response(problem, 400, code="validation_error")
    try:
        set_refund_password(new_password, current_agent().get("email") or "unknown")
        return jsonify({"success": True, "configured": True})
    except ValueError as e:
        return error_response(str(e), 400, code="validation_error")
    except Exception as e:
        logger.error(f"Set refund password failed: {type(e).__name__}: {e}")
        return error_response("Could not update the refund password.", 500)


@bp.route('/api/admin/settings/refund-password/status', methods=['GET'])
@require_staff('admin', 'super_admin')
def refund_password_status():
    """Whether a refund password is configured."""
    return jsonify({"success": True, "configured": refund_password_configured()})

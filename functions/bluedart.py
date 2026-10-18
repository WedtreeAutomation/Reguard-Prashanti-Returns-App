"""
BlueDart integration: serviceability, waybill (AWB + pickup) creation and
cancellation, tracking.

* JWT cached in process memory until shortly before it expires (thread-safe).
* Every request has a timeout; logs carry AWB / return ids only (no names,
  phones or addresses).
* Generate: requires ``returnId`` + ``idempotencyKey``; refuses a second active
  AWB (409 ``awb_exists``); the AWB is always written to
  ``bluedart_waybills/{awb}`` so it can never be orphaned, even if updating the
  return document fails.
* Cancel: the return document changes ONLY after BlueDart confirmed the AWB
  cancellation (and the pickup cancellation when a pickup token exists);
  otherwise 502 with details and no state change.
"""
import os
import base64
import json
import re
import threading
import time
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

import requests
from firebase_admin import firestore
from flask import Blueprint, jsonify, request
from google.cloud.firestore_v1.base_query import FieldFilter

import core
import guards
from core import logger
from guards import Conflict, GuardError, ServiceUnavailable
from notifications import notify
from security import error_response, json_body, require_staff

bp = Blueprint('bluedart', __name__)

REQUEST_TIMEOUT = (5, 30)
SERVICEABILITY_TIMEOUT = (5, 10)
PINCODE_CACHE_TTL_MS = 7 * 24 * 3600 * 1000
MAX_PINCODES_PER_CALL = 20
PINCODE_RE = re.compile(r"^[1-9][0-9]{5}$")
AWB_RE = re.compile(r"^[A-Za-z0-9]{6,20}$")
EARLY_STATUSES = {'', 'pending', 'open', 'approved'}
EARLY_REFUND_STATUSES = {'', 'pending', 'not started', 'none'}
EARLY_SHIPMENT_STATUSES = {'', 'pending', 'pickup cancelled', 'self ship requested', 'not started'}


# ==========================================================
# CONFIGURATION
# ==========================================================
class BlueDartConfig:
    BLUEDART_TOKEN_URL = core.env("BLUEDART_TOKEN_URL")
    BLUEDART_WAYBILL_URL = core.env("BLUEDART_WAYBILL_URL")
    BLUEDART_CANCEL_WAYBILL_URL = core.env("BLUEDART_CANCEL_WAYBILL_URL")
    BLUEDART_CANCEL_PICKUP_URL = core.env("BLUEDART_CANCEL_PICKUP_URL")
    BLUEDART_TRACKING_URL = core.env("BLUEDART_TRACKING_URL")
    BLUEDART_SERVICE_URL = core.env("BLUEDART_SERVICE_URL")
    BD_VERSION = core.env("BD_VERSION")
    BD_CLIENT_ID = core.env("BD_CLIENT_ID")
    BD_CLIENT_SECRET = core.env("BD_CLIENT_SECRET")
    BD_LOGIN_ID = core.env("BD_LOGIN_ID")
    BD_LICENCE_KEY = core.env("BD_LICENCE_KEY")
    BD_TRACKING_LICENSE_KEY = core.env("BD_TRACKING_LICENSE_KEY")
    BD_CUSTOMER_CODE = core.env("BD_CUSTOMER_CODE")
    # Same variable as notifications.py (e-mail tracking links); legacy name kept as fallback.
    PUBLIC_TRACKING_URL = (os.environ.get("BLUEDART_TRACKING_URL_TEMPLATE")
                           or core.env("BLUEDART_PUBLIC_TRACKING_URL",
                                       "https://www.bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo={awb}"))

    @classmethod
    def profile(cls) -> Dict[str, Any]:
        return {"LoginID": cls.BD_LOGIN_ID, "LicenceKey": cls.BD_LICENCE_KEY, "Api_type": "S"}


class BlueDartError(Exception):
    """BlueDart call failed. ``unknown`` = the outcome is not known (timeout)."""

    def __init__(self, message: str, user_message: str, unknown: bool = False, details: Optional[Dict] = None):
        super().__init__(message)
        self.user_message = user_message
        self.unknown = unknown
        self.details = details or {}


# ==========================================================
# JWT (cached, thread-safe)
# ==========================================================
_jwt_lock = threading.Lock()
_jwt_cache: Dict[str, Any] = {"token": None, "expires_at": 0.0}


def _jwt_expiry(token: str) -> float:
    """Epoch seconds when we should stop using ``token`` (2 min safety margin)."""
    now = time.time()
    try:
        payload_b64 = token.split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)))
        exp = float(payload.get("exp"))
        return max(now + 30, min(exp - 120, now + 12 * 3600))
    except (IndexError, ValueError, TypeError, AttributeError):
        return now + 3600


def get_bluedart_jwt(force_refresh: bool = False) -> str:
    with _jwt_lock:
        if not force_refresh and _jwt_cache["token"] and time.time() < _jwt_cache["expires_at"]:
            return _jwt_cache["token"]
        if not BlueDartConfig.BLUEDART_TOKEN_URL:
            raise BlueDartError("BLUEDART_TOKEN_URL not configured", "BlueDart is not configured on the server.")
        try:
            response = requests.get(BlueDartConfig.BLUEDART_TOKEN_URL, timeout=REQUEST_TIMEOUT, headers={
                "ClientID": BlueDartConfig.BD_CLIENT_ID or "", "clientSecret": BlueDartConfig.BD_CLIENT_SECRET or ""})
            token = response.json().get("JWTToken") if response.status_code == 200 else None
        except (requests.RequestException, ValueError) as e:
            raise BlueDartError(f"JWT fetch failed: {type(e).__name__}", "Could not reach BlueDart. Please try again.") from e
        if not token:
            logger.error(f"BlueDart JWT fetch failed (HTTP {response.status_code})")
            raise BlueDartError("JWT missing", "BlueDart authentication failed. Please try again later.")
        _jwt_cache.update(token=token, expires_at=_jwt_expiry(token))
        return token


def _bd_post(url: Optional[str], payload: Dict[str, Any], timeout=REQUEST_TIMEOUT) -> requests.Response:
    """POST with the cached JWT; refreshes the JWT once on HTTP 401.

    Raises BlueDartError(unknown=True) on read timeouts / dropped connections
    (the request may have been processed) and unknown=False when it never left.
    """
    if not url:
        raise BlueDartError("BlueDart URL not configured", "BlueDart is not configured on the server.")
    for attempt in range(2):
        headers = {"Content-Type": "application/json", "JWTToken": get_bluedart_jwt(force_refresh=attempt > 0)}
        try:
            response = requests.post(url, json=payload, headers=headers, timeout=timeout)
        except requests.exceptions.ConnectTimeout as e:
            raise BlueDartError("connect timeout", "Could not reach BlueDart. Please try again.") from e
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            raise BlueDartError(type(e).__name__, "BlueDart did not respond in time.", unknown=True) from e
        except requests.RequestException as e:
            raise BlueDartError(type(e).__name__, "Could not reach BlueDart. Please try again.") from e
        if response.status_code == 401 and attempt == 0:
            continue
        return response
    return response


def _json(response: requests.Response) -> Dict[str, Any]:
    try:
        body = response.json()
        return body if isinstance(body, dict) else {}
    except ValueError:
        return {}


def _provider_message(result: Dict[str, Any], default: str) -> str:
    statuses = result.get("Status") or []
    if isinstance(statuses, list) and statuses and isinstance(statuses[0], dict):
        return str(statuses[0].get("StatusInformation") or default)[:300]
    return str(result.get("ErrorMessage") or default)[:300]


# ==========================================================
# SERVICEABILITY
# ==========================================================
def parse_serviceability(resp_data: Dict[str, Any]) -> Optional[bool]:
    """BlueDart pincode answer -> True/False, or None when not understood."""
    result = resp_data.get("GetServicesforPincodeResult")
    if not isinstance(result, dict) or "IsError" not in result:
        return None
    if result.get("IsError") or str(result.get("ErrorMessage", "")).strip().lower() != "valid":
        return False
    return any(str(result.get(k, "No")).strip().lower() == "yes"
               for k in ("ApexOutbound", "GroundOutbound", "DomesticPriorityOutbound"))


def _cached_pincodes(pins: List[str]) -> Tuple[Dict[str, bool], List[str]]:
    results, missing = {}, []
    now = guards.now_ms()
    for pin in pins:
        try:
            snap = core.db.collection("bluedart_pincodes").document(pin).get() if core.db else None
            data = snap.to_dict() if snap is not None and snap.exists else None
        except Exception as e:
            logger.warning(f"Pincode cache read failed: {type(e).__name__}")
            data = None
        if data and isinstance(data.get("is_serviceable"), bool) and now - int(data.get("checkedAtMs") or 0) < PINCODE_CACHE_TTL_MS:
            results[pin] = data["is_serviceable"]
        else:
            missing.append(pin)
    return results, missing


def _fetch_pincode(pin: str) -> Optional[bool]:
    payload = {"pinCode": pin, "profile": dict(BlueDartConfig.profile(), Version=BlueDartConfig.BD_VERSION)}
    try:
        response = _bd_post(BlueDartConfig.BLUEDART_SERVICE_URL, payload, timeout=SERVICEABILITY_TIMEOUT)
    except BlueDartError as e:
        logger.warning(f"Serviceability check for {pin} failed: {e}")
        return None
    if response.status_code != 200:
        logger.warning(f"Serviceability check for {pin}: HTTP {response.status_code}")
        return None
    return parse_serviceability(_json(response))


@bp.route("/api/bluedart/serviceability", methods=["POST"])
@require_staff()
def check_serviceability():
    """``{pincodes:[...]}`` (max 20, 6 digits) -> ``{results:{pin: bool}, failed:[pins]}``.

    Only successful, understood answers are cached (7 days); failures are
    reported in ``failed`` and never cached.
    """
    raw = json_body().get("pincodes")
    if not isinstance(raw, list):
        return error_response("pincodes must be a list.", 400, code="invalid_field")
    pins = sorted({str(p).strip() for p in raw if str(p).strip()})
    invalid = [p for p in pins if not PINCODE_RE.match(p)]
    if invalid:
        return error_response("Pincodes must be 6 digits.", 400, code="invalid_pincode", invalid=invalid[:20])
    if len(pins) > MAX_PINCODES_PER_CALL:
        return error_response(f"At most {MAX_PINCODES_PER_CALL} pincodes per request.", 400, code="too_many_pincodes")
    if not pins:
        return jsonify({"success": True, "results": {}, "failed": []})

    results, missing = _cached_pincodes(pins)
    failed: List[str] = []
    if missing:
        with ThreadPoolExecutor(max_workers=min(5, len(missing))) as pool:
            answers = dict(zip(missing, pool.map(_fetch_pincode, missing)))
        for pin, answer in answers.items():
            if answer is None:
                failed.append(pin)
                continue
            results[pin] = answer
            if core.db:
                try:
                    core.db.collection("bluedart_pincodes").document(pin).set({
                        "pincode": pin, "is_serviceable": answer,
                        "checkedAt": firestore.SERVER_TIMESTAMP, "checkedAtMs": guards.now_ms(),
                    })
                except Exception as e:
                    logger.warning(f"Pincode cache write failed: {type(e).__name__}")
    return jsonify({"success": True, "results": results, "failed": failed})


# ==========================================================
# WAYBILL GENERATION
# ==========================================================
def has_active_awb(data: Dict[str, Any], active_records: Optional[List[str]] = None) -> Optional[str]:
    """The request's live AWB (or None), from server-owned state only.

    * ``activeWaybill`` -- set by this server when a pickup is created, cleared
      when BlueDart confirms the cancellation (locked in firestore.rules);
    * any ``bluedart_waybills`` record of this request still ``active``
      (``active_records``);
    * legacy documents (no activeWaybill): the ``awb`` field, unless its
      waybill record says it was cancelled. ``shipmentStatus`` (staff-
      writable) is only consulted for legacy AWBs without any record.
    """
    active = data.get("activeWaybill")
    if isinstance(active, dict) and str(active.get("awb") or "").strip():
        return str(active["awb"]).strip()
    if active_records:
        return active_records[0]
    awb = str(data.get("awb") or "").strip()
    if not awb or "activeWaybill" in data:
        return None
    if str(data.get("shipmentStatus") or "").strip().lower() == "pickup cancelled":
        return None
    return awb


def _active_waybill_records(return_id: str, data: Dict[str, Any]) -> List[str]:
    """AWBs whose top-level record for this request is still active (and the
    legacy ``awb`` when its record was not cancelled)."""
    out: List[str] = []
    try:
        db = guards.firestore_db()
        for snap in (db.collection("bluedart_waybills")
                     .where(filter=FieldFilter("returnId", "==", return_id)).stream()):
            rec = snap.to_dict() or {}
            if rec.get("status") == "active" and not rec.get("awbCancelledAt"):
                out.append(snap.id)
        legacy = str(data.get("awb") or "").strip()
        if legacy and legacy not in out and "activeWaybill" not in data:
            rec_snap = db.collection("bluedart_waybills").document(legacy).get()
            rec = rec_snap.to_dict() or {} if rec_snap.exists else {}
            if rec_snap.exists and rec.get("status") != "cancelled" and not rec.get("awbCancelledAt"):
                out.append(legacy)
    except GuardError:
        raise
    except Exception as e:
        logger.error(f"Waybill records of {return_id} could not be read: {type(e).__name__}")
        raise ServiceUnavailable("Could not verify existing pickups. Please try again.", code="db_unavailable")
    return out


def _no_active_awb(data: Dict[str, Any], active_records: Optional[List[str]] = None) -> None:
    awb = has_active_awb(data, active_records)
    if awb:
        raise Conflict("This request already has an active pickup (AWB). Cancel it before creating a new one.",
                       code="awb_exists", awb=awb)
    if str(data.get("status") or "").strip().lower() in {'closed', 'denied', 'rejected', 'cancelled', 'completed'}:
        raise Conflict("This request is closed; a pickup cannot be created.", code="return_closed")


def _build_waybill_payload(body: Dict[str, Any], data: Dict[str, Any]) -> Dict[str, Any]:
    req = body.get("Request")
    if not isinstance(req, dict) or not isinstance(req.get("Services"), dict):
        raise GuardError("Request.Services is required.", code="invalid_field")
    if not data.get("RAN"):
        raise GuardError("This request has no RAN.", code="missing_ran")
    req = json.loads(json.dumps(req))  # deep copy
    req["Services"]["CreditReferenceNo"] = data["RAN"]  # never trust the client's reference
    if BlueDartConfig.BD_CUSTOMER_CODE and isinstance(req.get("Shipper"), dict):
        req["Shipper"]["CustomerCode"] = BlueDartConfig.BD_CUSTOMER_CODE
    return {"Request": req, "Profile": BlueDartConfig.profile()}


def _decode_label(content: Any) -> Optional[bytes]:
    if isinstance(content, list) and content:
        if isinstance(content[0], int):
            return bytes(content)
        if isinstance(content[0], str):
            return base64.b64decode(content[0])
    if isinstance(content, str) and content:
        return base64.b64decode(content)
    return None


def _store_label(return_id: str, awb: str, content: Any) -> Optional[str]:
    """Upload the label PDF with a Firebase download token; return the tokenised URL."""
    if not content or core.bucket is None:
        return None
    try:
        pdf = _decode_label(content)
        if not pdf:
            return None
        path = f"returns/{return_id}/labels/AWB_{awb}.pdf"
        token = str(uuid.uuid4())
        blob = core.bucket.blob(path)
        blob.metadata = {"firebaseStorageDownloadTokens": token}
        blob.upload_from_string(pdf, content_type="application/pdf")
        return (f"https://firebasestorage.googleapis.com/v0/b/{core.bucket.name}/o/"
                f"{urllib.parse.quote(path, safe='')}?alt=media&token={token}")
    except Exception as e:
        logger.error(f"Label upload for AWB {awb} failed: {type(e).__name__}")
        return None


def update_firebase_with_waybill(return_ref, awb: str, token_number: Any, pickup_date: Any, label_url: Optional[str],
                                 tracking_url: str) -> bool:
    """Record the pickup on the return document (transaction, one retry).

    ``status`` / ``refundStatus`` / ``shipmentStatus`` only move forward: they
    are set only while the current value is earlier in the lifecycle.
    """
    stamp = guards.agent_stamp()

    @firestore.transactional
    def _txn(transaction):
        snap = return_ref.get(transaction=transaction)
        data = snap.to_dict() or {}
        update: Dict[str, Any] = {
            "activeWaybill": {"awb": awb, "createdAtMs": guards.now_ms()},
            "awb": awb, "pickupToken": token_number, "pickupDate": pickup_date, "shippingLabelUrl": label_url,
            "courierPartner": "Blue Dart", "trackingUrl": tracking_url,
            "awbCreatedAt": firestore.SERVER_TIMESTAMP, "updatedAt": firestore.SERVER_TIMESTAMP,
            "pickupCreatedBy": stamp,
        }
        if str(data.get("status") or "").strip().lower() in EARLY_STATUSES:
            update["status"] = "Approved"
        if str(data.get("refundStatus") or "").strip().lower() in EARLY_REFUND_STATUSES:
            update["refundStatus"] = "Pending"
        if str(data.get("shipmentStatus") or "").strip().lower() in EARLY_SHIPMENT_STATUSES:
            update["shipmentStatus"] = "Pickup Created"
        transaction.update(return_ref, update)
        transaction.set(return_ref.collection("bluedart_waybills").document(awb), {
            "awb": awb, "tokenNumber": token_number, "pickupDate": pickup_date, "labelUrl": label_url,
            "createdAt": firestore.SERVER_TIMESTAMP, "createdBy": stamp,
        })
        guards.add_activity(return_ref, "Pickup Created", f"Return pickup scheduled. AWB: {awb}",
                            metadata={"awb": awb, "tokenNumber": token_number}, transaction=transaction)

    for attempt in range(2):
        try:
            _txn(guards.firestore_db().transaction())
            return True
        except Exception as e:
            logger.error(f"Return doc update for AWB {awb} failed (attempt {attempt + 1}): {type(e).__name__}")
    return False


def _write_waybill_record(awb: str, data: Dict[str, Any]) -> bool:
    """Durable top-level record ``bluedart_waybills/{awb}`` (merge)."""
    try:
        guards.firestore_db().collection("bluedart_waybills").document(awb).set(
            dict(data, updatedAt=firestore.SERVER_TIMESTAMP), merge=True)
        return True
    except Exception as e:
        logger.error(f"WAYBILL RECORD NOT WRITTEN for AWB {awb}: {type(e).__name__}")
        return False


def _mask_phone(phone: Any) -> Optional[str]:
    digits = re.sub(r"\D", "", str(phone or ""))
    return f"******{digits[-4:]}" if len(digits) >= 4 else None


def _pickup_block(awb: str, pickup_date: Any, req: Dict[str, Any], data: Dict[str, Any], tracking_url: str) -> Dict[str, Any]:
    shipper = req.get("Shipper") or {}
    services = req.get("Services") or {}
    # Return docs created by the portal carry `customer` (+ `pickupAddressOverride`);
    # `pickupAddress` / `shippingAddress` only exist on legacy documents.
    address = next((data.get(k) for k in ("pickupAddressOverride", "pickupAddress")
                    if isinstance(data.get(k), dict)), {})
    shipping = data.get("shippingAddress") if isinstance(data.get("shippingAddress"), dict) else {}
    cust = data.get("customer") if isinstance(data.get("customer"), dict) else {}
    time_raw = re.sub(r"\D", "", str(services.get("PickupTime") or ""))
    time_window = None
    if len(time_raw) == 4:
        hour, minute = int(time_raw[:2]), time_raw[2:]
        time_window = f"After {hour % 12 or 12}:{minute} {'AM' if hour < 12 else 'PM'}"
    date_value = pickup_date or services.get("PickupDate")
    return {
        "courier": "Blue Dart",
        "awb": awb,
        "pickupDate": core.iso_utc(date_value),
        "pickupDateDisplay": core.ist_display(date_value, with_time=False),
        "timeWindow": time_window,
        "address": {
            "name": shipper.get("CustomerName") or address.get("name") or cust.get("name"),
            "lines": [ln for ln in (shipper.get("CustomerAddress1"), shipper.get("CustomerAddress2"),
                                    shipper.get("CustomerAddress3")) if ln]
                     or [ln for ln in (address.get("address") or cust.get("address"),) if ln],
            "city": address.get("city") or shipping.get("city") or cust.get("city"),
            "state": address.get("state") or shipping.get("province") or shipping.get("state") or cust.get("state"),
            "pincode": shipper.get("CustomerPincode") or address.get("zip") or cust.get("zip"),
            "phone": _mask_phone(shipper.get("CustomerMobile") or address.get("phone") or cust.get("phone")),
        },
        "trackingUrl": tracking_url,
    }


@bp.route("/api/bluedart/waybill/generate", methods=["POST"])
@require_staff()
def generate_waybill():
    """Create the BlueDart AWB + pickup for a return (idempotent, one active AWB)."""
    body = json_body()
    try:
        return_id = guards.validate_return_id(body.get("returnId"))
        key = guards.validate_idempotency_key(body.get("idempotencyKey"))
        record, stored = guards.begin_idempotent("bluedart:generate", key, guards.fingerprint_of(return_id),
                                                 unknown_code="waybill_status_unknown")
    except GuardError as e:
        return e.to_response()
    if stored is not None:
        return jsonify(dict(stored, duplicate=True)), 200

    return_ref = None
    locked = False
    try:
        return_ref, current = guards.load_return(return_id)
        records = _active_waybill_records(return_id, current)
        data = guards.claim_lock(return_ref, "waybill", key, precheck=lambda d: _no_active_awb(d, records),
                                 in_progress_code="waybill_in_progress", unknown_code="waybill_status_unknown")
        locked = True
        payload = _build_waybill_payload(body, data)
        if not guards.set_lock_stage(return_ref, "waybill", key, "executing"):
            raise Conflict("Another agent is already creating this pickup.", code="waybill_in_progress")
        response = _bd_post(BlueDartConfig.BLUEDART_WAYBILL_URL, payload)
    except GuardError as e:
        if locked:
            guards.release_lock(return_ref, "waybill", key)
        record.fail(e.message)
        return e.to_response()
    except BlueDartError as e:
        if e.unknown:
            return _waybill_unknown(return_ref, key, record, str(e))
        if locked:
            guards.release_lock(return_ref, "waybill", key)
        record.fail(str(e))
        return error_response(e.user_message, 502, code="bluedart_error")

    if response.status_code >= 500:
        # A 5xx from BlueDart (or a gateway in front of it) does not prove the
        # waybill was not created: treat it like a timeout.
        logger.warning(f"BlueDart waybill for return {return_id}: HTTP {response.status_code} (outcome unknown)")
        return _waybill_unknown(return_ref, key, record, f"HTTP {response.status_code}")
    response_data = _json(response)
    result = response_data.get("GenerateWayBillResult", response_data) if isinstance(response_data, dict) else {}
    awb = str(result.get("AWBNo") or "").strip()
    if response.status_code != 200 or result.get("IsError") or not awb:
        message = _provider_message(result, "Waybill generation failed")
        logger.warning(f"BlueDart waybill refused for return {return_id} (HTTP {response.status_code})")
        if response.status_code == 200 and not result.get("IsError") and not awb:
            guards.set_lock_stage(return_ref, "waybill", key, "unknown", error="no AWB in response")
            record.unknown("no AWB in response")
            return error_response("BlueDart did not return an AWB number. Check the BlueDart portal before retrying.",
                                  502, code="bluedart_error", statusUnknown=True)
        guards.release_lock(return_ref, "waybill", key)
        record.fail(message)
        return error_response(message, 400 if response.status_code == 200 else 502, code="bluedart_rejected",
                              response={"GenerateWayBillResult": {"IsError": True, "Status": result.get("Status") or []}})

    return _finish_waybill(return_ref, return_id, key, record, data, payload, result, awb)


def _waybill_unknown(return_ref, key, record, error: str):
    """Outcome unknown: keep the lock 'unknown' (an admin resolves it after
    checking the BlueDart portal) and the idempotency key 'unknown'."""
    guards.set_lock_stage(return_ref, "waybill", key, "unknown", error=error)
    record.unknown(error)
    guards.add_activity(return_ref, "Pickup status unknown",
                        "BlueDart did not confirm the pickup. Check the BlueDart portal; an admin must resolve this "
                        "request before another pickup can be created.", type_="warning")
    return error_response("BlueDart did not confirm the pickup, so its status is unknown. Check the BlueDart "
                          "portal before retrying; an admin must resolve this request.", 504,
                          code="bluedart_status_unknown", statusUnknown=True)


def _finish_waybill(return_ref, return_id, key, record, data, payload, result, awb):
    """BlueDart succeeded: persist durably, update the request, notify."""
    token_number = result.get("TokenNumber")
    pickup_date = result.get("PickupDate")
    tracking_url = BlueDartConfig.PUBLIC_TRACKING_URL.replace("{awb}", urllib.parse.quote(awb))
    stamp = guards.agent_stamp()
    _write_waybill_record(awb, {"awb": awb, "returnId": return_id, "RAN": data.get("RAN"), "tokenNumber": token_number,
                                "pickupDate": pickup_date, "status": "active", "createdBy": stamp,
                                "createdAt": firestore.SERVER_TIMESTAMP})
    label_url = _store_label(return_id, awb, result.get("AWBPrintContent"))
    if label_url:
        _write_waybill_record(awb, {"labelUrl": label_url})
    firebase_updated = update_firebase_with_waybill(return_ref, awb, token_number, pickup_date, label_url, tracking_url)
    if firebase_updated:
        guards.release_lock(return_ref, "waybill", key)
    else:
        _write_waybill_record(awb, {"returnDocUpdated": False})
        guards.set_lock_stage(return_ref, "waybill", key, "unknown", error=f"AWB {awb} created; doc update failed")
    response = {
        "success": True, "awbNumber": awb, "tokenNumber": token_number, "pickupDate": pickup_date,
        "labelUrl": label_url, "trackingUrl": tracking_url, "firebaseUpdated": firebase_updated,
        "message": "Pickup created successfully", "emailSent": False,
    }
    record.complete(response)
    try:
        response["emailSent"] = bool(notify("pickup_created", return_id,
                                            extra={"pickup": _pickup_block(awb, pickup_date, payload["Request"], data, tracking_url)},
                                            dedupe_key="pickup_created:" + awb))
    except Exception as e:
        logger.error(f"pickup_created notification failed: {type(e).__name__}")
    if response["emailSent"]:
        record.complete(response)
    return jsonify(response), 200


# ==========================================================
# CANCELLATION
# ==========================================================
def _waybill_details(return_ref, awb: str) -> Tuple[Dict[str, Any], bool]:
    """Server-side token/date for an AWB, and whether it belongs to this return.

    Looks at ``returns/{id}/bluedart_waybills/{awb}`` and the top-level
    ``bluedart_waybills/{awb}`` record.
    """
    details: Dict[str, Any] = {}
    belongs = False
    for ref, is_sub in ((return_ref.collection("bluedart_waybills").document(awb), True),
                        (guards.firestore_db().collection("bluedart_waybills").document(awb), False)):
        try:
            snap = ref.get()
            if not snap.exists:
                continue
            row = snap.to_dict() or {}
            belongs = belongs or is_sub or row.get("returnId") == return_ref.id
            for k, v in row.items():
                details.setdefault(k, v)
        except Exception as e:
            logger.warning(f"Waybill lookup for {awb} failed: {type(e).__name__}")
    return details, belongs


def _cancel_awb(awb: str) -> Tuple[bool, str]:
    response = _bd_post(BlueDartConfig.BLUEDART_CANCEL_WAYBILL_URL, {"Request": {"AWBNo": awb}, "Profile": BlueDartConfig.profile()})
    body = _json(response)
    inner = body.get("CancelWaybillResult", body)
    ok = response.status_code == 200 and isinstance(inner, dict) and inner.get("IsError") is False
    return ok, "" if ok else _provider_message(inner if isinstance(inner, dict) else {}, f"HTTP {response.status_code}")


def _cancel_pickup(token_number: Any, pickup_date: Any) -> Tuple[bool, str]:
    try:
        numeric_token = int(str(token_number).strip())
    except (TypeError, ValueError):
        return False, "Invalid pickup token"
    response = _bd_post(BlueDartConfig.BLUEDART_CANCEL_PICKUP_URL, {
        "request": {"TokenNumber": numeric_token, "PickupRegistrationDate": str(pickup_date),
                    "Remarks": "Cancelled via Returns Portal"},
        "profile": BlueDartConfig.profile(),
    })
    body = _json(response)
    inner = body.get("CancelPickupResult", body)
    ok = response.status_code == 200 and isinstance(inner, dict) and not inner.get("IsError", True)
    return ok, "" if ok else _provider_message(inner if isinstance(inner, dict) else {}, f"HTTP {response.status_code}")


@bp.route("/api/bluedart/waybill/cancel", methods=["POST"])
@require_staff()
def cancel_waybill():
    """Cancel the AWB and its pickup; update the request only when BlueDart confirmed."""
    body = json_body()
    try:
        return_ref, data = guards.load_return(body.get("returnId"))
        awb = str(body.get("awbNumber") or "").strip()
        if not AWB_RE.match(awb):
            raise GuardError("A valid awbNumber is required.", code="invalid_awb")
    except GuardError as e:
        return e.to_response()
    reason = str(body.get("reason") or "Cancelled by agent").strip()[:300]
    notes = str(body.get("additionalNotes") or "").strip()[:1000] or None
    reschedule = body.get("rescheduleAllowed") is True

    details, belongs = _waybill_details(return_ref, awb)
    if str(data.get("awb") or "").strip() != awb and not belongs:
        return error_response("This AWB does not belong to this request.", 409, code="awb_mismatch")
    token_number = details.get("tokenNumber") or body.get("tokenNumber")
    raw = details.get("rawResponse") if isinstance(details.get("rawResponse"), dict) else {}
    pickup_date = details.get("pickupDate") or raw.get("PickupDate") or body.get("pickupDate")

    try:
        if details.get("awbCancelledAt"):
            awb_ok, awb_msg = True, ""  # cancelled by an earlier attempt whose pickup step failed
        else:
            awb_ok, awb_msg = _cancel_awb(awb)
            if awb_ok:
                _write_waybill_record(awb, {"awb": awb, "returnId": return_ref.id, "awbCancelledAt": guards.now_ms()})
        if not awb_ok:
            return error_response(f"BlueDart did not cancel the AWB: {awb_msg}", 502, code="bluedart_cancel_failed",
                                  awbCancelled=False, pickupCancelled=False)
        pickup_needed = bool(token_number and pickup_date)
        pickup_ok, pickup_msg = (_cancel_pickup(token_number, pickup_date) if pickup_needed else (True, ""))
        if not pickup_ok:
            return error_response(f"The AWB was cancelled but BlueDart did not cancel the pickup: {pickup_msg}. "
                                  f"Please retry.", 502, code="bluedart_cancel_failed", awbCancelled=True,
                                  pickupCancelled=False)
    except BlueDartError as e:
        return error_response(e.user_message + (" The cancellation status is unknown; check the BlueDart portal."
                                                if e.unknown else ""), 502, code="bluedart_cancel_failed",
                              statusUnknown=e.unknown)

    firebase_updated = _record_cancellation(return_ref, data, awb, reason, notes, reschedule, pickup_needed)
    _write_waybill_record(awb, {"status": "cancelled", "cancelledAtMs": guards.now_ms(), "cancelReason": reason})
    email_sent = False
    try:
        email_sent = notify("pickup_cancelled", return_ref.id,
                            extra={"cancellation": {"awb": awb, "reason": reason, "notes": notes,
                                                    "rescheduleAllowed": reschedule}},
                            dedupe_key="pickup_cancelled:" + awb)
    except Exception as e:
        logger.error(f"pickup_cancelled notification failed: {type(e).__name__}")
    return jsonify({
        "success": True, "message": "Cancellation completed",
        "awb_cancellation_status": "Success",
        "pickup_cancellation_status": "Success" if pickup_needed else "Not required",
        "firebaseUpdated": firebase_updated, "emailSent": bool(email_sent),
    })


def _record_cancellation(return_ref, data, awb, reason, notes, reschedule, pickup_cancelled) -> bool:
    stamp = guards.agent_stamp()
    update: Dict[str, Any] = {
        "shipmentStatus": "Pickup Cancelled",
        "cancelledAt": firestore.SERVER_TIMESTAMP,
        "updatedAt": firestore.SERVER_TIMESTAMP,
        "cancellationDetails": {
            "awb": awb, "awbCancelled": True, "pickupCancelled": bool(pickup_cancelled), "reason": reason,
            "notes": notes, "rescheduleAllowed": reschedule, "cancelledBy": stamp, "cancelledAtMs": guards.now_ms(),
        },
    }
    if str(data.get("status") or "").strip().lower() in EARLY_STATUSES:
        update["status"] = "Open"
    if str(data.get("awb") or "") == awb:
        update["awb"] = ""
        update["previousAWB"] = awb
    active = data.get("activeWaybill")
    if not isinstance(active, dict) or str(active.get("awb") or "") in ("", awb):
        update["activeWaybill"] = None
    ok = guards.update_with_retry(return_ref, update)
    guards.add_activity(return_ref, "Pickup Cancelled", f"Pickup with AWB {awb} cancelled. Reason: {reason}",
                        type_="warning", metadata={"awb": awb, "rescheduleAllowed": reschedule})
    return ok


# ==========================================================
# TRACKING
# ==========================================================
@bp.route("/api/bluedart/tracking", methods=["GET"])
@require_staff()
def track_shipment():
    """Track one or more AWBs (comma separated, max 25) via BlueDart's servlet."""
    awbs = [a.strip() for a in (request.args.get("awb") or "").split(",") if a.strip()]
    if not awbs:
        return error_response("AWB number required", 400, code="missing_field")
    if len(awbs) > 25 or not all(AWB_RE.match(a) for a in awbs):
        return error_response("Invalid AWB number(s).", 400, code="invalid_awb")
    if not BlueDartConfig.BLUEDART_TRACKING_URL:
        return error_response("Tracking is not configured.", 503, code="not_configured")
    params = {"handler": "tnt", "action": "custawbquery", "loginid": BlueDartConfig.BD_LOGIN_ID,
              "lickey": BlueDartConfig.BD_TRACKING_LICENSE_KEY, "numbers": ",".join(awbs), "format": "json",
              "verno": "1.3", "scan": "1", "awb": "awb"}
    try:
        response = requests.get(BlueDartConfig.BLUEDART_TRACKING_URL, params=params, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as e:
        logger.warning(f"Tracking request failed: {type(e).__name__}")
        return error_response("BlueDart tracking is unavailable. Please try again.", 502, code="bluedart_error")
    tracking = _json(response) if response.status_code == 200 else None
    shipment_data = (tracking or {}).get("ShipmentData")
    if isinstance(shipment_data, dict) and "Error" in shipment_data:
        return error_response(f"Blue Dart: {str(shipment_data['Error'])[:200]}", 400, code="bluedart_error")
    return jsonify({"success": tracking is not None, "tracking": tracking,
                    "error": None if tracking is not None else "Tracking failed"})

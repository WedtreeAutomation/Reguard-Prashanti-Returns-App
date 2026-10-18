"""
Customer / agent e-mail notifications (sent through n8n).

INTERFACE (stable — other modules call these):

    notify(event, return_id, extra=None, dedupe_key=None) -> bool
        Build the payload for ``event`` from the Firestore return document
        ``returns/{return_id}`` (+ ``extra`` supplied by the caller), POST it to
        the n8n webhook for that event, and record the result on the return
        document under ``notifications.<dedupe_key or event>``.
        Returns True when n8n accepted the payload (2xx). Never raises.
        If ``dedupe_key`` was already sent successfully, does nothing and
        returns True.

    notify_agent_otp(email, name, otp, expiry_minutes) -> bool

Payload shapes: CONTRACT.md §6. ``extra`` for refund_done / exchange_processed /
pickup_created / pickup_cancelled / self_ship_requested may be either the
event block itself (``{"refund": {...}}``) or its flat contents
(``{"method": ..., "amount": ...}``); values given by the caller win over values
derived from the return document.
"""
import os
import re
import time
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from firebase_admin import firestore

from core import (BRAND_LOGO_URL, BRAND_NAME, BRAND_PRIMARY_COLOR, PUBLIC_APP_URL, RETURN_POLICY_URL,
                  STORE_WEBSITE_URL, SUPPORT_EMAIL, SUPPORT_PHONE, db, ist_display, iso_utc, logger, money,
                  safe_int, trigger_webhook, utcnow)

EVENT_WEBHOOK_ENV: Dict[str, str] = {
    "return_applied": "N8N_RETURN_APPLIED_WEBHOOK",
    "exchange_applied": "N8N_EXCHANGE_APPLIED_WEBHOOK",
    "mixed_applied": "N8N_MIXED_APPLIED_WEBHOOK",
    "return_rejected": "N8N_REJECTION_WEBHOOK",
    "return_closed": "N8N_CLOSED_WEBHOOK",
    "item_rejected": "N8N_ITEM_REJECTION_WEBHOOK",
    "self_ship_requested": "N8N_SELF_SHIP_WEBHOOK",
    "pickup_created": "N8N_PICKUP_CREATED_WEBHOOK",
    "pickup_cancelled": "N8N_PICKUP_CANCELLED_WEBHOOK",
    "return_received": "N8N_RETURN_RECEIVED_WEBHOOK",
    "refund_done": "N8N_REFUND_DONE_WEBHOOK",
    "exchange_processed": "N8N_EXCHANGE_PROCESSED_WEBHOOK",
    "agent_otp": "N8N_OTP_WEBHOOK",
}
RETURN_EVENTS = frozenset(EVENT_WEBHOOK_ENV) - {"agent_otp"}

REQUESTED_METHOD_LABELS = {
    "store_credit": "Store Credit",
    "gift_card": "Gift Card",
    "refund": "Original Payment Method",
    "none": "Not applicable",
}
REFUND_METHOD_LABELS = {
    "gift_card": "Gift Card",
    "store_credit": "Store Credit",
    "original_payment": "Original Payment Method",
    "manual": "Manual Refund",
}
REFUND_METHOD_ALIASES = {"giftcard": "gift_card", "gift-card": "gift_card", "original": "original_payment",
                         "original-payment": "original_payment", "refund": "original_payment",
                         "store-credit": "store_credit"}
EXPECTED_TIMELINES = {
    "original_payment": "5–7 business days",
    "gift_card": "Immediately (sent to your e-mail)",
    "store_credit": "Immediately (added to your store account)",
    "manual": "3–5 business days",
}
OUTCOME_LABELS = {"even": "Even exchange", "refund": "Refund due to you", "extra": "Balance payable by you"}
DEFAULT_TRACKING_TEMPLATE = "https://www.bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo={awb}"
SENDING_CLAIM_SECONDS = 120


# ==========================================================
# SMALL PURE HELPERS
# ==========================================================
def webhook_url_for(event: str) -> Optional[str]:
    """N8N_NOTIFY_WEBHOOK (if set) receives every event; else the per-event URL."""
    override = os.environ.get("N8N_NOTIFY_WEBHOOK")
    if override:
        return override
    env_name = EVENT_WEBHOOK_ENV.get(event)
    return os.environ.get(env_name) if env_name else None


def notification_key(raw: str) -> str:
    """Firestore-safe map key (field paths only allow [A-Za-z0-9_] unquoted)."""
    return re.sub(r"[^A-Za-z0-9_]", "_", str(raw or "event"))[:120] or "event"


def normalize_refund_method(method: Any) -> str:
    m = str(method or "").strip().lower()
    return REFUND_METHOD_ALIASES.get(m, m) or "manual"


def mask_phone(phone: Any) -> str:
    digits = re.sub(r"\D", "", str(phone or ""))
    return ("•" * 6 + digits[-4:]) if len(digits) >= 4 else ""


def request_type(doc: Dict[str, Any]) -> str:
    """'return' | 'exchange' | 'mixed' from the doc's items (fallback: actionType)."""
    actions = {str(i.get("actionType") or "return").lower() for i in (doc.get("items") or []) if isinstance(i, dict)}
    if {"return", "exchange"} <= actions:
        return "mixed"
    if actions == {"exchange"}:
        return "exchange"
    if actions:
        return "return"
    at = str(doc.get("actionType") or "return").lower()
    return at if at in ("return", "exchange", "mixed") else "return"


def rejected_line_ids(doc: Dict[str, Any]) -> set:
    return {safe_int(r.get("lineItemId")) for r in (doc.get("rejectedItems") or []) if isinstance(r, dict)}


def build_items(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
    rejected = rejected_line_ids(doc)
    items = []
    for it in doc.get("items") or []:
        if not isinstance(it, dict):
            continue
        qty = safe_int(it.get("quantityReturned"), 0) or 0
        unit = money(it.get("price"))
        items.append({
            "lineItemId": safe_int(it.get("lineItemId")),
            "title": it.get("title") or "",
            "variant": it.get("variantTitle") or it.get("variant") or "",
            "sku": it.get("sku") or "",
            "quantity": qty,
            "unitPrice": unit,
            "lineTotal": money(unit * qty),
            "image": it.get("productImage") or "",
            "action": str(it.get("actionType") or "return").lower(),
            "reason": it.get("reason") or "",
            "rejected": safe_int(it.get("lineItemId")) in rejected,
        })
    return items


def brand_block(order_name: str) -> Dict[str, Any]:
    return {
        "name": BRAND_NAME,
        "logoUrl": BRAND_LOGO_URL,
        "primaryColor": BRAND_PRIMARY_COLOR,
        "supportEmail": SUPPORT_EMAIL,
        "supportPhone": SUPPORT_PHONE,
        "website": STORE_WEBSITE_URL,
        "portalUrl": PUBLIC_APP_URL,
        "trackUrl": f"{PUBLIC_APP_URL}/ReturnStatusPage?order={quote(str(order_name or ''), safe='')}",
        "returnPolicyUrl": RETURN_POLICY_URL,
    }


def _event_input(extra: Optional[Dict[str, Any]], block_key: str) -> Dict[str, Any]:
    """Caller-provided data for an event block (nested or flat)."""
    if not isinstance(extra, dict):
        return {}
    nested = extra.get(block_key)
    if isinstance(nested, dict):
        return nested
    return {k: v for k, v in extra.items() if v is not None}


def _merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    out.update({k: v for k, v in override.items() if v is not None})
    return out


def _address_lines(*parts: Any) -> List[str]:
    return [str(p).strip() for p in parts if p and str(p).strip()]


# ==========================================================
# EVENT BLOCKS
# ==========================================================
def _applied_block(doc: Dict[str, Any], items: List[Dict[str, Any]]) -> Dict[str, Any]:
    return_value = sum(i["lineTotal"] for i in items if i["action"] == "return")
    exchange_value = sum(i["lineTotal"] for i in items if i["action"] == "exchange")
    code = str(doc.get("requestedMethod") or "none")
    has_return = any(i["action"] == "return" for i in items)
    return {
        "requestedMethod": {"code": code, "label": REQUESTED_METHOD_LABELS.get(code, code)} if has_return else None,
        "totals": {"returnValue": money(return_value), "exchangeValue": money(exchange_value)},
    }


def _item_rejected_block(doc, items, extra) -> Dict[str, Any]:
    data = _event_input(extra, "rejectedItem")
    line_id = safe_int(data.get("lineItemId"))
    item = next((i for i in items if i["lineItemId"] == line_id), None) or {}
    rejected_entry = next((r for r in (doc.get("rejectedItems") or [])
                           if isinstance(r, dict) and safe_int(r.get("lineItemId")) == line_id), {})
    reason = data.get("reason") or rejected_entry.get("reason") or ""
    remaining = sum(1 for i in items if not i["rejected"] and i["lineItemId"] != line_id)
    return {
        "rejectedItem": {
            "title": item.get("title") or rejected_entry.get("title") or "",
            "sku": item.get("sku") or rejected_entry.get("sku") or "",
            "quantity": item.get("quantity") or safe_int(rejected_entry.get("quantityReturned"), 0),
            "unitPrice": item.get("unitPrice", money(rejected_entry.get("price"))),
            "image": item.get("image") or "",
            "reason": reason,
        },
        "remainingItemsCount": remaining,
    }


def _self_ship_block(doc, extra) -> Dict[str, Any]:
    data = _event_input(extra, "selfShip")
    wh = data.get("warehouse") if isinstance(data.get("warehouse"), dict) else {}
    derived_wh = {
        "name": doc.get("selfShipWarehouseName") or "",
        "addressLines": _address_lines(doc.get("selfShipWarehouseAddress")),
        "city": "", "state": "", "pincode": "", "phone": "",
    }
    return {"selfShip": {
        "warehouse": _merge(derived_wh, wh),
        "instructions": data.get("instructions") or doc.get("selfShipInstructions") or "",
        "deadline": data.get("deadline") or doc.get("selfShipDeadline"),
    }}


def _pickup_block(doc, extra) -> Dict[str, Any]:
    data = _event_input(extra, "pickup")
    cust = doc.get("customer") or {}
    awb = str(data.get("awb") or doc.get("awb") or "")
    pickup_date = data.get("pickupDate") or doc.get("pickupDate")
    template = os.environ.get("BLUEDART_TRACKING_URL_TEMPLATE") or DEFAULT_TRACKING_TEMPLATE
    derived = {
        "courier": "Blue Dart",
        "awb": awb,
        "pickupDate": iso_utc(pickup_date) or (pickup_date if isinstance(pickup_date, str) else None),
        "pickupDateDisplay": ist_display(pickup_date, with_time=False),
        "timeWindow": doc.get("pickupTime") or None,
        "address": {
            "name": cust.get("name") or "",
            "lines": _address_lines(cust.get("address")),
            "city": cust.get("city") or "",
            "state": cust.get("state") or "",
            "pincode": cust.get("zip") or "",
            "phone": mask_phone(cust.get("phone")),
        },
        "trackingUrl": template.format(awb=quote(awb, safe="")) if awb else None,
    }
    block = _merge(derived, data)
    if isinstance(block.get("address"), dict) and block["address"].get("phone"):
        block["address"] = dict(block["address"], phone=mask_phone(block["address"]["phone"]))
    return {"pickup": block}


def _cancellation_block(doc, extra) -> Dict[str, Any]:
    data = _event_input(extra, "cancellation")
    return {"cancellation": {
        "awb": str(data.get("awb") or doc.get("awb") or doc.get("cancelledAwb") or ""),
        "reason": data.get("reason") or doc.get("pickupCancellationReason") or "",
        "notes": data.get("notes") or data.get("additionalNotes") or None,
        "rescheduleAllowed": bool(data.get("rescheduleAllowed", True)),
    }}


def _receipt_block(doc, items) -> Dict[str, Any]:
    rejected = {safe_int(r.get("lineItemId")): r for r in (doc.get("rejectedItems") or []) if isinstance(r, dict)}
    received_at = doc.get("receivedAt") or doc.get("updatedAt")
    rtype = request_type(doc)
    return {"receipt": {
        "receivedAt": iso_utc(received_at),
        "receivedAtDisplay": ist_display(received_at),
        "itemsAccepted": [i["title"] for i in items if not i["rejected"]],
        "itemsRejected": [{"title": i["title"], "reason": (rejected.get(i["lineItemId"]) or {}).get("reason", "")}
                          for i in items if i["rejected"]],
        "nextStep": {"return": "refund", "exchange": "exchange"}.get(rtype, "mixed"),
    }}


def _refund_block(doc, extra) -> Dict[str, Any]:
    data = _event_input(extra, "refund")
    method = normalize_refund_method(data.get("method") or doc.get("refundMethod"))
    amount = money(data.get("amount") if data.get("amount") is not None else doc.get("refundAmount"))
    block = {
        "method": method,
        "methodLabel": REFUND_METHOD_LABELS.get(method, method.replace("_", " ").title()),
        "amount": amount,
        "expectedTimeline": EXPECTED_TIMELINES.get(method, ""),
    }
    if method == "gift_card":
        block["giftCardCode"] = data.get("giftCardCode") or doc.get("giftCardCode")
        block["giftCardExpiresOn"] = data.get("giftCardExpiresOn") or doc.get("giftCardExpiresOn")
    reference = data.get("reference") or data.get("transactionId") or data.get("manualReference")
    if reference:
        block["reference"] = str(reference)
    if isinstance(data.get("breakdown"), dict):
        block["breakdown"] = data["breakdown"]
    for key in ("methodLabel", "expectedTimeline"):
        if data.get(key):
            block[key] = data[key]
    return {"refund": block}


def _exchange_block(doc, items, extra) -> Dict[str, Any]:
    data = _event_input(extra, "exchange")
    stored = doc.get("exchangeResult") if isinstance(doc.get("exchangeResult"), dict) else {}
    outcome = str(data.get("outcome") or stored.get("financialOutcome") or doc.get("financialOutcome") or "even")
    if data.get("amount") is not None:
        amount = money(data.get("amount"))
    elif outcome == "refund":
        amount = money(stored.get("netRefundAmount", doc.get("netRefundAmount")))
    elif outcome == "extra":
        amount = money(abs(money(stored.get("outstandingBalance", doc.get("outstandingBalance")))))
    else:
        amount = 0.0
    items_sent = data.get("itemsSent")
    if not isinstance(items_sent, list):
        items_sent = stored.get("itemsSent") if isinstance(stored.get("itemsSent"), list) else []
    return {"exchange": {
        "outcome": outcome,
        "outcomeLabel": data.get("outcomeLabel") or OUTCOME_LABELS.get(outcome, outcome),
        "amount": amount,
        "invoiceSent": bool(data.get("invoiceSent", stored.get("invoiceSent", doc.get("invoiceSent", False)))),
        "itemsSent": [{"title": s.get("title", ""), "variant": s.get("variant") or s.get("variantTitle") or "",
                       "quantity": safe_int(s.get("quantity"), 1), "image": s.get("image") or ""}
                      for s in items_sent if isinstance(s, dict)],
        "itemsReturned": data.get("itemsReturned") or [
            {"title": i["title"], "quantity": i["quantity"]}
            for i in items if i["action"] == "exchange" and not i["rejected"]],
    }}


# ==========================================================
# PAYLOAD BUILDER (pure)
# ==========================================================
def build_payload(event: str, return_id: str, doc: Dict[str, Any],
                  extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Assemble the full n8n payload for a return event (no I/O)."""
    doc = doc or {}
    extra = extra or {}
    cust = doc.get("customer") or {}
    order_name = doc.get("orderId") or return_id
    items = build_items(doc)
    submitted = doc.get("createdAt") or doc.get("submittedAt")
    payload: Dict[str, Any] = {
        "event": event,
        "recipient": (cust.get("email") or "").strip(),
        "brand": brand_block(order_name),
        "customer": {"name": cust.get("name") or "Customer", "email": cust.get("email") or "",
                     "phone": cust.get("phone") or ""},
        "order": {"name": order_name, "id": safe_int(doc.get("orderNumericId"))},
        "request": {"returnId": return_id, "RAN": doc.get("RAN") or "", "type": request_type(doc),
                    "submittedAt": iso_utc(submitted), "submittedAtDisplay": ist_display(submitted)},
        "items": items,
        "currency": doc.get("currency") or "INR",
        "sentAt": iso_utc(utcnow()),
    }
    if event in ("return_applied", "exchange_applied", "mixed_applied"):
        payload.update(_applied_block(doc, items))
    elif event == "return_rejected":
        payload["rejection"] = {"reason": extra.get("reason") or doc.get("rejectionReason") or ""}
    elif event == "return_closed":
        payload["closure"] = {"reason": extra.get("reason") or doc.get("rejectionReason") or "",
                              "canResubmit": True, "newRequestUrl": PUBLIC_APP_URL}
    elif event == "item_rejected":
        payload.update(_item_rejected_block(doc, items, extra))
    elif event == "self_ship_requested":
        payload.update(_self_ship_block(doc, extra))
    elif event == "pickup_created":
        payload.update(_pickup_block(doc, extra))
    elif event == "pickup_cancelled":
        payload.update(_cancellation_block(doc, extra))
    elif event == "return_received":
        payload.update(_receipt_block(doc, items))
    elif event == "refund_done":
        payload.update(_refund_block(doc, extra))
    elif event == "exchange_processed":
        payload.update(_exchange_block(doc, items, extra))
    return payload


def build_agent_otp_payload(email: str, name: str, otp: str, expiry_minutes: int) -> Dict[str, Any]:
    return {
        "event": "agent_otp",
        "recipient": email,
        "brand": brand_block(""),
        "agent": {"name": name or "", "email": email},
        "otp": otp,
        "expiryMinutes": int(expiry_minutes),
        "email": email,  # legacy key read by the pre-Re-Guard n8n OTP workflow
        "sentAt": iso_utc(utcnow()),
    }


# ==========================================================
# SENDING + DEDUPE
# ==========================================================
def _claim(ref, key: str, dedupe: bool):
    """Return ('send', doc) | ('sent', None) | ('busy', None) | ('missing', None).

    With ``dedupe`` a transaction marks ``notifications.<key>`` as 'sending'
    so concurrent callers don't both e-mail the customer.
    """
    if not dedupe:
        snap = ref.get()
        return ("send", snap.to_dict() or {}) if snap.exists else ("missing", None)

    @firestore.transactional
    def _txn(transaction):
        snap = ref.get(transaction=transaction)
        if not snap.exists:
            return "missing", None
        doc = snap.to_dict() or {}
        state = ((doc.get("notifications") or {}).get(key)) or {}
        if state.get("status") == "sent":
            return "sent", None
        claimed_at = state.get("claimedAtEpoch") or 0
        if state.get("status") == "sending" and time.time() - float(claimed_at) < SENDING_CLAIM_SECONDS:
            return "busy", None
        transaction.update(ref, {f"notifications.{key}": {"status": "sending", "claimedAtEpoch": int(time.time()),
                                                          "at": firestore.SERVER_TIMESTAMP}})
        return "send", doc

    return _txn(db.transaction())


def _record(ref, key: str, event: str, ok: bool, error: Optional[str] = None) -> None:
    entry = {"status": "sent" if ok else "failed", "event": event, "at": firestore.SERVER_TIMESTAMP}
    if error:
        entry["error"] = error[:300]
    try:
        ref.update({f"notifications.{key}": entry})
    except Exception as e:
        logger.error(f"Could not record notification state {key}: {type(e).__name__}")


def notify(event: str, return_id: str, extra: Optional[Dict[str, Any]] = None,
           dedupe_key: Optional[str] = None) -> bool:
    """Send a customer e-mail for ``event`` on ``returns/{return_id}``. Never raises."""
    try:
        if event not in RETURN_EVENTS:
            logger.error(f"notify: unknown event {event!r}")
            return False
        if not db or not return_id:
            logger.error(f"notify({event}): database unavailable or missing return id")
            return False
        ref = db.collection("returns").document(str(return_id))
        key = notification_key(dedupe_key or event)
        state, doc = _claim(ref, key, dedupe=bool(dedupe_key))
        if state == "sent":
            logger.info(f"notify({event}, {return_id}): already sent ({key}); skipping")
            return True
        if state == "missing":
            logger.error(f"notify({event}): return {return_id} not found")
            return False
        if state == "busy":
            logger.warning(f"notify({event}, {return_id}): another send is in progress ({key})")
            return False
        payload = build_payload(event, str(return_id), doc, extra)
        if not payload.get("recipient"):
            _record(ref, key, event, False, "no recipient e-mail on the return")
            return False
        url = webhook_url_for(event)
        ok = trigger_webhook(url, payload, f"notify:{event}:{return_id}")
        _record(ref, key, event, ok, None if ok else ("webhook not configured" if not url else "webhook failed"))
        return ok
    except Exception as e:
        logger.error(f"notify({event}, {return_id}) failed: {type(e).__name__}: {e}")
        return False


def notify_agent_otp(email: str, name: str, otp: str, expiry_minutes: int) -> bool:
    """E-mail a password-reset OTP to an agent. Never raises; never logs the OTP."""
    try:
        if not email or not otp:
            return False
        payload = build_agent_otp_payload(email, name, otp, expiry_minutes)
        return trigger_webhook(webhook_url_for("agent_otp"), payload, "notify:agent_otp")
    except Exception as e:
        logger.error(f"notify_agent_otp failed: {type(e).__name__}")
        return False

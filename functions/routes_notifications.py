"""
Staff-triggered customer notifications (CONTRACT §4.2) and the self-ship flow.

The browser only says *which* return and *what happened*; every e-mail
payload is built server-side from Firestore (notifications.py).
"""
import re
from typing import Any, Dict, List, Optional

from firebase_admin import firestore
from flask import Blueprint, jsonify

from core import db, is_terminal_status, logger, safe_int, shopify_add_tag, shopify_timeline_note
from notifications import REQUESTED_METHOD_LABELS, notify
from security import current_agent, error_response, json_body, require_staff

bp = Blueprint('notifications', __name__)

RETURN_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9\-_#]{0,63}$')
SELF_SHIP_TAG = "Return Approved Self Ship Requested"
MAX_TEXT = 1000


def _clean_text(value: Any, limit: int = MAX_TEXT) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ''


def _load_return(return_id: Any):
    """(ref, doc) or (None, error_response)."""
    if not db:
        return None, error_response("Service temporarily unavailable.", 503)
    if not isinstance(return_id, str) or not RETURN_ID_RE.match(return_id):
        return None, error_response("A valid returnId is required.", 400, code="validation_error")
    ref = db.collection('returns').document(return_id)
    snap = ref.get()
    if not snap.exists:
        return None, error_response("Return not found.", 404, code="not_found")
    return ref, snap.to_dict() or {}


def warehouse_address_lines(wh: Dict[str, Any]) -> List[str]:
    return [str(wh.get(k)).strip() for k in ('address1', 'address2', 'address3') if wh.get(k) and str(wh.get(k)).strip()]


def warehouse_full_address(wh: Dict[str, Any]) -> str:
    parts = warehouse_address_lines(wh) + [str(wh.get(k)).strip() for k in ('city', 'state', 'pincode', 'country')
                                           if wh.get(k) and str(wh.get(k)).strip()]
    return ', '.join(parts)


def notify_event_for(path_event: str, body: Dict[str, Any], doc: Dict[str, Any]):
    """Map /api/notify/<event> to (event, extra, dedupe_key) or raise ValueError."""
    if path_event == 'return-rejected':
        allow = body.get('allowResubmit')
        if not isinstance(allow, bool):
            allow = bool(doc.get('allowResubmit'))
        event = 'return_closed' if allow else 'return_rejected'
        reason = _clean_text(body.get('reason')) or _clean_text(doc.get('rejectionReason'))
        return event, {'reason': reason}, event
    if path_event == 'item-rejected':
        line_id = safe_int(body.get('lineItemId'))
        if line_id is None or not any(safe_int(i.get('lineItemId')) == line_id for i in doc.get('items') or []):
            raise ValueError("lineItemId does not belong to this return.")
        return 'item_rejected', {'lineItemId': line_id, 'reason': _clean_text(body.get('reason'))}, \
            f"item_rejected_{line_id}"
    if path_event == 'return-received':
        return 'return_received', {}, 'return_received'
    raise LookupError(path_event)


@bp.route('/api/notify/<event>', methods=['POST'])
@require_staff()
def notify_customer(event):
    """Send a customer e-mail for a staff action. Body: {returnId, ...eventInputs}."""
    body = json_body()
    ref, doc = _load_return(body.get('returnId'))
    if ref is None:
        return doc
    try:
        server_event, extra, dedupe_key = notify_event_for(event, body, doc)
    except LookupError:
        return error_response("Unknown notification type.", 404, code="unknown_event")
    except ValueError as e:
        return error_response(str(e), 400, code="validation_error")
    sent = notify(server_event, body['returnId'], extra, dedupe_key=dedupe_key)
    if not sent:
        return error_response("The e-mail could not be sent. Please try again later.", 502, code="email_failed")
    return jsonify({'success': True, 'emailSent': True})


def _self_ship_note(doc: Dict[str, Any], wh_name: str, wh_address: str, agent_name: str,
                    instructions: str, deadline: Optional[str]) -> str:
    method = REQUESTED_METHOD_LABELS.get(doc.get('requestedMethod') or '', 'Original Payment Method')
    lines = [f"Warehouse: {wh_name}", f"Address: {wh_address}", f"Refund Method: {method}"]
    if deadline:
        lines.append(f"Ship by: {deadline}")
    if instructions:
        lines.append(f"Instructions: {instructions}")
    lines.append(f"Requested by: {agent_name}")
    return "\n".join(lines)


@bp.route('/api/returns/self-ship', methods=['POST'])
@require_staff()
def process_self_ship():
    """Ask the customer to ship the items themselves to a configured warehouse."""
    body = json_body()
    ref, doc = _load_return(body.get('returnId'))
    if ref is None:
        return doc
    if is_terminal_status(doc.get('status')) or str(doc.get('refundStatus') or '').strip().lower() == 'refunded':
        return error_response("This request is already closed or refunded; self-ship cannot be requested.", 409,
                              code="request_terminal")
    warehouse_id = body.get('warehouseId')
    if not isinstance(warehouse_id, str) or not re.fullmatch(r'[A-Za-z0-9_\-]{1,128}', warehouse_id):
        return error_response("A valid warehouseId is required.", 400, code="validation_error")
    instructions = _clean_text(body.get('instructions'))
    deadline = _clean_text(body.get('deadline'), 40) or None
    try:
        wh_snap = db.collection('warehouses').document(warehouse_id).get()
    except Exception as e:
        logger.error(f"Warehouse lookup failed: {type(e).__name__}")
        return error_response("Could not load the warehouse.", 500)
    if not wh_snap.exists:
        return error_response("Warehouse not found.", 404, code="not_found")
    wh = wh_snap.to_dict() or {}
    wh_name = wh.get('name') or 'Warehouse'
    wh_address = warehouse_full_address(wh)
    agent = current_agent()
    agent_name = agent.get('name') or agent.get('email') or 'Agent'
    return_id = body['returnId']

    try:
        ref.update({
            'status': 'Approved',
            'shipmentStatus': 'Self Ship Requested',
            'selfShipWarehouse': warehouse_id,
            'selfShipWarehouseName': wh_name,
            'selfShipWarehouseAddress': wh_address,
            'selfShipInstructions': instructions,
            'selfShipDeadline': deadline,
            'selfShipRequestedAt': firestore.SERVER_TIMESTAMP,
            'selfShipRequestedBy': agent_name,
            'selfShipRequestedByEmail': agent.get('email'),
            'updatedAt': firestore.SERVER_TIMESTAMP,
        })
        ref.collection('activities').add({
            'type': 'info',
            'title': 'Self Ship Requested',
            'description': f"Customer asked to self-ship to {wh_name} warehouse at {wh_address}",
            'timestamp': firestore.SERVER_TIMESTAMP,
            'user': agent_name,
            'metadata': {'RAN': doc.get('RAN'), 'warehouseId': warehouse_id, 'warehouseName': wh_name,
                         'warehouseAddress': wh_address, 'agentEmail': agent.get('email')},
        })
    except Exception as e:
        logger.error(f"Self-ship Firestore update failed for {return_id}: {type(e).__name__}: {e}")
        return error_response("Could not update the return. Please try again.", 500)

    order_numeric_id = doc.get('orderNumericId')
    shopify_ok = False
    if order_numeric_id:
        tag_ok = shopify_add_tag(order_numeric_id, SELF_SHIP_TAG)
        note_ok = shopify_timeline_note(order_numeric_id, doc.get('RAN') or '', 'Self Ship Requested',
                                        _self_ship_note(doc, wh_name, wh_address, agent_name, instructions, deadline))
        shopify_ok = tag_ok and note_ok

    selfship = {'warehouse': {'name': wh_name, 'addressLines': warehouse_address_lines(wh),
                              'city': wh.get('city') or '', 'state': wh.get('state') or '',
                              'pincode': str(wh.get('pincode') or ''), 'phone': wh.get('phone') or ''},
                'instructions': instructions, 'deadline': deadline}
    # No dedupe: re-requesting self-ship (e.g. after a cancelled pickup) must e-mail again.
    email_sent = notify('self_ship_requested', return_id, {'selfShip': selfship})
    try:
        ref.update({'selfShipEmailSent': email_sent,
                    'selfShipEmailSentAt': firestore.SERVER_TIMESTAMP if email_sent else None})
    except Exception as e:
        logger.warning(f"Could not record self-ship e-mail state: {type(e).__name__}")
    return jsonify({'success': True, 'emailSent': email_sent, 'shopifyUpdated': shopify_ok})

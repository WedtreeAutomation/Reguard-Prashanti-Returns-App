"""
Exchange, restock and request-conversion endpoints.

POST /api/exchange/preview                (staff)  returnCalculate preview, no side effects
POST /api/exchange/process                (staff)  returnCreate + returnProcess (+ discount, invoice)
POST /api/exchange/active-price           (staff)  storefront price for a variant
POST /api/exchange/reconcile-hold         (staff)  release AWAITING_PAYMENT holds once paid
POST /api/returns/<returnId>/convert-action (staff) flip return <-> exchange
POST /api/orders/<order_id>/restock       (staff)  inventory adjustment, capped server-side

``_reconcile_and_release_hold`` is also used by the Shopify orders/paid
webhook in routes_orders.
"""
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests
from firebase_admin import firestore
from flask import Blueprint, jsonify
from google.cloud.firestore_v1.base_query import FieldFilter

import core
import guards
from core import is_terminal_status, logger, parse_amount, safe_int
from guards import Conflict, GuardError
from notifications import notify
from security import error_response, json_body, require_staff
from shopify_service import (ShopifyError, ShopifyTimeout, get_shopify_service, numeric_id,
                             order_gid as to_order_gid)

bp = Blueprint('exchange', __name__)

def _env_percent(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name) or default)
        return value if 0 < value <= 100 else default
    except ValueError:
        return default


MAX_EXCHANGE_DISCOUNT_PERCENT = _env_percent('MAX_EXCHANGE_DISCOUNT_PERCENT', 50.0)
LINE_ITEM_RETRY_DELAYS = (1, 2, 3, 4, 5, 6)
BALANCE_POLL_ATTEMPTS = 6
CLOSED_STATUSES = {'closed', 'denied', 'rejected', 'cancelled'}


class HoldReleaseError(RuntimeError):
    """Raised by _reconcile_and_release_hold when a hold could not be released
    (the webhook caller should answer non-2xx so Shopify retries)."""

    def __init__(self, message: str, result: Dict[str, Any]):
        super().__init__(message)
        self.result = result


# ==========================================================
# PURE HELPERS (unit-tested)
# ==========================================================
_REASON_TABLE: Tuple[Tuple[Tuple[str, ...], str], ...] = (
    (("defect", "damage", "broken", "fault", "torn", "tear", "stain", "hole", "loose thread", "poor quality",
      "bad quality"), "DEFECTIVE"),
    (("wrong item", "wrong product", "incorrect item", "different item", "wrong colour", "wrong color",
      "wrong design", "received wrong", "sent wrong", "wrong saree"), "WRONG_ITEM"),
    (("not as described", "not as shown", "not as pictured", "different from", "doesn't match", "does not match",
      "didn't match", "mismatch", "misleading", "not same as", "not like the picture"), "NOT_AS_DESCRIBED"),
    (("too small", "too tight", "tight", "small size", "size small", "size is small", "too short"), "SIZE_TOO_SMALL"),
    (("too large", "too big", "too loose", "loose fit", "is loose", "large size", "size large", "size big",
      "size is big", "size is large", "too long"), "SIZE_TOO_LARGE"),
    (("color", "colour", "shade"), "COLOR"),
    (("style", "design", "don't like", "didn't like", "dont like", "didnt like", "not like"), "STYLE"),
    (("changed my mind", "changed mind", "no longer", "unwanted", "don't need", "dont need", "not needed",
      "not required", "by mistake"), "UNWANTED"),
)


def map_return_reason_to_shopify_enum(reason_text: Optional[str]) -> str:
    """Customer reason text -> Shopify ``ReturnReason`` enum (first match wins;
    more specific groups come first, e.g. 'wrong colour' is WRONG_ITEM, not COLOR)."""
    text = (reason_text or "").strip().lower()
    if not text:
        return "UNKNOWN"
    for keywords, enum_value in _REASON_TABLE:
        if any(k in text for k in keywords):
            return enum_value
    return "OTHER"


_map_return_reason_to_shopify_enum = map_return_reason_to_shopify_enum  # backward-compatible name


def net_fees(total_fees: Any, value_adjustment: Any) -> Dict[str, float]:
    """Net the agent's fees against the credit-row value adjustment.

    Shopify's Return API can only *charge* a return shipping fee; it has no
    credit lever. So negative inputs (a credit to the customer) are rejected
    with a clear message instead of being silently zeroed, and an adjustment
    larger than the fees is reported as ``unappliableAdjustment``.
    """
    fees = guards.money(total_fees)
    adjustment = guards.money(value_adjustment)
    if fees < 0:
        raise GuardError("Fees cannot be negative. Shopify cannot add a credit to an exchange; "
                         "issue any extra credit as a separate refund.", code='negative_fees')
    if adjustment < 0:
        raise GuardError("The value adjustment cannot be negative.", code='negative_fees')
    return {
        'totalFees': fees,
        'valueAdjustment': adjustment,
        'netFee': guards.money(max(0.0, fees - adjustment)),
        'unappliableAdjustment': guards.money(max(0.0, adjustment - fees)),
    }


def outcome_for_balance(balance: Optional[float]) -> str:
    if balance is None:
        return 'unknown'
    if balance > 0.01:
        return 'extra'
    if balance < -0.01:
        return 'refund'
    return 'even'


def variant_gid(value: Any) -> str:
    text = str(value or '').strip()
    return text if text.startswith('gid://') else f"gid://shopify/ProductVariant/{numeric_id(text)}"


def parse_add_items(add_items: Any, max_percent: float = MAX_EXCHANGE_DISCOUNT_PERCENT) -> List[Dict[str, Any]]:
    """Validate replacement items; merge duplicates of the same variant.

    Returns ``[{variantId (gid), quantity, discountPercent, title}]``. Raises
    GuardError on bad quantities, discounts above ``max_percent`` or the same
    variant with different discounts.
    """
    merged: Dict[str, Dict[str, Any]] = {}
    for raw in add_items or []:
        if not isinstance(raw, dict) or not numeric_id(raw.get('variantId')).isdigit():
            raise GuardError('Every replacement item needs a valid variantId.', code='invalid_items')
        qty = safe_int(raw.get('quantity'), 0) or 0
        if qty <= 0:
            raise GuardError('Replacement quantities must be at least 1.', code='invalid_items')
        percent = parse_amount(raw.get('discountPercent'))
        if percent < 0:
            raise GuardError('Discounts cannot be negative.', code='invalid_discount')
        if percent > max_percent + 1e-9:
            raise GuardError(f"Exchange discounts are limited to {max_percent:g}%.", code='discount_too_high',
                             maxDiscountPercent=max_percent)
        gid = variant_gid(raw.get('variantId'))
        if gid in merged:
            if abs(merged[gid]['discountPercent'] - percent) > 0.001:
                raise GuardError('The same replacement variant cannot have two different discounts.',
                                 code='invalid_discount')
            merged[gid]['quantity'] += qty
        else:
            merged[gid] = {'variantId': gid, 'quantity': qty, 'discountPercent': round(percent, 2),
                           'title': str(raw.get('title') or '')[:200]}
    return list(merged.values())


def parse_remove_items(remove_items: Any) -> List[Dict[str, Any]]:
    """Validate returned items; merge duplicates of the same line item."""
    merged: Dict[str, Dict[str, Any]] = {}
    for raw in remove_items or []:
        lid = numeric_id((raw or {}).get('lineItemId')) if isinstance(raw, dict) else ''
        qty = safe_int(raw.get('quantity'), 0) if isinstance(raw, dict) else 0
        if not lid.isdigit() or not qty or qty <= 0:
            raise GuardError('Every returned item needs a lineItemId and a quantity of at least 1.', code='invalid_items')
        if lid in merged:
            merged[lid]['quantity'] += qty
            merged[lid]['restockWish'] += restock_wish(raw)
        else:
            merged[lid] = {'lineItemId': lid, 'quantity': qty, 'title': str(raw.get('title') or '')[:200],
                           'sku': raw.get('sku'), 'reason': raw.get('reason'), 'restockWish': restock_wish(raw)}
    return list(merged.values())


def restock_wish(item: Dict[str, Any]) -> int:
    """How many units the agent wants restocked at exchange time."""
    statuses = item.get('quantityRestockStatus')
    if isinstance(statuses, list) and statuses:
        return sum(1 for s in statuses if s)
    return max(0, safe_int(item.get('quantity'), 0) or 0) if item.get('restock') is True else 0


def plan_dispositions(total_qty: int, already_restocked: int, wish: int, has_location: bool) -> Dict[str, int]:
    """Split a returned line's units into restocked / not restocked.

    Units already restocked at intake are NOT_RESTOCKED here (no double
    counting); without a location nothing can be RESTOCKED. All values are
    clamped so they always add up to ``total_qty``.
    """
    total = max(0, int(total_qty or 0))
    already = min(total, max(0, int(already_restocked or 0)))
    remaining = total - already
    restock = min(remaining, max(0, int(wish or 0))) if has_location else 0
    return {'restocked': restock, 'notRestocked': total - restock, 'alreadyRestocked': already}


def match_discounts_by_variant(add_items: List[Dict[str, Any]], exchange_lines: List[Dict[str, Any]]
                               ) -> Tuple[Dict[str, float], List[str]]:
    """Map requested per-variant discounts onto the real order line items the
    exchange created (matched by ``lineItem.variant.id``, never by position).

    Returns ``({numeric LineItem id: percent}, [problems])``.
    """
    lines_by_variant: Dict[str, List[str]] = {}
    for line in exchange_lines or []:
        line_item = line.get('lineItem') or {}
        vid = (line_item.get('variant') or {}).get('id')
        if vid and line_item.get('id'):
            lines_by_variant.setdefault(vid, []).append(numeric_id(line_item['id']))
    discounts: Dict[str, float] = {}
    problems: List[str] = []
    for item in add_items:
        percent = float(item.get('discountPercent') or 0)
        if percent <= 0.01:
            continue
        line_ids = lines_by_variant.get(item['variantId'])
        if not line_ids:
            problems.append(f"No exchange line found for variant {numeric_id(item['variantId'])}")
            continue
        for lid in line_ids:
            discounts[lid] = percent
    return discounts, problems


def estimate_discount_total(add_items: List[Dict[str, Any]], calc_exchange_lines: List[Dict[str, Any]]) -> float:
    """Preview: discount the per-variant returnCalculate subtotals."""
    subtotal_by_variant: Dict[str, float] = {}
    for line in calc_exchange_lines or []:
        if line.get('variantId'):
            subtotal_by_variant[line['variantId']] = subtotal_by_variant.get(line['variantId'], 0.0) + float(line.get('subtotal') or 0)
    total = 0.0
    for item in add_items:
        percent = float(item.get('discountPercent') or 0)
        if percent > 0.01:
            total += subtotal_by_variant.get(item['variantId'], 0.0) * percent / 100.0
    return guards.money(total)


def fees_from_body(body: Dict[str, Any]) -> Dict[str, float]:
    """Same netting for preview (``valueAdjustment``) and process
    (``feeBreakdown.adjustment``)."""
    breakdown = body.get('feeBreakdown') if isinstance(body.get('feeBreakdown'), dict) else {}
    adjustment = body.get('valueAdjustment') if body.get('valueAdjustment') is not None else breakdown.get('adjustment')
    return net_fees(body.get('totalFees'), adjustment)


# ==========================================================
# PREVIEW
# ==========================================================
@bp.route('/api/exchange/preview', methods=['POST'])
@require_staff()
def preview_exchange():
    """returnCalculate preview (no side effects)."""
    body = json_body()
    try:
        order_id = numeric_id(body.get('shopifyOrderId'))
        if not order_id.isdigit():
            raise GuardError('shopifyOrderId is required.', code='missing_field', field='shopifyOrderId')
        remove_items = parse_remove_items(body.get('removeItems'))
        if not remove_items:
            raise GuardError('At least one returned item is required.', code='invalid_items')
        add_items = parse_add_items(body.get('addItems'))
        fees = fees_from_body(body)
    except GuardError as e:
        return e.to_response()

    try:
        service = get_shopify_service()
        gid = to_order_gid(order_id)
        returnable = service.get_returnable_fulfillment_line_items(gid)
        return_lines, unresolvable = [], []
        for item in remove_items:
            fli = returnable.get(item['lineItemId'])
            if fli:
                return_lines.append({"fulfillmentLineItemId": fli, "quantity": item['quantity']})
            else:
                unresolvable.append(item['title'] or item['lineItemId'])
        if not return_lines:
            return error_response('None of the selected items are currently returnable on Shopify.', 409,
                                  code='items_not_returnable', unresolvableItems=unresolvable)
        financials = service.calculate_return_financials(
            gid, return_lines, [{"variantId": a['variantId'], "quantity": a['quantity']} for a in add_items],
            return_shipping_fee_amount=fees['netFee'], currency_code=body.get('currency') or 'INR')
    except ShopifyError as e:
        return error_response(e.user_message, 502, code='shopify_error')

    discount_total = estimate_discount_total(add_items, financials.get('exchangeLines'))
    discounted_balance = guards.money(financials['netBalance'] - discount_total)
    return jsonify({
        'success': True,
        'netBalance': financials['netBalance'],
        'financialOutcome': financials['financialOutcome'],
        'returnSubtotal': financials['returnSubtotal'],
        'returnTax': financials['returnTax'],
        'exchangeSubtotal': financials['exchangeSubtotal'],
        'exchangeTax': financials['exchangeTax'],
        'unresolvableItems': unresolvable or None,
        'netReturnShippingFee': fees['netFee'],
        'unappliableAdjustment': fees['unappliableAdjustment'],
        'estimatedExchangeDiscountTotal': discount_total,
        'discountedNetBalance': discounted_balance,
        'discountedFinancialOutcome': outcome_for_balance(discounted_balance),
        'maxDiscountPercent': MAX_EXCHANGE_DISCOUNT_PERCENT,
    }), 200


# ==========================================================
# PROCESS
# ==========================================================
class _ExchangeAttempt:
    def __init__(self, record, key: str, return_id: str, return_ref):
        self.record = record
        self.key = key
        self.return_id = return_id
        self.return_ref = return_ref
        self.locked = False
        self.shopify_return_id: Optional[str] = None
        self.return_id_persisted = False  # shopifyReturnId saved on the doc (blocks a 2nd returnCreate)
        self.processed = False  # returnProcess succeeded

    def refuse(self, error: GuardError):
        if self.locked:
            guards.release_lock(self.return_ref, 'exchange', self.key)
        self.record.fail(error.message)
        return error.to_response()


@bp.route('/api/exchange/process', methods=['POST'])
@require_staff()
def process_exchange():
    """Create the Shopify Return + exchange items (returnCreate) and confirm it
    (returnProcess). Shopify computes the balance; nothing here forces a
    number onto the order's ledger.
    """
    body = json_body()
    try:
        return_id = guards.validate_return_id(body.get('returnId'))
        key = guards.validate_idempotency_key(body.get('idempotencyKey'))
        order_id = numeric_id(body.get('shopifyOrderId'))
        if not order_id.isdigit():
            raise GuardError('shopifyOrderId is required.', code='missing_field', field='shopifyOrderId')
        remove_items = parse_remove_items(body.get('removeItems'))
        if not remove_items:
            raise GuardError('At least one returned item is required.', code='invalid_items')
        add_items = parse_add_items(body.get('addItems'))
        fees = fees_from_body(body)
        record, stored = guards.begin_idempotent('exchange:process', key, guards.fingerprint_of(return_id, order_id),
                                                 unknown_code='exchange_status_unknown')
    except GuardError as e:
        return e.to_response()
    if stored is not None:
        return jsonify(dict(stored, duplicate=True)), 200

    try:
        return_ref, data = guards.load_return(return_id)
    except GuardError as e:
        record.fail(e.message)
        return e.to_response()
    attempt = _ExchangeAttempt(record, key, return_id, return_ref)

    if isinstance(data.get('exchangeResult'), dict) and data['exchangeResult']:
        response = _exchange_response(data['exchangeResult'], resumed=True)
        record.complete(response)
        return jsonify(response), 200

    try:
        _validate_exchange_against_doc(order_id, remove_items, data)
        data = guards.claim_lock(return_ref, 'exchange', key, precheck=_exchange_precheck,
                                 in_progress_code='exchange_in_progress', unknown_code='exchange_status_unknown')
        attempt.locked = True
        return _run_exchange(attempt, body, order_id, remove_items, add_items, fees, data)
    except GuardError as e:
        if attempt.shopify_return_id:
            return _exchange_failed(attempt, 'post_create', e.message, unknown=False)
        return attempt.refuse(e)
    except ShopifyTimeout as e:
        return _exchange_failed(attempt, 'returnProcess' if attempt.shopify_return_id else 'returnCreate',
                                type(e).__name__, unknown=True)
    except ShopifyError as e:
        if attempt.shopify_return_id:
            return _exchange_failed(attempt, 'returnProcess', e.user_message, unknown=False)
        return attempt.refuse(GuardError(e.user_message, code='shopify_error', status=502))
    except Exception as e:
        logger.error(f"Unexpected error in process_exchange for {return_id}: {type(e).__name__}", exc_info=True)
        if attempt.processed or attempt.shopify_return_id:
            return _exchange_failed(attempt, 'internal', type(e).__name__, unknown=True)
        return attempt.refuse(GuardError('Something went wrong while processing the exchange. Please try again.',
                                         code='internal_error', status=500))


def _exchange_precheck(data: Dict[str, Any]) -> None:
    if isinstance(data.get('exchangeResult'), dict) and data['exchangeResult']:
        raise Conflict('This exchange has already been processed. Refresh the page.', code='exchange_already_processed')
    if data.get('shopifyReturnId'):
        raise Conflict('A Shopify return was already created for this request but not completed. Finish or cancel it in '
                       'Shopify admin, then ask an admin to resolve the request before retrying.',
                       code='exchange_needs_review', shopifyReturnId=data.get('shopifyReturnId'))
    if str(data.get('status') or '').strip().lower() in CLOSED_STATUSES:
        raise Conflict('This request is closed.', code='return_closed')


def _validate_exchange_against_doc(order_id: str, remove_items: List[Dict[str, Any]], data: Dict[str, Any]) -> None:
    # The order comes from the document (or Shopify by order name), never the body.
    guards.resolve_order_numeric_id(data, order_id)
    # Only the request's EXCHANGE units (server-owned snapshot) may go into the
    # Shopify Return: return-action units are refunded separately (review H3).
    requested = guards.server_returned_qty(data, 'exchange')
    for item in remove_items:
        allowed = requested.get(item['lineItemId'], 0)
        if allowed <= 0:
            raise GuardError(f"{item['title'] or item['lineItemId']} is not part of this request.", code='invalid_items')
        if item['quantity'] > allowed:
            raise GuardError(f"Only {allowed} unit(s) of {item['title'] or item['lineItemId']} were requested.",
                             code='invalid_items')


def _run_exchange(attempt: _ExchangeAttempt, body, order_id, remove_items, add_items, fees, data):
    service = get_shopify_service()
    gid = to_order_gid(order_id)
    currency = body.get('currency') or 'INR'
    agent = guards.agent_stamp()

    # ---- resolve everything BEFORE the first mutation ----
    returnable = service.get_returnable_fulfillment_line_items(gid)
    unresolvable = [i['title'] or i['lineItemId'] for i in remove_items if i['lineItemId'] not in returnable]
    if unresolvable:
        raise GuardError(f"These items are not currently returnable on Shopify (already returned, or not fulfilled): "
                         f"{', '.join(str(u) for u in unresolvable)}. Resolve this on the order first.",
                         code='items_not_returnable', status=409, unresolvableItems=unresolvable)
    # Upper bound for any refund this exchange can produce: the value of the
    # units it sends back (Shopify prices). Keeps unrelated order balance
    # (other refunds owed on the order) out of exchangeResult (review H3).
    returned_value = _returned_items_value(service, gid, remove_items)
    restocked = guards.restocked_qty_by_line_item(data)
    location_gid = None
    if any(i['restockWish'] > 0 and i['quantity'] > restocked.get(i['lineItemId'], 0) for i in remove_items):
        location = service.get_restock_location_id(order_id)
        location_gid = f"gid://shopify/Location/{location}" if location else None
        if not location_gid:
            logger.warning(f"No restock location for order {order_id}; units will be NOT_RESTOCKED")
    by_fli = {returnable[i['lineItemId']]: i for i in remove_items}
    native_return_items = [{
        "fulfillmentLineItemId": returnable[i['lineItemId']],
        "quantity": i['quantity'],
        "returnReason": map_return_reason_to_shopify_enum(i.get('reason')),
        "returnReasonNote": (str(i.get('reason') or 'Exchange'))[:255],
    } for i in remove_items]

    # ---- 1st mutation: returnCreate ----
    if not guards.set_lock_stage(attempt.return_ref, 'exchange', attempt.key, 'executing'):
        raise Conflict('Another agent is already processing this exchange.', code='exchange_in_progress')
    created = service.create_return_with_exchange(
        gid, native_return_items, [{"variantId": a['variantId'], "quantity": a['quantity']} for a in add_items],
        notify_customer=False, requested_at=datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        return_shipping_fee_amount=fees['netFee'], currency_code=currency)
    attempt.shopify_return_id = created['id']
    attempt.return_id_persisted = guards.update_with_retry(attempt.return_ref, {
        'shopifyReturnId': created['id'], 'exchangeState': 'return_created', 'updatedAt': firestore.SERVER_TIMESTAMP})

    # ---- 2nd mutation: returnProcess ----
    rfo_map = service.get_reverse_fulfillment_order_line_item_map(created['id'])
    return_lines, note_lines, not_restocked_lines = [], [], []
    for rli in _edges_nodes(created.get('returnLineItems')):
        fli = (rli.get('fulfillmentLineItem') or {}).get('id')
        rfo_line = rfo_map.get(fli)
        item = by_fli.get(fli)
        if not rfo_line or not item:
            raise ShopifyError(f"Reverse fulfillment line missing for {numeric_id(fli)}",
                               user_message='Shopify did not return the reverse fulfillment lines for this return.')
        plan = plan_dispositions(rli.get('quantity') or item['quantity'], restocked.get(item['lineItemId'], 0),
                                 item['restockWish'], bool(location_gid))
        dispositions = []
        if plan['restocked']:
            dispositions.append({"reverseFulfillmentOrderLineItemId": rfo_line, "quantity": plan['restocked'],
                                 "dispositionType": "RESTOCKED", "locationId": location_gid})
        if plan['notRestocked']:
            dispositions.append({"reverseFulfillmentOrderLineItemId": rfo_line, "quantity": plan['notRestocked'],
                                 "dispositionType": "NOT_RESTOCKED"})
        if plan['alreadyRestocked']:
            note_lines.append(f"{plan['alreadyRestocked']} x {item['title'] or item['lineItemId']}")
        if item['restockWish'] > plan['restocked'] + plan['alreadyRestocked'] and not location_gid:
            not_restocked_lines.append(item['title'] or item['lineItemId'])
        return_lines.append({"id": rli['id'], "quantity": plan['restocked'] + plan['notRestocked'],
                             "dispositions": dispositions})
    note = None
    if note_lines:
        note = (f"{', '.join(note_lines)} already restocked into inventory at intake (Mark-Received); dispositioned "
                f"Not Restocked here only to avoid double-counting inventory.")
    processed = service.process_return(
        created['id'], return_lines,
        [{"id": e['id'], "quantity": e['quantity']} for e in _edges_nodes(created.get('exchangeLineItems'))],
        notify_customer=False, note=note)
    attempt.processed = True

    # ---- after this point the exchange exists in Shopify: nothing below may fail the request ----
    warnings: List[str] = []
    if not_restocked_lines:
        warnings.append('No restock location was found, so these units were not restocked: ' + ', '.join(not_restocked_lines))
    discount = _apply_discounts(service, gid, created['id'], processed, add_items)
    balance, fetched = _resolve_balance(service, gid, discount)
    outcome = outcome_for_balance(balance if fetched else None)
    net_refund = guards.money(min(abs(balance), returned_value)) if outcome == 'refund' else 0.0
    refund_capped = outcome == 'refund' and abs(balance) - net_refund > 0.009
    if refund_capped:
        warnings.append(f"Shopify's order balance (₹{abs(balance):.2f}) is larger than the value of the returned items "
                        f"(₹{returned_value:.2f}); only ₹{net_refund:.2f} is refundable for this exchange. Check the "
                        f"order for other refunds owed.")
    invoice_sent, invoice_error = False, None
    if outcome == 'extra':
        try:
            service.send_exchange_invoice(gid)
            invoice_sent = True
        except ShopifyTimeout:
            invoice_error = 'Shopify did not confirm the invoice e-mail; check the order before resending.'
        except ShopifyError as e:
            invoice_error = e.user_message
    if outcome == 'unknown':
        warnings.append("Shopify's balance for this exchange could not be read. The request needs review before any "
                        "refund or invoice.")

    result = {
        'financialOutcome': outcome,
        'netRefundAmount': net_refund,
        'returnedLineItems': [{'lineItemId': safe_int(i['lineItemId']), 'quantity': i['quantity']} for i in remove_items],
        'returnedItemsValue': guards.money(returned_value),
        'shopifyOrderBalance': guards.money(balance) if fetched else None,
        'refundCappedToReturnedValue': refund_capped,
        'outstandingBalance': guards.money(balance) if outcome == 'extra' else 0.0,
        'invoiceSent': invoice_sent,
        'invoiceError': invoice_error,
        'shopifyReturnId': created['id'],
        'processedAt': core.iso_utc(core.utcnow()),
        'processedAtMs': guards.now_ms(),
        'processedBy': agent,
        'needsReview': outcome == 'unknown',
        'discountPercentage': guards.money(body.get('discountPercentage')),
        'discountAppliedViaOrderEdit': discount['applied'],
        'discountEditError': discount['error'],
        'totalFees': fees['totalFees'],
        'netReturnShippingFee': fees['netFee'],
        'unappliableAdjustment': fees['unappliableAdjustment'],
    }
    timeline_ok = _write_exchange_timeline_note(service, order_id, remove_items, add_items, result, currency, agent)
    if not timeline_ok:
        warnings.append('The Shopify timeline note could not be written.')
    firebase_updated = _persist_exchange(attempt, data, body, fees, result, remove_items, add_items, order_id)
    if not firebase_updated:
        warnings.append('The exchange was processed in Shopify but the request could not be updated. Do NOT process it again.')
    response = _exchange_response(result, resumed=False)
    response.update({'firebaseUpdated': firebase_updated, 'warnings': warnings, 'emailSent': False})
    attempt.record.complete(response)
    if outcome != 'unknown':
        try:
            response['emailSent'] = bool(notify('exchange_processed', attempt.return_id,
                                                extra={'exchange': _exchange_notification(result, remove_items, add_items)},
                                                dedupe_key='exchange_processed:' + attempt.return_id))
        except Exception as e:
            logger.error(f"exchange_processed notification failed: {type(e).__name__}")
        if response['emailSent']:
            attempt.record.complete(response)
    return jsonify(response), 200


def _returned_items_value(service, gid: str, remove_items: List[Dict[str, Any]]) -> float:
    """Shopify value (net of real discounts, + tax when prices exclude it) of
    the units sent back by this exchange. Raises ShopifyError (before any
    mutation, so the attempt is simply refused)."""
    order = (service.get_refund_context(gid) or {}).get('order') or {}
    taxes_included = order.get('taxesIncluded', True) is not False
    lines = {numeric_id(li.get('id')): li for li in order.get('lineItems') or []}
    total = 0.0
    for item in remove_items:
        line = lines.get(item['lineItemId'])
        if line:
            qty = min(int(item['quantity']), max(0, safe_int(line.get('quantity'), 0) or 0))
            total += guards.unit_value(line, taxes_included) * qty
    return guards.money(total)


def _edges_nodes(connection: Any) -> List[Dict[str, Any]]:
    if not isinstance(connection, dict):
        return []
    return [e.get('node') or {} for e in connection.get('edges') or []]


def _apply_discounts(service, gid: str, return_gid: str, processed: Dict[str, Any],
                     add_items: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Post-exchange discount via Order Edit, matched by variant id. Never raises."""
    if not any(a['discountPercent'] > 0.01 for a in add_items):
        return {'applied': False, 'error': None, 'balance': None}
    lines = _edges_nodes(processed.get('exchangeLineItems'))

    def _ready(ls):
        return ls and all((line.get('lineItem') or {}).get('id') and ((line.get('lineItem') or {}).get('variant') or {}).get('id') for line in ls)

    for delay in LINE_ITEM_RETRY_DELAYS:
        if _ready(lines):
            break
        time.sleep(delay)
        try:
            lines = service.get_return_exchange_line_items(return_gid) or lines
        except ShopifyError as e:
            logger.warning(f"Re-reading exchange line items failed: {type(e).__name__}")
    discounts, problems = match_discounts_by_variant(add_items, lines)
    if not discounts:
        return {'applied': False, 'error': '; '.join(problems) or 'Exchange line items were not ready', 'balance': None}
    try:
        result = service.apply_post_exchange_discount(gid, discounts, notify_customer=False)
        return {'applied': True, 'error': '; '.join(problems) or None, 'balance': result['totalOutstanding']}
    except ShopifyTimeout:
        return {'applied': False, 'error': 'Shopify did not confirm the discount; check the order.', 'balance': None}
    except (ShopifyError, ValueError) as e:
        return {'applied': False, 'error': getattr(e, 'user_message', None) or 'The discount could not be applied.', 'balance': None}


def _resolve_balance(service, gid: str, discount: Dict[str, Any]) -> Tuple[float, bool]:
    """(balance, fetched). ``fetched`` is False when Shopify never answered."""
    if discount.get('applied') and discount.get('balance') is not None:
        return float(discount['balance']), True
    balance, fetched = 0.0, False
    for _ in range(BALANCE_POLL_ATTEMPTS):
        time.sleep(1)
        try:
            balance = service.get_order_outstanding_balance(gid)
            fetched = True
            if abs(balance) > 0.01:
                break
        except ShopifyError as e:
            logger.warning(f"Balance poll failed: {type(e).__name__}")
    return balance, fetched


def _write_exchange_timeline_note(service, order_id, remove_items, add_items, result, currency, agent) -> bool:
    removed = "\n".join(f"[-] Removed: {i['quantity']}x {i['title'] or 'Item'}" for i in remove_items)
    added = "\n".join(f"[+] Added: {a['quantity']}x {a['title'] or 'Variant'}"
                      + (f" ({a['discountPercent']:g}% off)" if a['discountPercent'] > 0.01 else '') for a in add_items)
    outcome_text = {
        'refund': f"Refund due to customer: {currency} {result['netRefundAmount']:.2f}",
        'extra': f"Balance due from customer: {currency} {result['outstandingBalance']:.2f}"
                 f" ({'invoice sent' if result['invoiceSent'] else 'invoice NOT sent'})",
        'even': 'No balance due',
        'unknown': 'Balance could not be confirmed - needs review',
    }[result['financialOutcome']]
    lines = ["Unified Exchange Processed", removed, added, outcome_text]
    if result['discountEditError']:
        lines.append(f"[!] Discount not applied: {result['discountEditError']}")
    if result['totalFees'] > 0.009:
        lines.append(f"[!] Adjustments & fees: {currency} {result['totalFees']:.2f}")
    lines.append(f"Action by: {agent['name']}")
    try:
        return service.add_timeline_note(order_id, "\n".join(line for line in lines if line))
    except Exception as e:
        logger.warning(f"Exchange timeline note failed: {type(e).__name__}")
        return False


def _persist_exchange(attempt: _ExchangeAttempt, data, body, fees, result, remove_items, add_items, order_id) -> bool:
    """Write exchangeResult + the legacy fields the UI reads, ledger, activity; release lock."""
    outcome = result['financialOutcome']
    update: Dict[str, Any] = {
        'exchangeResult': result,
        'exchangeState': 'processed',
        'exchangeError': firestore.DELETE_FIELD,
        'financialOutcome': outcome,
        'netRefundAmount': result['netRefundAmount'],
        'outstandingBalance': result['outstandingBalance'],
        'totalFees': fees['totalFees'],
        'netReturnShippingFee': fees['netFee'],
        'unappliableAdjustment': fees['unappliableAdjustment'],
        'discountPercentage': result['discountPercentage'],
        'discountAppliedViaOrderEdit': result['discountAppliedViaOrderEdit'],
        'discountEditError': result['discountEditError'],
        'exchangeLoggedAt': firestore.SERVER_TIMESTAMP,
        'exchangeLoggedBy': result['processedBy']['name'],
        'exchangeLoggedByEmail': result['processedBy'].get('email'),
        # read by the 'exchanges' report (Items sent column)
        'exchangeItemsSent': [{'title': a['title'] or 'Replacement item', 'variantId': a['variantId'],
                               'quantity': a['quantity']} for a in add_items],
        'updatedAt': firestore.SERVER_TIMESTAMP,
        'refundDetails': {
            'discountPercentage': result['discountPercentage'],
            'discountAppliedViaOrderEdit': result['discountAppliedViaOrderEdit'],
            'deductions': _fee_breakdown(body),
            'unappliableAdjustment': fees['unappliableAdjustment'],
        },
    }
    if outcome == 'extra':
        update.update({'status': 'Exchanged_Created', 'needsRefund': False, 'refundStatus': 'Not Eligible',
                       'invoiceSent': result['invoiceSent'], 'invoiceError': result['invoiceError'],
                       'invoiceSentAt': firestore.SERVER_TIMESTAMP if result['invoiceSent'] else None,
                       'awaitingCustomerPayment': True})
    elif outcome == 'even':
        update.update({'status': 'completed', 'needsRefund': False, 'refundStatus': 'Not Eligible',
                       'completedAt': firestore.SERVER_TIMESTAMP})
    elif outcome == 'refund':
        update.update({'status': 'Exchanged_Created', 'needsRefund': True})
    else:  # unknown: keep the request open for review, never silently "Not Eligible"
        update.update({'needsReview': True, 'refundStatus': 'Pending Review'})

    ok = guards.update_with_retry(attempt.return_ref, update)
    if not ok:
        logger.error(f"EXCHANGE PROCESSED BUT DOC NOT UPDATED: returnId={attempt.return_id} shopifyReturn={result['shopifyReturnId']}")
        guards.set_lock_stage(attempt.return_ref, 'exchange', attempt.key, 'unknown', error='processed; doc update failed')
        return False

    returned_items = [{'lineItemId': safe_int(i['lineItemId']), 'title': i['title'], 'sku': i.get('sku'),
                       'quantity': i['quantity'], 'unitPrice': None} for i in remove_items]
    if outcome == 'extra':
        guards.write_ledger_entry('exchange_invoice', result['outstandingBalance'], attempt.return_id, data,
                                  idempotency_key=attempt.key, items=returned_items, order_numeric_id=order_id,
                                  extra={'invoiceSent': result['invoiceSent'], 'shopifyReturnId': result['shopifyReturnId'],
                                         'note': 'Exchange balance invoiced to customer'})
    amount_text = {
        'refund': f"₹{result['netRefundAmount']:.2f} refund due to customer",
        'extra': f"₹{result['outstandingBalance']:.2f} balance due from customer "
                 f"({'checkout link emailed' if result['invoiceSent'] else 'checkout link FAILED to send'})",
        'even': 'items matched in value, no balance due',
        'unknown': "balance could not be confirmed from Shopify - needs review",
    }[outcome]
    guards.add_activity(attempt.return_ref, 'Automated Exchange Processed', f"Exchange processed — {amount_text}.",
                        type_='success' if outcome != 'unknown' else 'warning',
                        metadata={'financialOutcome': outcome, 'amount': result['netRefundAmount'] or result['outstandingBalance'],
                                  'shopifyReturnId': result['shopifyReturnId'],
                                  'discountAppliedViaOrderEdit': result['discountAppliedViaOrderEdit']})
    guards.release_lock(attempt.return_ref, 'exchange', attempt.key)
    return True


def _exchange_failed(attempt: _ExchangeAttempt, stage: str, message: str, unknown: bool):
    """A Shopify Return may exist: record a clear state for manual follow-up."""
    if attempt.shopify_return_id and not attempt.return_id_persisted:
        unknown = True  # nothing on the doc would stop a second returnCreate -> keep the lock
    state = 'process_unknown' if unknown else 'process_failed'
    if not attempt.shopify_return_id:
        state = 'create_unknown'
    guards.update_with_retry(attempt.return_ref, {
        'exchangeState': state,
        'exchangeError': {'stage': stage, 'message': str(message)[:300], 'atMs': guards.now_ms(),
                          'shopifyReturnId': attempt.shopify_return_id, 'by': guards.agent_stamp()},
        'updatedAt': firestore.SERVER_TIMESTAMP,
    })
    guards.add_activity(attempt.return_ref, 'Exchange needs manual follow-up',
                        f"Exchange stopped at {stage}: {str(message)[:200]}. Check the order in Shopify before retrying.",
                        type_='warning', metadata={'shopifyReturnId': attempt.shopify_return_id, 'stage': stage})
    if unknown:
        guards.set_lock_stage(attempt.return_ref, 'exchange', attempt.key, 'unknown', error=stage)
        attempt.record.unknown(f'{stage}: {message}')
        return error_response("Shopify did not confirm the exchange, so its status is unknown. Check the order in "
                              "Shopify before retrying; an admin must resolve this request.", 504,
                              code='shopify_timeout', statusUnknown=True, shopifyReturnId=attempt.shopify_return_id)
    guards.release_lock(attempt.return_ref, 'exchange', attempt.key)
    attempt.record.fail(f'{stage}: {message}')
    return error_response(f"The Shopify return was created but could not be completed ({message}). It needs manual "
                          f"follow-up in Shopify admin; do not retry.", 502, code='exchange_process_failed',
                          shopifyReturnId=attempt.shopify_return_id)


def _exchange_response(result: Dict[str, Any], resumed: bool) -> Dict[str, Any]:
    return {
        'success': True,
        'resumed': resumed,
        'financialOutcome': result.get('financialOutcome'),
        'outstandingBalance': result.get('outstandingBalance', 0.0),
        'netRefundAmount': result.get('netRefundAmount', 0.0),
        'invoiceSent': bool(result.get('invoiceSent')),
        'invoiceError': result.get('invoiceError'),
        'shopifyReturnId': result.get('shopifyReturnId'),
        'discountApplied': result.get('discountPercentage', 0.0),
        'discountAppliedViaOrderEdit': bool(result.get('discountAppliedViaOrderEdit')),
        'discountEditError': result.get('discountEditError'),
        'unappliableAdjustment': result.get('unappliableAdjustment', 0.0),
        'needsReview': bool(result.get('needsReview')),
        'exchangeResult': result,
    }


def _exchange_notification(result, remove_items, add_items) -> Dict[str, Any]:
    labels = {'even': 'No balance due', 'refund': 'Refund due to you', 'extra': 'Balance to be paid'}
    outcome = result['financialOutcome']
    return {
        'outcome': outcome,
        'outcomeLabel': labels.get(outcome, outcome),
        'amount': result['netRefundAmount'] if outcome == 'refund' else result['outstandingBalance'],
        'invoiceSent': result['invoiceSent'],
        'itemsSent': [{'title': a['title'] or 'Replacement item', 'variant': None, 'quantity': a['quantity'], 'image': None}
                      for a in add_items],
        'itemsReturned': [{'title': i['title'] or 'Item', 'quantity': i['quantity']} for i in remove_items],
    }


def _fee_breakdown(body: Dict[str, Any]) -> Dict[str, float]:
    breakdown = body.get('feeBreakdown') if isinstance(body.get('feeBreakdown'), dict) else {}
    return {k: guards.money(breakdown.get(k)) for k in ('restocking', 'reverseShipment', 'forwardShipment', 'adjustment', 'taxes')}


# ==========================================================
# ACTIVE STOREFRONT PRICE
# ==========================================================
@bp.route('/api/exchange/active-price', methods=['POST'])
@require_staff()
def get_active_storefront_price():
    """Post-discount unit price of a variant via a throwaway Storefront cart."""
    body = json_body()
    variant = numeric_id(body.get('variantId'))
    quantity = safe_int(body.get('quantity', 1), 0) or 0
    if not variant.isdigit():
        return error_response('Missing variantId', 400, code='missing_field')
    if quantity <= 0 or quantity > 100:
        return error_response('quantity must be between 1 and 100', 400, code='invalid_quantity')
    token = core.env('SHOPIFY_STOREFRONT_TOKEN')
    if not token or not core.SHOPIFY_STORE:
        logger.error("SHOPIFY_STOREFRONT_TOKEN / shop domain not configured")
        return error_response('Live pricing is not configured.', 503, code='not_configured')

    input_data: Dict[str, Any] = {"lines": [{"merchandiseId": f"gid://shopify/ProductVariant/{variant}", "quantity": quantity}]}
    codes = body.get('discountCodes')
    if isinstance(codes, list) and codes:
        input_data["discountCodes"] = [str(c)[:100] for c in codes[:5]]
    if isinstance(body.get('buyerIdentity'), dict):
        input_data["buyerIdentity"] = body['buyerIdentity']
    query = """
    mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart { lines(first: 1) { edges { node { cost { totalAmount { amount } } } } } }
      }
    }"""
    try:
        response = requests.post(
            f"https://{core.SHOPIFY_STORE}/api/{core.SHOPIFY_API_VERSION}/graphql.json",
            json={"query": query, "variables": {"input": input_data}},
            headers={"X-Shopify-Storefront-Access-Token": token, "Content-Type": "application/json"},
            timeout=(5, 10))
        cart = ((response.json().get('data') or {}).get('cartCreate') or {}).get('cart') if response.status_code == 200 else None
    except (requests.RequestException, ValueError) as e:
        logger.warning(f"Storefront price lookup failed: {type(e).__name__}")
        cart = None
    try:
        total = float(cart['lines']['edges'][0]['node']['cost']['totalAmount']['amount'])
    except (TypeError, KeyError, IndexError, ValueError):
        # 200 so the frontend falls back to the catalogue price (unchanged behaviour)
        return jsonify({'success': False, 'error': 'Could not calculate cart price (item may be out of stock)'}), 200
    return jsonify({'success': True, 'activePrice': guards.money(total / quantity)}), 200


# ==========================================================
# CONVERT RETURN <-> EXCHANGE
# ==========================================================
def _resolve_overall_type(items: List[Dict[str, Any]]) -> str:
    types = {str(i.get('actionType') or '').lower() for i in items if i.get('actionType')}
    if types == {'exchange'}:
        return 'exchange'
    if types and types != {'return'}:
        return 'mixed'
    return 'return'


@bp.route('/api/returns/<return_id>/convert-action', methods=['POST'])
@require_staff()
def convert_action_type(return_id):
    """Flip the whole request (or one ``lineItemId``) between return and exchange.

    ``return_id`` is the Firestore return document id. Refused (409) once the
    request is terminal, refunded or its exchange was processed.
    """
    body = json_body()
    new_type = str(body.get('newActionType') or '').strip().lower()
    line_item_id = body.get('lineItemId')
    if new_type not in ('return', 'exchange'):
        return error_response("newActionType must be 'return' or 'exchange'", 400, code='invalid_field')
    try:
        return_id = guards.validate_return_id(return_id)
        ref = guards.firestore_db().collection('returns').document(return_id)
        outcome = _convert_txn(ref, new_type, line_item_id)
    except GuardError as e:
        return e.to_response()
    except Exception as e:
        logger.error(f"convert-action failed for {return_id}: {type(e).__name__}", exc_info=True)
        return error_response('Could not convert the request. Please try again.', 500, code='internal_error')

    if outcome.get('notifyEvent'):
        try:
            notify(outcome['notifyEvent'], return_id, dedupe_key=f"converted:{return_id}:{new_type}")
        except Exception as e:
            logger.error(f"convert-action notification failed: {type(e).__name__}")
    outcome.pop('notifyEvent', None)
    return jsonify(dict(outcome, success=True))


def _converted_snapshot(data: Dict[str, Any], new_type: str, line_item_id: Optional[str]) -> Optional[List[Dict[str, Any]]]:
    """``submittedItems`` with the converted action type (None for legacy docs)."""
    snapshot = data.get('submittedItems')
    if not isinstance(snapshot, list):
        return None
    out = []
    for entry in snapshot:
        entry = dict(entry) if isinstance(entry, dict) else entry
        if isinstance(entry, dict) and (line_item_id is None or numeric_id(entry.get('lineItemId')) == line_item_id):
            entry['actionType'] = new_type
        out.append(entry)
    return out


def _convert_txn(ref, new_type: str, line_item_id: Any) -> Dict[str, Any]:
    agent = guards.agent_name()

    @firestore.transactional
    def _txn(transaction):
        snap = ref.get(transaction=transaction)
        if not snap.exists:
            raise guards.NotFound('Return not found', code='return_not_found')
        data = snap.to_dict() or {}
        if is_terminal_status(data.get('status')):
            raise Conflict('This request is closed and can no longer be converted.', code='request_terminal')
        if str(data.get('refundStatus') or '').lower() == 'refunded':
            raise Conflict('This request has already been refunded.', code='already_refunded')
        if data.get('exchangeResult') or data.get('shopifyReturnId'):
            raise Conflict('The exchange for this request was already processed in Shopify.', code='exchange_already_processed')
        items = [dict(i) for i in data.get('items') or [] if isinstance(i, dict)]
        old_overall = str(data.get('actionType') or '').strip().lower()
        if old_overall not in ('return', 'exchange', 'mixed'):
            old_overall = 'exchange' if 'exchange' in str(data.get('type') or '').lower() else _resolve_overall_type(items)

        stale_fields = {'financialOutcome': firestore.DELETE_FIELD, 'netRefundAmount': firestore.DELETE_FIELD}
        if line_item_id is not None:
            target = next((i for i in items if str(i.get('lineItemId')) == str(line_item_id)), None)
            if target is None:
                raise guards.NotFound(f'Line item {line_item_id} not found on this return', code='line_item_not_found')
            item_old = str(target.get('actionType') or 'return').lower()
            if item_old == new_type:
                return {'message': 'No change needed', 'actionType': old_overall, 'type': data.get('type'), 'items': items}
            target['actionType'] = new_type
            overall = _resolve_overall_type(items)
            type_str = {'return': 'Return', 'exchange': 'Exchange', 'mixed': 'Mixed'}[overall]
            # The old settlement (financialOutcome / netRefundAmount) was computed
            # for the old item mix -- clear it so modals don't reuse it.
            update = dict(stale_fields, actionType=overall, type=type_str, items=items,
                          needsRefund=overall in ('return', 'mixed'), updatedAt=firestore.SERVER_TIMESTAMP)
            snapshot = _converted_snapshot(data, new_type, numeric_id(line_item_id))
            if snapshot is not None:
                update['submittedItems'] = snapshot
            transaction.update(ref, update)
            guards.add_activity(ref, f"Item converted to {new_type.title()}",
                                f"{target.get('title', 'Item')} (SKU: {target.get('sku', 'N/A')}) converted from "
                                f"{item_old} to {new_type} by {agent}", type_='processing', transaction=transaction)
            return {'actionType': overall, 'type': type_str, 'items': items}

        if old_overall == new_type:
            return {'message': 'No change needed', 'actionType': old_overall, 'type': data.get('type')}
        for item in items:
            item['actionType'] = new_type
        type_str = 'Exchange' if new_type == 'exchange' else 'Return'
        update = {'actionType': new_type, 'type': type_str, 'items': items, 'updatedAt': firestore.SERVER_TIMESTAMP}
        snapshot = _converted_snapshot(data, new_type, None)
        if snapshot is not None:
            update['submittedItems'] = snapshot
        if new_type == 'return':
            # Converting away from an exchange: drop stale exchange-only numbers.
            update.update(stale_fields)
            update['needsRefund'] = True
        transaction.update(ref, update)
        guards.add_activity(ref, f'Converted to {type_str}', f'Request converted from {old_overall} to {new_type} by {agent}',
                            type_='processing', transaction=transaction)
        return {'actionType': new_type, 'type': type_str, 'items': items, 'notifyEvent': f'{new_type}_applied'}

    return _txn(guards.firestore_db().transaction())


# ==========================================================
# RESTOCK
# ==========================================================
@bp.route('/api/orders/<int:order_id>/restock', methods=['POST'])
@require_staff()
def restock_items(order_id):
    """Pure inventory adjustment for returned units, capped server-side by
    (returned quantity - ``restockedQtyByLineItem``). Writes restock_history and
    the return document; never creates a Refund or Return in Shopify."""
    body = json_body()
    try:
        return_ref, data = guards.load_return(body.get('returnId'))
        items = body.get('items')
        if not isinstance(items, list) or not items:
            raise GuardError('items are required.', code='invalid_items')
        # The path's order id must be the return's order (doc, else Shopify by name).
        guards.resolve_order_numeric_id(data, order_id)
    except GuardError as e:
        return e.to_response()
    except ShopifyError as e:
        return error_response(e.user_message, 502, code='shopify_error')
    condition = str(body.get('condition') or '').strip()[:100] or None
    return_id = return_ref.id

    try:
        service = get_shopify_service()
        location = service.get_restock_location_id(order_id)
        if not location:
            return error_response('Could not determine a Shopify location to restock into.', 502, code='no_location')
        normalized = [service.normalize_line_item(n) for n in service.get_order_line_items(to_order_gid(order_id))]
        inventory_by_line = {li['id']: li.get('inventoryItemId') for li in normalized}
        ordered_by_line = {li['id']: int(li.get('quantity') or 0) for li in normalized}
    except ShopifyError as e:
        return error_response(e.user_message, 502, code='shopify_error')

    try:
        allowed, skipped = _reserve_restock(return_ref, items, inventory_by_line, ordered_by_line)
    except GuardError as e:
        return e.to_response()
    if not allowed:
        return jsonify({'success': True, 'restockRecordId': None, 'restocked': [], 'skipped': skipped,
                        'id': None, 'totalQuantityRestocked': 0, 'items': [], 'message': 'Nothing to restock'}), 200

    changes = [{"inventoryItemId": inventory_by_line[str(i['lineItemId'])], "locationId": f"gid://shopify/Location/{location}",
                "delta": int(i['quantityReturned'])} for i in allowed]
    record_items = [_history_item(i, condition) for i in allowed]
    total = sum(int(i['quantityReturned']) for i in allowed)
    try:
        service.adjust_inventory(changes)
    except ShopifyTimeout:
        # Inventory may or may not have changed: keep the reservation (no double
        # restock), record the uncertainty.
        record_id = _write_restock_history(return_id, data, record_items, total, condition, 'failed',
                                           'Shopify did not confirm the inventory update; verify stock in Shopify.')
        guards.add_activity(return_ref, 'Restock status unknown', 'Shopify did not confirm the inventory update. '
                            'Verify stock in Shopify; these units will not be restocked again automatically.', type_='warning')
        return error_response('Shopify did not confirm the inventory update. Verify stock in Shopify before retrying.',
                              504, code='shopify_timeout', statusUnknown=True, restockRecordId=record_id)
    except ShopifyError as e:
        _release_restock_reservation(return_ref, allowed)
        record_id = _write_restock_history(return_id, data, record_items, total, condition, 'failed', e.user_message)
        return error_response(e.user_message, 502, code='shopify_error', restockRecordId=record_id, skipped=skipped)

    record_id = _write_restock_history(return_id, data, record_items, total, condition, 'success', None)
    _finish_restock_doc(return_ref, record_items, record_id, condition)
    guards.add_activity(return_ref, 'Items Restocked', f"{total} unit(s) restocked in inventory",
                        metadata={'items': [{'lineItemId': i['lineItemId'], 'quantity': i['quantityReturned']} for i in record_items],
                                  'locationId': location, 'restockRecordId': record_id})
    _restock_timeline_note(service, order_id, record_items, condition, data.get('RAN'))
    return jsonify({
        'success': True,
        'restockRecordId': record_id,
        'restocked': [{'lineItemId': i['lineItemId'], 'quantity': i['quantityReturned']} for i in record_items],
        'skipped': skipped,
        # legacy fields read by the current frontend
        'id': record_id,
        'totalQuantityRestocked': total,
        'items': record_items,
    }), 200


def _reserve_restock(return_ref, items, inventory_by_line, ordered_by_line=None
                     ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Cap + reserve quantities in ``restockedQtyByLineItem`` atomically."""

    @firestore.transactional
    def _txn(transaction):
        snap = return_ref.get(transaction=transaction)
        if not snap.exists:
            raise guards.NotFound('Return request not found.', code='return_not_found')
        data = snap.to_dict() or {}
        allowed, skipped = guards.cap_restock(items, data, ordered_by_line)
        resolvable = []
        for item in allowed:
            if inventory_by_line.get(str(item['lineItemId'])):
                resolvable.append(item)
            else:
                skipped.append({'lineItemId': item['lineItemId'], 'reason': 'no_inventory_item'})
        if resolvable:
            qty_map = guards.restocked_qty_by_line_item(data)
            for item in resolvable:
                lid = str(item['lineItemId'])
                qty_map[lid] = qty_map.get(lid, 0) + int(item['quantityReturned'])
            transaction.update(return_ref, {'restockedQtyByLineItem': qty_map, 'updatedAt': firestore.SERVER_TIMESTAMP})
        return resolvable, skipped

    return _txn(guards.firestore_db().transaction())


def _release_restock_reservation(return_ref, allowed) -> None:
    """Undo a reservation after a definitive Shopify failure (never raises)."""
    try:
        @firestore.transactional
        def _txn(transaction):
            snap = return_ref.get(transaction=transaction)
            qty_map = guards.restocked_qty_by_line_item(snap.to_dict() or {}) if snap.exists else {}
            for item in allowed:
                lid = str(item['lineItemId'])
                qty_map[lid] = max(0, qty_map.get(lid, 0) - int(item['quantityReturned']))
            transaction.update(return_ref, {'restockedQtyByLineItem': qty_map})

        _txn(guards.firestore_db().transaction())
    except Exception as e:
        logger.error(f"Could not release restock reservation on {return_ref.id}: {type(e).__name__}")


def _history_item(item: Dict[str, Any], condition: Optional[str]) -> Dict[str, Any]:
    images = item.get('customerImages') if isinstance(item.get('customerImages'), list) else []
    return {
        'lineItemId': item['lineItemId'],
        'quantityReturned': int(item['quantityReturned']),
        'sku': str(item.get('sku') or '')[:100] or None,
        'title': str(item.get('title') or '')[:300] or None,
        'condition': str(item.get('condition') or condition or '')[:100] or None,
        'productImage': str(item.get('productImage') or '')[:1000] or None,
        'customerImages': [str(u)[:1000] for u in images[:10]],
    }


def _write_restock_history(return_id, data, items, total, condition, status, error) -> Optional[str]:
    stamp = guards.agent_stamp()
    try:
        ref = guards.firestore_db().collection('restock_history').document()
        ref.set({
            'returnId': return_id, 'orderId': str(data.get('orderNumericId') or data.get('orderId') or ''),
            'orderName': data.get('orderId'), 'RAN': data.get('RAN'), 'items': items,
            'totalQuantityRestocked': total if status == 'success' else 0, 'requestedQuantity': total,
            'restockedAt': firestore.SERVER_TIMESTAMP, 'restockedAtMs': guards.now_ms(),
            'restockedBy': stamp['name'], 'restockedByEmail': stamp['email'],
            'condition': condition, 'status': status, 'errorMessage': error,
        })
        return ref.id
    except Exception as e:
        logger.error(f"restock_history write failed for {return_id}: {type(e).__name__}")
        return None


def _finish_restock_doc(return_ref, record_items, record_id, condition) -> None:
    """isRestocked / restockStatus / restockedItems / totals on the return doc."""
    try:
        @firestore.transactional
        def _txn(transaction):
            snap = return_ref.get(transaction=transaction)
            data = snap.to_dict() or {}
            qty_map = guards.restocked_qty_by_line_item(data)
            returned = guards.server_returned_qty(data)
            complete = all(qty_map.get(lid, 0) >= q for lid, q in returned.items())
            existing = [i for i in data.get('restockedItems') or [] if isinstance(i, dict)]
            transaction.update(return_ref, {
                'isRestocked': True,
                'restockStatus': 'Completed' if complete else 'Partial',
                'restockedItems': existing + record_items,
                'totalQuantityRestocked': sum(qty_map.values()),
                'restockRecordId': record_id,
                'restockCondition': condition,
                'updatedAt': firestore.SERVER_TIMESTAMP,
            })

        _txn(guards.firestore_db().transaction())
    except Exception as e:
        logger.error(f"Return doc restock fields not updated for {return_ref.id}: {type(e).__name__}")


def _restock_timeline_note(service, order_id, items, condition, ran) -> None:
    lines = "\n".join(f"  - {i['title'] or 'Item'} x{i['quantityReturned']}: {i['condition'] or condition or 'Not specified'}"
                      for i in items)
    message = (f"📦 [RAN: {ran or '-'}] Return Items Received & Assessed\n{lines}\n"
               f"Restocked {sum(i['quantityReturned'] for i in items)} unit(s) to online inventory at intake.\n"
               f"(The Return view may show these units as \"Not restocked\" later; that only prevents double counting.)\n"
               f"Assessed by: {guards.agent_name()}")
    try:
        service.add_timeline_note(order_id, message)
    except Exception as e:
        logger.warning(f"Restock timeline note failed: {type(e).__name__}")


# ==========================================================
# FULFILLMENT HOLD RECONCILIATION
# ==========================================================
def _reconcile_and_release_hold(numeric_order_id: int, require_balance_check: bool, source: str = 'reconciliation') -> Dict:
    """Release AWAITING_PAYMENT holds for exchanges awaiting customer payment.

    ``awaitingCustomerPayment`` is cleared only when every hold was released.
    Raises HoldReleaseError (with ``.result``) when Shopify could not be read
    or any hold failed to release -- the webhook should then answer non-2xx so
    Shopify retries. Returns ``{released, checked[, outstandingBalance]}``.
    """
    if not core.db:
        return {'released': [], 'checked': 0}
    docs = []
    for candidate in (str(numeric_order_id), safe_int(numeric_order_id)):
        docs = list(core.db.collection("returns")
                    .where(filter=FieldFilter("orderNumericId", "==", candidate))
                    .where(filter=FieldFilter("awaitingCustomerPayment", "==", True))
                    .limit(5).stream())
        if docs:
            break
    if not docs:
        return {'released': [], 'checked': 0}

    service = get_shopify_service()
    gid = to_order_gid(numeric_order_id)
    if require_balance_check:
        try:
            balance = service.get_order_outstanding_balance(gid)
        except ShopifyError as e:
            raise HoldReleaseError(f"Balance check failed: {type(e).__name__}",
                                   {'released': [], 'checked': len(docs), 'error': e.user_message}) from e
        if balance > 0.01:
            return {'released': [], 'checked': len(docs), 'outstandingBalance': balance}
    try:
        outcome = service.release_awaiting_payment_holds(gid)
    except ShopifyError as e:
        raise HoldReleaseError(f"Listing holds failed: {type(e).__name__}",
                               {'released': [], 'checked': len(docs), 'error': e.user_message}) from e

    result = {'released': outcome['released'], 'checked': len(docs), 'failed': outcome['failed'], 'found': outcome['found']}
    if outcome['failed']:
        for doc in docs:
            guards.add_activity(doc.reference, 'Hold release failed',
                                f"{len(outcome['failed'])} fulfillment hold(s) could not be released; will retry.",
                                type_='warning', metadata={'failed': outcome['failed']})
        raise HoldReleaseError(f"{len(outcome['failed'])} hold(s) not released", result)

    released_by = 'Shopify (orders/paid webhook)' if source == 'webhook' else f'{guards.agent_name()} (reconciliation)'
    for doc in docs:
        paid = parse_amount((doc.to_dict() or {}).get('outstandingBalance'))
        guards.update_with_retry(doc.reference, {
            'awaitingCustomerPayment': False,
            'holdReleased': bool(outcome['released']),
            'holdReleasedAt': firestore.SERVER_TIMESTAMP,
            'holdReleasedBy': released_by,
            'updatedAt': firestore.SERVER_TIMESTAMP,
        })
        guards.add_activity(doc.reference, 'Payment Received — Hold Released',
                            (f"Customer paid ₹{paid:.2f}; fulfillment hold released." if outcome['released'] else
                             f"Customer paid ₹{paid:.2f}; no fulfillment hold was waiting to be released."),
                            metadata={'releasedFulfillmentOrders': outcome['released'], 'amount': paid})
    return result


@bp.route('/api/exchange/reconcile-hold', methods=['POST'])
@require_staff()
def reconcile_exchange_hold():
    """On-demand: release payment holds if Shopify shows the balance is paid."""
    body = json_body()
    order_id = safe_int(body.get('orderNumericId'))
    if not order_id:
        return error_response('orderNumericId is required', 400, code='missing_field')
    try:
        return jsonify(dict(_reconcile_and_release_hold(order_id, require_balance_check=True), success=True)), 200
    except HoldReleaseError as e:
        return error_response('Some fulfillment holds could not be released. Please try again.', 502,
                              code='hold_release_failed', **{k: v for k, v in e.result.items() if k != 'error'})
    except ShopifyError as e:
        return error_response(e.user_message, 502, code='shopify_error')

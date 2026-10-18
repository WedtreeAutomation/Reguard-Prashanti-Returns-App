"""
Refund endpoints (CONTRACT §4.1).

POST /api/refund/gift-card | store-credit | manual   (any staff)
POST /api/refund/original-payment                    (admin, super_admin)
POST /api/money/resolve-unknown                      (admin, super_admin)

Every refund runs the same pipeline (``_run_refund``):

1. validate body (returnId, idempotencyKey, amount)  -> 400
2. refund password (when configured)                 -> 403 bad_refund_password
3. idempotency: replay a completed attempt           -> 200 {..., duplicate: true}
4. claim ``refundLock`` in a transaction             -> 409 refund_in_progress / already_refunded
5. server-side cap from Shopify prices               -> 400 amount_exceeds_cap {maxRefundable}
6. lock stage ``executing`` -> Shopify call
     timeout / unknown outcome                       -> 504 shopify_timeout (lock + key stay "unknown")
     definitive Shopify refusal                      -> 502 shopify_error (lock released)
7. ledger row, return doc + activity, release lock, store result, notify.
"""
from typing import Any, Dict, Optional

from flask import Blueprint, jsonify

import guards
from core import RefundMethod, logger, parse_amount
from guards import Conflict, GuardError
from notifications import notify
from security import (current_agent, error_response, failure_budget_exhausted, json_body, normalize_email,
                      record_failure, require_staff)
from settings_store import refund_password_configured, verify_refund_password
from shopify_service import (RefundOutcome, ShopifyError, ShopifyTimeout, get_shopify_service, numeric_id,
                             order_gid as to_order_gid, to_refund_line_items)

bp = Blueprint('refunds', __name__)

# endpoint kind -> (RefundMethod, ledger type, label, expected timeline)
REFUND_KINDS = {
    'gift-card': (RefundMethod.GIFT_CARD, 'gift_card', 'Gift card', 'Immediately (gift card code e-mailed)'),
    'store-credit': (RefundMethod.STORE_CREDIT, 'store_credit', 'Store credit', 'Immediately'),
    'original-payment': (RefundMethod.ORIGINAL_PAYMENT, 'original_payment', 'Original payment method',
                         '5–7 business days'),
    # The e-mail template renders "It usually reflects within <timeline>." for manual refunds.
    'manual': (RefundMethod.MANUAL, 'manual', 'Manual refund', '3–5 business days'),
}
CLOSED_STATUSES = {'closed', 'denied', 'rejected', 'cancelled'}
# Refund-password brute force (review M1): wrong passwords per agent, shared
# with /api/auth/verify-refund-password.
REFUND_PASSWORD_MAX_FAILURES = 10
REFUND_PASSWORD_WINDOW = 15 * 60
MANUAL_METHODS = {'cash', 'bank_transfer', 'upi', 'cheque', 'other'}


# ==========================================================
# ROUTES
# ==========================================================
@bp.route('/api/refund/gift-card', methods=['POST'])
@require_staff()
def refund_gift_card():
    """Issue a Shopify gift card for the refund amount."""
    return _run_refund('gift-card')


@bp.route('/api/refund/store-credit', methods=['POST'])
@require_staff()
def refund_store_credit():
    """Refund as Shopify-native store credit."""
    return _run_refund('store-credit')


@bp.route('/api/refund/original-payment', methods=['POST'])
@require_staff('admin', 'super_admin')
def refund_original_payment():
    """Refund to the order's original payment method(s) (admins only)."""
    return _run_refund('original-payment')


@bp.route('/api/refund/manual', methods=['POST'])
@require_staff()
def refund_manual():
    """Record a refund paid outside Shopify (cash / bank transfer / UPI ...)."""
    return _run_refund('manual')


@bp.route('/api/money/resolve-unknown', methods=['POST'])
@require_staff('admin', 'super_admin')
def resolve_unknown():
    """Clear a lock left in the 'unknown' state after a Shopify timeout.

    Body ``{returnId, kind: 'refund'|'exchange'|'waybill', note, clearShopifyReturn?}``.
    The admin confirms they checked Shopify / BlueDart first; ``note`` (≥ 5
    chars) is recorded in the activity log. For ``exchange``,
    ``clearShopifyReturn: true`` also forgets a Shopify Return that was created
    but never processed (only after it was closed/cancelled in Shopify admin).
    """
    body = json_body()
    try:
        kind = str(body.get('kind') or '').strip().lower()
        if kind not in guards.LOCK_FIELDS:
            raise GuardError("kind must be 'refund', 'exchange' or 'waybill'.", code='invalid_field', field='kind')
        note = str(body.get('note') or '').strip()
        if len(note) < 5:
            raise GuardError('Please describe what you verified (at least 5 characters).', code='missing_field', field='note')
        return_ref, data = guards.load_return(body.get('returnId'))
    except GuardError as e:
        return e.to_response()

    from firebase_admin import firestore
    field = guards.lock_field(kind)
    update: Dict[str, Any] = {field: firestore.DELETE_FIELD, 'updatedAt': firestore.SERVER_TIMESTAMP}
    cleared = [field] if data.get(field) else []
    if kind == 'exchange':
        for f in ('exchangeError', 'exchangeState'):
            if f in data:
                update[f] = firestore.DELETE_FIELD
                cleared.append(f)
        if body.get('clearShopifyReturn') is True and data.get('shopifyReturnId') and not data.get('exchangeResult'):
            update['shopifyReturnId'] = firestore.DELETE_FIELD
            update['abandonedShopifyReturnIds'] = firestore.ArrayUnion([data.get('shopifyReturnId')])
            cleared.append('shopifyReturnId')
    if not guards.update_with_retry(return_ref, update):
        return error_response('Could not update the request. Please try again.', 503, code='db_unavailable')
    guards.add_activity(return_ref, 'Pending operation resolved',
                        f"{kind.title()} state cleared after manual verification: {note[:300]}", type_='warning',
                        metadata={'kind': kind, 'cleared': cleared, 'previousLock': _public_lock(data.get(field))})
    return jsonify({'success': True, 'cleared': cleared})


# ==========================================================
# PIPELINE
# ==========================================================
class _Attempt:
    """State of one refund attempt (for correct cleanup on every exit path)."""

    def __init__(self, record, key: str):
        self.record = record
        self.key = key
        self.return_ref = None
        self.locked = False
        self.executing = False
        self.money_moved = False

    def refuse(self, error: GuardError):
        """Nothing was executed: release lock, mark key failed, return the error."""
        if self.locked:
            guards.release_lock(self.return_ref, 'refund', self.key)
        self.record.fail(error.message)
        return error.to_response()


def _run_refund(kind: str):
    method, ledger_type, label, timeline = REFUND_KINDS[kind]
    body = json_body()
    try:
        return_id = guards.validate_return_id(body.get('returnId'))
        key = guards.validate_idempotency_key(body.get('idempotencyKey'))
        if guards.parse_positive_amount(body.get('amount')) <= 0:
            raise GuardError('Refund amount must be greater than zero.', code='invalid_amount')
        manual = _manual_fields(body) if kind == 'manual' else {}
    except GuardError as e:
        return e.to_response()

    password_error = _check_refund_password(body.get('refundPassword'))
    if password_error is not None:
        return password_error

    try:
        record, stored = guards.begin_idempotent(
            f'refund:{kind}', key, guards.fingerprint_of(return_id, kind, guards.money(body.get('amount'))),
            unknown_code='refund_status_unknown')
    except GuardError as e:
        return e.to_response()
    if stored is not None:
        return jsonify(dict(stored, duplicate=True)), 200

    attempt = _Attempt(record, key)
    try:
        attempt.return_ref, _ = guards.load_return(return_id)
        data = guards.claim_lock(attempt.return_ref, 'refund', key, precheck=_refund_precheck,
                                 in_progress_code='refund_in_progress', unknown_code='refund_status_unknown')
        attempt.locked = True
        return _execute(kind, method, ledger_type, label, timeline, body, manual, return_id, data, attempt)
    except (GuardError, ShopifyError) as e:
        if attempt.money_moved:
            logger.error(f"Refund recording failed for {return_id}: {type(e).__name__}")
            return _recording_failed(attempt, e)
        if isinstance(e, GuardError):
            return attempt.refuse(e)
        if isinstance(e, ShopifyTimeout):
            return _unknown_outcome(attempt, e)
        if attempt.executing:
            # A refusal *during* execution: Shopify rejected the mutation
            # (userErrors), so nothing moved. Safe to release.
            logger.warning(f"Refund ({kind}) on {return_id} refused by Shopify: {type(e).__name__}")
        return attempt.refuse(GuardError(e.user_message, code='shopify_error', status=502))
    except Exception as e:  # unexpected: be conservative once money may have moved
        logger.error(f"Unexpected error in {kind} refund for {return_id}: {type(e).__name__}", exc_info=True)
        if attempt.money_moved:
            return _recording_failed(attempt, e)
        if attempt.executing:
            return _unknown_outcome(attempt, e)
        return attempt.refuse(GuardError('Something went wrong while processing the refund. Please try again.',
                                         code='internal_error', status=500))


def _execute(kind, method, ledger_type, label, timeline, body, manual, return_id, data, attempt: _Attempt):
    """Steps 5-7 of the pipeline (lock held)."""
    service = get_shopify_service()
    gid = _resolve_order_gid(body, data, service)
    context = service.get_refund_context(gid)
    details, order = context['details'], context['order']
    metadata = body.get('metadata') if isinstance(body.get('metadata'), dict) else {}
    include_shipping = parse_amount(metadata.get('shippingRefundAddition')) > 0
    cap_info = guards.compute_refund_cap(data, order, include_shipping, guards.ledger_refunded_total(return_id),
                                         order_context=guards.order_refund_context(data.get('orderId'), return_id))
    amount = guards.validate_refund_amount(body.get('amount'), cap_info)
    currency = ((details.get('totalPriceSet') or {}).get('shopMoney') or {}).get('currencyCode') or 'INR'
    note = str(body.get('note') or f"{label} for return {data.get('RAN') or return_id}")[:1000]
    notify_customer = body.get('notifyCustomer', True) is not False

    if kind == 'original-payment':
        available = round(sum(p['available'] for p in service.refundable_payments(details.get('transactions') or [])), 2)
        if amount > available + 0.01:
            raise GuardError(f"Only ₹{available:.2f} can be refunded to the original payment method(s) of this order.",
                             code='insufficient_refundable', maxRefundable=available)

    if not guards.set_lock_stage(attempt.return_ref, 'refund', attempt.key, 'executing'):
        raise Conflict('Another agent is already processing this request.', code='refund_in_progress')
    attempt.executing = True

    outcome = _shopify_refund(kind, method, service, gid, amount, currency, note, notify_customer, body, details, return_id)

    # ---- money has moved: never release the lock as "not executed" again ----
    attempt.executing = False
    attempt.money_moved = True
    return _finalize(kind, ledger_type, label, timeline, outcome, body, manual, metadata, cap_info,
                     return_id, data, details, order, notify_customer, attempt)


def _shopify_refund(kind, method, service, gid, amount, currency, note, notify_customer, body, details,
                    return_id) -> RefundOutcome:
    """The single money-moving step for each method."""
    if kind in ('gift-card', 'store-credit'):
        return service.process_refund(gid, amount, method, body.get('lineItems') or [], note, notify_customer,
                                      order_details=details)
    if kind == 'original-payment':
        refund = service.refund_to_original_payment(gid, amount, currency, notify=notify_customer, note=note,
                                                    order_details=details)
        txs = [e.get('node') or {} for e in ((refund.get('transactions') or {}).get('edges') or [])]
        return RefundOutcome(method=method, amount=amount, currency=currency, refund_id=refund.get('id'),
                             transaction_id=(txs[0].get('id') if txs else None), transactions=txs,
                             gateway=', '.join(sorted({t.get('gateway') for t in txs if t.get('gateway')})) or None,
                             customer_email=details.get('email'), order_name=details.get('name'))
    # manual: no money moves through Shopify; record a bookkeeping refund.
    bookkeeping = service.record_offline_refund(gid, amount, 'manual refund', note=note,
                                                refund_line_items=to_refund_line_items(body.get('lineItems')))
    return RefundOutcome(method=method, amount=amount, currency=currency,
                         refund_id=f"manual_{return_id}_{guards.now_ms()}",
                         customer_email=details.get('email'), order_name=details.get('name'),
                         shopify_ledger_recorded=bookkeeping.get('recorded'),
                         shopify_ledger_warning=bookkeeping.get('warning'))


def _finalize(kind, ledger_type, label, timeline, outcome: RefundOutcome, body, manual, metadata, cap_info,
              return_id, data, details, order, notify_customer, attempt: _Attempt):
    """Ledger, return document, lock release, idempotency result, e-mail."""
    agent = current_agent()
    warnings = []
    if outcome.shopify_ledger_warning:
        warnings.append(outcome.shopify_ledger_warning)

    ledger_id = guards.write_ledger_entry(
        ledger_type, outcome.amount, return_id, data, idempotency_key=attempt.key, items=cap_info['items'],
        order_numeric_id=details.get('legacyResourceId'),
        extra={
            'giftCardId': outcome.gift_card_id, 'giftCardLast4': outcome.gift_card_last4,
            'giftCardExpiresOn': outcome.gift_card_expires_on,
            'shopifyRefundId': outcome.refund_id if kind != 'manual' else None,
            'transactionId': outcome.transaction_id, 'gateway': outcome.gateway,
            'manualMethod': manual.get('method'), 'manualReference': manual.get('reference'),
            'deductions': metadata.get('deductions') if isinstance(metadata.get('deductions'), dict) else None,
            'baseAmount': parse_amount(metadata.get('baseAmount')) if metadata.get('baseAmount') is not None else None,
            'note': (body.get('note') or None),
            'maxRefundable': cap_info['cap'],
            # shipping is refundable once per ORDER (review H2): later caps read this
            'shippingRefund': (min(guards.money(metadata.get('shippingRefundAddition')), cap_info['shipping'])
                               if cap_info['shipping'] > 0 else None),
        })
    if not ledger_id:
        warnings.append('The refund ledger entry could not be written; reports may miss this refund.')

    cancellation = _maybe_cancel_full_return(kind, metadata, data, order, details)
    if cancellation and cancellation.get('requested') is not True:
        warnings.append('The Shopify order could not be cancelled automatically; cancel it in Shopify admin if needed.')

    extra_details = {'manualMethod': manual.get('method'), 'manualReference': manual.get('reference'),
                     'maxRefundable': cap_info['cap'], 'orderCancellation': cancellation}
    firebase_updated = True
    try:
        get_shopify_service().update_firebase_with_refund(
            outcome, return_ref=attempt.return_ref, metadata=dict(metadata, note=body.get('note')),
            agent=agent, ledger_id=ledger_id, extra_details=extra_details)
    except Exception as e:
        firebase_updated = False
        logger.error(f"REFUND DONE BUT RETURN DOC NOT UPDATED: returnId={return_id} ledger={ledger_id} ({type(e).__name__})")
        warnings.append('The refund succeeded but the request could not be marked as refunded. Do NOT refund again; '
                        'refresh the page or contact an admin.')

    if firebase_updated or ledger_id:
        guards.release_lock(attempt.return_ref, 'refund', attempt.key)
    else:
        # Neither the doc nor the ledger records this refund: keep the lock so
        # nobody can refund again until an admin has reconciled it.
        guards.set_lock_stage(attempt.return_ref, 'refund', attempt.key, 'unknown',
                              error='refund succeeded but was not recorded')

    response = {
        'success': True,
        'refundMethod': outcome.method.value,
        'refundId': outcome.refund_id,
        'amount': outcome.amount,
        'currency': outcome.currency,
        'customerEmail': outcome.customer_email,
        'orderName': outcome.order_name or data.get('orderId'),
        'firebaseUpdated': firebase_updated,
        'ledgerId': ledger_id,
        'maxRefundable': cap_info['cap'],
        'warnings': warnings,
    }
    if kind == 'gift-card':
        response.update({'giftCardLast4': outcome.gift_card_last4, 'giftCardExpiresOn': outcome.gift_card_expires_on,
                         'giftCardMasked': mask_gift_card(outcome.gift_card_code, outcome.gift_card_last4)})
    if kind == 'store-credit':
        response.update({'storeCreditTransactionId': None, 'accountBalance': outcome.account_balance})
    if kind == 'original-payment':
        response.update({'transactionId': outcome.transaction_id, 'transactions': outcome.transactions})
    if kind in ('gift-card', 'manual'):
        response['shopifyLedgerClosed'] = outcome.shopify_ledger_recorded is True
    if cancellation:
        response['orderCancellation'] = cancellation

    # The idempotency record (replays) never holds the full gift-card code.
    attempt.record.complete(dict(response, emailSent=False))
    email_sent = False
    if notify_customer:
        try:
            email_sent = notify('refund_done', return_id,
                                extra={'refund': _refund_notification(kind, outcome, label, timeline, manual, metadata, cap_info)},
                                dedupe_key=f"refund_done:{ledger_id or attempt.key}")
        except Exception as e:  # notify() promises not to raise; never let e-mail break a refund
            logger.error(f"refund_done notification failed for {return_id}: {type(e).__name__}")
    response['emailSent'] = bool(email_sent)
    if email_sent:
        attempt.record.complete(response)
    if kind == 'gift-card' and outcome.gift_card_code:
        # Shown ONCE to the issuing agent; persisted nowhere (the e-mail has it).
        return jsonify(dict(response, giftCardCode=outcome.gift_card_code)), 200
    return jsonify(response), 200


def _recording_failed(attempt: _Attempt, error: Exception):
    """Money moved but recording it crashed: block further refunds."""
    if attempt.return_ref is not None:
        guards.set_lock_stage(attempt.return_ref, 'refund', attempt.key, 'unknown', error='recording failed')
    attempt.record.unknown(f'recording failed: {type(error).__name__}')
    return error_response('The refund was issued in Shopify, but saving it failed. Do NOT refund again; '
                          'ask an admin to reconcile this request.', 500, code='refund_recording_failed',
                          statusUnknown=True)


def _unknown_outcome(attempt: _Attempt, error: Exception):
    """Mutation outcome unknown: keep the lock (stage 'unknown') and key."""
    logger.error(f"Refund outcome UNKNOWN (key {attempt.key[:8]}...): {type(error).__name__}")
    if attempt.return_ref is not None and attempt.locked:
        guards.set_lock_stage(attempt.return_ref, 'refund', attempt.key, 'unknown', error=type(error).__name__)
        guards.add_activity(attempt.return_ref, 'Refund status unknown',
                            'Shopify did not confirm the refund in time. Check the order in Shopify before retrying; '
                            'an admin must resolve this before another refund can be issued.', type_='warning')
    attempt.record.unknown(type(error).__name__)
    message = getattr(error, 'user_message', None) or ShopifyTimeout.default_user_message
    return error_response(message, 504, code='shopify_timeout', statusUnknown=True)


# ==========================================================
# HELPERS
# ==========================================================
def refund_password_failure_key():
    return ['refund-password', normalize_email(current_agent().get('email'))]


def _check_refund_password(password: Any):
    """None if OK, else an error response (403 bad_refund_password / 429 / 503).

    Wrong passwords are counted per agent (10 per 15 minutes, shared with
    /api/auth/verify-refund-password); successful checks are not counted.
    """
    try:
        if not refund_password_configured():
            return None
        key = refund_password_failure_key()
        if failure_budget_exhausted(key, REFUND_PASSWORD_MAX_FAILURES, REFUND_PASSWORD_WINDOW):
            return error_response('Too many incorrect refund passwords. Please wait 15 minutes and try again.', 429,
                                  code='rate_limited')
        if isinstance(password, str) and password and verify_refund_password(password):
            return None
        record_failure(key, REFUND_PASSWORD_WINDOW)
    except Exception as e:
        logger.error(f"Refund password check failed: {type(e).__name__}")
        return error_response('Could not verify the refund password. Please try again.', 503, code='unavailable')
    return error_response('Incorrect refund password.', 403, code='bad_refund_password')


def mask_gift_card(code: Optional[str], last4: Optional[str]) -> Optional[str]:
    """'•••• •••• •••• WXYZ' -- the only form of a gift-card code we persist/return twice."""
    tail = (last4 or (code or '')[-4:] or '').strip()
    return f"•••• •••• •••• {tail}" if tail else None


def _refund_precheck(data: Dict[str, Any]) -> None:
    """Runs inside the lock transaction."""
    if str(data.get('refundStatus') or '').strip().lower() == 'refunded':
        raise Conflict('This request has already been refunded.', code='already_refunded')
    if str(data.get('status') or '').strip().lower() in CLOSED_STATUSES:
        raise Conflict('This request is closed and cannot be refunded.', code='return_closed')


def _manual_fields(body: Dict[str, Any]) -> Dict[str, Optional[str]]:
    method = str(body.get('manualMethod') or 'other').strip().lower().replace(' ', '_')
    if method not in MANUAL_METHODS:
        method = 'other'
    reference = str(body.get('manualReference') or '').strip()[:120] or None
    return {'method': method, 'reference': reference}


def _resolve_order_gid(body: Dict[str, Any], data: Dict[str, Any], service=None) -> str:
    """The Shopify order of this return: the document's ``orderNumericId``, or
    -- when missing -- resolved server-side from its order name. The body's
    ``shopifyOrderId`` is never trusted; a disagreeing one is refused."""
    return to_order_gid(guards.resolve_order_numeric_id(data, body.get('shopifyOrderId'), service))


def _maybe_cancel_full_return(kind, metadata, data, order, details) -> Optional[Dict[str, Any]]:
    """Cancel the Shopify order (refund=false) for a plain full return.

    Requires the client's ``metadata.isFullReturn`` AND a server check that the
    request covers every ordered unit. Never blocks the refund result.
    """
    if not metadata.get('isFullReturn') or data.get('exchangeResult') or guards.request_type_of(data) != 'return':
        return None
    ordered_by_line = {numeric_id(li.get('id')): int(li.get('quantity') or 0) for li in order.get('lineItems') or []}
    ordered = sum(ordered_by_line.values())
    returned = sum(guards.server_returned_qty(data, None, ordered_by_line).values())
    if ordered <= 0 or returned < ordered:
        return {'requested': False, 'skipped': True, 'error': 'Not every ordered unit is part of this return.'}
    return get_shopify_service().cancel_shopify_order(details.get('id'), staff_note=f"Full return {data.get('RAN') or ''}".strip())


def _refund_notification(kind, outcome: RefundOutcome, label, timeline, manual, metadata, cap_info) -> Dict[str, Any]:
    """``refund`` block for the refund_done e-mail (CONTRACT §6)."""
    deductions = metadata.get('deductions') if isinstance(metadata.get('deductions'), dict) else {}
    deduction_labels = {'restocking': 'Restocking fee', 'reverseShipment': 'Reverse shipment',
                        'forwardShipment': 'Forward shipment', 'adjustment': 'Value adjustment', 'taxes': 'Taxes'}
    block: Dict[str, Any] = {
        'method': REFUND_KINDS[kind][1],
        'methodLabel': label if kind != 'manual' else f"Manual refund ({(manual.get('method') or 'other').replace('_', ' ')})",
        'amount': outcome.amount,
        'expectedTimeline': timeline,
        'breakdown': {
            'itemsValue': guards.money(metadata.get('baseAmount')) if metadata.get('baseAmount') is not None else cap_info['itemsValue'],
            'deductions': [{'label': deduction_labels.get(k, k), 'amount': guards.money(v)}
                           for k, v in deductions.items() if parse_amount(v) > 0.009],
            'shippingRefund': guards.money(metadata.get('shippingRefundAddition')),
            'total': outcome.amount,
        },
    }
    if outcome.gift_card_code:
        # The customer e-mail is the only place the full code goes (not persisted).
        block['giftCardCode'] = outcome.gift_card_code
        block['giftCardExpiresOn'] = outcome.gift_card_expires_on
    # Customers need the bare transaction number (the template hides gid:// values).
    reference = numeric_id(outcome.transaction_id) if kind == 'original-payment' else manual.get('reference')
    if reference:
        block['reference'] = reference
    return block


def _public_lock(lock: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(lock, dict):
        return None
    return {k: lock.get(k) for k in ('by', 'byName', 'at', 'stage', 'error') if k in lock}

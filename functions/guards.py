"""
Money-safety helpers shared by the refund / exchange / restock / BlueDart routes.

* ``load_return``           -- fetch a return document or raise ``NotFound``.
* idempotency records       -- ``idempotency/{sha256(scope, key)}``; a completed
                               attempt returns its stored result instead of
                               running again.
* per-return locks          -- ``refundLock`` / ``exchangeLock`` / ``waybillLock``
                               claimed in a Firestore transaction. A lock moves
                               ``claimed -> executing -> (released | unknown)``; a
                               lock that was ``executing`` when it went stale or
                               that is ``unknown`` is NEVER taken over
                               automatically, because the external call may have
                               succeeded (double-refund protection). An admin
                               clears it with ``POST /api/money/resolve-unknown``.
* ``write_ledger_entry``    -- one ``refund_ledger`` row per money movement
                               (CONTRACT §2 schema), agent from ``current_agent()``.
* ``compute_refund_cap``    -- server-side maximum refundable amount.
* restock capping helpers   -- returned quantity minus ``restockedQtyByLineItem``.

Every function that talks to Firestore reads ``core.db`` at call time so tests
can substitute a fake database.
"""
import hashlib
import math
import re
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

import core
from core import logger
from security import current_agent, error_response

LOCK_STALE_MS = 10 * 60 * 1000
IDEMPOTENCY_STALE_MS = 10 * 60 * 1000
IDEMPOTENCY_TTL_DAYS = 30
CAP_TOLERANCE = 1.0  # INR

LOCK_FIELDS = {"refund": "refundLock", "exchange": "exchangeLock", "waybill": "waybillLock"}

# Ledger types that represent money paid back to the customer.
REFUND_LEDGER_TYPES = ("gift_card", "store_credit", "original_payment", "manual")

# Discount allocations whose name looks like these are really a *payment*
# (gift card / wallet / store credit applied as a discount), so they do not
# reduce what the customer paid for the item. Mirrors IssueRefundModal.
PAYMENT_LIKE_DISCOUNT_WORDS = ("credit", "gift", "wallet", "reward", "loyalty")

_IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9_.:\-]{8,128}$")
_DOC_ID_RE = re.compile(r"^[^/]{1,200}$")


# ==========================================================
# ERRORS
# ==========================================================
class GuardError(Exception):
    """A refusal that maps 1:1 to a JSON error response."""

    status = 400
    default_code = "bad_request"

    def __init__(self, message: str, code: Optional[str] = None, status: Optional[int] = None, **extra):
        super().__init__(message)
        self.message = message
        self.code = code or self.default_code
        if status is not None:
            self.status = status
        self.extra = extra

    def to_response(self):
        return error_response(self.message, self.status, code=self.code, **self.extra)


class NotFound(GuardError):
    status = 404
    default_code = "not_found"


class Conflict(GuardError):
    status = 409
    default_code = "conflict"


class ServiceUnavailable(GuardError):
    status = 503
    default_code = "unavailable"


# ==========================================================
# SMALL HELPERS
# ==========================================================
def money(value: Any) -> float:
    """Round an amount to 2 dp (CONTRACT §0: ``round(x + 1e-9, 2)``)."""
    return round(core.parse_amount(value) + 1e-9, 2)


def now_ms() -> int:
    return core.now_ms()


def numeric_id(value: Any) -> str:
    """'gid://shopify/LineItem/123?x=1' / 123 / '123' -> '123' ('' if empty)."""
    if value is None:
        return ""
    return str(value).split("?")[0].rstrip("/").rsplit("/", 1)[-1].strip()


def agent_stamp() -> Dict[str, Any]:
    """{name, email} of the authenticated agent (for refundedBy etc.)."""
    agent = current_agent()
    return {"name": agent.get("name") or agent.get("email") or "System", "email": agent.get("email")}


def agent_name() -> str:
    return agent_stamp()["name"]


def _db():
    if core.db is None:
        raise ServiceUnavailable("The database is temporarily unavailable. Please try again shortly.")
    return core.db


def firestore_db():
    """The Firestore client, or ServiceUnavailable (503) when not initialised."""
    return _db()


def require_text(body: Dict[str, Any], field: str, label: Optional[str] = None, max_len: int = 200) -> str:
    """Return a stripped, non-empty string field or raise a 400 GuardError."""
    value = body.get(field)
    if not isinstance(value, (str, int)) or isinstance(value, bool) or not str(value).strip():
        raise GuardError(f"{label or field} is required.", code="missing_field", field=field)
    value = str(value).strip()
    if len(value) > max_len:
        raise GuardError(f"{label or field} is too long.", code="invalid_field", field=field)
    return value


# ==========================================================
# RETURN DOCUMENTS
# ==========================================================
def validate_return_id(return_id: Any) -> str:
    if not isinstance(return_id, str) or not _DOC_ID_RE.match(return_id.strip()) or return_id.strip() in (".", ".."):
        raise GuardError("returnId is required.", code="missing_field", field="returnId")
    return return_id.strip()


def load_return(return_id: Any) -> Tuple[Any, Dict[str, Any]]:
    """Return ``(doc_ref, data)`` for ``returns/{return_id}`` or raise NotFound."""
    return_id = validate_return_id(return_id)
    ref = _db().collection("returns").document(return_id)
    snap = ref.get()
    if not snap.exists:
        raise NotFound("Return request not found.", code="return_not_found")
    return ref, snap.to_dict() or {}


def add_activity(return_ref, title: str, description: str, type_: str = "success",
                 metadata: Optional[Dict[str, Any]] = None, transaction=None) -> None:
    """Append to ``returns/{id}/activities`` (never raises)."""
    entry = {
        "type": type_,
        "title": title,
        "description": description,
        "timestamp": firestore.SERVER_TIMESTAMP,
        "user": agent_name(),
        "userEmail": agent_stamp()["email"],
        "metadata": metadata or {},
    }
    try:
        if transaction is not None:
            transaction.set(return_ref.collection("activities").document(), entry)
        else:
            return_ref.collection("activities").add(entry)
    except Exception as e:  # activity log must never break a money flow
        logger.error(f"Could not write activity '{title}' on {getattr(return_ref, 'id', '?')}: {type(e).__name__}")


def update_with_retry(ref, data: Dict[str, Any], attempts: int = 2) -> bool:
    """``ref.update(data)`` with one retry. Returns success (never raises)."""
    for attempt in range(attempts):
        try:
            ref.update(data)
            return True
        except Exception as e:
            logger.error(f"Firestore update of {getattr(ref, 'id', '?')} failed (attempt {attempt + 1}): {type(e).__name__}")
    return False


# ==========================================================
# LOCKS (refundLock / exchangeLock / waybillLock)
# ==========================================================
def lock_field(kind: str) -> str:
    return LOCK_FIELDS[kind]


def _lock_is_blocking(lock: Dict[str, Any], key: str, now: int) -> Optional[str]:
    """Decide whether an existing lock blocks a claim with ``key``.

    Returns None (claim allowed), 'in_progress' or 'unknown'.
    """
    if not isinstance(lock, dict) or not lock:
        return None
    stage = lock.get("stage") or "claimed"
    if stage == "unknown":
        return "unknown"
    age = now - int(lock.get("at") or 0)
    if lock.get("key") == key:
        # Same attempt retried: only safe if we never reached the external call.
        return "unknown" if stage == "executing" else None
    if age < LOCK_STALE_MS:
        return "in_progress"
    # Stale lock from another attempt: safe to take over only if that attempt
    # never started the external (money-moving) call.
    return "unknown" if stage == "executing" else None


def claim_lock(ref, kind: str, key: str, precheck: Optional[Callable[[Dict[str, Any]], None]] = None,
               in_progress_code: Optional[str] = None, unknown_code: Optional[str] = None) -> Dict[str, Any]:
    """Claim ``<kind>Lock`` on the return document inside a transaction.

    ``precheck(data)`` runs inside the transaction and may raise GuardError
    (e.g. already refunded). Returns the document data read in the
    transaction. Raises NotFound / Conflict.
    """
    field = lock_field(kind)
    in_progress_code = in_progress_code or f"{kind}_in_progress"
    unknown_code = unknown_code or f"{kind}_status_unknown"
    db = _db()
    stamp = agent_stamp()

    @firestore.transactional
    def _txn(transaction):
        snap = ref.get(transaction=transaction)
        if not snap.exists:
            raise NotFound("Return request not found.", code="return_not_found")
        data = snap.to_dict() or {}
        now = now_ms()
        blocking = _lock_is_blocking(data.get(field) or {}, key, now)
        if blocking == "in_progress":
            raise Conflict("Another agent is already processing this request. Please wait a moment and refresh.",
                           code=in_progress_code)
        if blocking == "unknown":
            raise Conflict("A previous attempt did not finish and its outcome is unknown. Check Shopify, then ask "
                           "an admin to resolve it before trying again.", code=unknown_code)
        if precheck:
            precheck(data)
        transaction.update(ref, {field: {"key": key, "by": stamp["email"], "byName": stamp["name"],
                                         "at": now, "stage": "claimed"}})
        return data

    return _txn(db.transaction())


def set_lock_stage(ref, kind: str, key: str, stage: str, error: Optional[str] = None) -> bool:
    """Move our lock to ``executing`` / ``unknown`` (only if we still hold it)."""
    field = lock_field(kind)
    try:
        db = _db()

        @firestore.transactional
        def _txn(transaction):
            snap = ref.get(transaction=transaction)
            lock = (snap.to_dict() or {}).get(field) if snap.exists else None
            if not isinstance(lock, dict) or lock.get("key") != key:
                return False
            new_lock = dict(lock, stage=stage, stageAt=now_ms())
            if error:
                new_lock["error"] = str(error)[:300]
            transaction.update(ref, {field: new_lock})
            return True

        return bool(_txn(db.transaction()))
    except Exception as e:
        logger.error(f"Could not set {field} stage={stage} on {getattr(ref, 'id', '?')}: {type(e).__name__}")
        return False


def release_lock(ref, kind: str, key: str) -> bool:
    """Delete our lock (no-op if another attempt holds it). Never raises."""
    field = lock_field(kind)
    try:
        db = _db()

        @firestore.transactional
        def _txn(transaction):
            snap = ref.get(transaction=transaction)
            lock = (snap.to_dict() or {}).get(field) if snap.exists else None
            if isinstance(lock, dict) and lock.get("key") == key:
                transaction.update(ref, {field: firestore.DELETE_FIELD})
                return True
            return False

        return bool(_txn(db.transaction()))
    except Exception as e:
        logger.error(f"Could not release {field} on {getattr(ref, 'id', '?')}: {type(e).__name__}")
        return False


# ==========================================================
# IDEMPOTENCY
# ==========================================================
def validate_idempotency_key(key: Any) -> str:
    if not isinstance(key, str) or not _IDEMPOTENCY_KEY_RE.match(key.strip()):
        raise GuardError("idempotencyKey is required (8-128 characters: letters, digits, - _ . :).",
                         code="invalid_idempotency_key", field="idempotencyKey")
    return key.strip()


class IdempotencyRecord:
    """Handle on one ``idempotency/{id}`` document for the current attempt."""

    def __init__(self, scope: str, key: str, fingerprint: str):
        self.scope = scope
        self.key = key
        self.fingerprint = fingerprint
        digest = hashlib.sha256(f"{scope}\x00{key}".encode("utf-8")).hexdigest()
        self.ref = _db().collection("idempotency").document(digest)

    def _write(self, data: Dict[str, Any]) -> None:
        for attempt in range(2):
            try:
                self.ref.set(dict(data, updatedAtMs=now_ms()), merge=True)
                return
            except Exception as e:
                logger.error(f"Idempotency write ({self.scope}) failed (attempt {attempt + 1}): {type(e).__name__}")

    def complete(self, result: Dict[str, Any]) -> None:
        self._write({"status": "completed", "result": result, "completedAtMs": now_ms()})

    def fail(self, error: str) -> None:
        """Definitive failure: nothing was executed, the same key may be retried."""
        self._write({"status": "failed", "error": str(error)[:500]})

    def unknown(self, error: str) -> None:
        """Outcome unknown (e.g. Shopify timeout on a mutation): never re-run automatically."""
        self._write({"status": "unknown", "error": str(error)[:500]})


def fingerprint_of(*parts: Any) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:32]


def begin_idempotent(scope: str, key: str, fingerprint: str = "",
                     unknown_code: str = "status_unknown") -> Tuple[IdempotencyRecord, Optional[Dict[str, Any]]]:
    """Start (or replay) an idempotent attempt.

    Returns ``(record, stored_result)``. ``stored_result`` is not None when the
    same key already completed -> the caller returns it with ``duplicate: True``.
    Raises Conflict when the key is in flight, has an unknown outcome or was
    used for a different request.
    """
    key = validate_idempotency_key(key)
    record = IdempotencyRecord(scope, key, fingerprint)
    db = _db()
    stamp = agent_stamp()

    @firestore.transactional
    def _txn(transaction):
        snap = record.ref.get(transaction=transaction)
        now = now_ms()
        fresh = {
            "scope": scope, "status": "in_progress", "fingerprint": fingerprint,
            "agentEmail": stamp["email"], "createdAtMs": now, "updatedAtMs": now,
            "expireAt": core.utcnow() + _days(IDEMPOTENCY_TTL_DAYS),
        }
        if not snap.exists:
            transaction.set(record.ref, fresh)
            return None
        data = snap.to_dict() or {}
        if fingerprint and data.get("fingerprint") and data.get("fingerprint") != fingerprint:
            raise Conflict("This request key was already used for a different request. Please try again.",
                           code="idempotency_key_reused")
        status = data.get("status")
        if status == "completed":
            return data.get("result") or {}
        if status == "unknown":
            raise Conflict("The previous attempt's outcome is unknown. Check Shopify before retrying.",
                           code=unknown_code)
        if status == "in_progress" and now - int(data.get("updatedAtMs") or 0) < IDEMPOTENCY_STALE_MS:
            raise Conflict("This request is already being processed. Please wait.", code="request_in_progress")
        transaction.set(record.ref, fresh)  # failed, or a stale in-progress attempt -> retry
        return None

    stored = _txn(db.transaction())
    return record, stored


def _days(n: int):
    from datetime import timedelta
    return timedelta(days=n)


# ==========================================================
# LEDGER
# ==========================================================
def _customer_of(return_data: Dict[str, Any]) -> Dict[str, Any]:
    customer = return_data.get("customer") or {}
    return customer if isinstance(customer, dict) else {}


def request_type_of(return_data: Dict[str, Any]) -> str:
    """'return' | 'exchange' | 'mixed' from the doc (actionType, then items)."""
    action = str(return_data.get("actionType") or "").strip().lower()
    if action in ("return", "exchange", "mixed"):
        return action
    types = {str(i.get("actionType") or "return").lower() for i in (return_data.get("items") or []) if isinstance(i, dict)}
    if types == {"exchange"}:
        return "exchange"
    if "exchange" in types and "return" in types:
        return "mixed"
    return "return"


def write_ledger_entry(type_: str, amount: Any, return_id: str, return_data: Dict[str, Any], *,
                       idempotency_key: str, items: Optional[List[Dict[str, Any]]] = None,
                       order_numeric_id: Any = None, extra: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """Write one ``refund_ledger`` row (CONTRACT §2). Returns the doc id, or None
    if Firestore failed twice (logged as an error -- the backfill script can
    recreate it from the return document)."""
    agent = current_agent()
    customer = _customer_of(return_data)
    entry: Dict[str, Any] = {
        "type": type_,
        "amount": money(amount),
        "currency": "INR",
        "status": "success",
        "returnId": return_id,
        "RAN": return_data.get("RAN"),
        "orderName": return_data.get("orderId"),
        "orderNumericId": core.safe_int(order_numeric_id if order_numeric_id is not None
                                        else return_data.get("orderNumericId")),
        "requestType": request_type_of(return_data),
        "customerName": customer.get("name"),
        "customerEmail": customer.get("email"),
        "customerPhone": customer.get("phone"),
        "agentEmail": agent.get("email"),
        "agentName": agent.get("name"),
        "agentRole": agent.get("role"),
        "items": items or [],
        "idempotencyKey": idempotency_key,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "createdAtMs": now_ms(),
    }
    for k, v in (extra or {}).items():
        if v is not None:
            entry[k] = v
    for attempt in range(2):
        try:
            ref = _db().collection("refund_ledger").document()
            ref.set(entry)
            return ref.id
        except GuardError:
            break
        except Exception as e:
            logger.error(f"Ledger write ({type_}) for {return_id} failed (attempt {attempt + 1}): {type(e).__name__}")
    logger.error(f"LEDGER ENTRY MISSING: type={type_} returnId={return_id} amount={entry['amount']} key={idempotency_key}")
    return None


def ledger_refunded_total(return_id: str) -> float:
    """Sum of refund ledger rows already written for this return."""
    total = 0.0
    docs = _db().collection("refund_ledger").where(filter=FieldFilter("returnId", "==", return_id)).stream()
    for doc in docs:
        row = doc.to_dict() or {}
        if row.get("type") in REFUND_LEDGER_TYPES and row.get("status", "success") == "success":
            total += core.parse_amount(row.get("amount"))
    return money(total)


def order_ledger_rows(order_name: Any, transaction=None) -> List[Dict[str, Any]]:
    """Every successful refund-ledger row (all types) of an order."""
    if not order_name:
        return []
    query = _db().collection("refund_ledger").where(filter=FieldFilter("orderName", "==", order_name))
    snaps = query.stream(transaction=transaction) if transaction is not None else query.stream()
    rows = []
    for snap in snaps:
        row = snap.to_dict() or {}
        if row.get("status", "success") == "success":
            rows.append(row)
    return rows


def is_money_moved(return_data: Dict[str, Any], ledger_return_ids: Iterable[str] = (), return_id: Any = None) -> bool:
    """True once money (or a Shopify Return) moved for this request: it then
    keeps "holding" its units even if staff later close/deny it (H2)."""
    if str(return_data.get("refundStatus") or "").strip().lower() == "refunded":
        return True
    if return_data.get("exchangeResult") or return_data.get("shopifyReturnId") or return_data.get("refundLedgerId"):
        return True
    return return_id is not None and return_id in set(ledger_return_ids or ())


def order_refund_context(order_name: Any, return_id: str) -> Dict[str, Any]:
    """What OTHER requests of the same order already consumed (H2).

    ``consumedUnits`` -- units per line item refunded (or exchanged with a
    refund) by other requests: from their refund-ledger rows, or -- for a
    request marked refunded / exchanged without a ledger row -- from its
    server-owned item quantities.
    ``shippingRefunded`` -- order shipping was already refunded once (any
    request, including this one).
    """
    rows = order_ledger_rows(order_name)
    per_return: Dict[str, Dict[str, int]] = {}
    shipping_refunded = False
    for row in rows:
        if row.get("type") not in REFUND_LEDGER_TYPES:
            continue
        if core.parse_amount(row.get("shippingRefund")) > 0.009:
            shipping_refunded = True
        rid = str(row.get("returnId") or "")
        if rid == return_id:
            continue
        units = per_return.setdefault(rid, {})
        for item in row.get("items") or []:
            if not isinstance(item, dict):
                continue
            lid = numeric_id(item.get("lineItemId"))
            qty = max(0, core.safe_int(item.get("quantity"), 0) or 0)
            if lid and qty:
                units[lid] = max(units.get(lid, 0), qty)
    ledger_ids = {str(r.get("returnId") or "") for r in rows}
    try:
        siblings = _db().collection("returns").where(filter=FieldFilter("orderId", "==", order_name)).stream()
        for snap in siblings:
            sib = snap.to_dict() or {}
            details = sib.get("refundDetails") if isinstance(sib.get("refundDetails"), dict) else {}
            if core.parse_amount(details.get("shippingRefundAddition")) > 0.009 and \
                    str(sib.get("refundStatus") or "").strip().lower() == "refunded":
                shipping_refunded = True
            if snap.id == return_id or snap.id in ledger_ids or not is_money_moved(sib):
                continue
            units = per_return.setdefault(snap.id, {})
            for lid, qty in server_returned_qty(sib, "return").items():
                units[lid] = max(units.get(lid, 0), qty)
            for lid, qty in exchange_returned_units(sib).items():
                units[lid] = max(units.get(lid, 0), qty)
    except GuardError:
        raise
    except Exception as e:  # the ledger rows alone still bound the cap
        logger.error(f"Sibling returns of {order_name} could not be read: {type(e).__name__}")
    consumed: Dict[str, int] = {}
    for units in per_return.values():
        for lid, qty in units.items():
            consumed[lid] = consumed.get(lid, 0) + qty
    return {"consumedUnits": consumed, "shippingRefunded": shipping_refunded}


# ==========================================================
# RETURN ITEMS
# ==========================================================
def _rejected_line_ids(return_data: Dict[str, Any]) -> set:
    """Rejected line items (rejectedItems list + per-item flags).

    These fields are staff-writable, but rejecting only ever LOWERS a cap.
    """
    ids = set()
    for r in return_data.get("rejectedItems") or []:
        if isinstance(r, dict) and r.get("lineItemId") is not None:
            ids.add(numeric_id(r.get("lineItemId")))
    for item in return_data.get("items") or []:
        if isinstance(item, dict) and (item.get("rejected") is True
                                       or str(item.get("status") or "").strip().lower() == "rejected"):
            ids.add(numeric_id(item.get("lineItemId")))
    return ids


def _is_rejected(item: Dict[str, Any], rejected_ids: set) -> bool:
    if item.get("rejected") is True:
        return True
    if str(item.get("status") or "").strip().lower() == "rejected":
        return True
    return numeric_id(item.get("lineItemId")) in rejected_ids


def item_action(item: Dict[str, Any], return_data: Dict[str, Any]) -> str:
    action = str(item.get("actionType") or "").strip().lower()
    if action in ("return", "exchange"):
        return action
    # Legacy items without actionType inherit a pure-exchange request's type.
    return "exchange" if request_type_of(return_data) == "exchange" else "return"


def item_quantity(item: Dict[str, Any]) -> int:
    qty = core.safe_int(item.get("quantityReturned"), None)
    if qty is None:
        qty = core.safe_int(item.get("quantity"), 0)
    return max(0, qty or 0)


def active_items(return_data: Dict[str, Any], action: Optional[str] = None) -> List[Dict[str, Any]]:
    """Non-rejected items with quantity > 0 (optionally only one action type).

    NOTE: ``items`` is staff-writable in Firestore -- use it for display only.
    Money / inventory decisions use ``server_returned_qty``.
    """
    rejected = _rejected_line_ids(return_data)
    out = []
    for item in return_data.get("items") or []:
        if not isinstance(item, dict) or _is_rejected(item, rejected) or item_quantity(item) <= 0:
            continue
        if action and item_action(item, return_data) != action:
            continue
        out.append(item)
    return out


def submitted_snapshot(return_data: Dict[str, Any]) -> Optional[List[Dict[str, Any]]]:
    """The server-owned ``submittedItems`` snapshot written at submission
    (locked in firestore.rules), normalised. None for legacy documents."""
    snap = return_data.get("submittedItems")
    if not isinstance(snap, list):
        return None
    out: List[Dict[str, Any]] = []
    for entry in snap:
        if not isinstance(entry, dict):
            continue
        lid = numeric_id(entry.get("lineItemId"))
        qty = core.safe_int(entry.get("quantity"), 0) or 0
        if not lid or qty <= 0:
            continue
        action = str(entry.get("actionType") or "return").strip().lower()
        out.append({"lineItemId": lid, "quantity": qty,
                    "actionType": action if action in ("return", "exchange") else "return",
                    "unitPrice": money(entry.get("unitPrice"))})
    return out


def server_returned_qty(return_data: Dict[str, Any], action: Optional[str] = None,
                        ordered_qty: Optional[Dict[str, int]] = None) -> Dict[str, int]:
    """Units per line item that money / inventory decisions may rely on.

    * documents with ``submittedItems``: that server-owned snapshot;
    * legacy documents: ``items`` (staff-writable) de-duplicated per line item
      (max, never summed) and -- when ``ordered_qty`` is given -- clamped to
      the Shopify ordered quantity.
    Rejected line items are excluded. ``ordered_qty`` (numeric id -> qty)
    clamps both kinds of documents.
    """
    rejected = _rejected_line_ids(return_data)
    out: Dict[str, int] = {}
    snapshot = submitted_snapshot(return_data)
    if snapshot is not None:
        for entry in snapshot:
            lid = entry["lineItemId"]
            if lid in rejected or (action and entry["actionType"] != action):
                continue
            out[lid] = max(out.get(lid, 0), entry["quantity"])
    else:
        for item in active_items(return_data, action):
            lid = numeric_id(item.get("lineItemId"))
            if lid:
                out[lid] = max(out.get(lid, 0), item_quantity(item))
    if ordered_qty is not None:
        out = {lid: min(q, max(0, core.safe_int(ordered_qty.get(lid), 0) or 0)) for lid, q in out.items()}
    return {lid: q for lid, q in out.items() if q > 0}


def returned_qty_by_line_item(return_data: Dict[str, Any], action: Optional[str] = None) -> Dict[str, int]:
    """Backward-compatible name: server-trusted quantities (see server_returned_qty)."""
    return server_returned_qty(return_data, action)


def exchange_returned_units(return_data: Dict[str, Any]) -> Dict[str, int]:
    """Units sent back to Shopify by this request's processed exchange
    (``exchangeResult.returnedLineItems``, server-owned)."""
    result = return_data.get("exchangeResult")
    out: Dict[str, int] = {}
    if not isinstance(result, dict):
        return out
    for entry in result.get("returnedLineItems") or []:
        if isinstance(entry, dict):
            lid = numeric_id(entry.get("lineItemId"))
            qty = max(0, core.safe_int(entry.get("quantity"), 0) or 0)
            if lid and qty:
                out[lid] = out.get(lid, 0) + qty
    return out


def restocked_qty_by_line_item(return_data: Dict[str, Any]) -> Dict[str, int]:
    """Units already restocked per line item (server map, legacy list fallback)."""
    server_map = return_data.get("restockedQtyByLineItem")
    out: Dict[str, int] = {}
    if isinstance(server_map, dict):
        for k, v in server_map.items():
            out[numeric_id(k)] = max(0, core.safe_int(v, 0) or 0)
        return out
    for r in return_data.get("restockedItems") or []:
        if isinstance(r, dict):
            lid = numeric_id(r.get("lineItemId"))
            if lid:
                out[lid] = out.get(lid, 0) + max(0, core.safe_int(r.get("quantityReturned"), 0) or 0)
    return out


def cap_restock(requested: Iterable[Dict[str, Any]], return_data: Dict[str, Any],
                ordered_qty: Optional[Dict[str, int]] = None
                ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Cap requested restock quantities by (returned - already restocked).

    "Returned" comes from the server-owned snapshot (legacy: de-duplicated
    items clamped to the Shopify ordered quantity when ``ordered_qty`` is
    given); "already restocked" from the server-owned
    ``restockedQtyByLineItem``.

    Returns ``(allowed, skipped)``; ``allowed`` items are copies of the request
    items with ``quantityReturned`` set to the capped quantity and
    ``requestedQuantity`` kept; ``skipped`` = ``[{lineItemId, reason}]``.
    """
    returned = server_returned_qty(return_data, None, ordered_qty)
    restocked = restocked_qty_by_line_item(return_data)
    remaining = {lid: max(0, q - restocked.get(lid, 0)) for lid, q in returned.items()}
    allowed: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    for raw in requested:
        item = raw if isinstance(raw, dict) else {}
        lid = numeric_id(item.get("lineItemId"))
        qty = core.safe_int(item.get("quantityReturned"), 0) or 0
        if not lid:
            skipped.append({"lineItemId": item.get("lineItemId"), "reason": "invalid_line_item"})
            continue
        if qty <= 0:
            skipped.append({"lineItemId": core.safe_int(lid, lid), "reason": "invalid_quantity"})
            continue
        if lid not in returned:
            skipped.append({"lineItemId": core.safe_int(lid, lid), "reason": "not_in_return"})
            continue
        can = min(qty, remaining.get(lid, 0))
        if can <= 0:
            skipped.append({"lineItemId": core.safe_int(lid, lid), "reason": "already_restocked"})
            continue
        remaining[lid] -= can
        allowed.append(dict(item, lineItemId=core.safe_int(lid, lid), quantityReturned=can, requestedQuantity=qty))
    return allowed, skipped


# ==========================================================
# REFUND CAP
# ==========================================================
def is_payment_like_discount(name: Optional[str]) -> bool:
    text = (name or "").lower()
    return any(word in text for word in PAYMENT_LIKE_DISCOUNT_WORDS)


def _match_line(item: Dict[str, Any], lines: List[Dict[str, Any]], allow_sku: bool = True) -> Optional[Dict[str, Any]]:
    lid = numeric_id(item.get("lineItemId"))
    for line in lines:
        if lid and numeric_id(line.get("id")) == lid:
            return line
    sku = (item.get("sku") or "").strip() if allow_sku else ""
    if sku:
        for line in lines:
            if (line.get("sku") or "").strip() == sku:
                return line
    return None


def _unit_value(line: Dict[str, Any], taxes_included: bool) -> float:
    unit = max(0.0, core.parse_amount(line.get("unitPrice")))
    if not taxes_included:
        unit += max(0.0, core.parse_amount(line.get("unitTax")))
    return unit


unit_value = _unit_value


def _cap_entries(return_data: Dict[str, Any], lines: List[Dict[str, Any]], action: str
                 ) -> Tuple[Dict[str, Dict[str, Any]], List[Any]]:
    """Server-trusted ``{shopify line id: {line, qty, title, sku}}`` for one
    action type (deduplicated per Shopify line) + unmatched item labels."""
    titles = {numeric_id(i.get("lineItemId")): i for i in return_data.get("items") or [] if isinstance(i, dict)}
    out: Dict[str, Dict[str, Any]] = {}
    unmatched: List[Any] = []
    snapshot = submitted_snapshot(return_data)
    if snapshot is not None:
        sources = [({"lineItemId": lid}, qty, False) for lid, qty in server_returned_qty(return_data, action).items()]
    else:
        sources = [(item, item_quantity(item), True) for item in active_items(return_data, action)]
    for item, qty, allow_sku in sources:
        line = _match_line(item, lines, allow_sku=allow_sku)
        label = titles.get(numeric_id(item.get("lineItemId")), item)
        if not line:
            unmatched.append(label.get("title") or item.get("lineItemId"))
            continue
        lid = numeric_id(line.get("id"))
        entry = out.setdefault(lid, {"line": line, "qty": 0, "title": label.get("title"), "sku": label.get("sku")})
        entry["qty"] = max(entry["qty"], qty)  # duplicates never add up
    return out, unmatched


def exchange_refund_due(return_data: Dict[str, Any]) -> float:
    """Shopify-confirmed refund due from a processed exchange (0 if none).

    Only the server-owned ``exchangeResult`` counts -- never the top-level
    ``financialOutcome`` / ``netRefundAmount`` (staff-writable). Bounded by
    ``exchangeResult.returnedItemsValue`` when recorded.
    """
    result = return_data.get("exchangeResult")
    if not isinstance(result, dict) or result.get("financialOutcome") != "refund":
        return 0.0
    due = max(0.0, money(result.get("netRefundAmount")))
    if result.get("returnedItemsValue") is not None:
        due = min(due, max(0.0, money(result.get("returnedItemsValue"))))
    return due


def compute_refund_cap(return_data: Dict[str, Any], shopify_order: Dict[str, Any], include_shipping: bool,
                       already_refunded: float = 0.0, order_context: Optional[Dict[str, Any]] = None
                       ) -> Dict[str, Any]:
    """Maximum refundable amount for a return (CONTRACT §4.1, review H1-H3).

    ``shopify_order`` is the normalised dict from
    ``ShopifyService.get_refund_context``: ``{lineItems:[{id, sku, quantity,
    unitPrice, unitTax}], taxesIncluded, shippingTotal}`` where ``unitPrice`` is
    the per-unit price net of real (non gift-card/credit) discounts.
    ``order_context`` comes from ``order_refund_context`` (what other requests
    of the same order already consumed).

    cap = value of the request's non-rejected return-action units
          (server-owned quantities, one entry per Shopify line, clamped to
           ordered - consumed by other requests - units already valued by this
           request's own exchange) × Shopify price (+ tax when prices exclude tax)
        + exchange refund due (``exchangeResult`` only, bounded by the value of
          the units the exchange returned)
        + order shipping when requested and not refunded before on this order
        - amounts already refunded for this return.
    Items that cannot be matched to a Shopify line item count as 0 and are
    listed in ``unmatchedItems`` (refuse rather than guess).
    """
    order = shopify_order or {}
    lines = order.get("lineItems") or []
    taxes_included = order.get("taxesIncluded", True) is not False
    context = order_context or {}
    consumed = {numeric_id(k): max(0, core.safe_int(v, 0) or 0) for k, v in (context.get("consumedUnits") or {}).items()}
    via_exchange = exchange_returned_units(return_data)
    has_exchange_result = isinstance(return_data.get("exchangeResult"), dict) and bool(return_data.get("exchangeResult"))

    items_value = 0.0
    breakdown: List[Dict[str, Any]] = []
    entries, unmatched = _cap_entries(return_data, lines, "return")
    for lid, entry in entries.items():
        line = entry["line"]
        ordered = max(0, core.safe_int(line.get("quantity"), 0) or 0)
        own_exchange = via_exchange.get(lid, 0)
        available = max(0, ordered - consumed.get(lid, 0) - own_exchange)
        qty = max(0, min(entry["qty"] - own_exchange, available))
        if qty <= 0:
            continue
        unit = _unit_value(line, taxes_included)
        items_value += unit * qty
        breakdown.append({"lineItemId": core.safe_int(lid, lid), "title": entry["title"], "sku": entry["sku"],
                          "quantity": qty, "unitPrice": money(unit)})

    exchange_due = exchange_refund_due(return_data)
    if exchange_due > 0:
        # Units the exchange sent back to Shopify (recorded) or, for an older
        # exchangeResult, the request's exchange-action units.
        if via_exchange:
            exchange_units = dict(via_exchange)
        else:
            exchange_units = {lid: e["qty"] for lid, e in _cap_entries(return_data, lines, "exchange")[0].items()}
        bound = 0.0
        for lid, qty in exchange_units.items():
            line = next((ln for ln in lines if numeric_id(ln.get("id")) == lid), None)
            if not line:
                continue
            ordered = max(0, core.safe_int(line.get("quantity"), 0) or 0)
            qty = max(0, min(qty, ordered - consumed.get(lid, 0)))
            if qty <= 0:
                continue
            unit = _unit_value(line, taxes_included)
            bound += unit * qty
            breakdown.append({"lineItemId": core.safe_int(lid, lid), "title": line.get("title"), "sku": line.get("sku"),
                              "quantity": qty, "unitPrice": money(unit), "viaExchange": True})
        exchange_due = min(exchange_due, money(bound))
    elif has_exchange_result:
        exchange_due = 0.0

    shipping_refunded = bool(context.get("shippingRefunded"))
    shipping = max(0.0, money(order.get("shippingTotal"))) if include_shipping and not shipping_refunded else 0.0
    already = max(0.0, money(already_refunded))
    gross = money(items_value) + money(exchange_due) + shipping
    return {
        "cap": max(0.0, money(gross - already)),
        "itemsValue": money(items_value),
        "exchangeRefundDue": money(exchange_due),
        "shipping": money(shipping),
        "shippingAlreadyRefunded": shipping_refunded,
        "alreadyRefunded": already,
        "items": breakdown,
        "unmatchedItems": unmatched,
    }


def resolve_order_numeric_id(return_data: Dict[str, Any], claimed: Any = None, service=None) -> str:
    """The Shopify order id of a return, never taken from the request body.

    Uses the document's ``orderNumericId``; when missing, resolves it from the
    order name (``orderId``) through Shopify. A ``claimed`` id (body / path)
    that disagrees raises ``order_mismatch``. ShopifyError propagates.
    """
    doc_id = core.safe_int(return_data.get("orderNumericId"))
    claimed_id = numeric_id(claimed) if claimed not in (None, "") else ""
    if not doc_id:
        name = str(return_data.get("orderId") or "").strip()
        if not name:
            raise GuardError("This request is not linked to a Shopify order.", code="order_unresolved", status=409)
        if service is None:
            from shopify_service import get_shopify_service
            service = get_shopify_service()
        found = service.find_order_numeric_id_by_name(name)
        doc_id = core.safe_int(found)
        if not doc_id:
            raise GuardError("The Shopify order of this request could not be found.", code="order_unresolved",
                             status=409)
    if claimed_id and claimed_id != str(doc_id):
        raise GuardError("The order does not match this return request.", code="order_mismatch")
    return str(doc_id)


def parse_positive_amount(amount: Any) -> float:
    """Strictly parse a client amount (number or plain decimal string); 0.0 if invalid."""
    if isinstance(amount, bool):
        return 0.0
    if isinstance(amount, (int, float)):
        value = float(amount)
    elif isinstance(amount, str) and re.match(r"^\s*\d+(\.\d+)?\s*$", amount):
        value = float(amount)
    else:
        return 0.0
    if not math.isfinite(value) or value <= 0:
        return 0.0
    return money(value)


def validate_refund_amount(amount: Any, cap_info: Dict[str, Any]) -> float:
    """Return the rounded amount or raise GuardError (0 < amount <= cap + ₹1)."""
    value = parse_positive_amount(amount)
    if value <= 0:
        raise GuardError("Refund amount must be greater than zero.", code="invalid_amount")
    cap = money(cap_info.get("cap"))
    if value > cap + CAP_TOLERANCE:
        extra = {"maxRefundable": cap}
        if cap_info.get("unmatchedItems"):
            extra["unmatchedItems"] = cap_info["unmatchedItems"]
        raise GuardError(f"Refund amount ₹{value:.2f} exceeds the maximum refundable ₹{cap:.2f} for this request.",
                         code="amount_exceeds_cap", **extra)
    return value

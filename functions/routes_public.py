"""
Customer (public) return portal API — CONTRACT §3.

Customers prove ownership of an order (order number + e-mail/phone) and get
a short-lived customer token scoped to that order (security.issue_customer_token).
All business rules (return window, final sale, India only, custom items,
quantities, one active request per order, prices) are enforced here; the
browser is never trusted for them.
"""
import hmac
import re
import time
import uuid
from datetime import timedelta
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

from firebase_admin import firestore
from flask import Blueprint, g, jsonify, request
from google.cloud.firestore_v1.base_query import FieldFilter

from core import (RELEASED_STATUSES, ShopifyError, bucket, db, is_terminal_status, is_valid_email, iso_utc, logger,
                  money, normalize_phone, now_ms, safe_int, shopify_graphql, shopify_timeline_note, to_datetime,
                  utcnow, verify_order_ownership)
from notifications import DEFAULT_TRACKING_TEMPLATE, notify, request_type
from security import (client_ip, error_response, failure_budget_exhausted, hash_secret, issue_customer_token,
                      json_body, new_opaque_token, public_endpoint, rate_limited, record_failure, require_customer)
from settings_store import get_return_settings

bp = Blueprint('public', __name__)

# ==========================================================
# RULES (mirror CustomerPage.tsx)
# ==========================================================
NOTE_REQUIRED_REASONS = frozenset({"other reason", "i received a defective item", "wrong item shipped"})
DEFECTIVE_REASONS = frozenset({"i received a defective item", "wrong item shipped"})
MIN_NOTE_WORDS = 3
MAX_NOTE_LENGTH = 1000
MAX_REASON_LENGTH = 200
CUSTOM_KEYWORDS = ('custom', 'tailoring', 'bespoke', 'bspoke', 'stitching', 'blouse', 'fall', 'pico',
                   'measurements', 'saree finishing', 'tassels')
CUSTOM_SKU_RE = re.compile(r'-CUST|-BSP', re.IGNORECASE)
EXCLUDED_ORDER_TAGS = ('final sale', 'non-returnable')
INDIA_NAMES = ('india', 'in', 'भारत')
RETURN_METHODS = ('store_credit', 'gift_card', 'refund')
ACTION_TYPES = ('return', 'exchange')
MAX_IMAGES_PER_ITEM = 5
MAX_IMAGE_BYTES = 8 * 1024 * 1024
UPLOAD_TOKEN_TTL = timedelta(hours=2)
ORDER_NAME_RE = re.compile(r'^#?[A-Za-z0-9][A-Za-z0-9\-]{0,29}$')
RETURN_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9\-_]{0,63}$')
HEIC_BRANDS = {b'heic', b'heix', b'hevc', b'hevx', b'heim', b'heis', b'mif1', b'msf1'}
REQUEST_TYPE_NAMES = {'return': 'Return', 'exchange': 'Exchange', 'mixed': 'Return & Exchange'}
APPLIED_EVENTS = {'return': 'return_applied', 'exchange': 'exchange_applied', 'mixed': 'mixed_applied'}
WINDOW_15_MIN, WINDOW_1_HOUR = 15 * 60, 60 * 60
# Failed ownership checks per ORDER (any IP) per hour, shared by verify and
# lookup (review M2): IP-based limits alone are bypassable with many IPs.
ORDER_VERIFY_MAX_FAILURES = 20


class SubmissionError(Exception):
    """Validation failure with an HTTP status and machine-readable code."""

    def __init__(self, message: str, code: str = "validation_error", status: int = 400, **extra):
        super().__init__(message)
        self.message, self.code, self.status, self.extra = message, code, status, extra

    def response(self):
        return error_response(self.message, self.status, code=self.code, **self.extra)


# ==========================================================
# SHOPIFY ORDER (portal shape)
# ==========================================================
PORTAL_ORDER_QUERY = """
query PortalOrder($q: String!) {
  orders(first: 5, query: $q) {
    nodes {
      legacyResourceId name email phone createdAt tags currencyCode
      displayFulfillmentStatus displayFinancialStatus
      totalPriceSet { shopMoney { amount } }
      customer { id legacyResourceId firstName lastName displayName email phone }
      shippingAddress { address1 address2 city province provinceCode zip country countryCodeV2 phone firstName lastName }
      fulfillments(first: 20) { deliveredAt }
      lineItems(first: 100) {
        nodes {
          id name quantity currentQuantity sku
          variant { legacyResourceId title }
          customAttributes { key value }
          originalUnitPriceSet { shopMoney { amount } }
          discountAllocations { allocatedAmountSet { shopMoney { amount } } }
          image { url }
          product { legacyResourceId tags featuredImage { url } }
        }
      }
    }
  }
}
"""


def normalize_order_name(raw: Any) -> Optional[str]:
    """Trimmed order name if it looks like one (letters/digits/dash, optional #)."""
    if not isinstance(raw, str):
        return None
    name = raw.strip().replace(' ', '')
    return name if ORDER_NAME_RE.match(name) else None


def order_names_match(a: Any, b: Any) -> bool:
    return bool(a) and bool(b) and str(a).lstrip('#').upper() == str(b).lstrip('#').upper()


def unit_price_after_discounts(li: Dict[str, Any]) -> float:
    """Per-unit price after line-level discount allocations (never negative)."""
    original = money(((li.get('originalUnitPriceSet') or {}).get('shopMoney') or {}).get('amount'))
    qty = max(1, safe_int(li.get('quantity'), 1) or 1)
    discount = sum(money(((d.get('allocatedAmountSet') or {}).get('shopMoney') or {}).get('amount'))
                   for d in (li.get('discountAllocations') or []) if isinstance(d, dict))
    return max(0.0, money(original - discount / qty))


def shape_order(node: Dict[str, Any]) -> Dict[str, Any]:
    """Shopify GraphQL order node -> REST-like dict the CustomerPage expects.

    Internal helper fields start with ``_`` and are stripped before the order
    is sent to a browser (see ``order_for_client``).
    """
    delivered_at = next((f.get('deliveredAt') for f in (node.get('fulfillments') or []) if f.get('deliveredAt')), None)
    line_items, product_details = [], {}
    for li in ((node.get('lineItems') or {}).get('nodes') or []):
        product = li.get('product') or {}
        variant = li.get('variant') or {}
        product_id = safe_int(product.get('legacyResourceId'))
        product_image = (product.get('featuredImage') or {}).get('url')
        price = unit_price_after_discounts(li)
        line_items.append({
            'id': safe_int(li.get('id')),
            'title': li.get('name'),
            'quantity': safe_int(li.get('quantity'), 0),
            'current_quantity': safe_int(li.get('currentQuantity')),
            'price': f"{price:.2f}",
            'original_price': f"{money(((li.get('originalUnitPriceSet') or {}).get('shopMoney') or {}).get('amount')):.2f}",
            'sku': li.get('sku'),
            'variant_title': variant.get('title'),
            'variant_id': safe_int(variant.get('legacyResourceId')),
            'product_id': product_id,
            'properties': [{'name': a.get('key'), 'value': a.get('value')} for a in (li.get('customAttributes') or [])],
            'image': (li.get('image') or {}).get('url') or product_image,
            'product_tags': [str(t) for t in (product.get('tags') or [])],
        })
        if product_id:
            product_details[str(product_id)] = {'image': product_image, 'tags': [str(t).lower() for t in (product.get('tags') or [])]}
    customer = node.get('customer') or {}
    shipping = node.get('shippingAddress') or {}
    return {
        'id': safe_int(node.get('legacyResourceId')),
        'name': node.get('name'),
        'email': node.get('email'),
        'phone': node.get('phone'),
        'tags': ', '.join(node.get('tags') or []),
        'currency': node.get('currencyCode') or 'INR',
        'total_price': ((node.get('totalPriceSet') or {}).get('shopMoney') or {}).get('amount'),
        'created_at': node.get('createdAt'),
        'delivered_at': delivered_at,
        'financial_status': (node.get('displayFinancialStatus') or '').lower(),
        'fulfillment_status': (node.get('displayFulfillmentStatus') or '').lower(),
        'line_items': line_items,
        'customer': {'first_name': customer.get('firstName'), 'last_name': customer.get('lastName'),
                     'name': customer.get('displayName'), 'email': customer.get('email'), 'phone': customer.get('phone')},
        'shipping_address': {
            'address1': shipping.get('address1'), 'address2': shipping.get('address2'), 'city': shipping.get('city'),
            'province': shipping.get('province'), 'province_code': shipping.get('provinceCode'),
            'zip': shipping.get('zip'), 'country': shipping.get('country'),
            'country_code': shipping.get('countryCodeV2'), 'phone': shipping.get('phone'),
            'first_name': shipping.get('firstName'), 'last_name': shipping.get('lastName'),
        },
        'product_details': product_details,
        '_customer_gid': customer.get('id'),
        '_customer_legacy_id': customer.get('legacyResourceId'),
    }


def order_for_client(order: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in order.items() if not k.startswith('_')}


def fetch_portal_order(order_name: str) -> Optional[Dict[str, Any]]:
    """Order by name (exact, case-insensitive, with or without '#'). Raises ShopifyError."""
    candidates = [order_name]
    alternate = order_name[1:] if order_name.startswith('#') else f"#{order_name}"
    candidates.append(alternate)
    for candidate in candidates:
        data = shopify_graphql(PORTAL_ORDER_QUERY, {'q': f"name:'{candidate}'"})
        nodes = ((data.get('orders') or {}).get('nodes')) or []
        node = next((n for n in nodes if order_names_match(n.get('name'), order_name)), None)
        if node:
            return shape_order(node)
    return None


# ==========================================================
# ELIGIBILITY (pure)
# ==========================================================
def is_custom_item(li: Dict[str, Any], product_tags: Optional[List[str]] = None) -> bool:
    """Customised / bespoke items are not returnable (CustomerPage.isItemCustomized)."""
    tags = [str(t).lower() for t in (product_tags if product_tags is not None else li.get('product_tags') or [])]
    if any(k in t for t in tags for k in CUSTOM_KEYWORDS):
        return True
    texts = [li.get('title') or '', li.get('variant_title') or '']
    for prop in li.get('properties') or []:
        texts.extend([str(prop.get('name') or ''), str(prop.get('value') or '')])
    if any(k in t.lower() for t in texts for k in CUSTOM_KEYWORDS):
        return True
    return bool(li.get('sku') and CUSTOM_SKU_RE.search(str(li['sku'])))


def is_indian_order(order: Dict[str, Any]) -> bool:
    shipping = order.get('shipping_address') or {}
    code = str(shipping.get('country_code') or '').strip().upper()
    if code:
        return code == 'IN'
    country = str(shipping.get('country') or '').strip().lower()
    return bool(country) and any(country == n or (len(n) > 2 and n in country) for n in INDIA_NAMES)


def has_final_sale_tag(order: Dict[str, Any]) -> bool:
    tags = str(order.get('tags') or '').lower()
    return any(t in tags for t in EXCLUDED_ORDER_TAGS)


def has_active_return(existing: List[Tuple[str, Dict[str, Any]]]) -> bool:
    return any(not is_terminal_status(doc.get('status')) for _, doc in existing)


def _money_moved(doc_id: str, doc: Dict[str, Any], ledger_return_ids) -> bool:
    """Refunded, exchanged in Shopify or with ledger rows (review H2)."""
    if str(doc.get('refundStatus') or '').strip().lower() == 'refunded':
        return True
    if doc.get('exchangeResult') or doc.get('shopifyReturnId') or doc.get('refundLedgerId'):
        return True
    return doc_id in ledger_return_ids


def _held_units(doc: Dict[str, Any]) -> Dict[int, int]:
    """Units a request holds per line item: the server-owned ``submittedItems``
    snapshot (legacy: items, one entry per line item), minus rejected items."""
    rejected = {safe_int(r.get('lineItemId')) for r in (doc.get('rejectedItems') or []) if isinstance(r, dict)}
    units: Dict[int, int] = {}
    snapshot = doc.get('submittedItems')
    source = snapshot if isinstance(snapshot, list) else (doc.get('items') or [])
    for item in source:
        if not isinstance(item, dict):
            continue
        line_id = safe_int(item.get('lineItemId'))
        if line_id is None or line_id in rejected or item.get('rejected') is True:
            continue
        qty = safe_int(item.get('quantity') if isinstance(snapshot, list) else item.get('quantityReturned'), 0) or 0
        units[line_id] = max(units.get(line_id, 0), max(0, qty))
    return units


def requested_quantities(existing: List[Tuple[str, Dict[str, Any]]],
                         ledger_return_ids=frozenset()) -> Dict[int, int]:
    """Units already requested per line item by requests that still hold them.

    A closed / denied / rejected / cancelled request releases its units --
    unless money already moved for it (refunded, exchanged, ledger rows):
    those units stay held whatever its status says (staff can edit status).
    """
    totals: Dict[int, int] = {}
    for doc_id, doc in existing:
        released = str(doc.get('status') or '').strip().lower() in RELEASED_STATUSES
        if released and not _money_moved(doc_id, doc, ledger_return_ids):
            continue
        for line_id, qty in _held_units(doc).items():
            totals[line_id] = totals.get(line_id, 0) + qty
    return totals


def returnable_quantity(li: Dict[str, Any], requested: Dict[int, int]) -> int:
    ordered = safe_int(li.get('quantity'), 0) or 0
    remaining = ordered - requested.get(li.get('id'), 0)
    current = li.get('current_quantity')
    if isinstance(current, int):
        remaining = min(remaining, current)
    return max(0, remaining)


def days_since(value: Any, now=None) -> Optional[int]:
    dt = to_datetime(value)
    if not dt:
        return None
    return max(0, int(((now or utcnow()) - dt).total_seconds() // 86400))


def compute_eligibility(order: Dict[str, Any], return_days_limit: int,
                        existing: List[Tuple[str, Dict[str, Any]]], now=None) -> Dict[str, Any]:
    days = days_since(order.get('delivered_at') or order.get('created_at'), now)
    result: Dict[str, Any] = {'eligible': True, 'returnDaysLimit': return_days_limit, 'daysSinceDelivery': days}
    if order.get('fulfillment_status') != 'fulfilled':
        reason = 'not_fulfilled'
    elif days is None or days > return_days_limit:
        reason = 'time_window'
    elif has_final_sale_tag(order):
        reason = 'final_sale'
    elif not is_indian_order(order):
        reason = 'international'
    elif has_active_return(existing):
        reason = 'active_return'
    else:
        reason = None
    if reason:
        result.update({'eligible': False, 'reason': reason})
    return result


def attach_returnable(order: Dict[str, Any], requested: Dict[int, int]) -> None:
    for li in order.get('line_items') or []:
        li['returnableQuantity'] = 0 if is_custom_item(li) else returnable_quantity(li, requested)
        li['isCustomized'] = is_custom_item(li)


def is_valid_note(note: str) -> bool:
    words = [w for w in (note or '').strip().split() if w]
    if len(words) < MIN_NOTE_WORDS:
        return False
    return all(len(w) >= 2 and not re.match(r'^(.{1,3})\1{2,}$', w, re.IGNORECASE) for w in words)


# ==========================================================
# SUBMISSION VALIDATION (pure)
# ==========================================================
def _clean_item(raw: Any, lines: Dict[int, Dict[str, Any]], requested: Dict[int, int], seen: set) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SubmissionError("Invalid item in request.")
    line_id = safe_int(raw.get('lineItemId'))
    li = lines.get(line_id)
    if li is None:
        raise SubmissionError("One of the selected items is not part of this order.", "invalid_item")
    if line_id in seen:
        raise SubmissionError("An item was selected twice.", "invalid_item")
    seen.add(line_id)
    title = li.get('title') or 'This item'
    if is_custom_item(li):
        raise SubmissionError(f"{title} is customised and cannot be returned.", "not_returnable", lineItemId=line_id)
    qty = raw.get('quantity')
    if isinstance(qty, bool) or not isinstance(qty, int) or qty < 1:
        raise SubmissionError(f"Please choose a valid quantity for {title}.", "invalid_quantity", lineItemId=line_id)
    allowed = returnable_quantity(li, requested)
    if qty > allowed:
        raise SubmissionError(f"Only {allowed} unit(s) of {title} can be returned.", "quantity_exceeded",
                              lineItemId=line_id, returnableQuantity=allowed)
    action = str(raw.get('actionType') or '').lower()
    if action not in ACTION_TYPES:
        raise SubmissionError(f"Please choose Return or Exchange for {title}.", "invalid_action", lineItemId=line_id)
    reason = raw.get('reason').strip() if isinstance(raw.get('reason'), str) else ''
    if not reason or len(reason) > MAX_REASON_LENGTH:
        raise SubmissionError(f"Please select a reason for {title}.", "reason_required", lineItemId=line_id)
    note = raw.get('note').strip() if isinstance(raw.get('note'), str) else ''
    if len(note) > MAX_NOTE_LENGTH:
        raise SubmissionError(f"The note for {title} is too long (max {MAX_NOTE_LENGTH} characters).",
                              "note_too_long", lineItemId=line_id)
    if reason.lower() in NOTE_REQUIRED_REASONS and not is_valid_note(note):
        raise SubmissionError(f"Please describe the issue with {title} in at least {MIN_NOTE_WORDS} words.",
                              "note_required", lineItemId=line_id)
    image_count = raw.get('imageCount', 0)
    if isinstance(image_count, bool) or not isinstance(image_count, int) or not 0 <= image_count <= MAX_IMAGES_PER_ITEM:
        raise SubmissionError(f"You can attach up to {MAX_IMAGES_PER_ITEM} photos per item.", "too_many_images",
                              lineItemId=line_id)
    return {'li': li, 'quantity': qty, 'actionType': action, 'reason': reason, 'note': note, 'imageCount': image_count}


def _clean_pickup_address(raw: Any) -> Optional[Dict[str, str]]:
    if raw in (None, {}, ''):
        return None
    if not isinstance(raw, dict):
        raise SubmissionError("Invalid pickup address.", "invalid_address")
    fields = {k: str(raw.get(k) or '').strip()[:200] for k in ('name', 'phone', 'address', 'city', 'state', 'zip', 'country')}
    if not fields['address'] or not fields['city'] or not fields['state']:
        raise SubmissionError("Please enter the full pickup address.", "invalid_address")
    if not re.fullmatch(r'\d{6}', fields['zip']):
        raise SubmissionError("Please enter a valid 6-digit PIN code.", "invalid_address")
    if len(normalize_phone(fields['phone'])) != 10:
        raise SubmissionError("Please enter a valid 10-digit phone number for pickup.", "invalid_address")
    if fields['country'] and not is_indian_order({'shipping_address': {'country': fields['country']}}):
        raise SubmissionError("Returns are only accepted within India.", "international")
    fields['country'] = fields['country'] or 'India'
    return fields


def validate_submission(body: Dict[str, Any], order: Dict[str, Any],
                        requested: Dict[int, int]) -> Tuple[List[Dict[str, Any]], str, Optional[Dict[str, str]]]:
    """Validate the customer's request against the live order. Raises SubmissionError."""
    raw_items = body.get('items')
    lines = {li['id']: li for li in order.get('line_items') or [] if li.get('id') is not None}
    if not isinstance(raw_items, list) or not raw_items:
        raise SubmissionError("Please select at least one item.", "no_items")
    if len(raw_items) > len(lines):
        raise SubmissionError("Too many items in the request.", "invalid_item")
    seen: set = set()
    items = [_clean_item(raw, lines, requested, seen) for raw in raw_items]
    return_items = [i for i in items if i['actionType'] == 'return']
    method = str(body.get('requestedMethod') or '').lower()
    if not return_items:
        method = 'none'
    else:
        if method not in RETURN_METHODS:
            raise SubmissionError("Please choose how you would like to receive your refund.", "invalid_method")
        defective = any(i['reason'].lower() in DEFECTIVE_REASONS for i in return_items)
        if defective and method != 'refund':
            raise SubmissionError("Defective or wrong items are refunded to the original payment method.",
                                  "invalid_method")
    return items, method, _clean_pickup_address(body.get('pickupAddress'))


# ==========================================================
# RETURN DOCUMENT
# ==========================================================
def build_customer_block(order: Dict[str, Any], pickup: Optional[Dict[str, str]]) -> Dict[str, str]:
    cust = order.get('customer') or {}
    ship = order.get('shipping_address') or {}
    name = f"{cust.get('first_name') or ''} {cust.get('last_name') or ''}".strip() or cust.get('name') or ''
    address = ship.get('address1') or ''
    if ship.get('address2'):
        address = f"{address}, {ship['address2']}" if address else ship['address2']
    block = {
        'name': name,
        'email': order.get('email') or cust.get('email') or '',
        'phone': ship.get('phone') or order.get('phone') or cust.get('phone') or '',
        'address': address, 'city': ship.get('city') or '', 'state': ship.get('province') or '',
        'zip': ship.get('zip') or '', 'country': ship.get('country') or '',
    }
    if pickup:
        block.update({'address': pickup['address'], 'city': pickup['city'], 'state': pickup['state'],
                      'zip': pickup['zip'], 'country': pickup['country'], 'phone': pickup['phone']})
    return block


def build_return_document(order: Dict[str, Any], items: List[Dict[str, Any]], method: str,
                          pickup: Optional[Dict[str, str]], ran: str, upload_token: str,
                          previous: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Firestore return document (same field names the agent UI reads)."""
    doc_items = []
    for i in items:
        li = i['li']
        doc_items.append({
            'lineItemId': li['id'], 'title': li.get('title') or '', 'sku': li.get('sku') or 'N/A',
            'price': li.get('price') or '0.00', 'originalPrice': li.get('original_price'),
            'productImage': li.get('image') or '', 'variantTitle': li.get('variant_title') or '',
            'productId': li.get('product_id'), 'variantId': li.get('variant_id'),
            'quantityReturned': i['quantity'], 'reason': i['reason'], 'note': i['note'],
            'actionType': i['actionType'], 'customerImages': [], 'expectedImageCount': i['imageCount'],
        })
    # Server-owned snapshot (locked in firestore.rules): refund caps, restock
    # caps and exchange validation read THIS, never the staff-editable items.
    submitted = [{'lineItemId': i['li']['id'], 'quantity': i['quantity'], 'actionType': i['actionType'],
                  'unitPrice': money(i['li'].get('price'))} for i in items]
    has_return = any(i['actionType'] == 'return' for i in items)
    has_exchange = any(i['actionType'] == 'exchange' for i in items)
    overall = 'mixed' if has_return and has_exchange else ('exchange' if has_exchange else 'return')
    customer = build_customer_block(order, pickup)
    total_value = sum(money(d['price']) * d['quantityReturned'] for d in doc_items)
    doc = {
        'RAN': ran, 'orderId': order['name'], 'orderNumericId': order.get('id'),
        'customer': customer, 'items': doc_items, 'submittedItems': submitted,
        'type': REQUEST_TYPE_NAMES[overall], 'actionType': overall,
        'status': 'Open', 'refundStatus': 'Pending', 'awb': '',
        'requestedMethod': method if has_return else 'none',
        'refundEligibility': 'N/A' if not has_return else ('Eligible' if method == 'refund' else 'Not Eligible'),
        'hasDefectiveItems': any(i['actionType'] == 'return' and i['reason'].lower() in DEFECTIVE_REASONS for i in items),
        'previousReturns': previous,
        'createdAt': firestore.SERVER_TIMESTAMP, 'updatedAt': firestore.SERVER_TIMESTAMP,
        'createdAtMs': now_ms(), 'submittedAt': iso_utc(utcnow()),
        'ReturnSubmitEmailSent': False, 'webhookStatus': 'pending', 'imagesUploaded': False,
        'source': 'customer_portal', 'currency': order.get('currency') or 'INR',
        'totalRequestValue': money(total_value),
        'customerEmailLower': (customer['email'] or '').strip().lower(),
        'customerPhoneLast10': normalize_phone(customer['phone']),
        'uploadTokenHash': hash_secret(upload_token),
        'uploadTokenExpiresAt': utcnow() + UPLOAD_TOKEN_TTL,
    }
    if pickup:
        doc['pickupAddressOverride'] = pickup
    return doc


def next_return_doc_id(base_id: str, taken: set) -> str:
    """P905422, then P905422-2, P905422-3, ..."""
    if base_id not in taken:
        return base_id
    n = 2
    while f"{base_id}-{n}" in taken:
        n += 1
    return f"{base_id}-{n}"


def ran_for(counter: int, order_name: str) -> str:
    digits = re.sub(r'\D', '', order_name or '')
    return f"R{counter}-{digits[-6:]}"


def _existing_returns(order_name: str, transaction=None) -> List[Tuple[str, Dict[str, Any]]]:
    query = db.collection('returns').where(filter=FieldFilter('orderId', '==', order_name))
    snaps = query.stream(transaction=transaction) if transaction is not None else query.stream()
    return [(s.id, s.to_dict() or {}) for s in snaps]


def _ledger_return_ids(order_name: str, transaction=None) -> set:
    """Return ids with refund-ledger rows on this order (money moved)."""
    query = db.collection('refund_ledger').where(filter=FieldFilter('orderName', '==', order_name))
    snaps = query.stream(transaction=transaction) if transaction is not None else query.stream()
    return {str((s.to_dict() or {}).get('returnId') or '') for s in snaps} - {''}


def _create_return(order: Dict[str, Any], items, method, pickup) -> Tuple[str, str, str]:
    """Allocate RAN + doc id and create the return atomically. Returns (id, RAN, uploadToken)."""
    counter_ref = db.collection('settings').document('returnCounter')
    base_id = order['name'].lstrip('#')
    upload_token = new_opaque_token()
    overall_name = REQUEST_TYPE_NAMES[request_type({'items': [{'actionType': i['actionType']} for i in items]})]

    @firestore.transactional
    def _txn(transaction):
        existing = _existing_returns(order['name'], transaction)
        if has_active_return(existing):
            raise SubmissionError("There is already an open request for this order.", "active_return", 409)
        requested = requested_quantities(existing, _ledger_return_ids(order['name'], transaction))
        for i in items:
            if i['quantity'] > returnable_quantity(i['li'], requested):
                raise SubmissionError("Some items were already requested. Please refresh and try again.",
                                      "quantity_exceeded", 409)
        counter_snap = counter_ref.get(transaction=transaction)
        current = safe_int((counter_snap.to_dict() or {}).get('current')) if counter_snap.exists else None
        counter = current + 1 if current is not None else 1000000
        taken = {doc_id for doc_id, _ in existing}
        doc_id = next_return_doc_id(base_id, taken)
        for _ in range(50):  # a doc with this id may exist under another orderId spelling
            if not db.collection('returns').document(doc_id).get(transaction=transaction).exists:
                break
            taken.add(doc_id)
            doc_id = next_return_doc_id(base_id, taken)
        else:
            raise SubmissionError("Could not allocate a request number. Please try again.", "unavailable", 503)
        ran = ran_for(counter, order['name'])
        latest = max(existing, key=lambda e: e[1].get('createdAtMs') or 0, default=None)
        previous = {'returnId': latest[0], 'RAN': latest[1].get('RAN'), 'status': latest[1].get('status')} if latest else None
        ref = db.collection('returns').document(doc_id)
        transaction.set(counter_ref, {'current': counter}, merge=True)
        transaction.set(ref, build_return_document(order, items, method, pickup, ran, upload_token, previous))
        transaction.set(ref.collection('activities').document(), {
            'type': 'info', 'title': 'Request Submitted',
            'description': f"Customer submitted a {overall_name.lower()} request for {len(items)} item(s) "
                           f"via the returns portal.",
            'timestamp': firestore.SERVER_TIMESTAMP, 'user': 'Customer',
            'metadata': {'RAN': ran, 'itemCount': len(items), 'source': 'customer_portal'},
        })
        return doc_id, ran

    doc_id, ran = _txn(db.transaction())
    return doc_id, ran, upload_token


# ==========================================================
# PUBLIC RETURN VIEW (pure)
# ==========================================================
def _timeline(doc: Dict[str, Any]) -> List[Dict[str, str]]:
    status = str(doc.get('status') or '').lower()
    candidates = [
        ('Request submitted', doc.get('createdAt') or doc.get('submittedAt')),
        ('Pickup scheduled', doc.get('awbCreatedAt') if doc.get('awb') else None),
        ('Self-ship requested', doc.get('selfShipRequestedAt')),
        ('Item received', doc.get('receivedAt')),
        ('Exchange processed', doc.get('exchangeLoggedAt')),
        ('Refund issued', doc.get('refundCompletedAt') or doc.get('refundedAt')),
        ('Completed', doc.get('completedAt')),
    ]
    if status in ('denied', 'rejected'):
        candidates.append(('Request rejected', doc.get('updatedAt')))
    elif status == 'closed':
        candidates.append(('Request closed', doc.get('updatedAt')))
    entries = [{'title': t, 'at': iso_utc(v)} for t, v in candidates if iso_utc(v)]
    return sorted(entries, key=lambda e: e['at'])


def public_return(doc_id: str, doc: Dict[str, Any]) -> Dict[str, Any]:
    """Customer-safe view of a return (no address/phone/email, no agent names)."""
    rejected = {safe_int(r.get('lineItemId')): r for r in (doc.get('rejectedItems') or []) if isinstance(r, dict)}
    items = []
    for it in doc.get('items') or []:
        if not isinstance(it, dict):
            continue
        line_id = safe_int(it.get('lineItemId'))
        entry = {'lineItemId': line_id, 'title': it.get('title') or '', 'sku': it.get('sku') or '',
                 'price': money(it.get('price')), 'quantityReturned': safe_int(it.get('quantityReturned'), 0),
                 'actionType': it.get('actionType') or 'return', 'reason': it.get('reason') or '',
                 'productImage': it.get('productImage') or '', 'rejected': line_id in rejected}
        if line_id in rejected:
            entry['rejectionReason'] = rejected[line_id].get('reason') or ''
        items.append(entry)
    cust = doc.get('customer') or {}
    awb = doc.get('awb') or None
    gift_last4 = str(doc.get('giftCardLast4') or ((doc.get('refundDetails') or {}).get('giftCardLast4')
                                                  if isinstance(doc.get('refundDetails'), dict) else '') or '')
    if not gift_last4:  # legacy documents stored the full code
        legacy_code = str(doc.get('giftCardCode') or '')
        gift_last4 = legacy_code[-4:] if len(legacy_code) >= 4 else ''
    refund_method = doc.get('refundMethod')
    out = {
        'returnId': doc_id, 'RAN': doc.get('RAN') or '', 'orderId': doc.get('orderId') or '',
        'status': doc.get('status') or 'Open', 'shipmentStatus': doc.get('shipmentStatus') or '',
        'refundStatus': doc.get('refundStatus') or '', 'requestType': request_type(doc),
        'createdAt': iso_utc(doc.get('createdAt') or doc.get('submittedAt')), 'updatedAt': iso_utc(doc.get('updatedAt')),
        'items': items, 'requestedMethod': doc.get('requestedMethod') or 'none',
        'awb': awb, 'courierPartner': (doc.get('courierPartner') or 'Blue Dart') if awb else None,
        'pickupDate': iso_utc(doc.get('pickupDate')) if awb else None,
        'trackingUrl': DEFAULT_TRACKING_TEMPLATE.format(awb=quote(str(awb), safe='')) if awb else None,
        'refundMethod': {'giftcard': 'gift_card', 'original': 'original_payment'}.get(refund_method, refund_method),
        'refundAmount': money(doc.get('refundAmount')) if doc.get('refundAmount') is not None else None,
        'giftCardLast4': gift_last4[-4:] or None,
        'financialOutcome': doc.get('financialOutcome'),
        'timeline': _timeline(doc),
        'customer': {'name': (cust.get('name') or '').split(' ')[0], 'city': cust.get('city') or ''},
        # Customer-safe extras the status page uses for nicer copy.
        'itemReceived': bool(doc.get('receivedAt')) or str(doc.get('shipmentStatus') or '').lower() == 'received',
    }
    status = str(doc.get('status') or '').lower()
    if status in ('denied', 'rejected', 'closed'):
        reason = str(doc.get('rejectionReason') or '').strip()
        out['rejectionReason'] = reason or None
        out['allowResubmit'] = bool(doc.get('allowResubmit'))
        if status == 'closed':
            out['closeReason'] = reason or None
    if doc.get('financialOutcome') == 'extra' and doc.get('outstandingBalance') is not None:
        out['outstandingBalance'] = money(doc.get('outstandingBalance'))
    return out


def _public_returns_for(order_name: str) -> List[Dict[str, Any]]:
    existing = _existing_returns(order_name)
    existing.sort(key=lambda e: (e[1].get('createdAtMs') or 0, e[0]), reverse=True)
    return [public_return(doc_id, doc) for doc_id, doc in existing]


# ==========================================================
# IMAGE HELPERS (pure)
# ==========================================================
def detect_image_type(data: bytes) -> Optional[Tuple[str, str]]:
    """(content_type, extension) from magic bytes, or None if not an allowed image."""
    if data[:3] == b'\xff\xd8\xff':
        return 'image/jpeg', 'jpg'
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return 'image/png', 'png'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp', 'webp'
    if data[4:8] == b'ftyp' and data[8:12] in HEIC_BRANDS:
        return 'image/heic', 'heic'
    return None


def storage_download_url(bucket_name: str, path: str, token: str) -> str:
    return (f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/"
            f"{quote(path, safe='')}?alt=media&token={token}")


def upload_token_valid(doc: Dict[str, Any], token: Any) -> bool:
    stored = doc.get('uploadTokenHash')
    expires = to_datetime(doc.get('uploadTokenExpiresAt'))
    if not stored or not isinstance(token, str) or not token or not expires or expires < utcnow():
        return False
    return hmac.compare_digest(str(stored), hash_secret(token))


# ==========================================================
# REQUEST HELPERS
# ==========================================================
def _require_db():
    return None if db else error_response("Service temporarily unavailable. Please try again shortly.", 503)


def _verify_request(kind: str):
    """Common part of /orders/verify and /returns/lookup.

    Returns (order, verification_input, None) or (None, None, error_response).
    """
    body = json_body()
    order_name = normalize_order_name(body.get('orderName'))
    verification = body.get('verificationInput')
    if not order_name or not isinstance(verification, str) or not verification.strip() or len(verification) > 254:
        return None, None, error_response("Please enter your order number and the email or phone used for the order.",
                                          400, code="validation_error")
    ip = client_ip()
    order_key = ['portal-order-verify', order_name.lstrip('#').upper()]
    limited = (rate_limited([f'{kind}-order', order_name.lstrip('#').upper(), ip], 10, WINDOW_15_MIN)
               or rate_limited([f'{kind}-ip', ip], 60, WINDOW_1_HOUR))
    if not limited and failure_budget_exhausted(order_key, ORDER_VERIFY_MAX_FAILURES, WINDOW_1_HOUR):
        limited = error_response("Too many attempts for this order. Please try again in an hour.", 429,
                                 code="rate_limited")
    if limited:
        return None, None, limited
    try:
        order = fetch_portal_order(order_name)
    except ShopifyError as e:
        logger.error(f"Portal order fetch failed: {e}")
        return None, None, error_response("We couldn't reach the store right now. Please try again in a moment.", 502,
                                          code="upstream_unavailable")
    if not order:
        return None, None, error_response("Order not found. Please check the order number.", 404, code="order_not_found")
    if not verify_order_ownership(order, verification):
        record_failure(order_key, WINDOW_1_HOUR)
        return None, None, error_response("The email or phone number doesn't match this order.", 403,
                                          code="verification_failed")
    return order, verification.strip(), None


def _issue_token(order: Dict[str, Any], verification: str) -> str:
    is_email = is_valid_email(verification)
    return issue_customer_token(order['name'], order.get('id'),
                                email=verification if is_email else (order.get('email') or ''),
                                phone='' if is_email else normalize_phone(verification))


def _load_owned_return(return_id: str):
    """(ref, doc) for a return belonging to the token's order, or (None, error)."""
    if not RETURN_ID_RE.match(return_id or ''):
        return None, error_response("Request not found.", 404, code="not_found")
    ref = db.collection('returns').document(return_id)
    snap = ref.get()
    doc = (snap.to_dict() or {}) if snap.exists else None
    if doc is None or not order_names_match(doc.get('orderId'), g.customer.get('orderName')):
        return None, error_response("Request not found.", 404, code="not_found")
    return ref, doc


# ==========================================================
# ENDPOINTS
# ==========================================================
@bp.route('/api/public/settings', methods=['GET'])
@public_endpoint("Customer portal: non-secret return settings")
def public_settings():
    """Return window shown to customers."""
    settings = get_return_settings()
    return jsonify({'success': True, 'settings': {'returnDaysLimit': settings['returnDaysLimit']}})


@bp.route('/api/public/orders/verify', methods=['POST'])
@public_endpoint("Customer proves order ownership (order no. + email/phone); rate limited")
def verify_order():
    """Verify ownership; return the order, existing requests, eligibility and a customer token."""
    err = _require_db()
    if err:
        return err
    order, verification, err = _verify_request('verify')
    if err:
        return err
    if order.get('fulfillment_status') != 'fulfilled':
        return error_response("This order hasn't been delivered yet, so it can't be returned.", 404,
                              code="not_fulfilled")
    try:
        existing = _existing_returns(order['name'])
        settings = get_return_settings()
        attach_returnable(order, requested_quantities(existing, _ledger_return_ids(order['name'])))
        eligibility = compute_eligibility(order, settings['returnDaysLimit'], existing)
        token = _issue_token(order, verification)
    except Exception as e:
        logger.error(f"Order verify failed: {type(e).__name__}: {e}")
        return error_response("Something went wrong. Please try again.", 500)
    existing_view = [{'returnId': doc_id, 'RAN': doc.get('RAN') or '', 'status': doc.get('status') or '',
                      'items': [{'lineItemId': safe_int(i.get('lineItemId')),
                                 'quantityReturned': safe_int(i.get('quantityReturned'), 0),
                                 'actionType': i.get('actionType') or 'return'}
                                for i in (doc.get('items') or []) if isinstance(i, dict)]}
                     for doc_id, doc in existing]
    return jsonify({'success': True, 'order': order_for_client(order), 'customerToken': token,
                    'existingReturns': existing_view, 'eligibility': eligibility})


@bp.route('/api/public/returns', methods=['POST'])
@require_customer
def submit_return():
    """Create a return/exchange request for the token's order."""
    err = _require_db()
    if err:
        return err
    order_name = g.customer.get('orderName') or ''
    limited = rate_limited(['submit-return', order_name.upper()], 10, WINDOW_1_HOUR)
    if limited:
        return limited
    try:
        order = fetch_portal_order(order_name)
    except ShopifyError as e:
        logger.error(f"Portal order fetch failed on submit: {e}")
        return error_response("We couldn't reach the store right now. Please try again in a moment.", 502,
                              code="upstream_unavailable")
    if not order:
        return error_response("Order not found.", 404, code="order_not_found")
    try:
        existing = _existing_returns(order['name'])
        eligibility = compute_eligibility(order, get_return_settings()['returnDaysLimit'], existing)
        if not eligibility['eligible']:
            reason = eligibility['reason']
            messages = {
                'active_return': "There is already an open request for this order.",
                'time_window': "The return window for this order has closed.",
                'final_sale': "This order is not eligible for returns (final sale).",
                'international': "Returns are only accepted for orders shipped within India.",
                'not_fulfilled': "This order hasn't been delivered yet.",
            }
            return error_response(messages.get(reason, "This order is not eligible for returns."),
                                  409 if reason == 'active_return' else 400, code=reason)
        items, method, pickup = validate_submission(json_body(), order,
                                                    requested_quantities(existing, _ledger_return_ids(order['name'])))
        return_id, ran, upload_token = _create_return(order, items, method, pickup)
    except SubmissionError as e:
        return e.response()
    except Exception as e:
        logger.error(f"Return submission failed: {type(e).__name__}: {e}")
        return error_response("We couldn't save your request right now. Please try again.", 503, code="unavailable")
    logger.info(f"Return {return_id} ({ran}) created via portal")
    return jsonify({'success': True, 'returnId': return_id, 'RAN': ran, 'uploadToken': upload_token}), 201


def _read_upload_files(files) -> List[Tuple[bytes, str, str]]:
    out = []
    for idx, f in enumerate(files):
        data = f.stream.read(MAX_IMAGE_BYTES + 1)
        if not data:
            raise SubmissionError(f"Photo {idx + 1} is empty.", "invalid_image")
        if len(data) > MAX_IMAGE_BYTES:
            raise SubmissionError(f"Photo {idx + 1} is larger than 8 MB.", "image_too_large", 413)
        kind = detect_image_type(data)
        if not kind:
            raise SubmissionError(f"Photo {idx + 1} must be a JPEG, PNG, WebP or HEIC image.", "invalid_image")
        out.append((data, kind[0], kind[1]))
    return out


def _append_images(ref, line_id: int, urls: List[str]) -> None:
    """Append URLs to items[].customerImages inside a transaction (limits re-checked)."""
    @firestore.transactional
    def _txn(transaction):
        snap = ref.get(transaction=transaction)
        doc = snap.to_dict() or {}
        items = [dict(i) for i in (doc.get('items') or [])]
        target = next((i for i in items if safe_int(i.get('lineItemId')) == line_id), None)
        if target is None:
            raise SubmissionError("Item not found on this request.", "invalid_item")
        current = list(target.get('customerImages') or [])
        total = sum(len(i.get('customerImages') or []) for i in items)
        if len(current) + len(urls) > MAX_IMAGES_PER_ITEM or total + len(urls) > MAX_IMAGES_PER_ITEM * len(items):
            raise SubmissionError(f"You can upload up to {MAX_IMAGES_PER_ITEM} photos per item.", "too_many_images")
        target['customerImages'] = current + urls
        transaction.update(ref, {'items': items, 'updatedAt': firestore.SERVER_TIMESTAMP})

    _txn(db.transaction())


@bp.route('/api/public/returns/<return_id>/images', methods=['POST'])
@require_customer
def upload_images(return_id):
    """Upload 1–5 photos for one item of a just-created request."""
    err = _require_db()
    if err:
        return err
    if bucket is None:
        return error_response("Photo uploads are temporarily unavailable.", 503, code="unavailable")
    ref, doc = _load_owned_return(return_id)
    if ref is None:
        return doc
    if not upload_token_valid(doc, request.form.get('uploadToken')):
        return error_response("Your upload session has expired. Please contact support.", 403,
                              code="invalid_upload_token")
    if doc.get('finalizedAt'):
        return error_response("This request has already been submitted.", 409, code="already_finalized")
    limited = rate_limited(['upload-images', return_id], 60, WINDOW_1_HOUR)
    if limited:
        return limited
    line_id = safe_int(request.form.get('lineItemId'))
    items = doc.get('items') or []
    item = next((i for i in items if safe_int(i.get('lineItemId')) == line_id), None)
    files = [f for f in request.files.getlist('files') if f]
    try:
        if item is None:
            raise SubmissionError("Item not found on this request.", "invalid_item")
        if not 1 <= len(files) <= MAX_IMAGES_PER_ITEM:
            raise SubmissionError(f"Please attach between 1 and {MAX_IMAGES_PER_ITEM} photos.", "invalid_image")
        existing = len(item.get('customerImages') or [])
        total = sum(len(i.get('customerImages') or []) for i in items)
        if existing + len(files) > MAX_IMAGES_PER_ITEM or total + len(files) > MAX_IMAGES_PER_ITEM * len(items):
            raise SubmissionError(f"You can upload up to {MAX_IMAGES_PER_ITEM} photos per item.", "too_many_images")
        payloads = _read_upload_files(files)
    except SubmissionError as e:
        return e.response()

    ran = re.sub(r'[^A-Za-z0-9\-]', '_', doc.get('RAN') or return_id)
    stamp = now_ms()
    uploaded = []
    try:
        for idx, (data, content_type, ext) in enumerate(payloads):
            path = f"returns/{ran}/{line_id}/{stamp}_{existing + idx}.{ext}"
            token = str(uuid.uuid4())
            blob = bucket.blob(path)
            blob.metadata = {'firebaseStorageDownloadTokens': token}
            blob.upload_from_string(data, content_type=content_type)
            uploaded.append((blob, storage_download_url(bucket.name, path, token)))
        _append_images(ref, line_id, [u for _, u in uploaded])
    except Exception as e:
        for blob, _ in uploaded:
            try:
                blob.delete()
            except Exception:
                logger.warning("Could not delete an orphaned upload")
        if isinstance(e, SubmissionError):
            return e.response()
        logger.error(f"Image upload failed for {return_id}: {type(e).__name__}: {e}")
        return error_response("We couldn't upload your photos. Please try again.", 502, code="upload_failed")
    return jsonify({'success': True, 'urls': [u for _, u in uploaded]})


def _claim_finalize(ref) -> Tuple[bool, Dict[str, Any]]:
    """Mark the request finalized; returns (should_write_shopify_note, doc)."""

    @firestore.transactional
    def _txn(transaction):
        snap = ref.get(transaction=transaction)
        doc = snap.to_dict() or {}
        update: Dict[str, Any] = {}
        if not doc.get('finalizedAt'):
            update.update({'finalizedAt': firestore.SERVER_TIMESTAMP, 'imagesUploaded': True,
                           'updatedAt': firestore.SERVER_TIMESTAMP})
        claim_note = (not doc.get('shopifyNoteLogged')
                      and time.time() - float(doc.get('shopifyNoteClaimedAt') or 0) > 120)
        if claim_note:
            update['shopifyNoteClaimedAt'] = int(time.time())
        if update:
            transaction.update(ref, update)
        return claim_note, doc

    return _txn(db.transaction())


def shopify_submission_note(items: List[Dict[str, Any]]) -> str:
    lines = [f"• {i.get('title')} (SKU: {i.get('sku') or 'N/A'}) x{i.get('quantityReturned')} — "
             f"{str(i.get('actionType') or 'return').capitalize()} — Reason: {i.get('reason') or 'N/A'}" for i in items]
    kind = 'return/exchange request' if len(items) > 1 else 'return request'
    return f"Customer submitted a {kind} for {len(items)} item(s):\n" + "\n".join(lines)


@bp.route('/api/public/returns/<return_id>/finalize', methods=['POST'])
@require_customer
def finalize_return(return_id):
    """Idempotent: logs the Shopify timeline note and sends the *_applied e-mail once."""
    err = _require_db()
    if err:
        return err
    ref, doc = _load_owned_return(return_id)
    if ref is None:
        return doc
    if not doc.get('finalizedAt') and not upload_token_valid(doc, json_body().get('uploadToken')):
        return error_response("Your upload session has expired. Please contact support.", 403,
                              code="invalid_upload_token")
    limited = rate_limited(['finalize', return_id], 30, WINDOW_1_HOUR)
    if limited:
        return limited
    try:
        write_note, doc = _claim_finalize(ref)
    except Exception as e:
        logger.error(f"Finalize failed for {return_id}: {type(e).__name__}: {e}")
        return error_response("We couldn't complete your request right now. Please try again.", 503)
    if write_note:
        note_ok = shopify_timeline_note(doc.get('orderNumericId'), doc.get('RAN') or '', 'Return Request Submitted',
                                        shopify_submission_note(doc.get('items') or []))
        try:
            ref.update({'shopifyNoteLogged': note_ok})
        except Exception as e:
            logger.warning(f"Could not record Shopify note state: {type(e).__name__}")
    event = APPLIED_EVENTS[request_type(doc)]
    email_sent = notify(event, return_id, dedupe_key=event)
    try:
        if email_sent:
            ref.update({'ReturnSubmitEmailSent': True, 'webhookStatus': 'success',
                        'emailSentAt': firestore.SERVER_TIMESTAMP})
        else:
            ref.update({'webhookStatus': 'failed', 'webhookFailureTime': firestore.SERVER_TIMESTAMP})
    except Exception as e:
        logger.warning(f"Could not record e-mail state for {return_id}: {type(e).__name__}")
    return jsonify({'success': True, 'RAN': doc.get('RAN') or '', 'emailSent': bool(email_sent)})


@bp.route('/api/public/returns/lookup', methods=['POST'])
@public_endpoint("Customer status lookup (order no. + email/phone); rate limited")
def lookup_returns():
    """Status page: verify ownership and list the order's requests."""
    err = _require_db()
    if err:
        return err
    order, verification, err = _verify_request('lookup')
    if err:
        return err
    try:
        return jsonify({'success': True, 'customerToken': _issue_token(order, verification),
                        'returns': _public_returns_for(order['name'])})
    except Exception as e:
        logger.error(f"Return lookup failed: {type(e).__name__}: {e}")
        return error_response("Something went wrong. Please try again.", 500)


@bp.route('/api/public/returns', methods=['GET'])
@require_customer
def list_my_returns():
    """Requests of the token's order."""
    err = _require_db()
    if err:
        return err
    try:
        return jsonify({'success': True, 'returns': _public_returns_for(g.customer.get('orderName') or '')})
    except Exception as e:
        logger.error(f"Listing returns failed: {type(e).__name__}: {e}")
        return error_response("Something went wrong. Please try again.", 500)


BALANCES_QUERY = """
query PortalBalances($id: ID!) {
  order(id: $id) {
    customer {
      legacyResourceId
      storeCreditAccounts(first: 10) { nodes { balance { amount currencyCode } } }
    }
  }
}
"""
GIFT_CARDS_QUERY = """
query PortalGiftCards($q: String!) {
  giftCards(first: 50, query: $q) {
    nodes { lastCharacters expiresOn enabled balance { amount currencyCode } }
  }
}
"""


def shape_balances(customer: Dict[str, Any], gift_cards: List[Dict[str, Any]]) -> Dict[str, Any]:
    accounts = ((customer.get('storeCreditAccounts') or {}).get('nodes')) or []
    store_credit = None
    if accounts:
        store_credit = {'amount': money(sum(money((a.get('balance') or {}).get('amount')) for a in accounts)),
                        'currency': ((accounts[0].get('balance') or {}).get('currencyCode')) or 'INR'}
    cards = [{'last4': (gc.get('lastCharacters') or '')[-4:], 'balance': money((gc.get('balance') or {}).get('amount')),
              'currency': (gc.get('balance') or {}).get('currencyCode') or 'INR', 'expiresOn': gc.get('expiresOn')}
             for gc in gift_cards if gc.get('enabled', True)]
    return {'storeCredit': store_credit, 'giftCards': cards}


@bp.route('/api/public/balances', methods=['GET'])
@require_customer
def customer_balances():
    """Store credit and gift-card balances of the order's Shopify customer."""
    order_id = safe_int(g.customer.get('orderNumericId'))
    if not order_id:
        return jsonify({'success': True, 'storeCredit': None, 'giftCards': []})
    try:
        data = shopify_graphql(BALANCES_QUERY, {'id': f"gid://shopify/Order/{order_id}"})
        customer = ((data.get('order') or {}).get('customer')) or {}
        if not customer:
            return jsonify({'success': True, 'storeCredit': None, 'giftCards': []})
        cards: List[Dict[str, Any]] = []
        legacy_id = safe_int(customer.get('legacyResourceId'))
        if legacy_id:
            gdata = shopify_graphql(GIFT_CARDS_QUERY, {'q': f"customer_id:{legacy_id} status:enabled"})
            cards = ((gdata.get('giftCards') or {}).get('nodes')) or []
        return jsonify({'success': True, **shape_balances(customer, cards)})
    except ShopifyError as e:
        logger.error(f"Balance lookup failed: {e}")
        return error_response("We couldn't load your balances right now.", 502, code="upstream_unavailable")

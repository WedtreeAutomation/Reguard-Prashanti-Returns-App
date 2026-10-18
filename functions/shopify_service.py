"""
Shopify Admin API client used by the money flows (refunds, exchanges, restock).

Design rules
------------
* One pooled ``requests.Session`` per process (``get_shopify_service()`` is a
  module-level singleton).
* Every HTTP call has a timeout. GraphQL throttling (HTTP 200 with
  ``errors[].extensions.code == 'THROTTLED'``) and HTTP 429 are retried with
  exponential backoff (max 3 retries) -- a throttled request was never
  executed, so retrying is safe even for mutations.
* A **mutation** whose outcome is unknown (read timeout, dropped connection,
  5xx, unreadable body) raises ``ShopifyTimeout``. Callers must then keep their
  lock / idempotency record in the "unknown" state and tell the agent to check
  Shopify before retrying -- never retry such a mutation automatically.
* ``userErrors`` are checked the same way everywhere (``ShopifyUserError``).
* Logs carry operation names, ids and HTTP status only -- never raw response
  bodies (they contain customer PII).
"""
import random
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple, Union

import requests
from requests.adapters import HTTPAdapter

import core
from core import RefundMethod, logger

QUERY_TIMEOUT = (5, 20)       # (connect, read) seconds
MUTATION_TIMEOUT = (5, 40)
REST_TIMEOUT = (5, 15)
MAX_RETRIES = 3
MAX_BACKOFF_SECONDS = 8.0

_API_VERSION_RE = re.compile(r"^(\d{4}-(01|04|07|10)|unstable)$")
_DOMAIN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.\-]*\.[A-Za-z]{2,}$")

# Gateway label used for bookkeeping-only refunds (money already given to the
# customer outside the order's own payment: gift card, cash, bank transfer).
# "manual" is Shopify's offline gateway, so no payment processor is called.
OFFLINE_REFUND_GATEWAY = "manual"


# ==========================================================
# ERRORS
# ==========================================================
class ShopifyError(core.ShopifyError):
    """A Shopify call failed definitively (nothing was changed).

    ``user_message`` is safe to show to an agent; ``str(e)`` is for logs.
    """

    default_user_message = "Shopify could not complete the request. Please try again."

    def __init__(self, message: str, user_message: Optional[str] = None, errors: Optional[List[Any]] = None):
        super().__init__(message)
        self.user_message = user_message or self.default_user_message
        self.errors = errors or []


class ShopifyUserError(ShopifyError):
    """Shopify rejected the input (``userErrors``). Nothing was changed."""


class ShopifyNotFound(ShopifyError):
    default_user_message = "The order could not be found in Shopify."


class ShopifyNotConfigured(ShopifyError):
    default_user_message = "Shopify is not configured on the server."


class ShopifyTimeout(ShopifyError):
    """The outcome of a mutation is UNKNOWN (it may or may not have run)."""

    default_user_message = ("Shopify did not confirm the result in time, so its status is unknown. "
                            "Check the order in Shopify before retrying.")


# ==========================================================
# RESULT TYPES
# ==========================================================
@dataclass
class RefundOutcome:
    """What a successful Shopify-side refund produced (no Firestore state)."""
    method: RefundMethod
    amount: float
    currency: str = "INR"
    success: bool = True
    refund_id: Optional[str] = None
    transaction_id: Optional[str] = None
    transactions: List[Dict[str, Any]] = field(default_factory=list)
    gateway: Optional[str] = None
    gift_card_id: Optional[str] = None
    gift_card_code: Optional[str] = None
    gift_card_last4: Optional[str] = None
    gift_card_expires_on: Optional[str] = None
    customer_email: Optional[str] = None
    order_name: Optional[str] = None
    account_balance: Optional[Dict[str, Any]] = None
    # Bookkeeping refund that closes Shopify's "refund owed" balance for
    # gift-card / manual refunds: True recorded, False skipped/rejected,
    # None = not attempted or outcome unknown.
    shopify_ledger_recorded: Optional[bool] = None
    shopify_ledger_warning: Optional[str] = None


# ==========================================================
# HELPERS
# ==========================================================
def numeric_id(value: Any) -> str:
    """gid://shopify/X/123?y -> '123'."""
    if value is None:
        return ""
    return str(value).split("?")[0].rstrip("/").rsplit("/", 1)[-1].strip()


def order_gid(order_id: Any) -> str:
    text = str(order_id or "").strip()
    return text if text.startswith("gid://") else f"gid://shopify/Order/{numeric_id(text)}"


def _amount(money_bag: Any) -> float:
    """Parse ``{shopMoney:{amount}}`` / ``{amount}`` / scalar into a float."""
    if isinstance(money_bag, dict):
        if "shopMoney" in money_bag:
            money_bag = (money_bag.get("shopMoney") or {}).get("amount")
        elif "presentmentMoney" in money_bag:
            money_bag = (money_bag.get("presentmentMoney") or {}).get("amount")
        else:
            money_bag = money_bag.get("amount")
    try:
        return float(money_bag)
    except (TypeError, ValueError):
        return 0.0


def _is_mutation(query: str) -> bool:
    return query.lstrip().lower().startswith("mutation")


def _operation_name(query: str) -> str:
    match = re.match(r"\s*(query|mutation)\s+([A-Za-z0-9_]+)", query)
    return match.group(2) if match else "anonymous"


def _is_throttled(errors: Any) -> bool:
    for err in errors or []:
        if isinstance(err, dict) and ((err.get("extensions") or {}).get("code") == "THROTTLED"
                                      or str(err.get("message", "")).lower() == "throttled"):
            return True
    return False


def _throttle_wait(body: Dict[str, Any], attempt: int) -> float:
    """Seconds to wait before retrying a throttled query."""
    cost = (body.get("extensions") or {}).get("cost") or {}
    status = cost.get("throttleStatus") or {}
    try:
        needed = float(cost.get("requestedQueryCost") or 0) - float(status.get("currentlyAvailable") or 0)
        rate = float(status.get("restoreRate") or 0)
        if needed > 0 and rate > 0:
            return min(MAX_BACKOFF_SECONDS, max(0.5, needed / rate))
    except (TypeError, ValueError):
        pass
    return _backoff(attempt)


def _backoff(attempt: int) -> float:
    return min(MAX_BACKOFF_SECONDS, (2 ** attempt) * 0.5 + random.uniform(0, 0.25))


def _error_messages(errors: List[Any]) -> List[str]:
    out = []
    for err in errors or []:
        if isinstance(err, dict):
            field_path = err.get("field")
            prefix = f"{'.'.join(str(f) for f in field_path)}: " if isinstance(field_path, list) and field_path else ""
            out.append(f"{prefix}{err.get('message', 'Unknown error')}")
        else:
            out.append(str(err))
    return out


def check_user_errors(payload: Optional[Dict[str, Any]], op: str,
                      keys: Tuple[str, ...] = ("userErrors",)) -> Dict[str, Any]:
    """Raise ShopifyUserError if the mutation payload has user errors."""
    payload = payload or {}
    errors: List[Any] = []
    for key in keys:
        errors.extend(payload.get(key) or [])
    if errors:
        messages = _error_messages(errors)
        logger.warning(f"Shopify {op} rejected: {'; '.join(messages)[:300]}")
        raise ShopifyUserError(f"{op} userErrors: {messages}",
                               user_message="Shopify rejected the request: " + "; ".join(messages)[:300],
                               errors=errors)
    return payload


def _edges(connection: Any) -> List[Dict[str, Any]]:
    if not isinstance(connection, dict):
        return []
    if "nodes" in connection:
        return [n for n in connection.get("nodes") or [] if isinstance(n, dict)]
    return [e.get("node") or {} for e in connection.get("edges") or [] if isinstance(e, dict)]


# ==========================================================
# GRAPHQL DOCUMENTS
# ==========================================================
GET_ORDER_CUSTOMER = """
query GetOrderCustomer($id: ID!) {
  order(id: $id) {
    id
    legacyResourceId
    name
    email
    displayFinancialStatus
    taxesIncluded
    totalPriceSet { shopMoney { amount currencyCode } }
    totalShippingPriceSet { shopMoney { amount currencyCode } }
    customer { id displayName email firstName lastName }
    paymentGatewayNames
    transactions(first: 50) {
      id
      gateway
      kind
      status
      parentTransaction { id }
      amountSet { shopMoney { amount currencyCode } }
    }
  }
}
"""

FIND_ORDER_BY_NAME = """
query FindOrderByName($q: String!) {
  orders(first: 5, query: $q) { nodes { legacyResourceId name } }
}
"""

ORDER_LINE_ITEMS_PAGE = """
query OrderLineItemsPage($id: ID!, $after: String) {
  order(id: $id) {
    id
    lineItems(first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          sku
          title
          quantity
          originalUnitPriceSet { shopMoney { amount } }
          discountAllocations {
            allocatedAmountSet { shopMoney { amount } }
            discountApplication {
              __typename
              ... on DiscountCodeApplication { code }
              ... on ManualDiscountApplication { title description }
              ... on AutomaticDiscountApplication { title }
              ... on ScriptDiscountApplication { title }
            }
          }
          taxLines { priceSet { shopMoney { amount } } }
          variant { id inventoryItem { id } }
        }
      }
    }
  }
}
"""

GIFT_CARD_CREATE = """
mutation GiftCardCreate($input: GiftCardCreateInput!) {
  giftCardCreate(input: $input) {
    giftCard {
      id
      createdAt
      expiresOn
      lastCharacters
      initialValue { amount currencyCode }
      customer { id }
    }
    giftCardCode
    userErrors { field message }
  }
}
"""

REFUND_CREATE = """
mutation RefundCreate($input: RefundInput!) {
  refundCreate(input: $input) {
    userErrors { field message }
    refund {
      id
      totalRefundedSet { shopMoney { amount currencyCode } }
      transactions(first: 10) {
        edges { node { id gateway kind status amountSet { shopMoney { amount currencyCode } } } }
      }
    }
    order { id }
  }
}
"""

ORDER_EDIT_BEGIN = """
mutation OrderEditBegin($id: ID!) {
  orderEditBegin(id: $id) {
    calculatedOrder {
      id
      lineItems(first: 250) { edges { node { id quantity } } }
    }
    userErrors { field message }
  }
}
"""

ORDER_EDIT_ADD_LINE_ITEM_DISCOUNT = """
mutation OrderEditAddLineItemDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
  orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
    calculatedLineItem { id }
    userErrors { field message }
  }
}
"""

ORDER_EDIT_COMMIT = """
mutation OrderEditCommit($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
  orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
    order {
      id
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      totalOutstandingSet { shopMoney { amount currencyCode } }
    }
    userErrors { field message }
  }
}
"""

GET_ORDER_BALANCE = """
query GetOrderBalance($id: ID!) {
  order(id: $id) {
    id
    totalOutstandingSet { shopMoney { amount currencyCode } }
  }
}
"""

GET_RETURN_EXCHANGE_LINE_ITEMS = """
query GetReturnExchangeLineItems($id: ID!) {
  return(id: $id) {
    id
    exchangeLineItems(first: 50) {
      edges { node { id quantity lineItem { id variant { id } } } }
    }
  }
}
"""

ORDER_INVOICE_SEND = """
mutation OrderInvoiceSend($id: ID!) {
  orderInvoiceSend(id: $id) {
    order { id totalOutstandingSet { shopMoney { amount currencyCode } } }
    userErrors { field message }
  }
}
"""

GET_FULFILLMENT_ORDERS_ON_HOLD = """
query GetFulfillmentOrdersOnHold($id: ID!) {
  order(id: $id) {
    fulfillmentOrders(first: 50) {
      edges { node { id status fulfillmentHolds { id reason reasonNotes } } }
    }
  }
}
"""

FULFILLMENT_ORDER_RELEASE_HOLD = """
mutation FulfillmentOrderReleaseHold($id: ID!, $holdIds: [ID!]) {
  fulfillmentOrderReleaseHold(id: $id, holdIds: $holdIds) {
    fulfillmentOrder { id status }
    userErrors { field message }
  }
}
"""

STORE_CREDIT_BALANCE = """
query GetStoreCreditBalance($customerId: ID!) {
  customer(id: $customerId) {
    storeCreditAccounts(first: 5) { nodes { id balance { amount currencyCode } } }
  }
}
"""

RETURNABLE_FULFILLMENTS = """
query GetReturnableFulfillments($orderId: ID!) {
  returnableFulfillments(orderId: $orderId, first: 50) {
    edges {
      node {
        id
        fulfillment { id }
        returnableFulfillmentLineItems(first: 50) {
          edges { node { fulfillmentLineItem { id lineItem { id } } quantity } }
        }
      }
    }
  }
}
"""

RETURN_CREATE_WITH_EXCHANGE = """
mutation ReturnCreate($returnInput: ReturnInput!) {
  returnCreate(returnInput: $returnInput) {
    return {
      id
      status
      returnLineItems(first: 50) {
        edges {
          node {
            id
            quantity
            ... on ReturnLineItem { fulfillmentLineItem { id lineItem { id } } }
          }
        }
      }
      exchangeLineItems(first: 50) { edges { node { id quantity } } }
    }
    userErrors { field message }
  }
}
"""

RETURN_CALCULATE = """
query ReturnCalculate($input: CalculateReturnInput!) {
  returnCalculate(input: $input) {
    returnLineItems {
      id
      quantity
      subtotalSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
    }
    exchangeLineItems {
      id
      quantity
      variant { id }
      subtotalSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
    }
  }
}
"""

RETURN_REVERSE_FULFILLMENT_ORDERS = """
query GetReverseFulfillmentOrders($returnId: ID!) {
  return(id: $returnId) {
    id
    reverseFulfillmentOrders(first: 10) {
      edges {
        node {
          id
          lineItems(first: 50) {
            edges { node { id ... on ReverseFulfillmentOrderLineItem { fulfillmentLineItem { id } } } }
          }
        }
      }
    }
  }
}
"""

RETURN_PROCESS = """
mutation ReturnProcess($input: ReturnProcessInput!) {
  returnProcess(input: $input) {
    return {
      id
      status
      exchangeLineItems(first: 50) {
        edges { node { id quantity lineItem { id variant { id } } } }
      }
    }
    userErrors { field message }
  }
}
"""

ORDER_CANCEL = """
mutation OrderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!,
                     $notifyCustomer: Boolean, $staffNote: String) {
  orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock,
              notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
    job { id done }
    orderCancelUserErrors { field message code }
  }
}
"""

INVENTORY_ADJUST = """
mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
  inventoryAdjustQuantities(input: $input) {
    userErrors { field message }
  }
}
"""


# ==========================================================
# SERVICE
# ==========================================================
class ShopifyService:
    """Thin, safe wrapper around the Shopify Admin API (GraphQL + a little REST)."""

    def __init__(self, shop_domain: str, access_token: str, api_version: str):
        shop_domain = (shop_domain or "").strip().replace("https://", "").rstrip("/")
        if not shop_domain or not access_token:
            raise ShopifyNotConfigured("Shopify credentials not configured")
        if not _DOMAIN_RE.match(shop_domain):
            raise ShopifyNotConfigured(f"Invalid Shopify shop domain: {shop_domain!r}")
        if not _API_VERSION_RE.match(api_version or ""):
            raise ShopifyNotConfigured(f"Invalid SHOPIFY_API_VERSION {api_version!r} (expected e.g. 2025-01)")
        self.shop_domain = shop_domain
        self.api_version = api_version
        self.graphql_endpoint = f"https://{shop_domain}/admin/api/{api_version}/graphql.json"
        self.rest_base = f"https://{shop_domain}/admin/api/{api_version}"
        self.session = requests.Session()
        adapter = HTTPAdapter(pool_connections=4, pool_maxsize=16)
        self.session.mount("https://", adapter)
        self.session.headers.update({"Content-Type": "application/json", "X-Shopify-Access-Token": access_token})

    # ------------------------------------------------------------------
    # Transport
    # ------------------------------------------------------------------
    def _make_graphql_request(self, query: str, variables: Optional[Dict] = None,
                              mutation: Optional[bool] = None) -> Dict:
        """POST a GraphQL document and return its ``data``.

        Raises ShopifyError (definitive failure), ShopifyTimeout (mutation
        outcome unknown). Does NOT check ``userErrors`` -- use
        ``check_user_errors`` on the payload.
        """
        is_mutation = _is_mutation(query) if mutation is None else mutation
        op = _operation_name(query)
        payload: Dict[str, Any] = {"query": query}
        if variables:
            payload["variables"] = variables
        timeout = MUTATION_TIMEOUT if is_mutation else QUERY_TIMEOUT
        attempt = 0
        while True:
            try:
                response = self.session.post(self.graphql_endpoint, json=payload, timeout=timeout)
            except requests.exceptions.ConnectTimeout as e:
                # The request never reached Shopify -> safe to retry.
                if attempt < MAX_RETRIES:
                    attempt += 1
                    time.sleep(_backoff(attempt))
                    continue
                raise ShopifyError(f"{op}: connect timeout", user_message="Could not reach Shopify. Please try again.") from e
            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
                if is_mutation:
                    logger.error(f"Shopify {op}: {type(e).__name__} -- mutation outcome unknown")
                    raise ShopifyTimeout(f"{op}: {type(e).__name__}") from e
                if attempt < 1:
                    attempt += 1
                    time.sleep(_backoff(attempt))
                    continue
                raise ShopifyError(f"{op}: {type(e).__name__}",
                                   user_message="Shopify did not respond in time. Please try again.") from e
            except requests.exceptions.RequestException as e:
                raise ShopifyError(f"{op}: {type(e).__name__}") from e

            status = response.status_code
            if status == 429:
                if attempt < MAX_RETRIES:
                    attempt += 1
                    time.sleep(self._retry_after(response, attempt))
                    continue
                raise ShopifyError(f"{op}: HTTP 429", user_message="Shopify is busy right now. Please try again in a minute.")
            if status >= 500:
                logger.error(f"Shopify {op}: HTTP {status}")
                if is_mutation:
                    raise ShopifyTimeout(f"{op}: HTTP {status}")
                if attempt < MAX_RETRIES:
                    attempt += 1
                    time.sleep(_backoff(attempt))
                    continue
                raise ShopifyError(f"{op}: HTTP {status}", user_message="Shopify is temporarily unavailable. Please try again.")
            if status in (401, 403):
                logger.error(f"Shopify {op}: HTTP {status} (check access token / scopes)")
                raise ShopifyError(f"{op}: HTTP {status}", user_message="The server is not authorised to perform this action in Shopify.")
            if status != 200:
                logger.error(f"Shopify {op}: HTTP {status}")
                raise ShopifyError(f"{op}: HTTP {status}")
            try:
                body = response.json()
            except ValueError as e:
                if is_mutation:
                    raise ShopifyTimeout(f"{op}: unreadable response") from e
                raise ShopifyError(f"{op}: unreadable response") from e

            errors = body.get("errors")
            if errors:
                if _is_throttled(errors) and attempt < MAX_RETRIES:
                    attempt += 1
                    wait = _throttle_wait(body, attempt)
                    logger.info(f"Shopify {op} throttled; retrying in {wait:.1f}s (attempt {attempt})")
                    time.sleep(wait)
                    continue
                messages = _error_messages(errors if isinstance(errors, list) else [errors])
                logger.error(f"Shopify {op} GraphQL errors: {'; '.join(messages)[:300]}")
                raise ShopifyError(f"{op}: GraphQL error: {'; '.join(messages)[:300]}", errors=errors)
            return body.get("data") or {}

    @staticmethod
    def _retry_after(response, attempt: int) -> float:
        try:
            return min(MAX_BACKOFF_SECONDS, max(0.5, float(response.headers.get("Retry-After", ""))))
        except (TypeError, ValueError):
            return _backoff(attempt)

    def _rest(self, method: str, path: str, **kwargs) -> Tuple[int, Dict[str, Any]]:
        """Small REST helper with timeout + 429 retry. Returns (status, json-or-{})."""
        url = f"{self.rest_base}/{path.lstrip('/')}"
        for attempt in range(MAX_RETRIES + 1):
            response = self.session.request(method, url, timeout=REST_TIMEOUT, **kwargs)
            if response.status_code == 429 and attempt < MAX_RETRIES:
                time.sleep(self._retry_after(response, attempt + 1))
                continue
            try:
                body = response.json() if response.content else {}
            except ValueError:
                body = {}
            return response.status_code, body if isinstance(body, dict) else {}
        return 429, {}

    # ------------------------------------------------------------------
    # Orders
    # ------------------------------------------------------------------
    def get_order_details(self, order_gid_value: str) -> Dict:
        """Order header, customer, shipping total and up to 50 transactions."""
        result = self._make_graphql_request(GET_ORDER_CUSTOMER, {"id": order_gid(order_gid_value)})
        order = result.get("order")
        if not order:
            raise ShopifyNotFound(f"Order not found: {numeric_id(order_gid_value)}")
        return order

    def get_order_line_items(self, order_gid_value: str) -> List[Dict[str, Any]]:
        """All line items of the order (paginated, 50 per page)."""
        items: List[Dict[str, Any]] = []
        after = None
        for _ in range(40):  # hard stop: 2000 line items
            result = self._make_graphql_request(ORDER_LINE_ITEMS_PAGE, {"id": order_gid(order_gid_value), "after": after})
            order = result.get("order")
            if not order:
                raise ShopifyNotFound(f"Order not found: {numeric_id(order_gid_value)}")
            connection = order.get("lineItems") or {}
            items.extend(_edges(connection))
            page = connection.get("pageInfo") or {}
            if not page.get("hasNextPage"):
                break
            after = page.get("endCursor")
        return items

    @staticmethod
    def normalize_line_item(node: Dict[str, Any]) -> Dict[str, Any]:
        """Per-unit price net of real discounts (gift-card/credit-like
        discounts are payments, not price reductions) and per-unit tax."""
        from guards import is_payment_like_discount  # local import: guards imports security/flask
        qty = max(1, int(node.get("quantity") or 1))
        original = _amount(node.get("originalUnitPriceSet"))
        discount_total = 0.0
        for alloc in node.get("discountAllocations") or []:
            app = alloc.get("discountApplication") or {}
            name = " ".join(str(app.get(k) or "") for k in ("title", "description", "code"))
            if is_payment_like_discount(name):
                continue
            discount_total += _amount(alloc.get("allocatedAmountSet"))
        tax_total = sum(_amount(t.get("priceSet")) for t in node.get("taxLines") or [])
        return {
            "id": numeric_id(node.get("id")),
            "sku": node.get("sku"),
            "title": node.get("title"),
            "quantity": qty,
            "unitPrice": round(original - discount_total / qty, 2),
            "unitTax": round(tax_total / qty, 2),
            "inventoryItemId": ((node.get("variant") or {}).get("inventoryItem") or {}).get("id"),
            "variantId": (node.get("variant") or {}).get("id"),
        }

    def get_refund_context(self, order_gid_value: str) -> Dict[str, Any]:
        """Everything the refund endpoints need from Shopify in two calls:
        ``{details, order: {lineItems, taxesIncluded, shippingTotal}}``."""
        details = self.get_order_details(order_gid_value)
        lines = [self.normalize_line_item(n) for n in self.get_order_line_items(order_gid_value)]
        return {
            "details": details,
            "order": {
                "lineItems": lines,
                "taxesIncluded": details.get("taxesIncluded", True) is not False,
                "shippingTotal": _amount(details.get("totalShippingPriceSet")),
            },
        }

    def find_order_numeric_id_by_name(self, order_name: str) -> Optional[str]:
        """Numeric id of the order with exactly this name (with or without '#'),
        or None. Raises ShopifyError when Shopify cannot be read."""
        wanted = str(order_name or "").strip().lstrip("#").upper()
        if not wanted:
            return None
        for candidate in (f"#{wanted}", wanted):
            result = self._make_graphql_request(FIND_ORDER_BY_NAME, {"q": f"name:'{candidate}'"})
            for node in (result.get("orders") or {}).get("nodes") or []:
                if str(node.get("name") or "").strip().lstrip("#").upper() == wanted and node.get("legacyResourceId"):
                    return str(node["legacyResourceId"])
        return None

    def get_order_outstanding_balance(self, order_gid_value: str) -> float:
        """Shopify's own outstanding balance (positive: customer owes;
        negative: merchant owes). Raises if it cannot be read."""
        result = self._make_graphql_request(GET_ORDER_BALANCE, {"id": order_gid(order_gid_value)})
        order = result.get("order")
        if not order:
            raise ShopifyNotFound(f"Order not found: {numeric_id(order_gid_value)}")
        amount = ((order.get("totalOutstandingSet") or {}).get("shopMoney") or {}).get("amount")
        try:
            return float(amount)
        except (TypeError, ValueError) as e:
            raise ShopifyError("Outstanding balance missing from Shopify response") from e

    def get_order_note(self, numeric_order_id: Any) -> Optional[str]:
        """The merchant's order note, or None if it could not be read."""
        try:
            status, body = self._rest("GET", f"orders/{numeric_id(numeric_order_id)}.json", params={"fields": "id,note"})
        except requests.RequestException as e:
            logger.warning(f"Could not read note of order {numeric_id(numeric_order_id)}: {type(e).__name__}")
            return None
        if status != 200 or "order" not in body:
            logger.warning(f"Could not read note of order {numeric_id(numeric_order_id)}: HTTP {status}")
            return None
        return (body.get("order") or {}).get("note") or ""

    def add_timeline_note(self, numeric_order_id: Any, message: str) -> bool:
        """Create an order-timeline entry without losing the merchant's note.

        Shopify has no timeline-comment API for apps, so the note is set to
        ``message`` (which creates a timeline event) and then restored. If the
        current note cannot be read first, nothing is written at all, so the
        merchant's note can never be wiped. The restore is retried.
        """
        oid = numeric_id(numeric_order_id)
        original = self.get_order_note(oid)
        if original is None:
            logger.warning(f"Timeline note skipped for order {oid}: original note unreadable")
            return False
        path = f"orders/{oid}.json"
        try:
            status, _ = self._rest("PUT", path, json={"order": {"id": int(oid), "note": message[:5000]}})
        except (requests.RequestException, ValueError) as e:
            logger.warning(f"Timeline note write failed for order {oid}: {type(e).__name__}")
            status = 0
        restored = False
        for attempt in range(3):
            try:
                restore_status, _ = self._rest("PUT", path, json={"order": {"id": int(oid), "note": original}})
                if restore_status == 200:
                    restored = True
                    break
            except (requests.RequestException, ValueError) as e:
                logger.warning(f"Restoring note on order {oid} failed (attempt {attempt + 1}): {type(e).__name__}")
            time.sleep(0.5 * (attempt + 1))
        if not restored:
            logger.error(f"ORDER NOTE NOT RESTORED on order {oid}; restore it from the order timeline")
        return status == 200 and restored

    def get_restock_location_id(self, numeric_order_id: Any) -> Optional[str]:
        """Numeric location id for restocking: the order's fulfillment location,
        else the shop's first location. None if neither can be resolved."""
        oid = numeric_id(numeric_order_id)
        try:
            status, body = self._rest("GET", f"orders/{oid}.json", params={"fields": "id,fulfillments"})
            if status == 200:
                for fulfillment in (body.get("order") or {}).get("fulfillments") or []:
                    if fulfillment.get("location_id"):
                        return str(fulfillment["location_id"])
            status, body = self._rest("GET", "locations.json")
            if status == 200 and body.get("locations"):
                return str(body["locations"][0]["id"])
        except (requests.RequestException, KeyError, IndexError, TypeError) as e:
            logger.error(f"Could not resolve a restock location for order {oid}: {type(e).__name__}")
        return None

    def adjust_inventory(self, changes: List[Dict[str, Any]]) -> None:
        """inventoryAdjustQuantities (reason 'restock', quantity name 'available')."""
        result = self._make_graphql_request(INVENTORY_ADJUST, {
            "input": {"reason": "restock", "name": "available", "changes": changes}
        })
        check_user_errors(result.get("inventoryAdjustQuantities"), "inventoryAdjustQuantities")

    # ------------------------------------------------------------------
    # Exchanges (native Return / Exchange objects)
    # ------------------------------------------------------------------
    def get_returnable_fulfillment_line_items(self, order_gid_value: str) -> Dict[str, str]:
        """Numeric LineItem id -> FulfillmentLineItem gid for every returnable unit."""
        result = self._make_graphql_request(RETURNABLE_FULFILLMENTS, {"orderId": order_gid(order_gid_value)})
        mapping: Dict[str, str] = {}
        for fulfillment in _edges(result.get("returnableFulfillments")):
            for node in _edges(fulfillment.get("returnableFulfillmentLineItems")):
                fli = node.get("fulfillmentLineItem") or {}
                line_item_gid = (fli.get("lineItem") or {}).get("id")
                if line_item_gid and fli.get("id"):
                    mapping[numeric_id(line_item_gid)] = fli["id"]
        logger.info(f"Order {numeric_id(order_gid_value)}: {len(mapping)} returnable line item(s)")
        return mapping

    def calculate_return_financials(self, order_gid_value: str, return_line_items: List[Dict],
                                    exchange_line_items: List[Dict], return_shipping_fee_amount: float = 0.0,
                                    currency_code: str = "INR") -> Dict:
        """returnCalculate preview. ``netBalance`` > 0: customer pays; < 0: refund due.

        (CalculatedReturn has no total field, so the balance is derived from the
        itemised lines + the return shipping fee.)
        """
        calc_input: Dict[str, Any] = {"orderId": order_gid(order_gid_value), "returnLineItems": return_line_items}
        if exchange_line_items:
            calc_input["exchangeLineItems"] = exchange_line_items
        if return_shipping_fee_amount and float(return_shipping_fee_amount) > 0:
            calc_input["returnShippingFee"] = {
                "amount": {"amount": f"{float(return_shipping_fee_amount):.2f}", "currencyCode": currency_code or "INR"}
            }
        result = self._make_graphql_request(RETURN_CALCULATE, {"input": calc_input})
        calc = result.get("returnCalculate") or {}
        return_lines = calc.get("returnLineItems") or []
        exchange_lines = calc.get("exchangeLineItems") or []
        return_subtotal = abs(sum(_amount(n.get("subtotalSet")) for n in return_lines))
        return_tax = sum(_amount(n.get("totalTaxSet")) for n in return_lines)
        exchange_subtotal = sum(_amount(n.get("subtotalSet")) for n in exchange_lines)
        exchange_tax = sum(_amount(n.get("totalTaxSet")) for n in exchange_lines)
        net = (exchange_subtotal + exchange_tax) - (return_subtotal + return_tax) + float(return_shipping_fee_amount or 0)
        net = round(net + 1e-9, 2)
        return {
            "returnSubtotal": round(return_subtotal, 2),
            "returnTax": round(return_tax, 2),
            "exchangeSubtotal": round(exchange_subtotal, 2),
            "exchangeTax": round(exchange_tax, 2),
            "netBalance": net,
            "financialOutcome": "extra" if net > 0.01 else ("refund" if net < -0.01 else "even"),
            "exchangeLines": [
                {"variantId": (n.get("variant") or {}).get("id"), "quantity": n.get("quantity"),
                 "subtotal": _amount(n.get("subtotalSet"))}
                for n in exchange_lines
            ],
        }

    def create_return_with_exchange(self, order_gid_value: str, return_line_items: List[Dict],
                                    exchange_line_items: List[Dict], notify_customer: bool = False,
                                    requested_at: Optional[str] = None,
                                    return_shipping_fee_amount: Optional[float] = None,
                                    currency_code: str = "INR") -> Dict:
        """returnCreate (records intent; moves no money). ``return_shipping_fee_amount``
        is the agent's net deductions as a MoneyInput (never negative)."""
        return_input: Dict[str, Any] = {
            "orderId": order_gid(order_gid_value),
            "returnLineItems": return_line_items,
            "notifyCustomer": notify_customer,
        }
        if exchange_line_items:
            return_input["exchangeLineItems"] = exchange_line_items
        if requested_at:
            return_input["requestedAt"] = requested_at
        if return_shipping_fee_amount and float(return_shipping_fee_amount) > 0:
            return_input["returnShippingFee"] = {
                "amount": {"amount": f"{float(return_shipping_fee_amount):.2f}", "currencyCode": currency_code or "INR"}
            }
        result = self._make_graphql_request(RETURN_CREATE_WITH_EXCHANGE, {"returnInput": return_input})
        payload = check_user_errors(result.get("returnCreate"), "returnCreate")
        ret = payload.get("return")
        if not ret or not ret.get("id"):
            raise ShopifyTimeout("returnCreate returned no Return object")  # unknown: treat as unknown
        return ret

    def get_reverse_fulfillment_order_line_item_map(self, return_gid: str) -> Dict[str, str]:
        """FulfillmentLineItem gid -> ReverseFulfillmentOrderLineItem gid."""
        result = self._make_graphql_request(RETURN_REVERSE_FULFILLMENT_ORDERS, {"returnId": return_gid})
        mapping: Dict[str, str] = {}
        for rfo in _edges((result.get("return") or {}).get("reverseFulfillmentOrders")):
            for node in _edges(rfo.get("lineItems")):
                fli = (node.get("fulfillmentLineItem") or {}).get("id")
                if fli:
                    mapping[fli] = node["id"]
        return mapping

    def process_return(self, return_gid: str, return_line_items: List[Dict], exchange_line_items: List[Dict],
                       notify_customer: bool = False, note: Optional[str] = None) -> Dict:
        """returnProcess: books the return + exchange and sets each unit's
        disposition. Never moves money (no financialTransfer is sent)."""
        input_payload: Dict[str, Any] = {
            "returnId": return_gid,
            "returnLineItems": return_line_items,
            "notifyCustomer": notify_customer,
        }
        if exchange_line_items:
            input_payload["exchangeLineItems"] = exchange_line_items
        if note:
            input_payload["note"] = note[:500]
        result = self._make_graphql_request(RETURN_PROCESS, {"input": input_payload})
        payload = check_user_errors(result.get("returnProcess"), "returnProcess")
        return payload.get("return") or {}

    def get_return_exchange_line_items(self, return_gid: str) -> List[Dict]:
        """Fresh read of a return's exchange lines incl. ``lineItem {id variant {id}}``."""
        result = self._make_graphql_request(GET_RETURN_EXCHANGE_LINE_ITEMS, {"id": return_gid})
        return _edges((result.get("return") or {}).get("exchangeLineItems"))

    def apply_post_exchange_discount(self, order_gid_value: str, line_item_discounts: Dict[str, float],
                                     notify_customer: bool = False) -> Dict:
        """Discount replacement line items via a separate Order Edit.

        ``line_item_discounts``: numeric Order LineItem id -> percent (0 < p <= 100).
        Nothing is committed unless every discount was accepted. Returns
        ``{totalOutstanding, currentTotalPrice, discountedLineItemIds}``.
        """
        if not line_item_discounts:
            raise ValueError("apply_post_exchange_discount called with no discounts")
        for percent in line_item_discounts.values():
            if not (0 < float(percent) <= 100):
                raise ValueError("Discount percent must be between 0 and 100")
        begin = check_user_errors(
            self._make_graphql_request(ORDER_EDIT_BEGIN, {"id": order_gid(order_gid_value)}).get("orderEditBegin"),
            "orderEditBegin")
        calculated = begin.get("calculatedOrder") or {}
        if not calculated.get("id"):
            raise ShopifyError("orderEditBegin returned no calculatedOrder")
        calc_line_by_numeric = {numeric_id(n["id"]): n["id"] for n in _edges(calculated.get("lineItems")) if n.get("id")}

        discounted = []
        for line_id, percent in line_item_discounts.items():
            calc_line = calc_line_by_numeric.get(numeric_id(line_id))
            if not calc_line:
                raise ShopifyError(f"Exchange line item {line_id} not found in the order edit; nothing committed",
                                   user_message="The replacement item could not be found for the discount; nothing was changed.")
            result = self._make_graphql_request(ORDER_EDIT_ADD_LINE_ITEM_DISCOUNT, {
                "id": calculated["id"],
                "lineItemId": calc_line,
                "discount": {"percentValue": round(float(percent), 2), "description": "Exchange discount"},
            })
            check_user_errors(result.get("orderEditAddLineItemDiscount"), "orderEditAddLineItemDiscount")
            discounted.append(numeric_id(line_id))

        commit = check_user_errors(self._make_graphql_request(ORDER_EDIT_COMMIT, {
            "id": calculated["id"],
            "notifyCustomer": notify_customer,
            "staffNote": "Discount applied to exchange replacement item(s).",
        }).get("orderEditCommit"), "orderEditCommit")
        order = commit.get("order") or {}
        if "totalOutstandingSet" not in order:
            raise ShopifyTimeout("orderEditCommit returned no balance")
        return {
            "totalOutstanding": _amount(order.get("totalOutstandingSet")),
            "currentTotalPrice": _amount(order.get("currentTotalPriceSet")),
            "discountedLineItemIds": discounted,
        }

    def send_exchange_invoice(self, order_gid_value: str) -> Dict:
        """E-mail the customer a checkout link for the outstanding balance."""
        result = self._make_graphql_request(ORDER_INVOICE_SEND, {"id": order_gid(order_gid_value)})
        return check_user_errors(result.get("orderInvoiceSend"), "orderInvoiceSend").get("order") or {}

    def release_awaiting_payment_holds(self, order_gid_value: str) -> Dict[str, Any]:
        """Release every AWAITING_PAYMENT hold on the order.

        Returns ``{found, released:[fulfillmentOrderId], failed:[{fulfillmentOrderId, holdId, error}]}``.
        Raises ShopifyError if the holds cannot even be listed.
        """
        result = self._make_graphql_request(GET_FULFILLMENT_ORDERS_ON_HOLD, {"id": order_gid(order_gid_value)})
        found, released, failed = 0, [], []
        for fo in _edges((result.get("order") or {}).get("fulfillmentOrders")):
            if fo.get("status") != "ON_HOLD":
                continue
            for hold in fo.get("fulfillmentHolds") or []:
                if hold.get("reason") != "AWAITING_PAYMENT" or not hold.get("id"):
                    continue
                found += 1
                try:
                    res = self._make_graphql_request(FULFILLMENT_ORDER_RELEASE_HOLD,
                                                     {"id": fo["id"], "holdIds": [hold["id"]]})
                    check_user_errors(res.get("fulfillmentOrderReleaseHold"), "fulfillmentOrderReleaseHold")
                    if fo["id"] not in released:
                        released.append(fo["id"])
                except ShopifyError as e:
                    logger.error(f"Releasing hold {numeric_id(hold['id'])} on {numeric_id(fo['id'])} failed: {type(e).__name__}")
                    failed.append({"fulfillmentOrderId": fo["id"], "holdId": hold["id"], "error": e.user_message})
        return {"found": found, "released": released, "failed": failed}

    # ------------------------------------------------------------------
    # Refunds
    # ------------------------------------------------------------------
    @staticmethod
    def refundable_payments(transactions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """THE single 'remaining refundable per payment' implementation.

        For each successful SALE/CAPTURE: amount minus every SUCCESS/PENDING
        REFUND whose ``parentTransaction.id`` points at it. Gift-card payments
        first (same order as before). Returns ``[{id, gateway, available}]``.
        """
        txs = [t for t in transactions or [] if isinstance(t, dict)]
        refunded_by_parent: Dict[str, float] = {}
        for t in txs:
            if t.get("kind") == "REFUND" and t.get("status") in ("SUCCESS", "PENDING"):
                parent = (t.get("parentTransaction") or {}).get("id") or t.get("parentId")
                if parent:
                    refunded_by_parent[parent] = refunded_by_parent.get(parent, 0.0) + _amount(t.get("amountSet"))
        payments = []
        for t in txs:
            if t.get("kind") in ("SALE", "CAPTURE") and t.get("status") == "SUCCESS" and t.get("id"):
                available = round(_amount(t.get("amountSet")) - refunded_by_parent.get(t["id"], 0.0), 2)
                if available > 0:
                    payments.append({"id": t["id"], "gateway": t.get("gateway"), "available": available})
        payments.sort(key=lambda p: 0 if p.get("gateway") == "gift_card" else 1)
        return payments

    def refund_to_original_payment(self, order_gid_value: str, refund_amount: Union[str, float], currency_code: str,
                                   notify: Optional[bool] = None, note: Optional[str] = None,
                                   order_details: Optional[Dict] = None) -> Dict:
        """refundCreate against the order's real payments (this DOES move money)."""
        refund_amount = round(float(refund_amount) + 1e-9, 2)
        details = order_details or self.get_order_details(order_gid_value)
        gid = order_gid(order_gid_value)
        remaining = refund_amount
        transactions = []
        for payment in self.refundable_payments(details.get("transactions") or []):
            if remaining <= 0.0049:
                break
            portion = round(min(remaining, payment["available"]), 2)
            transactions.append({"orderId": gid, "parentId": payment["id"], "kind": "REFUND",
                                 "gateway": payment["gateway"], "amount": f"{portion:.2f}"})
            remaining = round(remaining - portion, 2)
        if not transactions or remaining > 0.01:
            available = round(refund_amount - remaining, 2) if transactions else 0.0
            raise ShopifyUserError(
                f"Only {available:.2f} refundable on original payments",
                user_message=(f"Only ₹{available:.2f} can be refunded to the original payment method(s) of this order."
                              if available > 0 else "No refundable original payment was found on this order."))
        refund_input: Dict[str, Any] = {"orderId": gid, "transactions": transactions,
                                        "notify": True if notify is None else bool(notify)}
        if note:
            refund_input["note"] = note[:1000]
        result = self._make_graphql_request(REFUND_CREATE, {"input": refund_input})
        refund = check_user_errors(result.get("refundCreate"), "refundCreate").get("refund")
        if not refund:
            raise ShopifyTimeout("refundCreate returned no refund")
        return refund

    def refund_to_store_credit(self, order_gid_value: str, refund_amount: Union[str, float], currency_code: str,
                               notify: Optional[bool] = None, note: Optional[str] = None,
                               refund_line_items: Optional[List[Dict]] = None) -> Dict:
        """Shopify-native store credit refund (``refundMethods.storeCreditRefund``):
        credits the customer AND records a real Refund on the order."""
        amount = round(float(refund_amount) + 1e-9, 2)
        refund_input: Dict[str, Any] = {
            "orderId": order_gid(order_gid_value),
            "transactions": [],
            "refundMethods": [{"storeCreditRefund": {"amount": {"amount": f"{amount:.2f}",
                                                                "currencyCode": currency_code or "INR"}}}],
            "notify": True if notify is None else bool(notify),
        }
        if refund_line_items:
            refund_input["refundLineItems"] = refund_line_items
        if note:
            refund_input["note"] = note[:1000]
        result = self._make_graphql_request(REFUND_CREATE, {"input": refund_input})
        refund = check_user_errors(result.get("refundCreate"), "refundCreate").get("refund")
        if not refund:
            raise ShopifyTimeout("refundCreate returned no refund")
        return refund

    def create_gift_card(self, initial_value: Union[str, float], customer_id: Optional[str] = None,
                         note: Optional[str] = None) -> Dict:
        """giftCardCreate. Returns the gift card incl. ``code`` (full code)."""
        value = f"{round(float(initial_value) + 1e-9, 2):.2f}"
        gift_input: Dict[str, Any] = {"initialValue": value}
        if customer_id:
            gift_input["customerId"] = customer_id
        if note:
            gift_input["note"] = note[:500]
        result = self._make_graphql_request(GIFT_CARD_CREATE, {"input": gift_input})
        payload = check_user_errors(result.get("giftCardCreate"), "giftCardCreate")
        gift_card = dict(payload.get("giftCard") or {})
        if not gift_card.get("id"):
            raise ShopifyTimeout("giftCardCreate returned no gift card")
        if payload.get("giftCardCode"):
            gift_card["code"] = payload["giftCardCode"]
        return gift_card

    def get_store_credit_balance(self, customer_id: str) -> Optional[Dict]:
        """Best-effort current store credit balance (None on any failure)."""
        try:
            result = self._make_graphql_request(STORE_CREDIT_BALANCE, {"customerId": customer_id})
            accounts = ((result.get("customer") or {}).get("storeCreditAccounts") or {}).get("nodes") or []
            return accounts[0].get("balance") if accounts else None
        except ShopifyError as e:
            logger.warning(f"Could not fetch store credit balance: {type(e).__name__}")
            return None

    def record_offline_refund(self, order_gid_value: str, refund_amount: Union[str, float], method_label: str,
                              note: Optional[str] = None,
                              refund_line_items: Optional[List[Dict]] = None) -> Dict[str, Any]:
        """Bookkeeping-only refund for money already given outside the order's
        payments (gift card, cash, bank transfer) so Shopify stops showing
        "refund owed".

        Money safety: the transaction uses the offline ``manual`` gateway and
        **never** a ``parentId`` -- a parent pointing at a real captured payment
        is how Shopify decides to refund through the payment processor, which
        would pay the customer a second time. If Shopify refuses a parent-less
        offline refund, the bookkeeping step is skipped (the customer has
        already been compensated) and the caller gets ``recorded: False`` plus
        a warning to settle the balance manually in Shopify admin.

        Never raises. Returns ``{recorded: True|False|None, refundId?, warning?}``
        (None = Shopify timed out; the bookkeeping state is unknown).
        """
        amount = round(float(refund_amount) + 1e-9, 2)
        gid = order_gid(order_gid_value)
        label = (method_label or "offline").replace("_", " ")
        refund_input: Dict[str, Any] = {
            "orderId": gid,
            "transactions": [{"orderId": gid, "kind": "REFUND", "gateway": OFFLINE_REFUND_GATEWAY,
                              "amount": f"{amount:.2f}"}],
            "notify": False,
            "note": ((note or "").strip() + f"\nSettled outside Shopify via {label} (bookkeeping entry, no payment processed).").strip()[:1000],
        }
        if refund_line_items:
            refund_input["refundLineItems"] = refund_line_items
        try:
            result = self._make_graphql_request(REFUND_CREATE, {"input": refund_input})
            refund = check_user_errors(result.get("refundCreate"), "refundCreate").get("refund") or {}
            return {"recorded": True, "refundId": refund.get("id")}
        except ShopifyTimeout:
            logger.warning(f"Offline bookkeeping refund on order {numeric_id(gid)} timed out; state unknown")
            return {"recorded": None, "warning": "Shopify did not confirm the bookkeeping entry; check the order's balance in Shopify."}
        except ShopifyError as e:
            logger.warning(f"Offline bookkeeping refund skipped on order {numeric_id(gid)}: {type(e).__name__}")
            return {"recorded": False,
                    "warning": "Shopify still shows a refund owed on this order; mark it as refunded manually in Shopify admin."}

    def cancel_shopify_order(self, order_id: Any, staff_note: Optional[str] = None) -> Dict[str, Any]:
        """orderCancel with refund=false, restock=false, notifyCustomer=false,
        reason OTHER. Never raises; returns ``{requested, jobId?, error?}``."""
        gid = order_gid(order_id)
        try:
            result = self._make_graphql_request(ORDER_CANCEL, {
                "orderId": gid, "reason": "OTHER", "refund": False, "restock": False,
                "notifyCustomer": False, "staffNote": (staff_note or "Full return refunded via Re-Guard")[:255],
            })
            payload = check_user_errors(result.get("orderCancel"), "orderCancel",
                                        keys=("orderCancelUserErrors", "userErrors"))
            job = payload.get("job") or {}
            logger.info(f"Order {numeric_id(gid)} cancellation requested (job {numeric_id(job.get('id'))})")
            return {"requested": True, "jobId": job.get("id")}
        except ShopifyTimeout:
            return {"requested": None, "error": "Shopify did not confirm the cancellation; check the order."}
        except ShopifyError as e:
            return {"requested": False, "error": e.user_message}

    def process_refund(self, order_gid_value: str, amount: Union[str, float], refund_method: RefundMethod,
                       line_item_refunds: List[Dict], note: str, notify_customer: bool,
                       order_details: Optional[Dict] = None) -> RefundOutcome:
        """Shopify side of a gift-card or store-credit refund (no Firestore).

        Raises ShopifyError / ShopifyTimeout / ValueError on failure.
        """
        details = order_details or self.get_order_details(order_gid_value)
        customer = details.get("customer") or {}
        currency = ((details.get("totalPriceSet") or {}).get("shopMoney") or {}).get("currencyCode") or "INR"
        amount_value = round(float(amount) + 1e-9, 2)
        refund_line_items = to_refund_line_items(line_item_refunds)
        outcome = RefundOutcome(method=refund_method, amount=amount_value, currency=currency,
                                customer_email=details.get("email") or customer.get("email"),
                                order_name=details.get("name"))

        if refund_method == RefundMethod.GIFT_CARD:
            if not customer.get("id"):
                raise ShopifyUserError("No customer on order", user_message="This order has no customer, so a gift card cannot be issued.")
            gift_card = self.create_gift_card(amount_value, customer["id"], note)
            code = gift_card.get("code") or ""
            outcome.refund_id = gift_card.get("id")
            outcome.gift_card_id = gift_card.get("id")
            outcome.gift_card_code = code or None
            outcome.gift_card_last4 = (gift_card.get("lastCharacters") or code[-4:] or None)
            outcome.gift_card_expires_on = gift_card.get("expiresOn")
            outcome.gateway = "gift_card"
            bookkeeping = self.record_offline_refund(order_gid_value, amount_value, "gift card",
                                                     note=note, refund_line_items=refund_line_items)
            outcome.shopify_ledger_recorded = bookkeeping.get("recorded")
            outcome.shopify_ledger_warning = bookkeeping.get("warning")
        elif refund_method == RefundMethod.STORE_CREDIT:
            if not customer.get("id"):
                raise ShopifyUserError("No customer on order", user_message="This order has no customer, so store credit cannot be issued.")
            refund = self.refund_to_store_credit(order_gid_value, amount_value, currency, notify=notify_customer,
                                                 note=note, refund_line_items=refund_line_items)
            outcome.refund_id = refund.get("id")
            outcome.gateway = "store_credit"
            outcome.account_balance = self.get_store_credit_balance(customer["id"])
        else:
            raise ValueError(f"Unsupported refund method for process_refund: {refund_method.value}")
        return outcome

    def update_firebase_with_refund(self, outcome: RefundOutcome, *, return_ref, metadata: Dict[str, Any],
                                    agent: Dict[str, Any], ledger_id: Optional[str] = None,
                                    extra_details: Optional[Dict[str, Any]] = None) -> None:
        """Mark the return refunded (fields the UI reads) + add an activity.

        Refuses (ValueError) unless the refund succeeded; raises on Firestore
        failure after one retry -- the caller decides how to report it.
        """
        from firebase_admin import firestore  # local: keep module import-light
        if outcome is None or not outcome.success:
            raise ValueError("Refusing to mark a return refunded: the refund did not succeed")
        metadata = metadata or {}
        is_full = bool(metadata.get("isFullReturn"))
        return_type = "Full Return" if is_full else "Partial Return"
        details = {
            "method": outcome.method.value,
            "finalAmount": outcome.amount,
            "shopifyRefundId": outcome.refund_id or outcome.transaction_id,
            "transactionId": outcome.transaction_id,
            # Never the full gift-card code: return docs are staff-readable (review M3).
            "giftCardLast4": outcome.gift_card_last4,
            "giftCardMasked": _masked_gift_card(outcome),
            "transactions": outcome.transactions or [],
            "returnType": return_type,
            "expectedFulfillment": "Unfulfilled" if is_full else "Partially Fulfilled",
            "isFullReturn": is_full,
            "baseAmount": metadata.get("baseAmount", 0),
            "shippingRefundAddition": metadata.get("shippingRefundAddition", 0),
            "deductions": metadata.get("deductions") if isinstance(metadata.get("deductions"), dict) else {},
            "quantityMultiplied": metadata.get("quantityMultiplied") if isinstance(metadata.get("quantityMultiplied"), dict) else {},
            "note": metadata.get("note"),
            "ledgerId": ledger_id,
            "shopifyLedgerRecorded": outcome.shopify_ledger_recorded,
        }
        details.update(extra_details or {})
        refunded_by = {"name": agent.get("name"), "email": agent.get("email")}
        update = {
            "refundStatus": "Refunded",
            "status": "completed",
            "updatedAt": firestore.SERVER_TIMESTAMP,
            "refundDetails": details,
            "refundMethod": outcome.method.value,
            "refundAmount": outcome.amount,
            "refundCompletedAt": firestore.SERVER_TIMESTAMP,
            "refundedAt": firestore.SERVER_TIMESTAMP,
            "shopifyRefundId": outcome.refund_id,
            "returnType": return_type,
            "refundedBy": refunded_by,
            "refundLedgerId": ledger_id,
            "needsRefund": False,
        }
        if outcome.gift_card_code or outcome.gift_card_last4:
            update["giftCardLast4"] = outcome.gift_card_last4 or (outcome.gift_card_code or "")[-4:]
            update["giftCardMasked"] = _masked_gift_card(outcome)
            if outcome.gift_card_expires_on:
                update["giftCardExpiresOn"] = outcome.gift_card_expires_on
        last_error: Optional[Exception] = None
        for _ in range(2):
            try:
                return_ref.update(update)
                last_error = None
                break
            except Exception as e:  # Firestore client raises many types
                last_error = e
                logger.error(f"Refund doc update failed for {getattr(return_ref, 'id', '?')}: {type(e).__name__}")
        if last_error is not None:
            raise last_error
        try:
            method_text = {"giftcard": "gift card", "store_credit": "store credit",
                           "original": "original payment method", "manual": "manual refund"}.get(outcome.method.value, outcome.method.value)
            return_ref.collection("activities").add({
                "type": "success",
                "title": "Refund Issued",
                "description": f"Refund of ₹{outcome.amount:.2f} issued via {method_text} ({return_type})",
                "timestamp": firestore.SERVER_TIMESTAMP,
                "user": refunded_by["name"],
                "userEmail": refunded_by["email"],
                "metadata": {"refundMethod": outcome.method.value, "amount": outcome.amount,
                             "refundId": outcome.refund_id, "ledgerId": ledger_id},
            })
        except Exception as e:
            logger.error(f"Refund activity write failed for {getattr(return_ref, 'id', '?')}: {type(e).__name__}")


def _masked_gift_card(outcome: RefundOutcome) -> Optional[str]:
    tail = (outcome.gift_card_last4 or (outcome.gift_card_code or "")[-4:] or "").strip()
    return f"•••• •••• •••• {tail}" if tail else None


def to_refund_line_items(line_items: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Frontend ``[{lineItemId, quantity}]`` -> RefundLineItemInput with NO_RESTOCK
    (restocking is handled by the restock endpoint / returnProcess)."""
    out = []
    for item in line_items or []:
        if not isinstance(item, dict):
            continue
        lid = numeric_id(item.get("lineItemId"))
        try:
            qty = int(item.get("quantity") or 0)
        except (TypeError, ValueError):
            qty = 0
        if lid.isdigit() and qty > 0:
            out.append({"lineItemId": f"gid://shopify/LineItem/{lid}", "quantity": qty, "restockType": "NO_RESTOCK"})
    return out


# ==========================================================
# SINGLETON
# ==========================================================
_service: Optional[ShopifyService] = None
_service_lock = threading.Lock()


def get_shopify_service() -> ShopifyService:
    """Process-wide ShopifyService (one pooled HTTP session).

    Raises ShopifyNotConfigured when the shop domain / token / API version is
    missing or invalid.
    """
    global _service
    if _service is None:
        with _service_lock:
            if _service is None:
                _service = ShopifyService(core.SHOPIFY_STORE, core.SHOPIFY_ACCESS_TOKEN, core.SHOPIFY_API_VERSION)
    return _service


# ==========================================================
# ORDER LOOKUP (used by routes_orders / routes_public)
# ==========================================================
VERIFY_ORDER_QUERY = """
query VerifyOrderByName($searchQuery: String!) {
  orders(first: 1, query: $searchQuery) {
    nodes {
      legacyResourceId
      name
      email
      phone
      displayFulfillmentStatus
      displayFinancialStatus
      tags
      createdAt
      currencyCode
      totalPriceSet { shopMoney { amount } }
      customer { firstName lastName displayName email phone }
      shippingAddress { address1 address2 city province provinceCode zip country phone firstName lastName }
      fulfillments(first: 10) { deliveredAt }
      lineItems(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id
          name
          quantity
          sku
          variant { title }
          originalUnitPriceSet { shopMoney { amount } }
          product { legacyResourceId tags featuredImage { url } }
        }
      }
    }
  }
}
"""


def _gid_to_numeric_id(gid: Optional[str]) -> Optional[int]:
    """gid://shopify/LineItem/123456789 -> 123456789."""
    try:
        return int(numeric_id(gid)) if gid else None
    except ValueError:
        return None


def fetch_order_by_name_graphql(order_name: str) -> Optional[Dict[str, Any]]:
    """Order + line items + product images/tags + delivery date in ONE GraphQL
    call, reshaped into the REST-like dict the customer page expects.
    Returns None when no order has exactly this name; raises ShopifyError."""
    result = get_shopify_service()._make_graphql_request(
        VERIFY_ORDER_QUERY, {"searchQuery": f"name:'{order_name}'"})
    nodes = (result.get("orders") or {}).get("nodes") or []
    node = next((o for o in nodes if o.get("name") == order_name), None)
    if not node:
        return None

    delivered_at = next((f.get("deliveredAt") for f in node.get("fulfillments") or [] if f.get("deliveredAt")), None)
    connection = node.get("lineItems") or {}
    if (connection.get("pageInfo") or {}).get("hasNextPage"):
        logger.warning(f"Order {numeric_id(node.get('legacyResourceId'))} has more than 100 line items; list truncated")

    line_items = []
    product_details: Dict[str, Any] = {}
    for li in connection.get("nodes") or []:
        variant = li.get("variant") or {}
        product = li.get("product") or {}
        legacy_product_id = product.get("legacyResourceId")
        line_items.append({
            "id": _gid_to_numeric_id(li.get("id")),
            "title": li.get("name"),
            "quantity": li.get("quantity"),
            "price": ((li.get("originalUnitPriceSet") or {}).get("shopMoney") or {}).get("amount", "0.00"),
            "sku": li.get("sku"),
            "variant_title": variant.get("title"),
            "product_id": legacy_product_id,
        })
        if legacy_product_id:
            product_details[str(legacy_product_id)] = {
                "image": (product.get("featuredImage") or {}).get("url"),
                "tags": product.get("tags", []),
            }

    customer = node.get("customer") or {}
    shipping = node.get("shippingAddress") or {}
    return {
        "id": node.get("legacyResourceId"),
        "name": node.get("name"),
        "email": node.get("email"),
        "phone": node.get("phone"),
        "tags": ", ".join(node.get("tags") or []),
        "currency": node.get("currencyCode"),
        "total_price": ((node.get("totalPriceSet") or {}).get("shopMoney") or {}).get("amount"),
        "created_at": node.get("createdAt"),
        "delivered_at": delivered_at,
        "financial_status": (node.get("displayFinancialStatus") or "").lower(),
        "fulfillment_status": (node.get("displayFulfillmentStatus") or "").lower(),
        "line_items": line_items,
        "customer": {
            "first_name": customer.get("firstName"),
            "last_name": customer.get("lastName"),
            "name": customer.get("displayName"),
            "email": customer.get("email"),
            "phone": customer.get("phone"),
        },
        "shipping_address": {
            "address1": shipping.get("address1"),
            "address2": shipping.get("address2"),
            "city": shipping.get("city"),
            "province": shipping.get("province"),
            "province_code": shipping.get("provinceCode"),
            "zip": shipping.get("zip"),
            "country": shipping.get("country"),
            "phone": shipping.get("phone"),
            "first_name": shipping.get("firstName"),
            "last_name": shipping.get("lastName"),
        },
        "product_details": product_details,
    }


def find_customer_by_identifier(identifier: str, identifier_type: str) -> Optional[Dict]:
    """Shopify customer by exact e-mail, or by phone (last 10 digits)."""
    try:
        service = get_shopify_service()
        if identifier_type == "email":
            result = service._make_graphql_request("""
            query GetCustomerByEmail($identifier: CustomerIdentifierInput!) {
              customer: customerByIdentifier(identifier: $identifier) {
                id legacyResourceId email firstName lastName phone
              }
            }""", {"identifier": {"emailAddress": identifier}})
            return result.get("customer") or None
        clean_phone = re.sub(r"\D", "", identifier or "")[-10:]
        if len(clean_phone) < 10:
            return None
        result = service._make_graphql_request("""
        query GetCustomerByPhone($query: String!) {
          customers(first: 5, query: $query) {
            edges { node { id legacyResourceId email firstName lastName phone } }
          }
        }""", {"query": f"phone:*{clean_phone}*"})
        for node in _edges(result.get("customers")):
            if re.sub(r"\D", "", node.get("phone") or "")[-10:] == clean_phone:
                return node
        return None
    except ShopifyError as e:
        logger.error(f"Customer lookup failed: {type(e).__name__}")
        return None


def get_customer_store_credit_accounts(customer: Dict) -> List[Dict]:
    """Store credit accounts of a Shopify customer ([] on failure)."""
    customer_id = (customer or {}).get("id")
    if not customer_id:
        return []
    try:
        result = get_shopify_service()._make_graphql_request("""
        query GetStoreCreditAccounts($customerId: ID!) {
          customer(id: $customerId) {
            storeCreditAccounts(first: 10) { nodes { id balance { amount currencyCode } } }
          }
        }""", {"customerId": customer_id})
        accounts = ((result.get("customer") or {}).get("storeCreditAccounts") or {}).get("nodes") or []
        return [{"id": a["id"], "balance_amount": _amount(a.get("balance")),
                 "balance_currency": (a.get("balance") or {}).get("currencyCode")} for a in accounts]
    except (ShopifyError, KeyError) as e:
        logger.error(f"Store credit lookup failed: {type(e).__name__}")
        return []


def get_customer_gift_cards(customer: Dict) -> List[Dict]:
    """Enabled gift cards of a Shopify customer (masked codes only; [] on failure)."""
    legacy_id = (customer or {}).get("legacyResourceId")
    if not legacy_id:
        return []
    try:
        result = get_shopify_service()._make_graphql_request("""
        query GetCustomerGiftCards($query: String!) {
          giftCards(first: 50, query: $query) {
            edges { node { id balance { amount currencyCode } maskedCode lastCharacters expiresOn customer { id } } }
          }
        }""", {"query": f"customer_id:{legacy_id} status:enabled"})
        return [{
            "id": gc["id"],
            "balance_amount": _amount(gc.get("balance")),
            "balance_currency": (gc.get("balance") or {}).get("currencyCode"),
            "code": gc.get("maskedCode"),
            "last4": gc.get("lastCharacters"),
            "expires_on": gc.get("expiresOn"),
            "customer_id": (gc.get("customer") or {}).get("id"),
        } for gc in _edges(result.get("giftCards"))]
    except (ShopifyError, KeyError) as e:
        logger.error(f"Gift card lookup failed: {type(e).__name__}")
        return []

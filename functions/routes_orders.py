"""
Order / product / customer helper routes used by the agent UI, the image
download proxy, Shopify webhook setup and the (public, HMAC-verified)
Shopify orders/paid webhook.
"""
import io
import os
import re
import urllib.parse
import zipfile
from typing import Any, Dict, List, Optional, Tuple

import requests
from flask import Blueprint, Response, jsonify, request

from core import (PUBLIC_APP_URL, SHOPIFY_BASE_URL, WEBHOOK_CALLBACK_PATH, ShopifyError, _is_allowed_download_url,
                  _safe_filename, db, is_valid_email, logger, normalize_phone, shopify_add_tag, shopify_configured,
                  shopify_graphql, shopify_headers, shopify_timeline_note, verify_order_ownership,
                  verify_shopify_webhook)
from routes_exchange import HoldReleaseError, _reconcile_and_release_hold
from security import client_ip, error_response, json_body, public_endpoint, rate_limited, require_staff

bp = Blueprint('orders', __name__)

MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024
MAX_ZIP_IMAGES = 50
MAX_ZIP_TOTAL_BYTES = 120 * 1024 * 1024
UPSTREAM_ERROR = "The store didn't respond as expected. Please try again."
PRODUCT_FIELDS = 'id,title,handle,product_type,tags,status,variants,options,images'


class DownloadError(Exception):
    pass


# ==========================================================
# DOWNLOAD PROXY (SSRF-safe)
# ==========================================================
def fetch_capped(url: str, cap: int = MAX_DOWNLOAD_BYTES) -> Tuple[bytes, str]:
    """Fetch an allow-listed https URL without following redirects, streaming
    with a hard size cap. Raises DownloadError."""
    if not isinstance(url, str) or len(url) > 4096:
        raise DownloadError("invalid url")
    parsed = urllib.parse.urlparse(url)
    if not _is_allowed_download_url(parsed):
        raise DownloadError("host not allowed")
    try:
        with requests.get(url, timeout=(5, 20), stream=True, allow_redirects=False) as resp:
            if resp.status_code != 200:
                raise DownloadError(f"upstream status {resp.status_code}")
            declared = resp.headers.get('Content-Length')
            if declared and declared.isdigit() and int(declared) > cap:
                raise DownloadError("file too large")
            buf = bytearray()
            for chunk in resp.iter_content(chunk_size=64 * 1024):
                buf.extend(chunk)
                if len(buf) > cap:
                    raise DownloadError("file too large")
            content_type = (resp.headers.get('Content-Type') or '').split(';')[0].strip().lower()
    except requests.RequestException as e:
        raise DownloadError(type(e).__name__) from e
    return bytes(buf), content_type if content_type.startswith('image/') else 'application/octet-stream'


def _attachment(data: bytes, mimetype: str, filename: str) -> Response:
    return Response(data, mimetype=mimetype, headers={
        'Content-Disposition': f'attachment; filename="{filename}"',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
    })


@bp.route('/api/download/image', methods=['GET'])
@require_staff()
def download_image():
    """Proxy-download one allow-listed image so the browser saves it (cross-origin
    links ignore the ``download`` attribute)."""
    image_url = request.args.get('url', '')
    filename = _safe_filename(request.args.get('filename', ''), 'image.jpg')
    if not image_url:
        return error_response('Missing url parameter', 400)
    try:
        data, mimetype = fetch_capped(image_url)
    except DownloadError as e:
        logger.warning(f"Image download refused/failed: {e}")
        return error_response('This image could not be downloaded.', 400 if 'allowed' in str(e) else 502)
    return _attachment(data, mimetype, filename)


@bp.route('/api/download/images-zip', methods=['POST'])
@require_staff()
def download_images_zip():
    """Bundle up to 50 allow-listed images into one ZIP."""
    data = json_body()
    images = data.get('images')
    zip_filename = _safe_filename(data.get('zipFilename', ''), 'images')
    if not isinstance(images, list) or not images:
        return error_response('No images provided', 400)
    if len(images) > MAX_ZIP_IMAGES:
        return error_response(f'At most {MAX_ZIP_IMAGES} images can be zipped at once.', 400)
    mem_zip = io.BytesIO()
    used_names, fetched, total = set(), 0, 0
    with zipfile.ZipFile(mem_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
        for idx, img in enumerate(images):
            url = (img or {}).get('url') if isinstance(img, dict) else None
            if not url:
                continue
            try:
                content, _ = fetch_capped(url)
            except DownloadError as e:
                logger.warning(f"Skipping zip image {idx + 1}: {e}")
                continue
            total += len(content)
            if total > MAX_ZIP_TOTAL_BYTES:
                logger.warning("Zip size cap reached; remaining images skipped")
                break
            name = _safe_filename(img.get('filename', ''), f'image_{idx + 1}.jpg')
            base, ext = os.path.splitext(name)
            final_name, counter = name, 1
            while final_name in used_names:
                final_name = f"{base}_{counter}{ext}"
                counter += 1
            used_names.add(final_name)
            zf.writestr(final_name, content)
            fetched += 1
    if fetched == 0:
        return error_response('Failed to fetch any of the requested images', 502)
    return _attachment(mem_zip.getvalue(), 'application/zip', f"{zip_filename}.zip")


# ==========================================================
# ORDERS
# ==========================================================


@bp.route(WEBHOOK_CALLBACK_PATH, methods=['POST'])
@public_endpoint("Shopify HMAC-verified webhook")
def shopify_orders_paid_webhook():
    """orders/paid: release exchange fulfilment holds once the customer paid.
    Non-2xx on processing failure so Shopify retries."""
    if not verify_shopify_webhook(request):
        logger.warning(f"Rejected orders/paid webhook with invalid signature from {client_ip()}")
        return error_response('Invalid webhook signature', 401)
    payload = request.get_json(silent=True) or {}
    numeric_order_id = payload.get('id')
    if not numeric_order_id:
        return jsonify({'success': True, 'ignored': True}), 200
    if not db:
        return error_response('Service unavailable', 503)
    try:
        # Release only after Shopify itself confirms the balance is paid: an
        # orders/paid event can precede the exchange balance being settled.
        result = _reconcile_and_release_hold(numeric_order_id, require_balance_check=True, source='webhook')
        released = (result or {}).get('released') or []
        logger.info(f"orders/paid webhook: released {len(released)} hold(s) for order {numeric_order_id}")
        return jsonify({'success': True, 'releasedFulfillmentOrders': released,
                        'outstandingBalance': (result or {}).get('outstandingBalance')}), 200
    except HoldReleaseError as e:
        logger.error(f"orders/paid webhook: holds not released for {numeric_order_id}: {e}")
        return error_response('Hold release failed; please retry', 503)
    except Exception as e:
        logger.error(f"orders/paid webhook processing failed for {numeric_order_id}: {type(e).__name__}: {e}")
        return error_response('Processing failed', 500)


@bp.route('/api/orders/<int:order_id>/order-note', methods=['POST'])
@require_staff()
def update_order_note(order_id):
    """Add an entry to the Shopify order timeline (note overwrite + restore)."""
    data = json_body()
    event_title = str(data.get('eventTitle') or 'Update')[:200]
    message = str(data.get('message') or '')[:4000]
    ran = str(data.get('ran') or 'Unknown')[:64]
    if shopify_timeline_note(order_id, ran, event_title, message):
        return jsonify({'success': True})
    return error_response('Failed to update the Shopify timeline', 502)


@bp.route('/api/orders/<int:order_id>/tags', methods=['POST'])
@require_staff()
def add_order_tag(order_id):
    """Append a tag to a Shopify order without overwriting existing tags."""
    tag = json_body().get('tag')
    if not isinstance(tag, str) or not tag.strip() or ',' in tag or len(tag) > 255:
        return error_response('A single tag (no commas, max 255 characters) is required', 400)
    if shopify_add_tag(order_id, tag.strip()):
        return jsonify({'success': True, 'tag': tag.strip()})
    return error_response('Failed to update Shopify tags', 502)


def _exact_phone_customers(phone10: str) -> List[Dict[str, Any]]:
    """Shopify customers whose phone's last 10 digits equal ``phone10``."""
    data = shopify_graphql("""
        query($q: String!) { customers(first: 10, query: $q) {
          nodes { id legacyResourceId email phone
                  storeCreditAccounts(first: 5) { nodes { id balance { amount currencyCode } } } } } }
    """, {'q': f"phone:*{phone10}*"})
    nodes = ((data.get('customers') or {}).get('nodes')) or []
    return [n for n in nodes if normalize_phone(n.get('phone')) == phone10]


def parse_identifier(raw: Any) -> Tuple[Optional[str], Optional[str]]:
    """('email', value) | ('phone', last10) | (None, None)."""
    if not isinstance(raw, str):
        return None, None
    value = raw.strip()
    if '@' in value:
        return ('email', value) if is_valid_email(value) else (None, None)
    digits = re.sub(r'\D', '', value)
    return ('phone', digits[-10:]) if len(digits) >= 10 else (None, None)


@bp.route('/api/orders/customer', methods=['POST'])
@require_staff()
def fetch_customer_orders():
    """Fulfilled orders of a customer identified by exact e-mail or phone."""
    kind, value = parse_identifier(json_body().get('identifier'))
    if not kind:
        return error_response('Provide a valid email or a phone number with at least 10 digits', 400)
    params = {'status': 'any', 'limit': 250,
              'fields': 'id,name,email,phone,customer,line_items,fulfillment_status,created_at,shipping_address,'
                        'tags,currency,order_number,total_price,shipping_lines'}
    try:
        if kind == 'email':
            params['email'] = value
        else:
            customers = _exact_phone_customers(value)
            if not customers:
                return jsonify({'success': True, 'orders': []})
            params['customer_id'] = customers[0].get('legacyResourceId')
        response = requests.get(f"{SHOPIFY_BASE_URL}/orders.json", headers=shopify_headers(), params=params, timeout=15)
        if response.status_code != 200:
            logger.error(f"Customer orders fetch returned HTTP {response.status_code}")
            return error_response(UPSTREAM_ERROR, 502)
        orders = response.json().get('orders', [])
    except (ShopifyError, requests.RequestException, ValueError) as e:
        logger.error(f"Customer orders fetch failed: {type(e).__name__}")
        return error_response(UPSTREAM_ERROR, 502)
    filtered = [o for o in orders if o.get('fulfillment_status') == 'fulfilled' and verify_order_ownership(o, value)]
    return jsonify({'success': True, 'orders': filtered})


@bp.route('/api/orders/<order_name>', methods=['GET'])
@require_staff()
def get_shopify_order(order_name):
    """Shopify order (REST shape) by exact name."""
    if not re.fullmatch(r'#?[A-Za-z0-9\-]{1,40}', order_name or ''):
        return error_response('Invalid order name', 400)
    try:
        response = requests.get(f"{SHOPIFY_BASE_URL}/orders.json", headers=shopify_headers(),
                                params={'name': order_name, 'status': 'any'}, timeout=10)
        if response.status_code != 200:
            return error_response(UPSTREAM_ERROR, 502)
        orders = response.json().get('orders', [])
    except (requests.RequestException, ValueError) as e:
        logger.error(f"Order fetch failed: {type(e).__name__}")
        return error_response(UPSTREAM_ERROR, 502)
    order = next((o for o in orders if o.get('name') == order_name), None)
    if not order:
        return error_response('Order not found', 404)
    return jsonify({'success': True, 'order': order})


# ==========================================================
# PRODUCTS
# ==========================================================
def _normalize_tags(tags: Any) -> List[str]:
    if isinstance(tags, str):
        return [t.strip().lower() for t in tags.split(',') if t.strip()]
    if isinstance(tags, list):
        return [str(t).strip().lower() for t in tags]
    return []


@bp.route('/api/products/<int:product_id>', methods=['GET'])
@public_endpoint("Product image + tags for the customer portal (no PII); rate limited per IP")
def get_product_details(product_id):
    """{image, tags} of a product."""
    limited = rate_limited(['product-details', client_ip()], 600, 3600)
    if limited:
        return limited
    try:
        response = requests.get(f"{SHOPIFY_BASE_URL}/products/{product_id}.json", headers=shopify_headers(),
                                params={'fields': 'id,image,tags'}, timeout=10)
        if response.status_code != 200:
            return jsonify({'image': None, 'tags': []})
        product = response.json().get('product', {}) or {}
    except (requests.RequestException, ValueError) as e:
        logger.error(f"Product details fetch failed: {type(e).__name__}")
        return jsonify({'image': None, 'tags': []}), 502
    return jsonify({'image': (product.get('image') or {}).get('src'), 'tags': _normalize_tags(product.get('tags'))})


def shape_product(product: Dict[str, Any]) -> Dict[str, Any]:
    """Variants (with availability) and images (variant-specific first)."""
    variants = []
    for v in product.get('variants', []) or []:
        qty = v.get('inventory_quantity', 0) or 0
        policy = v.get('inventory_policy', 'deny')
        variants.append({
            'id': v.get('id'), 'title': v.get('title'), 'sku': v.get('sku') or '', 'price': v.get('price'),
            'compare_at_price': v.get('compare_at_price'), 'inventory_quantity': qty, 'inventory_policy': policy,
            'available': qty > 0 or policy == 'continue', 'option1': v.get('option1'), 'option2': v.get('option2'),
            'option3': v.get('option3'), 'image_id': v.get('image_id'), 'weight': v.get('weight'),
            'weight_unit': v.get('weight_unit'),
        })
    images = [{'id': i.get('id'), 'src': i.get('src'), 'alt': i.get('alt'), 'variant_ids': i.get('variant_ids', []) or [],
               'position': i.get('position', 0)} for i in product.get('images', []) or []]
    images.sort(key=lambda x: (len(x['variant_ids']) == 0, x['position'] or 0))
    return {'id': product.get('id'), 'title': product.get('title'), 'handle': product.get('handle'),
            'product_type': product.get('product_type'), 'tags': product.get('tags'), 'status': product.get('status'),
            'variants': variants, 'options': product.get('options', []), 'images': images}


def _fetch_product(product_id: Any):
    response = requests.get(f"{SHOPIFY_BASE_URL}/products/{product_id}.json", headers=shopify_headers(),
                            params={'fields': PRODUCT_FIELDS}, timeout=10)
    if response.status_code == 404:
        return None, 404
    if response.status_code != 200:
        logger.error(f"Shopify returned HTTP {response.status_code} for product {product_id}")
        return None, 502
    product = response.json().get('product') or {}
    return (product, 200) if product else (None, 404)


@bp.route('/api/products/<int:product_id>/variants', methods=['GET'])
@require_staff()
def get_product_variants(product_id):
    """Full product with variants/options/images (Exchange modal)."""
    try:
        product, status = _fetch_product(product_id)
    except requests.Timeout:
        return error_response('Request timed out', 504)
    except (requests.RequestException, ValueError) as e:
        logger.error(f"Product variants fetch failed for {product_id}: {type(e).__name__}")
        return error_response(UPSTREAM_ERROR, 502)
    if status != 200:
        return error_response('Product not found' if status == 404 else UPSTREAM_ERROR, status)
    return jsonify({'success': True, 'product': shape_product(product)})


SEARCH_PRODUCTS_QUERY = """
query FindProductByTerm($query: String!) {
  products(first: 10, query: $query) {
    edges { node { legacyResourceId title variants(first: 50) { edges { node { sku } } } } }
  }
}
"""


def pick_product_id(edges: List[Dict[str, Any]], term: str) -> Optional[str]:
    """Exact SKU match, then title contains, then Shopify's first result."""
    t = term.lower()
    for e in edges:
        node = e.get('node') or {}
        skus = [((v.get('node') or {}).get('sku') or '').strip().lower() for v in (node.get('variants') or {}).get('edges', [])]
        if t in skus:
            return node.get('legacyResourceId')
    for e in edges:
        node = e.get('node') or {}
        if t in (node.get('title') or '').lower():
            return node.get('legacyResourceId')
    return (edges[0].get('node') or {}).get('legacyResourceId') if edges else None


@bp.route('/api/products/by-sku/<path:sku>/variants', methods=['GET', 'OPTIONS'])
@require_staff()
def get_product_variants_by_sku(sku):
    """Find a product by SKU, title or Shopify query filter (e.g. product_type:Add-Ons)."""
    term = (sku or '').strip()[:200]
    if not term:
        return error_response('Search term is required', 400)
    try:
        data = shopify_graphql(SEARCH_PRODUCTS_QUERY, {'query': term})
        edges = ((data.get('products') or {}).get('edges')) or []
        if not edges and ':' not in term:
            data = shopify_graphql(SEARCH_PRODUCTS_QUERY, {'query': f"*{term}*"})
            edges = ((data.get('products') or {}).get('edges')) or []
        product_id = pick_product_id(edges, term)
        if not product_id:
            return error_response(f'No product found matching: {term}', 404)
        product, status = _fetch_product(product_id)
    except requests.Timeout:
        return error_response('Request timed out', 504)
    except (ShopifyError, requests.RequestException, ValueError) as e:
        logger.error(f"Product search failed: {type(e).__name__}: {e}")
        return error_response(UPSTREAM_ERROR, 502)
    if status != 200:
        return error_response('Product not found' if status == 404 else UPSTREAM_ERROR, status)
    return jsonify({'success': True, 'product': shape_product(product)})


# ==========================================================
# CUSTOMER BALANCES (staff)
# ==========================================================
EMAIL_BALANCE_QUERY = """
query($email: String!) {
  customer: customerByIdentifier(identifier: {emailAddress: $email}) {
    id legacyResourceId email
    storeCreditAccounts(first: 5) { nodes { id balance { amount currencyCode } } }
  }
}
"""
GIFT_CARD_QUERY = """
query($query: String!) {
  giftCards(first: 25, query: $query) { nodes { id maskedCode balance { amount currencyCode } } }
}
"""


def _amount(node: Dict[str, Any]) -> Tuple[float, str]:
    bal = node.get('balance') or {}
    try:
        return float(bal.get('amount') or 0), bal.get('currencyCode') or 'INR'
    except (TypeError, ValueError):
        return 0.0, bal.get('currencyCode') or 'INR'


@bp.route('/api/customer/balances', methods=['POST'])
@require_staff()
def get_customer_balances():
    """Store credit + gift cards for a customer (exact e-mail or 10-digit phone)."""
    kind, value = parse_identifier(json_body().get('identifier'))
    if not kind:
        return error_response('Provide a valid email or a phone number with at least 10 digits', 400)
    if not shopify_configured():
        return error_response('Shopify is not configured', 503)
    try:
        if kind == 'email':
            customer = shopify_graphql(EMAIL_BALANCE_QUERY, {'email': value}).get('customer')
            if customer and (customer.get('email') or '').strip().lower() != value.lower():
                customer = None
        else:
            matches = _exact_phone_customers(value)
            customer = matches[0] if matches else None
        if not customer:
            return jsonify({'customer_found': False, 'store_credit_accounts': [], 'gift_cards': []}), 200
        store_credits = []
        for acc in ((customer.get('storeCreditAccounts') or {}).get('nodes')) or []:
            amount, currency = _amount(acc)
            store_credits.append({'id': acc.get('id'), 'balance_amount': amount, 'balance_currency': currency})
        gift_cards = []
        legacy_id = customer.get('legacyResourceId')
        if legacy_id:
            nodes = ((shopify_graphql(GIFT_CARD_QUERY, {'query': f"customer_id:{legacy_id} status:enabled"})
                      .get('giftCards') or {}).get('nodes')) or []
            for gc in nodes:
                amount, currency = _amount(gc)
                gift_cards.append({'id': gc.get('id'), 'code': gc.get('maskedCode'), 'balance_amount': amount,
                                   'balance_currency': currency})
    except ShopifyError as e:
        logger.error(f"Balances lookup failed: {e}")
        return error_response('Failed to process balance request', 502)
    return jsonify({
        'customer_found': True,
        'email': customer.get('email', ''),
        'customer_graphql_id': customer.get('id'),
        'customer_legacy_id': legacy_id,
        'store_credit_accounts': store_credits,
        'gift_cards': gift_cards,
    }), 200


# ==========================================================
# SHOPIFY WEBHOOK SETUP (super admin)
# ==========================================================
@bp.route('/api/setup/register-payment-webhook', methods=['POST'])
@require_staff('super_admin')
def register_payment_webhook():
    """Subscribe ORDERS_PAID to PUBLIC_APP_URL + the webhook path (body callbackUrl is ignored)."""
    if not PUBLIC_APP_URL.startswith('https://'):
        return error_response("PUBLIC_APP_URL must be the deployed app's public https URL.", 400)
    callback_url = PUBLIC_APP_URL + WEBHOOK_CALLBACK_PATH
    try:
        result = shopify_graphql("""
            mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
              webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
                webhookSubscription { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
                userErrors { field message }
              }
            }
        """, {"topic": "ORDERS_PAID", "webhookSubscription": {"callbackUrl": callback_url, "format": "JSON"}})
    except ShopifyError as e:
        logger.error(f"Registering payment webhook failed: {e}")
        return error_response(UPSTREAM_ERROR, 502)
    payload = result.get('webhookSubscriptionCreate') or {}
    errors = payload.get('userErrors') or []
    if errors:
        if any(w in (e.get('message') or '').lower() for e in errors for w in ('already', 'taken')):
            return jsonify({'success': True, 'alreadyRegistered': True, 'callbackUrl': callback_url}), 200
        return jsonify({'success': False, 'error': 'Shopify rejected the subscription', 'errors': errors}), 400
    logger.info(f"Registered ORDERS_PAID webhook -> {callback_url}")
    return jsonify({'success': True, 'webhookSubscription': payload.get('webhookSubscription')}), 200


@bp.route('/api/setup/webhooks', methods=['GET'])
@require_staff('super_admin')
def list_webhooks():
    """Webhook subscriptions registered on the shop."""
    try:
        result = shopify_graphql("""
            query { webhookSubscriptions(first: 25) { edges { node { id topic
              endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } } }
        """)
    except ShopifyError as e:
        logger.error(f"Listing webhooks failed: {e}")
        return error_response(UPSTREAM_ERROR, 502)
    edges = ((result.get('webhookSubscriptions') or {}).get('edges')) or []
    return jsonify({'success': True, 'subscriptions': [e.get('node') for e in edges]}), 200

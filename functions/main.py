"""
Re-Guard API — Flask app served as a Firebase HTTPS function.

Every /api route declares its auth mode (require_staff / require_customer /
public_endpoint); tests/test_smoke.py enforces it.
"""
import os
from datetime import datetime, timezone

from firebase_functions import https_fn, options
from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.exceptions import HTTPException

from core import PUBLIC_APP_URL, logger
from bluedart import bp as bluedart_bp
from routes_admin import bp as admin_bp
from routes_auth import bp as auth_bp
from routes_exchange import bp as exchange_bp
from routes_notifications import bp as notifications_bp
from routes_orders import bp as orders_bp
from routes_public import bp as public_bp
from routes_refunds import bp as refunds_bp
from routes_reports import bp as reports_bp

APP_VERSION = "2.0.0"
PRODUCTION_ORIGINS = ["https://prashantireturns.web.app", "https://prashantireturns.firebaseapp.com"]
DEV_ORIGINS = ["http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5173", "http://127.0.0.1:5000"]


def allowed_origins() -> list:
    """Production origins + PUBLIC_APP_URL + CORS_ORIGINS (comma separated).
    Local dev origins only outside Cloud Functions or when ALLOW_DEV_CORS=1."""
    origins = list(PRODUCTION_ORIGINS)
    if PUBLIC_APP_URL:
        origins.append(PUBLIC_APP_URL)
    origins += [o.strip().rstrip('/') for o in os.environ.get('CORS_ORIGINS', '').split(',') if o.strip()]
    running_in_cloud = bool(os.environ.get('K_SERVICE') or os.environ.get('FUNCTION_TARGET'))
    if not running_in_cloud or os.environ.get('ALLOW_DEV_CORS') == '1':
        origins += DEV_ORIGINS
    return sorted({o for o in origins if o.startswith(('https://', 'http://localhost', 'http://127.0.0.1'))})


app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 45 * 1024 * 1024
app.json.sort_keys = False
CORS(app, origins=allowed_origins(),
     allow_headers=['Authorization', 'Content-Type', 'X-Customer-Token', 'Idempotency-Key'],
     methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], max_age=600)

for blueprint in (bluedart_bp, orders_bp, exchange_bp, refunds_bp, notifications_bp, auth_bp,
                  public_bp, admin_bp, reports_bp):
    app.register_blueprint(blueprint)


@app.after_request
def security_headers(response):
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    if request.path.startswith('/api/'):
        response.headers.setdefault('Cache-Control', 'no-store')
    return response


# ==========================================================
# HEALTH CHECK
# ==========================================================
@app.route('/health', methods=['GET'])
def health_check():
    """Liveness probe (no configuration details)."""
    return jsonify({'status': 'healthy', 'service': 'reguard-api', 'version': APP_VERSION,
                    'timestamp': datetime.now(timezone.utc).isoformat()}), 200


# ==========================================================
# ERROR HANDLERS (JSON, no internals)
# ==========================================================
@app.errorhandler(413)
def payload_too_large(_error):
    return jsonify({'success': False, 'error': 'The upload is too large. Please use smaller photos.',
                    'code': 'payload_too_large'}), 413


@app.errorhandler(HTTPException)
def http_error(error: HTTPException):
    messages = {400: 'Bad request.', 401: 'Authentication required.', 403: 'Forbidden.',
                404: 'Resource not found.', 405: 'Method not allowed.', 429: 'Too many requests.'}
    status = error.code or 500
    return jsonify({'success': False, 'error': messages.get(status, error.name or 'Request failed.'),
                    'code': (error.name or 'error').lower().replace(' ', '_')}), status


@app.errorhandler(Exception)
def unhandled_error(error: Exception):
    logger.error(f"Unhandled error on {request.method} {request.path}: {type(error).__name__}: {error}")
    return jsonify({'success': False, 'error': 'Internal server error', 'code': 'internal_error'}), 500


# ==========================================================
# MAIN ENTRY POINT
# ==========================================================
# MIN_INSTANCES=1 (functions/.env) keeps one instance warm so the first request after a
# quiet period doesn't wait for a cold start (a few seconds for Python + firebase-admin).
# It is billed while idle, so it defaults to 0.
MIN_INSTANCES = max(0, int(os.environ.get('MIN_INSTANCES', '0') or 0))


@https_fn.on_request(max_instances=10, min_instances=MIN_INSTANCES, memory=options.MemoryOption.GB_1, timeout_sec=300)
def prashanti_returns_api(req: https_fn.Request) -> https_fn.Response:
    """Wraps the Flask app to be served as a Firebase Cloud Function."""
    with app.request_context(req.environ):
        return app.full_dispatch_request()

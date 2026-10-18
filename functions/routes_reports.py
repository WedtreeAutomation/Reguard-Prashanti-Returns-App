"""
Reports (CONTRACT §5): ``GET /api/reports/<type>?from=YYYY-MM-DD&to=YYYY-MM-DD``.

Dates are IST calendar days, inclusive, at most 10 years ("All time"). Every report is
built by a pure function (rows in -> columns/rows/summary out) so the logic is
unit-testable; Firestore access is limited to single-field range queries:

    refund_ledger      createdAtMs     (reports 1–4, 9)
    returns            exchangeLoggedAt (5, 9)
    returns            createdAt       (6–8)
    restock_history    restockedAt     (10, 9)
"""
import re
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from flask import Blueprint, jsonify, request
from google.cloud.firestore_v1.base_query import FieldFilter

from core import IST, db, iso_utc, logger, money, safe_int, to_datetime, utcnow
from notifications import normalize_refund_method, request_type
from security import ADMIN_ROLES, current_agent, error_response, require_staff

bp = Blueprint('reports', __name__)

MAX_RANGE_DAYS = 3660  # ~10 years: lets the UI offer an "All time" range
DEFAULT_RANGE_DAYS = 30
MAX_DOCS_PER_QUERY = 20000
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
Doc = Tuple[str, Dict[str, Any]]

LEDGER_TYPE_LABELS = {
    'gift_card': 'Gift voucher', 'store_credit': 'Store credit', 'original_payment': 'Original payment',
    'manual': 'Manual refund', 'exchange_invoice': 'Exchange invoice',
}
REQUESTED_METHOD_LABELS = {'store_credit': 'Store credit', 'gift_card': 'Gift voucher', 'refund': 'Original payment',
                           'none': '—'}
OUTCOME_LABELS = {'even': 'Even', 'refund': 'Refund due', 'extra': 'Customer to pay'}
REQUEST_TYPE_LABELS = {'return': 'Return', 'exchange': 'Exchange', 'mixed': 'Return & Exchange'}


# ==========================================================
# DATE RANGE
# ==========================================================
def parse_report_range(from_s: Optional[str], to_s: Optional[str],
                       today: Optional[date] = None) -> Tuple[date, date, datetime, datetime]:
    """IST calendar-day range -> (from, to, start_utc, end_utc_exclusive). Raises ValueError."""
    today = today or utcnow().astimezone(IST).date()
    for label, value in (('from', from_s), ('to', to_s)):
        if value and not DATE_RE.match(value):
            raise ValueError(f"'{label}' must be a date in YYYY-MM-DD format.")
    try:
        to_d = date.fromisoformat(to_s) if to_s else today
        from_d = date.fromisoformat(from_s) if from_s else to_d - timedelta(days=DEFAULT_RANGE_DAYS - 1)
    except ValueError as e:
        raise ValueError("Invalid date.") from e
    if from_d > to_d:
        raise ValueError("'from' must be on or before 'to'.")
    if (to_d - from_d).days + 1 > MAX_RANGE_DAYS:
        raise ValueError(f"The date range can be at most {MAX_RANGE_DAYS} days.")
    start = datetime.combine(from_d, time.min, tzinfo=IST).astimezone(timezone.utc)
    end = datetime.combine(to_d + timedelta(days=1), time.min, tzinfo=IST).astimezone(timezone.utc)
    return from_d, to_d, start, end


def ist_iso(value: Any) -> Optional[str]:
    dt = to_datetime(value)
    return dt.astimezone(IST).isoformat(timespec='seconds') if dt else None


def ist_date(value: Any) -> Optional[str]:
    dt = to_datetime(value)
    if dt:
        return dt.astimezone(IST).date().isoformat()
    return value if isinstance(value, str) and DATE_RE.match(value) else None


# ==========================================================
# SMALL HELPERS
# ==========================================================
def col(key: str, label: str, type_: str = 'text') -> Dict[str, str]:
    return {'key': key, 'label': label, 'type': type_}


def summary(label: str, value: Any, type_: str = 'number') -> Dict[str, Any]:
    return {'label': label, 'value': value, 'type': type_}


def items_text(items: Iterable[Dict[str, Any]], qty_key: str = 'quantity') -> str:
    parts = []
    for it in items or []:
        if isinstance(it, dict):
            parts.append(f"{it.get('title') or it.get('sku') or 'Item'} × {safe_int(it.get(qty_key), 0) or 0}")
    return '; '.join(parts)


def ledger_time(row: Dict[str, Any]) -> Optional[datetime]:
    return to_datetime(row.get('createdAtMs')) or to_datetime(row.get('createdAt'))


def _sort_desc(rows: List[Dict[str, Any]], key: str) -> List[Dict[str, Any]]:
    return sorted(rows, key=lambda r: r.get(key) or '', reverse=True)


def doc_items(doc: Dict[str, Any], include_rejected: bool = True) -> List[Dict[str, Any]]:
    rejected = {safe_int(r.get('lineItemId')) for r in (doc.get('rejectedItems') or []) if isinstance(r, dict)}
    return [i for i in (doc.get('items') or [])
            if isinstance(i, dict) and (include_rejected or safe_int(i.get('lineItemId')) not in rejected)]


def item_value(item: Dict[str, Any]) -> float:
    return money(item.get('price')) * (safe_int(item.get('quantityReturned'), 0) or 0)


class AgentDirectory:
    """Resolve agent name/email/role from the agents collection."""

    def __init__(self, agents: Iterable[Dict[str, Any]]):
        self.by_email: Dict[str, Dict[str, Any]] = {}
        self.by_name: Dict[str, Dict[str, Any]] = {}
        for a in agents:
            email = (a.get('email') or '').strip().lower()
            if email:
                self.by_email[email] = a
            if a.get('name'):
                self.by_name[str(a['name']).strip().lower()] = a

    def resolve(self, name: Any = None, email: Any = None, role: Any = None) -> Dict[str, str]:
        found = self.by_email.get(str(email or '').strip().lower()) or self.by_name.get(str(name or '').strip().lower()) or {}
        return {'name': name or found.get('name') or '', 'email': email or found.get('email') or '',
                'role': role or found.get('role') or ''}


# ==========================================================
# LEDGER REPORTS (1–4)
# ==========================================================
def _ledger_base(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        'createdAt': ist_iso(ledger_time(row)), 'RAN': row.get('RAN') or '', 'orderName': row.get('orderName') or '',
        'requestType': REQUEST_TYPE_LABELS.get(row.get('requestType'), row.get('requestType') or ''),
        'customerName': row.get('customerName') or '', 'customerEmail': row.get('customerEmail') or '',
        'customerPhone': row.get('customerPhone') or '', 'items': items_text(row.get('items')),
        'amount': money(row.get('amount')), 'agentName': row.get('agentName') or '',
        'agentEmail': row.get('agentEmail') or '', 'agentRole': row.get('agentRole') or '',
    }


CUSTOMER_COLS = [col('customerName', 'Customer name'), col('customerEmail', 'Customer email'),
                 col('customerPhone', 'Customer phone')]
AGENT_COLS = [col('agentName', 'Agent name'), col('agentEmail', 'Agent email'), col('agentRole', 'Agent role')]


def report_gift_vouchers(ledger: List[Dict[str, Any]]) -> Dict[str, Any]:
    rows = []
    for r in ledger:
        if r.get('type') != 'gift_card':
            continue
        row = _ledger_base(r)
        row.update({'giftCardLast4': r.get('giftCardLast4') or '', 'giftCardExpiresOn': ist_date(r.get('giftCardExpiresOn'))})
        rows.append(row)
    rows = _sort_desc(rows, 'createdAt')
    columns = [col('createdAt', 'Date & time', 'datetime'), col('RAN', 'RAN'), col('orderName', 'Order no.'),
               col('requestType', 'Request type'), *CUSTOMER_COLS, col('items', 'Items'),
               col('giftCardLast4', 'Gift card (last 4)'), col('giftCardExpiresOn', 'Expiry', 'date'),
               col('amount', 'Value', 'currency'), *AGENT_COLS]
    total = money(sum(r['amount'] for r in rows))
    return {'columns': columns, 'rows': rows,
            'summary': [summary('Gift vouchers issued', len(rows)), summary('Total value', total, 'currency')]}


def report_refunds(ledger: List[Dict[str, Any]]) -> Dict[str, Any]:
    rows = []
    for r in ledger:
        kind = r.get('type')
        if kind not in ('original_payment', 'manual'):
            continue
        row = _ledger_base(r)
        manual_method = (r.get('manualMethod') or '').replace('_', ' ').strip()
        row.update({
            'method': 'Original payment' if kind == 'original_payment' else f"Manual – {manual_method or 'other'}",
            'reference': r.get('gateway') or r.get('manualReference') or '',
            'transactionId': r.get('transactionId') or r.get('shopifyRefundId') or '',
            '_kind': kind,
        })
        rows.append(row)
    rows = _sort_desc(rows, 'createdAt')
    original = money(sum(r['amount'] for r in rows if r['_kind'] == 'original_payment'))
    manual = money(sum(r['amount'] for r in rows if r['_kind'] == 'manual'))
    for r in rows:
        r.pop('_kind', None)
    columns = [col('createdAt', 'Date & time', 'datetime'), col('RAN', 'RAN'), col('orderName', 'Order no.'),
               *CUSTOMER_COLS, col('method', 'Method'), col('reference', 'Gateway / Reference'),
               col('transactionId', 'Transaction ID'), col('amount', 'Value', 'currency'), *AGENT_COLS]
    return {'columns': columns, 'rows': rows, 'summary': [
        summary('Refunds', len(rows)), summary('Total refunded', money(original + manual), 'currency'),
        summary('Original payment', original, 'currency'), summary('Manual', manual, 'currency')]}


def report_store_credit(ledger: List[Dict[str, Any]]) -> Dict[str, Any]:
    rows = _sort_desc([_ledger_base(r) for r in ledger if r.get('type') == 'store_credit'], 'createdAt')
    per_agent: Dict[str, float] = defaultdict(float)
    for r in rows:
        per_agent[r['agentName'] or r['agentEmail'] or 'Unknown'] += r['amount']
    columns = [col('createdAt', 'Date & time', 'datetime'), col('RAN', 'RAN'), col('orderName', 'Order no.'),
               col('requestType', 'Request type'), *CUSTOMER_COLS, col('items', 'Items'),
               col('amount', 'Value', 'currency'), *AGENT_COLS]
    items = [summary('Store credits issued', len(rows)),
             summary('Total value', money(sum(r['amount'] for r in rows)), 'currency')]
    items += [summary(f"By {name}", money(v), 'currency') for name, v in sorted(per_agent.items(), key=lambda kv: -kv[1])]
    return {'columns': columns, 'rows': rows, 'summary': items}


def report_transactions(ledger: List[Dict[str, Any]]) -> Dict[str, Any]:
    rows = []
    for r in ledger:
        kind = r.get('type') or ''
        row = _ledger_base(r)
        row.update({
            'type': LEDGER_TYPE_LABELS.get(kind, kind),
            'reference': (f"GC ••••{r['giftCardLast4']}" if r.get('giftCardLast4') else '')
            or r.get('transactionId') or r.get('manualReference') or r.get('shopifyRefundId') or '',
            'note': r.get('note') or '', '_kind': kind,
        })
        rows.append(row)
    rows = _sort_desc(rows, 'createdAt')
    by_type: Dict[str, float] = defaultdict(float)
    for r in rows:
        by_type[r['_kind']] += r['amount']
        r.pop('_kind', None)
    paid_out = money(sum(v for k, v in by_type.items() if k != 'exchange_invoice'))
    columns = [col('createdAt', 'Date & time', 'datetime'), col('type', 'Type'), col('RAN', 'RAN'),
               col('orderName', 'Order no.'), col('requestType', 'Request type'), *CUSTOMER_COLS,
               col('items', 'Items'), col('reference', 'Reference'), col('amount', 'Value', 'currency'),
               *AGENT_COLS, col('note', 'Note')]
    items = [summary('Transactions', len(rows)), summary('Total refunded / credited', paid_out, 'currency')]
    items += [summary(LEDGER_TYPE_LABELS.get(k, k), money(v), 'currency') for k, v in sorted(by_type.items())]
    return {'columns': columns, 'rows': rows, 'summary': items}


# ==========================================================
# EXCHANGES (5)
# ==========================================================
def exchange_facts(doc: Dict[str, Any], agents: AgentDirectory) -> Dict[str, Any]:
    """Normalised facts about a processed exchange (doc fields + exchangeResult)."""
    res = doc.get('exchangeResult') if isinstance(doc.get('exchangeResult'), dict) else {}
    outcome = str(res.get('financialOutcome') or res.get('outcome') or doc.get('financialOutcome') or 'even')
    if outcome == 'refund':
        amount = money(res.get('netRefundAmount', doc.get('netRefundAmount')))
    elif outcome == 'extra':
        amount = abs(money(res.get('outstandingBalance', doc.get('outstandingBalance'))))
    else:
        amount = 0.0
    sent = res.get('itemsSent') or res.get('addedItems') or doc.get('exchangeItemsSent') or []
    invoice = res.get('invoiceSent', doc.get('invoiceSent'))
    processed_by = res.get('processedBy') if isinstance(res.get('processedBy'), dict) else {}
    agent = agents.resolve(name=res.get('agentName') or processed_by.get('name') or doc.get('exchangeLoggedBy'),
                           email=res.get('agentEmail') or processed_by.get('email') or doc.get('exchangeLoggedByEmail'),
                           role=processed_by.get('role'))
    return {
        'processedAt': res.get('processedAt') or doc.get('exchangeLoggedAt'),
        'outcome': outcome, 'amount': money(amount),
        'itemsReturned': items_text([i for i in doc_items(doc, False) if i.get('actionType') == 'exchange'],
                                    'quantityReturned'),
        'itemsSent': items_text(sent) if isinstance(sent, list) else '',
        'invoiceSent': ('Yes' if invoice else 'No') if outcome == 'extra' else '—',
        'agent': agent,
    }


def report_exchanges(returns: List[Doc], agents: AgentDirectory) -> Dict[str, Any]:
    rows, outcomes = [], Counter()
    refund_due = to_pay = 0.0
    for _, doc in returns:
        f = exchange_facts(doc, agents)
        cust = doc.get('customer') or {}
        outcomes[f['outcome']] += 1
        refund_due += f['amount'] if f['outcome'] == 'refund' else 0
        to_pay += f['amount'] if f['outcome'] == 'extra' else 0
        rows.append({
            'processedAt': ist_iso(f['processedAt']), 'RAN': doc.get('RAN') or '', 'orderName': doc.get('orderId') or '',
            'customerName': cust.get('name') or '', 'customerEmail': cust.get('email') or '',
            'itemsReturned': f['itemsReturned'], 'itemsSent': f['itemsSent'],
            'outcome': OUTCOME_LABELS.get(f['outcome'], f['outcome']), 'amount': f['amount'],
            'invoiceSent': f['invoiceSent'], 'agentName': f['agent']['name'],
        })
    columns = [col('processedAt', 'Date processed', 'datetime'), col('RAN', 'RAN'), col('orderName', 'Order no.'),
               col('customerName', 'Customer'), col('customerEmail', 'Customer email'),
               col('itemsReturned', 'Items returned'), col('itemsSent', 'Items sent'), col('outcome', 'Outcome'),
               col('amount', 'Net amount', 'currency'), col('invoiceSent', 'Invoice sent'), col('agentName', 'Agent')]
    return {'columns': columns, 'rows': _sort_desc(rows, 'processedAt'), 'summary': [
        summary('Exchanges processed', len(rows)), summary('Even', outcomes['even']),
        summary('Refund due', outcomes['refund']), summary('Customer to pay', outcomes['extra']),
        summary('Total refund due', money(refund_due), 'currency'),
        summary('Total payable by customers', money(to_pay), 'currency')]}


# ==========================================================
# REQUEST-BASED REPORTS (6–8)
# ==========================================================
def report_requests(returns: List[Doc]) -> Dict[str, Any]:
    rows, types, units_total, value_total, open_count = [], Counter(), 0, 0.0, 0
    for doc_id, doc in returns:
        items = doc_items(doc)
        cust = doc.get('customer') or {}
        units = sum(safe_int(i.get('quantityReturned'), 0) or 0 for i in items)
        value = money(sum(item_value(i) for i in items))
        rtype = request_type(doc)
        types[rtype] += 1
        units_total += units
        value_total += value
        status = doc.get('status') or ''
        if status.lower() not in ('closed', 'denied', 'rejected', 'completed', 'exchanged_created', 'cancelled'):
            open_count += 1
        reasons = list(dict.fromkeys(i.get('reason') for i in items if i.get('reason')))
        refund_method = normalize_refund_method(doc.get('refundMethod')) if doc.get('refundMethod') else ''
        rows.append({
            'createdAt': ist_iso(doc.get('createdAt') or doc.get('submittedAt')), 'RAN': doc.get('RAN') or '',
            'orderName': doc.get('orderId') or doc_id, 'type': REQUEST_TYPE_LABELS.get(rtype, rtype), 'status': status,
            'customerName': cust.get('name') or '', 'customerEmail': cust.get('email') or '',
            'customerPhone': cust.get('phone') or '', 'city': cust.get('city') or '', 'state': cust.get('state') or '',
            'items': items_text(items, 'quantityReturned'), 'units': units, 'value': value,
            'reasons': '; '.join(reasons),
            'requestedMethod': REQUESTED_METHOD_LABELS.get(doc.get('requestedMethod') or 'none', doc.get('requestedMethod')),
            'refundMethod': LEDGER_TYPE_LABELS.get(refund_method, refund_method),
            'refundAmount': money(doc.get('refundAmount')) if doc.get('refundAmount') is not None else None,
            'updatedAt': ist_iso(doc.get('updatedAt')),
        })
    columns = [col('createdAt', 'Created', 'datetime'), col('RAN', 'RAN'), col('orderName', 'Order no.'),
               col('type', 'Type'), col('status', 'Status'), *CUSTOMER_COLS, col('city', 'City'), col('state', 'State'),
               col('items', 'Items'), col('units', 'Units', 'number'), col('value', 'Request value', 'currency'),
               col('reasons', 'Reason(s)'), col('requestedMethod', 'Requested method'),
               col('refundMethod', 'Refund method'), col('refundAmount', 'Refund amount', 'currency'),
               col('updatedAt', 'Last updated', 'datetime')]
    return {'columns': columns, 'rows': _sort_desc(rows, 'createdAt'), 'summary': [
        summary('Requests', len(rows)), summary('Returns', types['return']), summary('Exchanges', types['exchange']),
        summary('Mixed', types['mixed']), summary('Still open', open_count), summary('Units', units_total),
        summary('Total request value', money(value_total), 'currency')]}


def _pct(part: float, whole: float) -> float:
    return round(part * 100.0 / whole, 1) if whole else 0.0


def report_most_returned_products(returns: List[Doc]) -> Dict[str, Any]:
    groups: Dict[str, Dict[str, Any]] = {}
    for doc_id, doc in returns:
        for it in doc_items(doc):
            sku = str(it.get('sku') or '').strip()
            key = sku.lower() if sku and sku.upper() != 'N/A' else f"title:{(it.get('title') or '').lower()}"
            g = groups.setdefault(key, {'product': it.get('title') or '', 'sku': sku if sku.upper() != 'N/A' else '',
                                        'requests': set(), 'returned': 0, 'exchanged': 0, 'value': 0.0,
                                        'reasons': Counter()})
            qty = safe_int(it.get('quantityReturned'), 0) or 0
            g['requests'].add(doc_id)
            g['exchanged' if it.get('actionType') == 'exchange' else 'returned'] += qty
            g['value'] += item_value(it)
            if it.get('reason'):
                g['reasons'][it['reason']] += qty or 1
    all_units = sum(g['returned'] + g['exchanged'] for g in groups.values())
    rows = []
    for g in groups.values():
        total = g['returned'] + g['exchanged']
        rows.append({'product': g['product'], 'sku': g['sku'], 'requests': len(g['requests']),
                     'unitsReturned': g['returned'], 'unitsExchanged': g['exchanged'], 'totalUnits': total,
                     'totalValue': money(g['value']),
                     'topReason': g['reasons'].most_common(1)[0][0] if g['reasons'] else '',
                     'share': _pct(total, all_units)})
    rows.sort(key=lambda r: (-r['totalUnits'], -r['totalValue'], r['product']))
    columns = [col('product', 'Product'), col('sku', 'SKU'), col('requests', 'Requests', 'number'),
               col('unitsReturned', 'Units returned', 'number'), col('unitsExchanged', 'Units exchanged', 'number'),
               col('totalUnits', 'Total units', 'number'), col('totalValue', 'Total value', 'currency'),
               col('topReason', 'Top reason'), col('share', 'Share of all units (%)', 'number')]
    return {'columns': columns, 'rows': rows, 'summary': [
        summary('Distinct products', len(rows)), summary('Total units', all_units),
        summary('Total value', money(sum(r['totalValue'] for r in rows)), 'currency')]}


def report_return_reasons(returns: List[Doc]) -> Dict[str, Any]:
    groups: Dict[str, Dict[str, Any]] = {}
    for doc_id, doc in returns:
        for it in doc_items(doc):
            reason = (it.get('reason') or 'Not specified').strip() or 'Not specified'
            g = groups.setdefault(reason, {'requests': set(), 'units': 0, 'value': 0.0})
            g['requests'].add(doc_id)
            g['units'] += safe_int(it.get('quantityReturned'), 0) or 0
            g['value'] += item_value(it)
    all_units = sum(g['units'] for g in groups.values())
    rows = [{'reason': reason, 'requests': len(g['requests']), 'units': g['units'], 'value': money(g['value']),
             'share': _pct(g['units'], all_units)} for reason, g in groups.items()]
    rows.sort(key=lambda r: (-r['units'], -r['value'], r['reason']))
    columns = [col('reason', 'Reason'), col('requests', 'Requests', 'number'), col('units', 'Units', 'number'),
               col('value', 'Value', 'currency'), col('share', 'Share (%)', 'number')]
    return {'columns': columns, 'rows': rows, 'summary': [
        summary('Reasons', len(rows)), summary('Units', all_units),
        summary('Total value', money(sum(r['value'] for r in rows)), 'currency')]}


# ==========================================================
# RESTOCKS (10) + AGENT PERFORMANCE (9)
# ==========================================================
def report_restocks(records: List[Doc]) -> Dict[str, Any]:
    rows, units_ok, failed = [], 0, 0
    for _, rec in records:
        status = rec.get('status') or 'success'
        failed += 1 if status == 'failed' else 0
        for it in rec.get('items') or []:
            if not isinstance(it, dict):
                continue
            qty = safe_int(it.get('quantityReturned', it.get('quantity')), 0) or 0
            units_ok += qty if status == 'success' else 0
            rows.append({
                'restockedAt': ist_iso(rec.get('restockedAt')), 'RAN': rec.get('RAN') or '',
                'orderName': rec.get('orderName') or rec.get('orderId') or '', 'product': it.get('title') or '', 'sku': it.get('sku') or '',
                'quantity': qty, 'condition': it.get('condition') or rec.get('condition') or '',
                'status': status, 'restockedBy': rec.get('restockedBy') or rec.get('restockedByEmail') or '',
            })
    columns = [col('restockedAt', 'Date', 'datetime'), col('RAN', 'RAN'), col('orderName', 'Order no.'),
               col('product', 'Product'), col('sku', 'SKU'), col('quantity', 'Quantity', 'number'),
               col('condition', 'Condition'), col('status', 'Status'), col('restockedBy', 'Restocked by')]
    return {'columns': columns, 'rows': _sort_desc(rows, 'restockedAt'), 'summary': [
        summary('Restock records', len(records)), summary('Units restocked', units_ok),
        summary('Failed restocks', failed)]}


def report_agent_performance(ledger: List[Dict[str, Any]], exchanges: List[Doc], restocks: List[Doc],
                             agents: AgentDirectory) -> Dict[str, Any]:
    stats: Dict[str, Dict[str, Any]] = {}

    def bucket(info: Dict[str, str]) -> Dict[str, Any]:
        key = (info.get('email') or info.get('name') or 'unknown').strip().lower()
        s = stats.setdefault(key, {'agentName': info.get('name') or '', 'agentEmail': info.get('email') or '',
                                   'agentRole': info.get('role') or '', 'gvCount': 0, 'gvValue': 0.0,
                                   'scCount': 0, 'scValue': 0.0, 'opCount': 0, 'opValue': 0.0,
                                   'manualCount': 0, 'manualValue': 0.0, 'exchanges': 0, 'restocks': 0})
        for field, k in (('agentName', 'name'), ('agentEmail', 'email'), ('agentRole', 'role')):
            s[field] = s[field] or info.get(k) or ''
        return s

    prefix = {'gift_card': 'gv', 'store_credit': 'sc', 'original_payment': 'op', 'manual': 'manual'}
    for r in ledger:
        p = prefix.get(r.get('type'))
        if not p:
            continue
        s = bucket(agents.resolve(r.get('agentName'), r.get('agentEmail'), r.get('agentRole')))
        s[f'{p}Count'] += 1
        s[f'{p}Value'] += money(r.get('amount'))
    for _, doc in exchanges:
        bucket(exchange_facts(doc, agents)['agent'])['exchanges'] += 1
    for _, rec in restocks:
        if (rec.get('status') or 'success') == 'success':
            bucket(agents.resolve(rec.get('restockedBy'), rec.get('restockedByEmail')))['restocks'] += 1
    rows = []
    for s in stats.values():
        for p in ('gv', 'sc', 'op', 'manual'):
            s[f'{p}Value'] = money(s[f'{p}Value'])
        s['totalValue'] = money(s['gvValue'] + s['scValue'] + s['opValue'] + s['manualValue'])
        rows.append(s)
    rows.sort(key=lambda r: (-r['totalValue'], -(r['exchanges'] + r['restocks']), r['agentName'].lower()))
    columns = [*AGENT_COLS, col('gvCount', 'GV count', 'number'), col('gvValue', 'GV value', 'currency'),
               col('scCount', 'Store credit count', 'number'), col('scValue', 'Store credit value', 'currency'),
               col('opCount', 'Original payment count', 'number'), col('opValue', 'Original payment value', 'currency'),
               col('manualCount', 'Manual count', 'number'), col('manualValue', 'Manual value', 'currency'),
               col('totalValue', 'Total refunded value', 'currency'), col('exchanges', 'Exchanges processed', 'number'),
               col('restocks', 'Restocks performed', 'number')]
    return {'columns': columns, 'rows': rows, 'summary': [
        summary('Agents', len(rows)), summary('Total refunded value', money(sum(r['totalValue'] for r in rows)), 'currency'),
        summary('Exchanges processed', sum(r['exchanges'] for r in rows)),
        summary('Restocks performed', sum(r['restocks'] for r in rows))]}


# ==========================================================
# FIRESTORE ACCESS
# ==========================================================
def _range_docs(collection: str, field: str, start: Any, end: Any) -> List[Doc]:
    query = (db.collection(collection).where(filter=FieldFilter(field, '>=', start))
             .where(filter=FieldFilter(field, '<', end)).order_by(field).limit(MAX_DOCS_PER_QUERY))
    docs = [(s.id, s.to_dict() or {}) for s in query.stream()]
    if len(docs) >= MAX_DOCS_PER_QUERY:
        logger.warning(f"Report query on {collection}.{field} hit the {MAX_DOCS_PER_QUERY}-document cap")
    return docs


def _ledger(start: datetime, end: datetime) -> List[Dict[str, Any]]:
    start_ms, end_ms = int(start.timestamp() * 1000), int(end.timestamp() * 1000)
    rows = []
    for doc_id, d in _range_docs('refund_ledger', 'createdAtMs', start_ms, end_ms):
        d['id'] = doc_id
        if (d.get('status') or 'success') == 'success':
            rows.append(d)
    return rows


def _agents() -> AgentDirectory:
    return AgentDirectory((s.to_dict() or {}) for s in db.collection('agents').stream())


REPORTS: Dict[str, Tuple[str, Callable[[datetime, datetime], Dict[str, Any]]]] = {
    'gift-vouchers': ('Gift Vouchers Issued', lambda s, e: report_gift_vouchers(_ledger(s, e))),
    'refunds': ('Refunds Issued', lambda s, e: report_refunds(_ledger(s, e))),
    'store-credit': ('Store Credit Given', lambda s, e: report_store_credit(_ledger(s, e))),
    'transactions': ('All Money Movements', lambda s, e: report_transactions(_ledger(s, e))),
    'exchanges': ('Exchanges Processed',
                  lambda s, e: report_exchanges(_range_docs('returns', 'exchangeLoggedAt', s, e), _agents())),
    'requests': ('Return & Exchange Requests', lambda s, e: report_requests(_range_docs('returns', 'createdAt', s, e))),
    'most-returned-products': ('Most Returned Products',
                               lambda s, e: report_most_returned_products(_range_docs('returns', 'createdAt', s, e))),
    'return-reasons': ('Return Reasons', lambda s, e: report_return_reasons(_range_docs('returns', 'createdAt', s, e))),
    'agent-performance': ('Agent Performance', lambda s, e: report_agent_performance(
        _ledger(s, e), _range_docs('returns', 'exchangeLoggedAt', s, e),
        _range_docs('restock_history', 'restockedAt', s, e), _agents())),
    'restocks': ('Restocks', lambda s, e: report_restocks(_range_docs('restock_history', 'restockedAt', s, e))),
}
ALL_STAFF_REPORTS = frozenset({'restocks'})


@bp.route('/api/reports/<report_type>', methods=['GET'])
@require_staff()
def get_report(report_type):
    """One report for an IST date range (admins; 'restocks' for all staff)."""
    spec = REPORTS.get(report_type)
    if not spec:
        return error_response("Unknown report type.", 404, code="unknown_report")
    agent = current_agent()
    if report_type not in ALL_STAFF_REPORTS and agent.get('role') not in ADMIN_ROLES:
        return error_response("You do not have permission to view this report.", 403, code="forbidden")
    try:
        from_d, to_d, start, end = parse_report_range(request.args.get('from'), request.args.get('to'))
    except ValueError as e:
        return error_response(str(e), 400, code="invalid_range")
    if not db:
        return error_response("Service temporarily unavailable.", 503)
    title, builder = spec
    try:
        body = builder(start, end)
    except Exception as e:
        logger.error(f"Report {report_type} failed: {type(e).__name__}: {e}")
        return error_response("The report could not be generated. Please try again.", 500)
    report = {'type': report_type, 'title': title, 'from': from_d.isoformat(), 'to': to_d.isoformat(),
              'generatedAt': iso_utc(utcnow()), 'generatedBy': agent.get('name') or agent.get('email') or '',
              **body}
    return jsonify({'success': True, 'report': report})


# ==========================================================
# RETURNS PAGE TAB COUNTS
# ==========================================================
# Same rules as the tabs in src/components/Pages/Returns.tsx (statusHelpers).
_OPEN_STATUSES = {'open', 'pending', 'approved'}
_NOT_STARTED_SHIPMENT = {'', 'not created', 'pickup cancelled'}
_ACTIVE_SHIPMENT = {'pickup created', 'pickup scheduled', 'in transit', 'pickup exception', 'self ship requested'}
_DONE_OR_CLOSED = {'completed', 'exchanged_created', 'closed', 'denied'}
TAB_COUNT_KEYS = ('all', 'open', 'active', 'product_received', 'received', 'completed', 'rejected', 'failed')
TAB_COUNT_CACHE_SECONDS = 30
TAB_COUNT_MAX_DOCS = 50000
_tab_count_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}


def count_return_tabs(docs: Iterable[Dict[str, Any]]) -> Dict[str, int]:
    """Count return requests per Returns-page tab (pure; one pass)."""
    counts = {k: 0 for k in TAB_COUNT_KEYS}
    for d in docs:
        status = str(d.get('status') or '').strip().lower()
        ship = str(d.get('shipmentStatus') or '').strip().lower()
        refund = str(d.get('refundStatus') or '').strip().lower()
        counts['all'] += 1
        if status in _OPEN_STATUSES and ship in _NOT_STARTED_SHIPMENT:
            counts['open'] += 1
        if ship in _ACTIVE_SHIPMENT:
            counts['active'] += 1
        if ship == 'product reached' and status not in _DONE_OR_CLOSED:
            counts['product_received'] += 1
        if ship == 'received' and status not in _DONE_OR_CLOSED:
            counts['received'] += 1
        if status in ('completed', 'exchanged_created') or (ship == 'received' and refund == 'refunded'):
            counts['completed'] += 1
        if status in ('denied', 'closed'):
            counts['rejected'] += 1
        if ship in ('failed', 'cancelled') or refund == 'failed':
            counts['failed'] += 1
    return counts


def _ms_param(name: str) -> Optional[datetime]:
    raw = request.args.get(name)
    if raw in (None, ''):
        return None
    value = safe_int(raw)
    if value is None or value < 0:
        raise ValueError(f"'{name}' must be epoch milliseconds.")
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc)


@bp.route('/api/returns/tab-counts', methods=['GET'])
@require_staff()
def returns_tab_counts():
    """Counts for every Returns-page tab in one call (optionally within a createdAt window).

    Reads only the three status fields (field projection), and caches the answer
    for a few seconds per window so the page can poll it cheaply.
    """
    import time as _time
    try:
        start, end = _ms_param('startMs'), _ms_param('endMs')
    except ValueError as e:
        return error_response(str(e), 400)
    if not db:
        return error_response('Database unavailable.', 503)
    key = f"{request.args.get('startMs', '')}|{request.args.get('endMs', '')}"
    hit = _tab_count_cache.get(key)
    if hit and hit[0] > _time.monotonic():
        return jsonify(hit[1]), 200
    try:
        q = db.collection('returns')
        if start:
            q = q.where(filter=FieldFilter('createdAt', '>=', start))
        if end:
            q = q.where(filter=FieldFilter('createdAt', '<', end))
        if hasattr(q, 'select'):
            q = q.select(['status', 'shipmentStatus', 'refundStatus'])
        if hasattr(q, 'limit'):
            q = q.limit(TAB_COUNT_MAX_DOCS)
        rows = [(snap.to_dict() or {}) for snap in q.stream()]
    except Exception as e:
        logger.error(f"Tab counts query failed: {type(e).__name__}: {e}")
        return error_response('Could not load counts.', 500)
    body = {'success': True, 'counts': count_return_tabs(rows), 'capped': len(rows) >= TAB_COUNT_MAX_DOCS}
    if len(_tab_count_cache) > 200:
        _tab_count_cache.clear()
    _tab_count_cache[key] = (_time.monotonic() + TAB_COUNT_CACHE_SECONDS, body)
    return jsonify(body), 200

// =============================================================================
// Re-Guard — "Render Email" (n8n Code node, mode: Run Once for Each Item)
//
// Source of truth: n8n/src/render-email.js. `node n8n/build-workflow.mjs` embeds
// this file into n8n/reguard-email-workflow.json. Edit here, then rebuild.
//
// Layout/copy follow the client's reference file (email-template-needed.html):
// plum header with the Prashanti logo, white 600px card, Product/SKU/Qty/Amount tables,
// footer with customer care + the Re-guard logo (reguard-logo-bg.png).
//
// Input : webhook item; payload = $json.body ?? $json (CONTRACT §6).
// Output: { recipient, subject, html, event, returnId }  ->  Gmail "Send Email".
// Throws on a missing/invalid recipient or an unknown event so the execution
// is marked as failed instead of silently e-mailing nobody.
//
// Every interpolated value goes through the `h` tagged template, which HTML-
// escapes by default; only fragments produced by `h`/`raw` are inserted as-is.
// Plain JavaScript only (no require / external modules).
// =============================================================================

// ---------------------------------------------------------------- constants --
// Brand defaults. Every value can be overridden by the payload's `brand` block.
//  headerLogoUrl : white Prashanti logo shown on the purple header band
//  footerLogoUrl : Re-guard logo shown in the footer (served from the web app's public/ folder)
// The old `brand.logoUrl` key is ignored on purpose: the backend still sends reguard-logo.png
// in it, which is not meant for the header any more.
const DEFAULT_BRAND = {
  name: 'Prashanti Sarees',
  headerLogoUrl: 'https://www.prashantisarees.com/cdn/shop/files/Prashanti-Logo-white_f9153faf-1034-472c-b9b7-0c6ac58815e3.png?v=1721145957&width=320',
  footerLogoUrl: 'https://prashantireturns.web.app/reguard-logo-bg.png',
  supportEmail: 'support@prashantisarees.in',
  supportPhone: '+91 99625 05459',
  website: 'https://www.prashantisarees.com',
  shopUrl: 'https://www.prashantisarees.com/collections/all',
  portalUrl: 'https://prashantireturns.web.app',
  trackUrl: '',
  returnPolicyUrl: 'https://www.prashantisarees.com/en-us/pages/return-policy',
};

// Palette taken from the client's reference template (email-template-needed.html).
const C = {
  plum: '#6f1e56',
  plumSoft: '#f1d6e6',
  ink: '#222222',
  body: '#444444',
  muted: '#777777',
  soft: '#666666',
  line: '#e6e6e6',
  lineSoft: '#efefef',
  frame: '#e6dfe4',
  tint: '#faf6f9',
  white: '#ffffff',
};
const FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = "'Courier New',Courier,monospace";

// Webhook path -> event (only used when a payload arrives without `event`).
const PATH_EVENTS = {
  'otp-requested': 'agent_otp',
  'return-applied': 'return_applied',
  'exchange-applied': 'exchange_applied',
  'mixed-applied': 'mixed_applied',
  'return-rejected': 'return_rejected',
  'return-closed': 'return_closed',
  'item-rejected': 'item_rejected',
  'self-ship-requested': 'self_ship_requested',
  'pickup-created': 'pickup_created',
  'pickup-cancelled': 'pickup_cancelled',
  'return-received': 'return_received',
  'refund-done': 'refund_done',
  'exchange-processed': 'exchange_processed',
};
const EVENT_ALIASES = { otp_requested: 'agent_otp', forgot_password: 'agent_otp', self_ship: 'self_ship_requested' };

// ------------------------------------------------------- escaping & values --
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const raw = (s) => new Raw(String(s));

function renderValue(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  if (v === null || v === undefined || v === false) return '';
  if (typeof v === 'number' && !Number.isFinite(v)) return '';
  return escapeHtml(v);
}

// Tagged template: escapes every interpolation unless it is Raw (or an array of Raw).
function h(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + strings[i + 1];
  return raw(out);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const obj = (v) => (isObj(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

// Clean string: '' for null/undefined/objects and for the literal junk strings.
function str(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return '';
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return /^(undefined|null|nan|none)$/i.test(s) ? '' : s;
}

function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}
const hasNum = (v) => Number.isFinite(num(v));

// Only http(s)/mailto/tel URLs are ever placed in href/src.
function safeUrl(v, { allowMail = false } = {}) {
  const s = str(v);
  if (!s) return '';
  if (/^https?:\/\/[^\s<>"']+$/i.test(s)) return s;
  if (allowMail && /^(mailto|tel):[^\s<>"']+$/i.test(s)) return s;
  return '';
}

function isEmail(v) {
  const s = str(v);
  return s.length <= 254 && /^[^\s@<>"'(),;:\\[\]]+@[^\s@<>"'(),;:\\[\]]+\.[^\s@<>"'(),;:\\[\]]{2,}$/.test(s);
}

// ----------------------------------------------------------- formatting ----
// ₹ with Indian digit grouping, always 2 decimals (no Intl dependency).
function fmtINR(v) {
  const n = num(v);
  if (!Number.isFinite(n)) return '';
  const neg = n < 0;
  const fixed = (Math.round(Math.abs(n) * 100 + 1e-6) / 100).toFixed(2);
  const [intPart, dec] = fixed.split('.');
  let grouped = intPart;
  if (intPart.length > 3) {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = rest + ',' + last3;
  }
  return (neg ? '−' : '') + '₹' + grouped + '.' + dec;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// IST formatting. 'YYYY-MM-DD' -> "15 Oct 2026"; ISO timestamp -> "9 Oct 2026, 1:30 PM IST".
// Unparseable input is returned unchanged (it is escaped later).
function fmtDateIST(v, { time = true } = {}) {
  const s = str(v);
  if (!s) return '';
  const dOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dOnly) {
    const m = Number(dOnly[2]);
    if (m < 1 || m > 12) return s;
    return `${Number(dOnly[3])} ${MONTHS[m - 1]} ${dOnly[1]}`;
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return s;
  const d = new Date(t + 330 * 60 * 1000); // UTC+05:30
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (!time) return date;
  let hr = d.getUTCHours();
  const ap = hr >= 12 ? 'PM' : 'AM';
  hr = hr % 12 || 12;
  return `${date}, ${hr}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ap} IST`;
}

function maskPhone(v) {
  const s = str(v);
  if (!s) return '';
  if (/[*•xX]/.test(s)) return s; // already masked upstream
  const digits = s.replace(/\D/g, '');
  if (digits.length < 6) return '';
  return '••••••' + digits.slice(-4);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const cleanVariant = (v) => { const s = str(v); return /^default title$/i.test(s) ? '' : s; };
const nl2br = (text) => str(text).split(/\r?\n/).map((line, i) => (i ? h`<br>${line}` : h`${line}`));

// --------------------------------------------------------- layout helpers --
// Layout and styling follow the client's reference template (email-template-needed.html):
// plum header band, white 600px card with a 1px frame, 22px title, bordered h3 section titles,
// Product / SKU / Qty / Amount tables, outline buttons, footer with customer care + logo.
const FF = raw(FONT);
const strong = (v) => h`<strong style="color:${C.ink};">${v}</strong>`;
const link = (href, label) => {
  const u = safeUrl(href, { allowMail: true });
  return u ? h`<a href="${u}" style="color:${C.plum};text-decoration:underline;">${label}</a>` : h`${label}`;
};

const P = (content, extra = '') =>
  h`<p style="margin:0 0 16px;font-family:${FF};font-size:15px;line-height:23px;color:${C.body};${raw(extra)}">${content}</p>`;

const title1 = (text) =>
  h`<h1 style="margin:0 0 14px;font-family:${FF};font-size:22px;line-height:30px;font-weight:600;color:${C.ink};">${text}</h1>`;

// Section title with a hairline underneath (the reference's <h3> block).
const sectionTitle = (text) =>
  h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0;"><tr><td style="padding:0 0 8px;border-bottom:1px solid ${C.line};"><h3 style="margin:0;font-family:${FF};font-size:14px;line-height:20px;font-weight:600;color:${C.ink};">${text}</h3></td></tr></table>`;

// rows: [[label, value], ...] -> label left, value right. Empty values are dropped.
function kvTable(rows, { margin = '6px 0 24px', flush = false } = {}) {
  const kept = rows.filter((r) => r && (r[1] instanceof Raw ? r[1].s !== '' : str(r[1]) !== ''));
  if (!kept.length) return raw('');
  const body = kept.map(([label, value], i) => {
    const top = i ? `border-top:1px solid ${C.lineSoft};` : '';
    return h`<tr>
<td valign="top" style="padding:10px 12px 10px 0;${raw(top)}font-family:${FF};font-size:13px;line-height:20px;color:${C.muted};">${label}</td>
<td align="right" valign="top" style="padding:10px 0;${raw(top)}font-family:${FF};font-size:14px;line-height:20px;font-weight:600;color:${C.ink};word-break:break-word;overflow-wrap:anywhere;">${value instanceof Raw ? value : str(value)}</td>
</tr>`;
  });
  return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:${raw(margin)};${raw(flush ? '' : `border-top:1px solid ${C.line};`)}border-bottom:1px solid ${C.line};">${body}</table>`;
}

// Order ID strip shown under the intro of every customer e-mail.
const orderStrip = (ctx, extra = []) =>
  kvTable([
    ['Order ID', ctx.orderName ? h`#${ctx.orderName}` : ''],
    ['RAN', ctx.ran],
    ...extra,
  ]);

// Tinted card with a plum left bar (reasons, address, refund destination, ...).
function noteCard({ label, title: t = '', body: b = '', sub: sb = '' }) {
  const frag = (v) => (Array.isArray(v) ? raw(renderValue(v)) : v);
  const title = frag(t); const body = frag(b); const sub = frag(sb);
  const bodyRaw = body instanceof Raw ? body.s !== '' : str(body) !== '';
  return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr>
<td bgcolor="${C.tint}" style="background:${C.tint};border-left:3px solid ${C.plum};padding:14px 18px;word-break:break-word;overflow-wrap:anywhere;">
${str(label) ? h`<div style="margin:0 0 4px;font-family:${FF};font-size:12px;line-height:16px;color:${C.muted};">${label}</div>` : ''}
${title instanceof Raw || str(title) ? h`<div style="font-family:${FF};font-size:15px;line-height:22px;font-weight:600;color:${C.ink};">${title}</div>` : ''}
${bodyRaw ? h`<div style="font-family:${FF};font-size:14px;line-height:21px;color:${C.ink};">${body}</div>` : ''}
${sub instanceof Raw || str(sub) ? h`<div style="margin:4px 0 0;font-family:${FF};font-size:13px;line-height:19px;color:${C.soft};">${sub}</div>` : ''}
</td></tr></table>`;
}

// Big boxed one-time / gift-card code.
function codeBox({ label, value, sub, size = 34 }) {
  return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;"><tr>
<td align="center" bgcolor="${C.tint}" style="background:${C.tint};border:1px solid ${C.frame};padding:22px 16px;">
${str(label) ? h`<div style="margin:0 0 8px;font-family:${FF};font-size:13px;line-height:16px;color:${C.muted};">${label}</div>` : ''}
<div style="font-family:${raw(MONO)};font-size:${size}px;line-height:${size + 6}px;font-weight:700;letter-spacing:${size > 28 ? 8 : 3}px;color:${C.plum};word-break:break-all;">${value}</div>
${sub ? h`<div style="margin:10px 0 0;font-family:${FF};font-size:13px;line-height:18px;color:${C.soft};">${sub}</div>` : ''}
</td></tr></table>`;
}

function bullets(lines) {
  const rows = lines.filter(Boolean).map((l) => h`<li style="margin:0 0 6px;font-family:${FF};font-size:14px;line-height:21px;color:${C.body};">${l}</li>`);
  return rows.length ? h`<ul style="margin:12px 0 16px;padding:0 0 0 20px;">${rows}</ul>` : raw('');
}

// steps: [{title, text}] -> numbered plum badges.
function steps(list) {
  const rows = list.filter((s) => s && (str(s.title) || s.text)).map((s, i) => h`<tr>
<td width="36" valign="top" style="padding:0 0 14px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="24" height="24" align="center" valign="middle" bgcolor="${C.plum}" style="background:${C.plum};border-radius:12px;font-family:${FF};font-size:12px;line-height:24px;font-weight:700;color:${C.white};">${i + 1}</td></tr></table>
</td>
<td valign="top" style="padding:2px 0 14px;font-family:${FF};font-size:14px;line-height:21px;color:${C.body};">${str(s.title) ? h`<strong style="color:${C.ink};">${s.title}</strong>` : ''}${s.text ? h`<br>${s.text}` : ''}</td>
</tr>`);
  return rows.length ? h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 8px;">${rows}</table>` : raw('');
}

// buttons: [{href, label}] -> first one solid plum, the others outlined. Invalid URLs are skipped.
function buttons(list) {
  const ok = list.filter((b) => b && safeUrl(b.href, { allowMail: true }));
  if (!ok.length) return raw('');
  const cells = ok.map((b, i) => {
    const primary = i === 0;
    const bg = primary ? C.plum : C.white;
    const fg = primary ? C.white : C.plum;
    return h`<td class="stack" style="padding:${raw(i < ok.length - 1 ? '0 12px 0 0' : '0')};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn-tbl"><tr>
<td align="center" bgcolor="${bg}" style="background:${bg};border:1px solid ${C.plum};border-radius:4px;">
<a href="${safeUrl(b.href, { allowMail: true })}" class="btn-a" style="display:inline-block;padding:12px 26px;font-family:${FF};font-size:14px;line-height:18px;font-weight:600;color:${fg};text-decoration:none;">${b.label}</a>
</td></tr></table></td>`;
  });
  return h`<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn-tbl" style="margin:12px 0 4px;"><tr>${cells}</tr></table>`;
}

function normItem(it) {
  const o = obj(it);
  const q = num(o.quantity);
  const quantity = Number.isFinite(q) && q > 0 ? q : 1;
  const unitPrice = num(o.unitPrice);
  let lineTotal = num(o.lineTotal);
  if (!Number.isFinite(lineTotal) && Number.isFinite(unitPrice)) lineTotal = unitPrice * quantity;
  const action = str(o.action).toLowerCase();
  return {
    title: str(o.title) || 'Item',
    variant: cleanVariant(o.variant),
    sku: str(o.sku),
    quantity,
    unitPrice,
    lineTotal,
    image: str(o.image),
    action: action === 'return' || action === 'exchange' ? action : '',
    reason: str(o.reason),
  };
}

const TH = `padding:14px 0 8px;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:12px;line-height:16px;color:${C.muted};`;
const TD = `padding:14px 0;border-bottom:1px solid ${C.lineSoft};font-family:${FONT};font-size:14px;line-height:20px;color:${C.ink};`;

// Product / SKU / Qty / Amount table. The SKU and Amount columns appear only when there is data.
// opts: showPrice, showAction (Return/Exchange tag), showReason, total {label, amount}.
function itemsTable(items, { showPrice = true, showAction = false, showReason = false, total = null } = {}) {
  const list = arr(items).map(normItem);
  if (!list.length) return raw('');
  const showSku = list.some((i) => i.sku);
  const showAmt = showPrice && list.some((i) => Number.isFinite(i.lineTotal));
  const cols = 2 + (showSku ? 1 : 0) + (showAmt ? 1 : 0);
  const head = h`<tr>
<td style="${raw(TH)}padding-right:8px;">Product</td>
${showSku ? h`<td width="124" style="${raw(TH)}">SKU</td>` : ''}
<td width="40" align="center" style="${raw(TH)}">Qty</td>
${showAmt ? h`<td width="90" align="right" style="${raw(TH)}">Amount</td>` : ''}
</tr>`;
  const rows = list.map((it) => h`<tr>
<td valign="top" style="${raw(TD)}padding-right:8px;word-break:break-word;overflow-wrap:anywhere;">${it.title}${it.variant ? h`<br><span style="font-size:12px;color:${C.soft};">${it.variant}</span>` : ''}${showAction && it.action ? h`<br><span style="font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;color:${C.plum};">${it.action === 'return' ? 'Return' : 'Exchange'}</span>` : ''}${showReason && it.reason ? h`<br><span style="font-size:12px;color:${C.soft};">Reason: ${it.reason}</span>` : ''}</td>
${showSku ? h`<td width="124" valign="top" style="${raw(TD)}font-size:12px;color:${C.soft};word-break:break-word;">${it.sku}</td>` : ''}
<td width="40" align="center" valign="top" style="${raw(TD)}">${it.quantity}</td>
${showAmt ? h`<td width="90" align="right" valign="top" style="${raw(TD)}white-space:nowrap;">${Number.isFinite(it.lineTotal) ? fmtINR(it.lineTotal) : ''}</td>` : ''}
</tr>`);
  const totalRow = total && hasNum(total.amount)
    ? h`<tr>
<td colspan="${cols - 1}" style="padding:14px 0;border-top:2px solid ${C.plum};font-family:${FF};font-size:14px;line-height:20px;font-weight:700;color:${C.ink};">${total.label}</td>
<td align="right" style="padding:14px 0;border-top:2px solid ${C.plum};font-family:${FF};font-size:14px;line-height:20px;font-weight:700;color:${C.plum};white-space:nowrap;">${fmtINR(total.amount)}</td>
</tr>`
    : '';
  return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;">${head}${rows}${totalRow}</table>`;
}

// Exchange summary: Product / Qty / Value with a group label row ("Returned product", ...).
function groupedItems(groups) {
  const used = groups.map((g) => ({ label: g.label, items: arr(g.items).map(normItem) })).filter((g) => g.items.length);
  if (!used.length) return raw('');
  const showVal = used.some((g) => g.items.some((i) => Number.isFinite(i.lineTotal)));
  const cols = showVal ? 3 : 2;
  const th = `padding:0 0 8px;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:12px;line-height:16px;color:${C.muted};`;
  const body = used.map((g) => h`<tr><td colspan="${cols}" style="padding:16px 0 0;font-family:${FF};font-size:13px;line-height:18px;font-weight:700;color:${C.plum};">${g.label}</td></tr>
${g.items.map((it) => h`<tr>
<td valign="top" style="${raw(TD)}padding-right:8px;word-break:break-word;overflow-wrap:anywhere;">${it.title}${it.variant || it.sku ? h`<br><span style="font-size:12px;color:${C.soft};">${[it.variant, it.sku].filter(Boolean).join(' · ')}</span>` : ''}</td>
<td width="40" align="center" valign="top" style="${raw(TD)}">${it.quantity}</td>
${showVal ? h`<td width="90" align="right" valign="top" style="${raw(TD)}white-space:nowrap;">${Number.isFinite(it.lineTotal) ? fmtINR(it.lineTotal) : ''}</td>` : ''}
</tr>`)}`);
  return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 8px;">
<tr><td style="${raw(th)}">Product</td><td width="40" align="center" style="${raw(th)}">Qty</td>${showVal ? h`<td width="90" align="right" style="${raw(th)}">Value</td>` : ''}</tr>
${body}</table>`;
}

// Refund rows: label left, amount right, closing "Total" row with a plum rule.
function moneyRows(rows, total) {
  const kept = rows.filter((r) => r && hasNum(r.amount));
  const tr = (label, amount, neg) => h`<tr><td style="padding:10px 0;font-family:${FF};font-size:14px;line-height:20px;color:#555555;">${label}</td><td align="right" style="padding:10px 0;font-family:${FF};font-size:14px;line-height:20px;color:${C.ink};white-space:nowrap;">${neg ? '− ' : ''}${fmtINR(Math.abs(num(amount)))}</td></tr>`;
  const totalRow = total && hasNum(total.amount)
    ? h`<tr><td style="padding:12px 0 0;border-top:2px solid ${C.plum};font-family:${FF};font-size:15px;line-height:20px;font-weight:700;color:${C.ink};">${total.label}</td><td align="right" style="padding:12px 0 0;border-top:2px solid ${C.plum};font-family:${FF};font-size:15px;line-height:20px;font-weight:700;color:${C.plum};white-space:nowrap;">${fmtINR(total.amount)}</td></tr>`
    : '';
  if (!kept.length && !totalRow) return raw('');
  return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 0;">${kept.map((r) => tr(str(r.label) || 'Adjustment', r.amount, !!r.negative))}${totalRow}</table>`;
}

// ------------------------------------------------------------------ shell --
// `body` is the Raw fragment that goes inside the white content cell.
// staff: OTP mail for agents (text header like the reference, no policy link).
function shell({ brand, preheader, title, body, staff = false }) {
  const headerLogo = safeUrl(brand.headerLogoUrl) || DEFAULT_BRAND.headerLogoUrl;
  const footerLogo = safeUrl(brand.footerLogoUrl) || DEFAULT_BRAND.footerLogoUrl;
  const website = safeUrl(brand.website) || DEFAULT_BRAND.website;
  const policy = staff ? '' : safeUrl(brand.returnPolicyUrl);
  const supportEmail = isEmail(brand.supportEmail) ? brand.supportEmail : DEFAULT_BRAND.supportEmail;
  const phone = str(brand.supportPhone);

  const header = staff
    ? h`<div style="font-family:${FF};font-size:22px;line-height:28px;font-weight:700;letter-spacing:-0.3px;color:${C.white};">Re-guard <span style="color:${C.plumSoft};">by Prashanti</span></div>`
    : h`<a href="${website}" style="text-decoration:none;"><img src="${headerLogo}" width="170" alt="${brand.name}" style="display:block;width:170px;height:auto;font-family:${FF};font-size:17px;line-height:22px;font-weight:600;color:${C.white};"></a>`;

  return h`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${title}</title>
<style>
body, table, td, p, a, li, h1, h2, h3 { font-family: ${FF}; }
body { margin: 0; padding: 0; background: #ffffff; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
table { border-collapse: collapse; mso-table-lspace: 0; mso-table-rspace: 0; }
img { border: 0; display: block; outline: none; text-decoration: none; }
@media only screen and (max-width: 620px) {
.container { width: 100% !important; }
.px { padding-left: 20px !important; padding-right: 20px !important; }
.stack { display: block !important; width: 100% !important; padding: 0 0 10px 0 !important; }
.btn-tbl { width: 100% !important; }
.btn-a { display: block !important; text-align: center !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:${FF};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#ffffff;">${preheader}${raw('&#8199;&#65279;&#847; '.repeat(30))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff;">
<tr>
<td align="center" style="padding:24px 12px;">

<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;border:1px solid ${C.frame};">

<!-- Header -->
<tr>
<td class="px" align="left" bgcolor="${C.plum}" style="background:${C.plum};padding:22px 36px;">
${header}
</td>
</tr>

<!-- Content -->
<tr>
<td class="px" style="padding:32px 36px 28px;background:#ffffff;">
${body}
</td>
</tr>

<!-- Footer -->
<tr>
<td class="px" style="padding:20px 36px 28px;background:#ffffff;border-top:1px solid #eeeeee;">
<p style="margin:0 0 8px;font-family:${FF};font-size:13px;line-height:20px;color:${C.soft};">Prashanti customer care: <a href="mailto:${supportEmail}" style="color:${C.plum};text-decoration:underline;">${supportEmail}</a>${phone ? h` &nbsp;|&nbsp; ${phone}` : ''}</p>
${policy ? h`<p style="margin:0 0 8px;font-family:${FF};font-size:13px;line-height:20px;color:${C.soft};"><a href="${policy}" style="color:${C.plum};text-decoration:underline;">Return &amp; refund policy</a></p>` : ''}
<div style="margin:16px 0 0;"><img src="${footerLogo}" height="40" alt="Re-guard by Prashanti" style="display:block;height:40px;width:auto;max-width:240px;border:0;"></div>
</td>
</tr>

</table>

</td>
</tr>
</table>
</body>
</html>`.s;
}

// ------------------------------------------------------------- context ----
function requestTypeOf(event, request, items) {
  const t = str(request.type).toLowerCase();
  if (t === 'return' || t === 'exchange' || t === 'mixed') return t;
  if (event === 'exchange_applied') return 'exchange';
  if (event === 'mixed_applied') return 'mixed';
  const acts = new Set(items.map((i) => i.action).filter(Boolean));
  if (acts.size > 1) return 'mixed';
  if (acts.has('exchange')) return 'exchange';
  return 'return';
}
const NOUN = { return: 'return request', exchange: 'exchange request', mixed: 'return & exchange request' };
const KIND = { return: 'return', exchange: 'exchange', mixed: 'return or exchange' };
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function makeBrand(data) {
  const brandIn = obj(data.brand);
  const brand = { ...DEFAULT_BRAND };
  for (const k of Object.keys(DEFAULT_BRAND)) if (str(brandIn[k])) brand[k] = str(brandIn[k]);
  return brand;
}

function buildContext(data, event) {
  const brand = makeBrand(data);
  const customer = obj(data.customer);
  const order = obj(data.order);
  const request = obj(data.request);
  // Items the agent rejected (`rejected: true`) are not part of the request any more:
  // never list them as items to hand over / refunded. (item_rejected and
  // return_received carry their own rejected-item blocks.)
  const items = arr(data.items).filter((i) => obj(i).rejected !== true).map(normItem);
  const orderName = str(order.name) || str(request.returnId);
  if (!safeUrl(brand.trackUrl)) {
    const base = (safeUrl(brand.portalUrl) || DEFAULT_BRAND.portalUrl).replace(/\/+$/, '');
    brand.trackUrl = base + '/ReturnStatusPage' + (orderName ? '?order=' + encodeURIComponent(orderName) : '');
  }
  const type = requestTypeOf(event, request, items);
  const ran = str(request.RAN) || str(request.ran);
  const name = str(customer.name);
  const submitted = str(request.submittedAtDisplay) || fmtDateIST(request.submittedAt);
  // Subject suffix: "Order P905422 (RAN R1000123-905422)"
  const ref = [orderName ? `Order ${orderName}` : '', ran ? `(RAN ${ran})` : ''].filter(Boolean).join(' ');
  return { data, event, brand, customer, order, request, items, orderName, type, ran, name, submitted, ref };
}

const greet = (ctx) => P(h`Hi ${ctx.name || 'there'},`);
const subjectWith = (ctx, what) => (ctx.ref ? `${what} — ${ctx.ref}` : what);
const orderTxt = (ctx) => (ctx.orderName ? h`order #${ctx.orderName}` : h`your order`);
const pre = (ctx, text) => (ctx.orderName ? `Order #${ctx.orderName}: ${text}` : capFirst(text));
const ctxShell = (ctx, o) => shell({ brand: ctx.brand, ...o });

function supportMailto(ctx) {
  const subj = `Query about ${ctx.ran ? 'RAN ' + ctx.ran : 'my request'}${ctx.orderName ? ' / Order ' + ctx.orderName : ''}`;
  return 'mailto:' + ctx.brand.supportEmail + '?subject=' + encodeURIComponent(subj);
}
const newRequestUrl = (ctx, c = {}) => safeUrl(c.newRequestUrl) || safeUrl(ctx.brand.portalUrl) || DEFAULT_BRAND.portalUrl;

// ------------------------------------------------------------- templates --
const T = {};

function applied(ctx) {
  const d = ctx.data;
  const type = ctx.type;
  const noun = NOUN[type];
  const method = obj(d.requestedMethod);
  const methodLabel = str(method.label) || str(method.code).replace(/_/g, ' ');
  const strip = orderStrip(ctx, [type !== 'exchange' ? ['Preferred refund method', methodLabel] : null]);
  const track = { href: ctx.brand.trackUrl, label: type === 'exchange' ? 'Track exchange' : type === 'mixed' ? 'Track request' : 'Track return status' };
  const policy = { href: ctx.brand.returnPolicyUrl, label: type === 'exchange' ? 'Exchange policy' : 'Return policy' };

  let intro; let itemsTitle; let next;
  if (type === 'return') {
    itemsTitle = 'Items being returned';
    intro = h`We've received your return request for ${orderTxt(ctx)}. We're checking the details and will update you on the approval status shortly.`;
    next = h`${sectionTitle('What happens next')}${P("We'll check the images and the reason you provided. Once the request is approved, you'll get instructions for pickup or shipping.", 'margin-top:14px;')}${buttons([track])}`;
  } else {
    itemsTitle = type === 'exchange' ? 'Items for exchange' : 'Items in your request';
    intro = h`We've received your ${noun} for ${orderTxt(ctx)}. Our team is reviewing it and will contact you within 24 hours to confirm the details.`;
    const lastStep = type === 'exchange'
      ? { title: 'Exchange is processed', text: 'Once the items pass our quality check, we process your exchange.' }
      : { title: 'Refund and exchange are processed', text: 'Once the items pass our quality check, we issue the refund and dispatch your exchange item(s).' };
    next = h`${sectionTitle('What happens next')}${steps([
      { title: 'We review your request', text: type === 'exchange' ? 'Our team checks the items and the reason for exchange.' : 'Our team checks the items and the reasons you gave.' },
      { title: 'We contact you', text: 'We call or email you to confirm the options and stock.' },
      { title: 'Pickup is arranged', text: 'We schedule a pickup for the items you are sending back.' },
      lastStep,
    ])}${P(h`If you need us sooner, call ${ctx.brand.supportPhone} or email ${link('mailto:' + ctx.brand.supportEmail, ctx.brand.supportEmail)}.`)}${buttons([track, policy])}`;
  }
  return {
    subject: subjectWith(ctx, `${capFirst(noun)} received`),
    html: ctxShell(ctx, {
      preheader: pre(ctx, type === 'return' ? 'we are reviewing your request' : 'we will contact you within 24 hours'),
      title: `${capFirst(noun)} received`,
      body: h`${title1(`We've received your ${noun}`)}${greet(ctx)}${P(intro)}${strip}${sectionTitle(itemsTitle)}${itemsTable(ctx.items, { showAction: type === 'mixed', showReason: true })}${next}`,
    }),
  };
}
T.return_applied = applied;
T.exchange_applied = applied;
T.mixed_applied = applied;

T.return_rejected = (ctx) => {
  const reason = str(obj(ctx.data.rejection).reason);
  const noun = NOUN[ctx.type];
  return {
    subject: subjectWith(ctx, `${capFirst(noun)} declined`),
    html: ctxShell(ctx, {
      preheader: pre(ctx, `your ${noun} was not approved`),
      title: `${capFirst(noun)} not approved`,
      body: h`${title1(`Your ${noun} was not approved`)}${greet(ctx)}${P(h`We're sorry, but we couldn't approve the ${noun} for ${orderTxt(ctx)}.`)}${orderStrip(ctx)}${noteCard({ label: 'Reason', body: reason ? nl2br(reason) : 'Not specified. Please contact us for details.' })}${P(h`${strong('This decision is final.')} The items in this order are not eligible for ${KIND[ctx.type]}, and a new request can't be submitted for this order.`)}${ctx.items.length ? h`${sectionTitle('Items in this request')}${itemsTable(ctx.items, { showAction: ctx.type === 'mixed' })}` : ''}${P('If you think this is a mistake, please contact us.', 'margin-top:14px;')}${buttons([{ href: ctx.brand.trackUrl, label: 'View return status' }, { href: ctx.brand.returnPolicyUrl, label: 'Return policy' }])}`,
    }),
  };
};

T.return_closed = (ctx) => {
  const c = obj(ctx.data.closure);
  const reason = str(c.reason);
  const noun = NOUN[ctx.type];
  const canResubmit = c.canResubmit !== false;
  return {
    subject: subjectWith(ctx, `${capFirst(noun)} closed`),
    html: ctxShell(ctx, {
      preheader: pre(ctx, `your ${noun} was closed`),
      title: `${capFirst(noun)} closed`,
      body: h`${title1(`Your ${noun} has been closed`)}${greet(ctx)}${P(h`Your ${noun} for ${orderTxt(ctx)} has been closed.`)}${orderStrip(ctx)}${noteCard({ label: 'Reason for closing', body: reason ? nl2br(reason) : 'Not specified.' })}${P(canResubmit ? `You can submit a new ${KIND[ctx.type]} request. Please check the return policy and include all the details we ask for.` : 'If you have any questions about this, please get in touch with our support team.')}${ctx.items.length ? h`${sectionTitle('Items in this request')}${itemsTable(ctx.items, { showAction: ctx.type === 'mixed' })}` : ''}${buttons(canResubmit
        ? [{ href: newRequestUrl(ctx, c), label: `Start a new ${ctx.type === 'exchange' ? 'exchange' : ctx.type === 'mixed' ? 'request' : 'return'}` }, { href: ctx.brand.trackUrl, label: 'View status' }]
        : [{ href: supportMailto(ctx), label: 'Contact support' }, { href: ctx.brand.trackUrl, label: 'View status' }])}`,
    }),
  };
};

T.item_rejected = (ctx) => {
  const d = ctx.data;
  const ri = obj(d.rejectedItem);
  const item = normItem(ri);
  const reason = str(ri.reason) || str(obj(d.rejection).reason);
  const remaining = Math.max(0, Math.floor(num(d.remainingItemsCount) || 0));
  const itemTotal = Number.isFinite(item.lineTotal) ? item.lineTotal : NaN;
  const img = safeUrl(item.image);
  const bits = [item.sku ? `SKU: ${item.sku}` : '', `Qty: ${item.quantity}`].filter(Boolean).join(' | ');
  const money = [Number.isFinite(item.unitPrice) ? `Price: ${fmtINR(item.unitPrice)}` : '', Number.isFinite(itemTotal) ? `Total: ${fmtINR(itemTotal)}` : ''].filter(Boolean).join(' | ');
  const kind = KIND[ctx.type];
  return {
    subject: subjectWith(ctx, 'Item not approved'),
    html: ctxShell(ctx, {
      preheader: pre(ctx, 'one item was not approved'),
      title: `Item not approved for ${kind}`,
      body: h`${title1(`One item was not approved for ${kind}`)}${greet(ctx)}${P(h`We've reviewed the ${NOUN[ctx.type]} for ${orderTxt(ctx)}. One item in the request could not be approved.`)}${orderStrip(ctx)}${sectionTitle('Item not approved')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 18px;"><tr>
${img ? h`<td width="78" valign="top" style="width:78px;padding:0 14px 0 0;"><img src="${img}" width="64" alt="" style="display:block;width:64px;height:auto;border:1px solid ${C.line};border-radius:4px;"></td>` : ''}
<td valign="top" style="font-family:${FF};font-size:14px;line-height:21px;color:${C.ink};word-break:break-word;overflow-wrap:anywhere;"><strong>${item.title}</strong>${item.variant ? h`<br><span style="font-size:12px;color:${C.soft};">${item.variant}</span>` : ''}<br><span style="font-size:13px;color:${C.soft};">${bits}</span>${money ? h`<br><span style="font-size:13px;color:${C.soft};">${money}</span>` : ''}</td>
</tr></table>
${noteCard({ label: 'Reason', body: reason ? nl2br(reason) : 'Not specified. Please contact us for details.' })}${remaining > 0
        ? P(`${remaining === 1 ? 'The other item in your request is' : `The other ${remaining} items in your request are`} still being processed. Your ${NOUN[ctx.type]} stays active for ${remaining === 1 ? 'it' : 'them'}.`)
        : P(`This was the only item in the request, so the ${NOUN[ctx.type]} is now closed.`)}${P('If you need any clarification regarding this decision, please contact our Prashanti customer-care team. We’ll be happy to assist you.')}${buttons([{ href: ctx.brand.trackUrl, label: 'View return status' }, { href: ctx.brand.returnPolicyUrl, label: 'Return policy' }])}`,
    }),
  };
};

T.self_ship_requested = (ctx) => {
  const s = obj(ctx.data.selfShip);
  const w = obj(s.warehouse);
  const deadline = fmtDateIST(s.deadline, { time: false });
  const instructions = str(s.instructions);
  const noun = NOUN[ctx.type];
  const phone = str(ctx.brand.supportPhone);
  const waDigits = phone.replace(/\D/g, '');
  const cityLine = [str(w.city), [str(w.state), str(w.pincode)].filter(Boolean).join(' – ')].filter(Boolean).join(', ');
  const addrLines = [...arr(w.addressLines).map(str).filter(Boolean), cityLine].filter(Boolean);
  const addr = h`${str(w.name) ? h`<strong>${w.name}</strong>` : ''}${addrLines.map((l) => h`<br>${l}`)}${str(w.phone) ? h`<br>Phone: ${w.phone}` : ''}`;
  const refundable = ctx.items.filter((i) => i.action !== 'exchange');
  const refundTotal = refundable.reduce((a, i) => a + (Number.isFinite(i.lineTotal) ? i.lineTotal : 0), 0);
  const closing = ctx.type === 'exchange'
    ? 'Your exchange will be processed after we receive and inspect the items.'
    : ctx.type === 'mixed'
      ? 'Your refund and exchange will be processed after we receive and inspect the items.'
      : 'Your refund will be processed within 5 to 7 business days after we receive and inspect the items.';
  return {
    subject: subjectWith(ctx, 'Self-ship instructions for your return'),
    html: ctxShell(ctx, {
      preheader: pre(ctx, `your ${KIND[ctx.type]} is approved`),
      title: 'Self-ship instructions',
      body: h`${title1(ctx.type === 'exchange' ? 'Your exchange is approved' : ctx.type === 'mixed' ? 'Your request is approved' : 'Your return is approved')}${greet(ctx)}${P(h`Your ${noun} for ${orderTxt(ctx)} has been approved. Please send the items back to our warehouse with any courier service you like.`)}${orderStrip(ctx)}${deadline ? noteCard({ label: 'Please ship by', title: deadline }) : ''}${sectionTitle('Ship to this address')}<div style="height:14px;line-height:14px;font-size:14px;">&nbsp;</div>${noteCard({ label: 'Warehouse address', body: addr })}${instructions ? noteCard({ label: 'Additional instructions from our team', body: nl2br(instructions) }) : ''}${sectionTitle('Packing and shipping instructions')}${bullets([
        'Pack the item securely with all original tags, labels, and accessories.',
        h`Write your ${ctx.ran ? h`RAN ${strong(ctx.ran)}` : 'Order ID'}${ctx.orderName ? h` and Order ID ${strong('#' + ctx.orderName)}` : ''} clearly on the package and put a copy of this email inside.`,
        'Ship the package using a reliable courier service.',
        'Once shipped, please share the courier and tracking details with us via a support ticket, email, or WhatsApp.',
        'Please retain the shipping receipt for your records. Shipping charges are subject to our published return policy.',
      ])}${sectionTitle('Send us your tracking details')}${kvTable([
        ['Email', link('mailto:' + ctx.brand.supportEmail, ctx.brand.supportEmail)],
        ['WhatsApp', waDigits.length >= 8 ? link('https://wa.me/' + waDigits, phone) : phone],
      ], { margin: '0 0 24px', flush: true })}${ctx.items.length ? h`${sectionTitle('Items to return')}${itemsTable(ctx.items, { showAction: ctx.type === 'mixed', total: ctx.type !== 'exchange' && refundTotal > 0 ? { label: 'Total refund amount', amount: refundTotal } : null })}` : ''}${P(closing, 'margin-top:14px;')}${P('Thank you for your cooperation and support.')}${buttons([{ href: ctx.brand.trackUrl, label: 'Track return status' }])}`,
    }),
  };
};

T.pickup_created = (ctx) => {
  const p = obj(ctx.data.pickup);
  const a = obj(p.address);
  const courier = str(p.courier) || 'our courier partner';
  const date = str(p.pickupDateDisplay) || fmtDateIST(p.pickupDate, { time: false });
  const trackingUrl = safeUrl(p.trackingUrl);
  const awb = str(p.awb);
  const cityLine = [str(a.city), [str(a.state), str(a.pincode)].filter(Boolean).join(' – ')].filter(Boolean).join(', ');
  const addrLines = [...arr(a.lines).map(str).filter(Boolean), cityLine].filter(Boolean);
  const phone = maskPhone(a.phone);
  const addr = str(a.name) || addrLines.length
    ? h`${str(a.name) ? h`${a.name}` : ''}${addrLines.map((l, i) => h`${i || str(a.name) ? raw('<br>') : ''}${l}`)}${phone ? h`<br>Phone: ${phone}` : ''}`
    : raw('');
  return {
    subject: subjectWith(ctx, `Pickup scheduled${date ? ' for ' + date : ''}`),
    html: ctxShell(ctx, {
      preheader: pre(ctx, date ? `pickup on ${date}` : 'your pickup is scheduled'),
      title: 'Pickup scheduled',
      body: h`${title1('Your pickup is scheduled')}${greet(ctx)}${P(h`The pickup for ${orderTxt(ctx)} is scheduled. ${courier === 'our courier partner' ? 'Our courier partner' : courier} will collect the items from your address.`)}${orderStrip(ctx)}${sectionTitle('Pickup details')}${kvTable([
        ['Date', date],
        ['Time slot', str(p.timeWindow)],
        ['Courier', str(p.courier)],
        ['Tracking number', awb || 'Will be updated soon'],
        ['Pickup address', addr],
      ], { margin: '0 0 24px', flush: true })}${sectionTitle('Before the pickup')}${bullets([
        'Pack the items securely, in the original packaging if possible.',
        'Include all tags and accessories.',
        ctx.ran ? h`Write your RAN ${strong(ctx.ran)} on the package and keep a copy of this email or the return label ready.` : 'Keep a copy of this email or the return label ready.',
        awb ? h`Hand the package only to the pickup agent and check that the tracking number ${strong(awb)} matches.` : 'Hand the package to the pickup agent.',
      ])}${P('Someone needs to be at the address during the time slot. To reschedule, please contact us at least 24 hours before the pickup.')}${buttons(trackingUrl
        ? [{ href: trackingUrl, label: 'Track pickup' }, { href: ctx.brand.trackUrl, label: 'View request status' }]
        : [{ href: ctx.brand.trackUrl, label: 'Track pickup' }])}`,
    }),
  };
};

T.pickup_cancelled = (ctx) => {
  const c = obj(ctx.data.cancellation);
  const reason = str(c.reason);
  const notes = str(c.notes);
  const reschedule = c.rescheduleAllowed === true || c.rescheduleAllowed === 'true';
  const awb = str(c.awb);
  const nextText = notes
    || (reschedule
      ? "Your request is still active and we'll arrange a new pickup. You'll receive a new confirmation e-mail with the new tracking number and date. Please don't hand the parcel to anyone quoting the cancelled tracking number."
      : 'Your return request is still active. You can schedule a new pickup or ship the items yourself.');
  return {
    subject: subjectWith(ctx, 'Pickup cancelled'),
    html: ctxShell(ctx, {
      preheader: pre(ctx, 'your pickup was cancelled'),
      title: 'Pickup cancelled',
      body: h`${title1('Your pickup was cancelled')}${greet(ctx)}${P(h`The pickup scheduled for ${orderTxt(ctx)} has been cancelled.`)}${orderStrip(ctx, [['Cancelled tracking number', awb]])}${noteCard({ label: 'Cancellation reason', body: reason ? nl2br(reason) : 'No reason provided' })}${sectionTitle('Next steps')}${P(nl2br(nextText), 'margin-top:14px;')}${reschedule ? '' : bullets([
        h`${strong('Reschedule the pickup.')} Choose a new date and time.`,
        h`${strong('Self-ship the items.')} Send them back with a courier of your choice.`,
      ])}${sectionTitle('Prashanti customer care')}${P('If you need help with either option, please get in touch.', 'margin-top:14px;')}${kvTable([
        ['Email', link('mailto:' + ctx.brand.supportEmail, ctx.brand.supportEmail)],
        ['Phone', ctx.brand.supportPhone],
      ], { margin: '0 0 24px', flush: true })}${buttons([{ href: ctx.brand.trackUrl, label: 'Reschedule pickup' }, { href: supportMailto(ctx), label: 'Contact support' }])}`,
    }),
  };
};

T.return_received = (ctx) => {
  const r = obj(ctx.data.receipt);
  const when = str(r.receivedAtDisplay) || fmtDateIST(r.receivedAt);
  const accepted = arr(r.itemsAccepted).map((t) => (isObj(t) ? str(t.title) : str(t))).filter(Boolean);
  const rejected = arr(r.itemsRejected).map((x) => (isObj(x) ? { title: str(x.title) || 'Item', reason: str(x.reason) } : { title: str(x), reason: '' })).filter((x) => x.title);
  const pool = ctx.items.slice();
  const acceptedRows = accepted.map((title) => {
    const i = pool.findIndex((it) => it.title === title);
    return i >= 0 ? pool.splice(i, 1)[0] : { title };
  });
  const nextStep = str(r.nextStep).toLowerCase() || (ctx.type === 'mixed' ? 'mixed' : ctx.type === 'exchange' ? 'exchange' : 'refund');
  const exchangeOnly = nextStep === 'exchange';
  const hasExchange = nextStep === 'mixed';
  const refundTotal = acceptedRows.filter((i) => i.action !== 'exchange').reduce((a, i) => a + (Number.isFinite(i.lineTotal) ? i.lineTotal : 0), 0);
  const stepList = exchangeOnly
    ? [
      { title: 'Replacement order is prepared', text: "We're preparing your replacement order. You don't need to do anything." },
      { title: 'Shipping confirmation', text: "You'll get an email once your replacement order has shipped." },
    ]
    : [
      { title: 'Refund is processed', text: "Your refund will be processed within 5 to 7 business days. You don't need to do anything." },
      { title: 'Refund confirmation', text: "You'll get an email once the refund is complete." },
      hasExchange ? { title: 'Exchange is processed separately', text: "We'll email you when your replacement item ships." } : null,
    ];
  const typeLabel = exchangeOnly ? 'Exchange' : hasExchange ? 'Return and exchange' : 'Return';
  return {
    subject: subjectWith(ctx, "We've received your returned items"),
    html: ctxShell(ctx, {
      preheader: pre(ctx, "we've received your items"),
      title: exchangeOnly ? 'Exchange received' : 'Return received',
      body: h`${title1(exchangeOnly ? "We've received your exchange items" : "We've received your return")}${greet(ctx)}${P(h`We've received the ${exchangeOnly ? 'exchange' : 'returned'} items for ${orderTxt(ctx)}, and our team has checked them. Here is what happens next.`)}${sectionTitle('Order details')}${kvTable([
        ['Order ID', ctx.orderName ? h`#${ctx.orderName}` : ''],
        ['RAN', ctx.ran],
        ['Request type', typeLabel],
        ['Received on', when],
      ], { margin: '0 0 24px', flush: true })}${acceptedRows.length ? h`${sectionTitle(exchangeOnly ? 'Exchange items' : 'Returned items')}${itemsTable(acceptedRows, { showAction: ctx.type === 'mixed', total: !exchangeOnly && refundTotal > 0 ? { label: 'Total refund amount', amount: refundTotal } : null })}` : ''}${rejected.length
        ? h`${sectionTitle(rejected.length > 1 ? 'Items not accepted' : 'Item not accepted')}<div style="height:14px;line-height:14px;font-size:14px;">&nbsp;</div>${rejected.map((x) => noteCard({ label: x.title, body: x.reason ? h`Reason: ${x.reason}` : 'Not specified.' }))}`
        : ''}${sectionTitle('What happens next')}${steps(stepList)}${buttons([{ href: ctx.brand.trackUrl, label: exchangeOnly ? 'Track exchange status' : 'Track refund status' }])}`,
    }),
  };
};

T.refund_done = (ctx) => {
  const r = obj(ctx.data.refund);
  const method = str(r.method).toLowerCase();
  const methodLabel = str(r.methodLabel) || {
    gift_card: 'Gift card', store_credit: 'Store credit', original_payment: 'Original payment method', manual: 'Bank transfer / manual refund',
  }[method] || 'Refund';
  const amount = fmtINR(r.amount);
  const code = str(r.giftCardCode);
  const expires = fmtDateIST(r.giftCardExpiresOn, { time: false });
  const reference = /^gid:\/\//i.test(str(r.reference)) ? '' : str(r.reference);
  const timeline = str(r.expectedTimeline);
  const b = isObj(r.breakdown) ? r.breakdown : null;
  // Mixed request: only the returned items are refunded (exchange items are replaced).
  const returnedOnly = ctx.items.filter((i) => i.action === 'return');
  const refunded = ctx.type === 'mixed' && returnedOnly.length ? returnedOnly : ctx.items;
  const methodCopy = {
    gift_card: 'Your refund has been issued as a gift card. Use the code below at checkout on our website; it can be applied to one or more orders until the balance is used up.',
    store_credit: 'Your refund has been added as store credit to your account linked to this e-mail address. It will be available at checkout on your next purchase.',
    original_payment: `The refund goes back to the payment method used for this order.${timeline ? ` Depending on your bank, it usually reflects within ${timeline}.` : ''}`,
    manual: `Your refund has been transferred to the account details you shared with us.${timeline ? ` It usually reflects within ${timeline}.` : ''}`,
  }[method] || 'Your refund has been processed.';
  const money = b
    ? moneyRows([
      { label: 'Items value', amount: b.itemsValue },
      ...arr(b.deductions).map((dd) => ({ label: str(obj(dd).label) || 'Deduction', amount: obj(dd).amount, negative: true })),
      { label: 'Shipping refund', amount: num(b.shippingRefund) ? b.shippingRefund : null },
    ], { label: 'Total refund', amount: hasNum(b.total) ? b.total : r.amount })
    : moneyRows([], { label: 'Total refund', amount: r.amount });
  const destSub = h`${methodCopy}${reference ? h`<br>${method === 'original_payment' ? 'Transaction ID' : 'Reference'}: ${reference}` : ''}${timeline && (method === 'original_payment' || method === 'manual') ? h`<br>Expected timeline: ${timeline}` : ''}`;
  const shop = ctx.brand.shopUrl;
  return {
    subject: subjectWith(ctx, amount ? `Refund of ${amount} processed` : 'Refund processed'),
    html: ctxShell(ctx, {
      preheader: pre(ctx, 'refund processed'),
      title: 'Refund processed',
      body: h`${title1('Your refund has been processed')}${greet(ctx)}${P(h`Your refund for ${orderTxt(ctx)} has been processed${ctx.type === 'exchange' ? '' : ' based on your return request'}.`)}${orderStrip(ctx)}${sectionTitle('Refund details')}${money}${refunded.length ? h`${sectionTitle(ctx.type === 'exchange' ? 'Items in this request' : 'Items included in the return')}${itemsTable(refunded)}` : ''}${sectionTitle('Refund destination')}<div style="height:14px;line-height:14px;font-size:14px;">&nbsp;</div>${noteCard({ label: 'Your refund is credited to', title: methodLabel, sub: destSub })}${method === 'gift_card' && code
        ? h`${codeBox({ label: 'Your gift card code', value: code, size: 24, sub: expires ? `Valid until ${expires}` : 'Enter this code in the gift card / discount field at checkout.' })}${P('Keep this code safe. Anyone with the code can use the balance, and we will never ask you to share it.', 'font-size:13px;line-height:20px;color:#666666;')}`
        : ''}${method === 'original_payment' ? P(`If the amount hasn't reflected after ${timeline || '7 business days'}, please contact your bank with the transaction ID above, or reach out to us.`, 'font-size:13px;line-height:20px;color:#666666;') : ''}${P('Refunds are credited as Store Credit, a Gift Card, or to your Original Payment Method, depending on the option approved for your order.')}${buttons([{ href: ctx.brand.trackUrl, label: 'Track request' }, { href: shop, label: 'Continue shopping' }])}`,
    }),
  };
};

T.exchange_processed = (ctx) => {
  const e = obj(ctx.data.exchange);
  const outcome = str(e.outcome).toLowerCase();
  const amount = num(e.amount);
  const amt = Number.isFinite(amount) && amount > 0 ? fmtINR(amount) : '';
  const invoiceSent = e.invoiceSent === true || e.invoiceSent === 'true';
  let outTitle; let outText;
  if (outcome === 'refund') {
    outTitle = amt ? `${amt} is due back to you` : 'A refund is due to you';
    outText = "Your new item(s) cost less than the item(s) you returned. We'll refund the difference and send you a separate confirmation once it's issued.";
  } else if (outcome === 'extra') {
    outTitle = amt ? `Balance payable: ${amt}` : 'Balance payable';
    outText = invoiceSent
      ? "Your new item(s) cost more than the item(s) you returned. We've e-mailed you a payment invoice from our online store in a separate message. Please complete the payment using the link in that e-mail so we can dispatch your order."
      : 'Your new item(s) cost more than the item(s) you returned. Our team will share the payment details with you shortly; your order will be dispatched once the payment is received.';
  } else {
    outTitle = 'Even exchange: nothing more to pay';
    outText = 'The value of your new item(s) matches the item(s) you returned. The replacement will be packed and shipped.';
  }
  const sent = arr(e.itemsSent);
  const returned = arr(e.itemsReturned).length ? arr(e.itemsReturned) : ctx.items;
  const closing = outcome === 'extra'
    ? 'Your exchange has been processed. The replacement item will be shipped to your original shipping address once the balance is paid. Thank you for your patience and understanding.'
    : 'Your exchange has been successfully processed. The replacement item will be shipped shortly to your original shipping address. Thank you for your patience and understanding.';
  return {
    subject: subjectWith(ctx, outcome === 'extra' && amt ? `Exchange processed — balance ${amt} payable` : 'Exchange processed'),
    html: ctxShell(ctx, {
      preheader: pre(ctx, outcome === 'extra' ? 'exchange processed, balance payable' : 'exchange processed'),
      title: 'Exchange processed',
      body: h`${title1('Your exchange has been processed')}${greet(ctx)}${P(h`Your exchange for ${orderTxt(ctx)} has been processed based on your exchange request.`)}${orderStrip(ctx)}${noteCard({ label: 'Exchange outcome', title: outTitle, sub: outText })}${sectionTitle('Exchange summary')}${groupedItems([
        { label: returned.length > 1 ? 'Returned products' : 'Returned product', items: returned },
        { label: sent.length > 1 ? 'Replacement products' : 'Replacement product', items: sent },
      ])}${P(closing, 'margin-top:14px;')}${buttons([{ href: ctx.brand.trackUrl, label: 'Track request' }, { href: ctx.brand.shopUrl, label: 'Continue shopping' }])}`,
    }),
  };
};

T.agent_otp = (_ctx, data) => {
  const agent = obj(data.agent);
  const brand = makeBrand(data);
  const otp = str(data.otp != null ? String(data.otp) : '');
  if (!/^\d{4,8}$/.test(otp)) throw new Error('Re-Guard Render Email: agent_otp payload needs a 4–8 digit numeric `otp`.');
  const mins = Math.floor(num(data.expiryMinutes));
  const validity = Number.isFinite(mins) && mins > 0 ? plural(mins, 'minute', 'minutes') : '10 minutes';
  return {
    subject: 'Your Re-Guard verification code',
    html: shell({
      brand,
      staff: true,
      preheader: 'Your one-time code to reset your password',
      title: 'Your OTP for password reset',
      body: h`${str(agent.name) ? P(h`Hi ${str(agent.name).split(/\s+/)[0]},`) : ''}${P('We received a request to reset your password. Use the one-time code below to verify your identity and continue.')}${codeBox({ label: 'Your OTP', value: otp, sub: `This code expires in ${validity}.` })}${P('If you did not request this, please ignore this message.')}`,
    }),
  };
};

// ------------------------------------------------------------- dispatch ----
function readPayload(json) {
  let data = json && json.body !== undefined && json.body !== null ? json.body : json;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (err) { throw new Error('Re-Guard Render Email: request body is not valid JSON.'); }
  }
  if (!isObj(data)) throw new Error('Re-Guard Render Email: request body must be a JSON object.');
  return data;
}

function resolveEvent(data, json) {
  let ev = str(data.event).toLowerCase().replace(/-/g, '_');
  if (!ev) {
    const url = str(obj(json).webhookUrl);
    const m = /\/([a-z-]+)\/?$/.exec(url);
    if (m && PATH_EVENTS[m[1]]) ev = PATH_EVENTS[m[1]];
  }
  return EVENT_ALIASES[ev] || ev;
}

function renderEmail(json) {
  const data = readPayload(json);
  const event = resolveEvent(data, json);
  if (!event || !T[event]) {
    throw new Error(`Re-Guard Render Email: unknown event "${event || '(missing)'}". Expected one of: ${Object.keys(T).join(', ')}.`);
  }
  const recipient = str(data.recipient) || (event === 'agent_otp' ? str(obj(data.agent).email) : '');
  if (!isEmail(recipient)) {
    throw new Error(`Re-Guard Render Email: missing or invalid "recipient" for event "${event}".`);
  }
  const ctx = event === 'agent_otp' ? null : buildContext(data, event);
  const out = T[event](ctx, data);
  const subject = out.subject.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return {
    event,
    recipient,
    subject,
    html: out.html,
    returnId: ctx ? (str(ctx.request.returnId) || ctx.orderName) : '',
  };
}

// --------------------------------------------------------------- n8n I/O ----
return { json: renderEmail($json) };

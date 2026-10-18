#!/usr/bin/env node
// Renders every sample payload through the *exact* "Render Email" code embedded in
// n8n/reguard-email-workflow.json (run in a node:vm sandbox that mimics the n8n Code
// node in "Run Once for Each Item" mode), writes n8n/previews/<event>.html and runs
// edge-case tests. Exits non-zero on any failure.
//
//   node n8n/render-preview.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const workflow = JSON.parse(readFileSync(join(here, 'reguard-email-workflow.json'), 'utf8'));
const codeNode = workflow.nodes.find((n) => n.name === 'Render Email');
if (!codeNode) throw new Error('Render Email node not found in workflow JSON');
if (codeNode.parameters.mode !== 'runOnceForEachItem') throw new Error('Render Email must run once for each item');
const jsCode = codeNode.parameters.jsCode;
const script = new vm.Script(`(async () => {\n${jsCode}\n})()`, { filename: 'RenderEmail.js' });

const EVENTS = [
  'agent_otp', 'return_applied', 'exchange_applied', 'mixed_applied', 'return_rejected', 'return_closed',
  'item_rejected', 'self_ship_requested', 'pickup_created', 'pickup_cancelled', 'return_received',
  'refund_done', 'exchange_processed',
];

let failures = 0;
let passes = 0;
const fail = (name, msg) => { failures++; console.error(`  ✗ ${name}: ${msg}`); };
const ok = (name) => { passes++; console.log(`  ✓ ${name}`); };

// Simulates the n8n webhook node output for one request.
function webhookItem(body, path = 'reguard-notify') {
  return {
    headers: { 'content-type': 'application/json', 'x-reguard-token': '***' },
    params: {}, query: {}, body,
    webhookUrl: `https://n8n.example.com/webhook/${path}`,
    executionMode: 'production',
  };
}

async function render(json) {
  const item = { json };
  const sandbox = {
    $json: json,
    $input: { item, first: () => item, last: () => item, all: () => [item] },
    items: [item],
    console,
  };
  const res = await script.runInNewContext(sandbox, { timeout: 2000 });
  const out = res && res.json ? res.json : res;
  if (!out || typeof out !== 'object') throw new Error('Code node returned no item');
  return out;
}

// Output checks shared by every rendered e-mail.
function lint(out, { expectEscaped = [] } = {}) {
  const errs = [];
  for (const k of ['recipient', 'subject', 'html', 'event']) if (typeof out[k] !== 'string' || !out[k]) errs.push(`missing ${k}`);
  const html = out.html || '';
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  if (/<script/i.test(html)) errs.push('un-escaped <script in html');
  // event-handler attributes inside real tags (quoted attribute values blanked first)
  for (const m of html.matchAll(/<[a-z][^>]*>/gi)) {
    if (/\son[a-z]+\s*=/i.test(m[0].replace(/"[^"]*"/g, '""'))) { errs.push(`event handler attribute in tag: ${m[0].slice(0, 80)}`); break; }
  }
  if (/javascript:/i.test(html)) errs.push('javascript: URL in html');
  const junk = /\b(undefined|null|NaN)\b/.exec(text) || /\b(undefined|null|NaN)\b/.exec(out.subject || '');
  if (junk) errs.push(`literal "${junk[1]}" in output near: ${text.slice(Math.max(0, junk.index - 60), junk.index + 40).replace(/\s+/g, ' ')}`);
  if (/\[object Object\]/.test(html + out.subject)) errs.push('[object Object] in output');
  if (/[\r\n]/.test(out.subject || '')) errs.push('newline in subject');
  if (!/<!DOCTYPE html>/.test(html) || !/<\/html>\s*$/.test(html)) errs.push('incomplete html document');
  // header band + footer logo (reguard-logo-bg.png) + the old text footer must be gone
  if (!html.includes('https://prashantireturns.web.app/reguard-logo-bg.png') || !html.includes('alt="Re-guard by Prashanti"')) errs.push('footer logo (reguard-logo-bg.png) missing');
  const footer = html.slice(html.indexOf('<!-- Footer -->'));
  if (/©|&copy;|Wedtree/i.test(footer)) errs.push('old text footer (© / Wedtree) still present');
  if ((footer.match(/Re-guard by Prashanti/g) || []).length !== 1) errs.push('footer must carry the Re-guard brand only once (as the logo alt)');
  if (html.includes('reguard-logo.png')) errs.push('legacy reguard-logo.png still referenced');
  if (!/max-width:600px/.test(html)) errs.push('600px container missing');
  for (const needle of expectEscaped) if (html.includes(needle)) errs.push(`raw (unescaped) text found: ${needle}`);
  // every <img> must have alt
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) if (!/\balt="/.test(m[0])) errs.push('img without alt');
  return errs;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const load = (ev) => JSON.parse(readFileSync(join(here, 'sample-payloads', `${ev}.json`), 'utf8'));

// ---------------------------------------------------------------- samples --
console.log('Rendering sample payloads');
mkdirSync(join(here, 'previews'), { recursive: true });
const sampleFiles = readdirSync(join(here, 'sample-payloads')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
for (const ev of EVENTS) if (!sampleFiles.includes(ev)) fail(ev, 'sample payload missing');
const rendered = {};
for (const ev of EVENTS.filter((e) => sampleFiles.includes(e))) {
  try {
    const payload = load(ev);
    if (payload.event !== ev) throw new Error(`sample event is ${payload.event}`);
    const out = await render(webhookItem(payload));
    const errs = lint(out);
    if (out.event !== ev) errs.push(`event ${out.event} != ${ev}`);
    if (out.recipient !== payload.recipient) errs.push('recipient mismatch');
    if (errs.length) { fail(ev, errs.join('; ')); continue; }
    rendered[ev] = out;
    writeFileSync(join(here, 'previews', `${ev}.html`), out.html);
    ok(`${ev.padEnd(20)} "${out.subject}"`);
  } catch (e) {
    fail(ev, e.stack || e.message);
  }
}

// ---------------------------------------------------- content assertions --
console.log('\nContent assertions');
const must = (name, cond, msg) => (cond ? ok(name) : fail(name, msg));
if (rendered.refund_done) {
  const html = rendered.refund_done.html;
  must('refund_done shows gift card code', html.includes('PSRG-7KQ2-M9XD-4TWA'), 'code missing');
  must('refund_done shows ₹ amount with en-IN grouping', html.includes('₹18,349.00'), 'amount missing');
  must('refund_done shows expiry in IST format', html.includes('14 Oct 2027'), 'expiry missing');
  must('refund_done preheader/subject do not leak code', !rendered.refund_done.subject.includes('PSRG') && !/display:none[^>]*>[^<]*PSRG/.test(html), 'code leaked');
}
for (const ev of EVENTS.filter((e) => e !== 'refund_done' && rendered[e])) {
  if (rendered[ev].html.includes('PSRG-')) fail(`${ev} no gift code`, 'gift code leaked');
}
if (rendered.pickup_created) {
  const html = rendered.pickup_created.html;
  must('pickup_created shows AWB + masked phone', html.includes('81234567890') && !html.includes('98450'), 'AWB missing or phone unmasked');
}
for (const ev of EVENTS.filter((e) => rendered[e])) {
  if (rendered[ev].html.includes('98450 12345') || rendered[ev].html.includes('9845012345')) fail(`${ev} phone`, 'customer phone appears unmasked');
}
if (rendered.agent_otp) {
  const o = rendered.agent_otp;
  must('agent_otp shows code, text header, no policy link', o.html.includes('482913') && /<!-- Header -->[\s\S]*Re-guard <span[\s\S]*<!-- Content -->/.test(o.html) && !o.html.includes('Return &amp; refund policy'), 'bad OTP mail');
  must('agent_otp subject has no code', !o.subject.includes('482913'), 'OTP in subject');
}
if (rendered.self_ship_requested) {
  const html = rendered.self_ship_requested.html;
  must('self_ship shows warehouse, RAN, deadline', html.includes('Usman Road') && html.includes('R1000123-905422') && html.includes('16 Oct 2026'), 'missing content');
}
if (rendered.return_applied) {
  must('return_applied subject format', rendered.return_applied.subject === 'Return request received — Order P905422 (RAN R1000123-905422)', rendered.return_applied.subject);
  must('return_applied has track button', rendered.return_applied.html.includes('ReturnStatusPage?order=P905422'), 'track url missing');
  must('order strip shows Order ID + RAN', rendered.return_applied.html.includes('#P905422') && rendered.return_applied.html.includes('R1000123-905422'), 'order strip missing');
  must('header uses the Prashanti logo (not reguard-logo)', /<!-- Header -->[\s\S]*Prashanti-Logo-white[\s\S]*<!-- Content -->/.test(rendered.return_applied.html), 'header logo missing');
}

// every free-text block from the payload must really be rendered (cards, reasons, notes)
const showsAll = (ev, needles) => {
  if (!rendered[ev]) return;
  const miss = needles.filter((n) => !rendered[ev].html.includes(n));
  must(`${ev} renders its text blocks`, miss.length === 0, `missing: ${miss.join(' | ')}`);
};
const sampleOf = (ev) => load(ev);
{
  const rj = sampleOf('return_rejected'); showsAll('return_rejected', [rj.rejection.reason.slice(0, 40).replace(/'/g, '&#39;')]);
  const cl = sampleOf('return_closed'); showsAll('return_closed', [cl.closure.reason.slice(0, 40).replace(/'/g, '&#39;')]);
  const ir = sampleOf('item_rejected'); showsAll('item_rejected', [ir.rejectedItem.reason.slice(0, 40).replace(/'/g, '&#39;')]);
  const ss = sampleOf('self_ship_requested'); showsAll('self_ship_requested', [ss.selfShip.instructions.split('\n')[0].slice(0, 40), 'Additional instructions']);
  const pc = sampleOf('pickup_cancelled'); showsAll('pickup_cancelled', [pc.cancellation.reason.slice(0, 40).replace(/'/g, '&#39;')]);
}

// ------------------------------------------------------------- edge cases --
console.log('\nEdge cases');
async function expectOk(name, json, opts = {}) {
  try {
    const out = await render(json);
    const errs = lint(out, opts);
    if (opts.check) { const m = opts.check(out); if (m) errs.push(m); }
    if (errs.length) fail(name, errs.join('; ')); else ok(name);
    return out;
  } catch (e) { fail(name, e.stack || e.message); }
}
async function expectThrow(name, json, re) {
  try { await render(json); fail(name, 'expected an error, got output'); }
  catch (e) { if (re && !re.test(e.message)) fail(name, `wrong error: ${e.message}`); else ok(`${name} → "${e.message.slice(0, 70)}…"`); }
}

const INJ = '<script>alert("x")</script><img src=x onerror=alert(1)>';
const LONG = 'Handwoven Banarasi Katan Silk Saree with Intricate Kadwa Meenakari Jaal, Antique Zari Pallu and Contrast Blouse Piece '.repeat(3).trim();
const INJ_ESC = ['<script>alert', '<img src=x', '"><script'];

for (const ev of EVENTS) {
  if (!sampleFiles.includes(ev)) continue;
  const base = load(ev);
  // 1. HTML injection in every string field
  const inj = clone(base);
  const poison = (o) => {
    for (const k of Object.keys(o)) {
      if (['event', 'recipient', 'otp', 'logoUrl', 'headerLogoUrl', 'footerLogoUrl', 'shopUrl', 'trackUrl', 'website', 'portalUrl', 'returnPolicyUrl', 'newRequestUrl', 'trackingUrl', 'image', 'supportEmail', 'method', 'outcome', 'nextStep', 'action', 'type', 'code', 'submittedAt', 'receivedAt', 'pickupDate', 'deadline', 'giftCardExpiresOn'].includes(k)) continue;
      if (typeof o[k] === 'string') o[k] = o[k] + ' ' + INJ;
      else if (o[k] && typeof o[k] === 'object') poison(o[k]);
    }
  };
  poison(inj);
  if (Array.isArray(inj.receipt?.itemsAccepted)) inj.receipt.itemsAccepted = inj.receipt.itemsAccepted.map((t) => t + INJ);
  inj.brand.trackUrl = 'javascript:alert(1)';
  if (inj.items?.[0]) inj.items[0].image = '"><script>alert(1)</script>';
  await expectOk(`${ev}: HTML injection escaped`, webhookItem(inj), { expectEscaped: INJ_ESC });

  if (ev === 'agent_otp') continue;
  // 2. minimal envelope: only event + recipient + event block, no images/variants/breakdown/optional fields
  const min = { event: ev, recipient: base.recipient };
  for (const k of ['rejection', 'closure', 'rejectedItem', 'selfShip', 'pickup', 'cancellation', 'receipt', 'refund', 'exchange', 'requestedMethod']) {
    if (base[k]) min[k] = {};
  }
  min.items = [{ title: 'Silk saree', quantity: 1 }];
  await expectOk(`${ev}: minimal payload (no optional fields)`, webhookItem(min));

  // 3. very long names, no images/variants, null-ish values
  const lng = clone(base);
  for (const it of lng.items || []) { it.title = LONG; delete it.image; delete it.variant; it.sku = null; it.unitPrice = null; it.lineTotal = 'NaN'; }
  if (lng.rejectedItem) { lng.rejectedItem.title = LONG; delete lng.rejectedItem.image; }
  if (lng.exchange) lng.exchange.itemsSent = [{ title: LONG, quantity: 1 }];
  if (lng.receipt) lng.receipt.itemsAccepted = [LONG];
  if (lng.refund) { delete lng.refund.breakdown; delete lng.refund.giftCardExpiresOn; }
  if (lng.customer) lng.customer.name = null;
  await expectOk(`${ev}: long names, no images/variant/breakdown, nulls`, webhookItem(lng), {
    // pickup_cancelled and pickup_created intentionally list no items (the reference template doesn't)
    check: (out) => (ev === 'pickup_cancelled' || ev === 'pickup_created' || out.html.includes(LONG.slice(0, 40)) ? '' : 'long title missing'),
  });
}

// refund method variants + exchange outcome variants
for (const method of ['store_credit', 'original_payment', 'manual']) {
  const p = load('refund_done');
  p.refund = { method, methodLabel: method === 'manual' ? 'Manual – UPI' : '', amount: 2499, reference: 'TXN-55129', expectedTimeline: '5–7 business days' };
  await expectOk(`refund_done: ${method}`, webhookItem(p), { check: (o) => (o.html.includes('₹2,499.00') ? '' : 'amount missing') });
}
for (const [outcome, invoiceSent] of [['even', false], ['refund', false], ['extra', false], ['extra', true]]) {
  const p = load('exchange_processed');
  Object.assign(p.exchange, { outcome, invoiceSent, amount: outcome === 'even' ? 0 : 1234567.5 });
  await expectOk(`exchange_processed: ${outcome}${invoiceSent ? ' + invoice' : ''}`, webhookItem(p), {
    check: (o) => (outcome !== 'even' && !o.html.includes('₹12,34,567.50') ? 'en-IN grouping wrong' : ''),
  });
}
{
  const p = load('pickup_cancelled'); p.cancellation.rescheduleAllowed = false; delete p.cancellation.notes;
  await expectOk('pickup_cancelled: no reschedule', webhookItem(p));
  const q = load('return_closed'); q.closure.canResubmit = false;
  await expectOk('return_closed: cannot resubmit', webhookItem(q));
  const r = load('return_received'); r.receipt.itemsRejected = [{ title: 'Unknown saree', reason: 'Not part of this order' }]; r.receipt.itemsAccepted = ['Kanchipuram Pure Silk Saree – Maroon with Gold Zari Border'];
  await expectOk('return_received: with rejected items', webhookItem(r), { check: (o) => (o.html.includes('Not part of this order') ? '' : 'rejected reason missing') });
  const s = load('pickup_created'); s.pickup.address.phone = '9845012345';
  await expectOk('pickup_created: unmasked phone gets masked', webhookItem(s), { check: (o) => (o.html.includes('9845012345') ? 'phone not masked' : '') });
  const brandless = load('return_applied'); delete brandless.brand;
  await expectOk('no brand block → defaults', webhookItem(brandless), { check: (o) => (o.html.includes('https://prashantireturns.web.app/reguard-logo-bg.png') && o.html.includes('Prashanti-Logo-white') && o.html.includes('ReturnStatusPage?order=P905422') ? '' : 'brand fallback failed') });
}

// input shapes
await expectOk('payload at top level (no body wrapper)', load('return_applied'));
await expectOk('body as JSON string', webhookItem(JSON.stringify(load('return_applied'))));
{
  const p = load('pickup_created'); delete p.event;
  await expectOk('event inferred from webhook path', webhookItem(p, 'pickup-created'), { check: (o) => (o.event === 'pickup_created' ? '' : `got ${o.event}`) });
  const k = load('refund_done'); k.event = 'refund-done';
  await expectOk('kebab-case event accepted', webhookItem(k), { check: (o) => (o.event === 'refund_done' ? '' : `got ${o.event}`) });
}

// failures that must stop the execution
{
  const p = load('return_applied'); delete p.recipient;
  await expectThrow('missing recipient throws', webhookItem(p), /recipient/);
  const q = load('return_applied'); q.recipient = 'not-an-email';
  await expectThrow('invalid recipient throws', webhookItem(q), /recipient/);
  const r = load('return_applied'); r.recipient = 'a@b.com\r\nBcc: evil@x.com';
  await expectThrow('header-injection recipient throws', webhookItem(r), /recipient/);
  const s = load('return_applied'); s.event = 'something_else';
  await expectThrow('unknown event throws', webhookItem(s), /unknown event/);
  const t = load('return_applied'); delete t.event;
  await expectThrow('missing event (generic path) throws', webhookItem(t), /unknown event/);
  const u = load('agent_otp'); u.otp = '<b>1</b>';
  await expectThrow('agent_otp invalid otp throws', webhookItem(u), /otp/);
  await expectThrow('non-JSON body throws', webhookItem('not json'), /JSON/);
}

// --------------------------------------------------------- workflow sanity --
console.log('\nWorkflow JSON');
{
  const names = new Set(workflow.nodes.map((n) => n.name));
  const ids = workflow.nodes.map((n) => n.id);
  must('unique node ids', new Set(ids).size === ids.length, 'duplicate ids');
  const whIds = workflow.nodes.filter((n) => n.webhookId).map((n) => n.webhookId);
  must('unique webhookIds', new Set(whIds).size === whIds.length, 'duplicate webhookIds');
  let missing = [];
  for (const [from, c] of Object.entries(workflow.connections)) {
    if (!names.has(from)) missing.push(from);
    for (const branch of c.main) for (const e of branch) if (!names.has(e.node)) missing.push(e.node);
  }
  must('every connection references an existing node', missing.length === 0, missing.join(', '));
  const paths = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').map((n) => n.parameters.path).sort();
  const expected = ['otp-requested', 'return-applied', 'exchange-applied', 'mixed-applied', 'return-rejected', 'return-closed', 'item-rejected', 'self-ship-requested', 'pickup-created', 'pickup-cancelled', 'return-received', 'refund-done', 'exchange-processed', 'reguard-notify'].sort();
  must('14 webhook paths (13 legacy + reguard-notify)', JSON.stringify(paths) === JSON.stringify(expected), paths.join(','));
  const webhooks = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
  must('every webhook uses header auth + is connected', webhooks.every((n) => n.parameters.authentication === 'headerAuth' && n.credentials?.httpHeaderAuth && workflow.connections[n.name]), 'auth/connection missing');
  const gmail = workflow.nodes.find((n) => n.name === 'Send Email');
  must('Gmail node wired to Render Email output', gmail?.parameters.sendTo === '={{ $json.recipient }}' && gmail.parameters.emailType === 'html' && gmail.credentials?.gmailOAuth2?.id === 'QY514loq9YhkZO51', 'gmail config');
  // the embedded code must be identical to src/render-email.js
  const src = readFileSync(join(here, 'src', 'render-email.js'), 'utf8');
  must('workflow jsCode is in sync with src/render-email.js', src === jsCode, 'run: node n8n/build-workflow.mjs');
  must('no require()/import in jsCode', !/\brequire\s*\(|^\s*import\s/m.test(jsCode), 'external module use');
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) { console.error('\nFAILED'); process.exit(1); }
console.log(`Previews written to ${join(here, 'previews')}`);

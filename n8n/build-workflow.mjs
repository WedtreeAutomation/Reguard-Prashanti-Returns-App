#!/usr/bin/env node
// Builds n8n/reguard-email-workflow.json from n8n/src/render-email.js.
// Node ids / webhookIds are generated once and then reused (matched by node name)
// so re-building never changes them. Usage: node n8n/build-workflow.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'reguard-email-workflow.json');
const jsCode = readFileSync(join(here, 'src', 'render-email.js'), 'utf8');

// Gmail credential reference copied from original_workflow.json (re-links on import).
const GMAIL_CREDENTIAL = { gmailOAuth2: { id: 'QY514loq9YhkZO51', name: 'Gmail account' } };
// Placeholder: create a "Header Auth" credential with this exact name in n8n (see README).
const HEADER_AUTH_CREDENTIAL = { httpHeaderAuth: { id: 'reguardWebhookToken', name: 'Re-Guard Webhook Token' } };

const WEBHOOKS = [
  ['Webhook · Agent OTP', 'otp-requested'],
  ['Webhook · Return Applied', 'return-applied'],
  ['Webhook · Exchange Applied', 'exchange-applied'],
  ['Webhook · Mixed Applied', 'mixed-applied'],
  ['Webhook · Return Rejected', 'return-rejected'],
  ['Webhook · Return Closed', 'return-closed'],
  ['Webhook · Item Rejected', 'item-rejected'],
  ['Webhook · Self-Ship Requested', 'self-ship-requested'],
  ['Webhook · Pickup Created', 'pickup-created'],
  ['Webhook · Pickup Cancelled', 'pickup-cancelled'],
  ['Webhook · Return Received', 'return-received'],
  ['Webhook · Refund Done', 'refund-done'],
  ['Webhook · Exchange Processed', 'exchange-processed'],
  ['Webhook · Re-Guard Notify (any event)', 'reguard-notify'],
];

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { nodes: [] };
const prevByName = new Map(previous.nodes.map((n) => [n.name, n]));
const ids = (name) => {
  const p = prevByName.get(name);
  return { id: p?.id || randomUUID(), webhookId: p?.webhookId || randomUUID() };
};

const SPACING = 176;
const midY = ((WEBHOOKS.length - 1) * SPACING) / 2;

const nodes = [];
WEBHOOKS.forEach(([name, path], i) => {
  const { id, webhookId } = ids(name);
  nodes.push({
    parameters: {
      httpMethod: 'POST',
      path,
      authentication: 'headerAuth',
      responseMode: 'lastNode',
      responseData: 'firstEntryJson',
      options: {},
    },
    id,
    name,
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [0, i * SPACING],
    webhookId,
    credentials: HEADER_AUTH_CREDENTIAL,
  });
});

nodes.push({
  parameters: { mode: 'runOnceForEachItem', jsCode },
  id: ids('Render Email').id,
  name: 'Render Email',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [400, midY],
});

const gmailIds = ids('Send Email');
nodes.push({
  parameters: {
    sendTo: '={{ $json.recipient }}',
    subject: '={{ $json.subject }}',
    emailType: 'html',
    message: '={{ $json.html }}',
    options: {
      appendAttribution: false,
      senderName: 'Prashanti Sarees',
      replyTo: 'support@prashantisarees.in',
    },
  },
  id: gmailIds.id,
  name: 'Send Email',
  type: 'n8n-nodes-base.gmail',
  typeVersion: 2.1,
  position: [720, midY],
  webhookId: gmailIds.webhookId,
  credentials: GMAIL_CREDENTIAL,
});

nodes.push({
  parameters: {
    content:
      '## Re-Guard customer e-mails\n' +
      'Every webhook (13 legacy paths + `reguard-notify`) feeds **Render Email**, which dispatches on `event` ' +
      '(CONTRACT §6) and renders one shared, branded template; **Send Email** sends it via Gmail.\n\n' +
      'Webhooks require header `X-Reguard-Token` (credential **Re-Guard Webhook Token**).\n' +
      'Unknown event / invalid recipient → the execution fails (backend sees HTTP 500).\n\n' +
      'Edit templates in `n8n/src/render-email.js`, then `node n8n/build-workflow.mjs` and re-import. See `n8n/README.md`.',
    height: 300,
    width: 420,
    color: 5,
  },
  id: ids('About this workflow').id,
  name: 'About this workflow',
  type: 'n8n-nodes-base.stickyNote',
  typeVersion: 1,
  position: [340, midY - 360],
});

const connections = {};
for (const [name] of WEBHOOKS) {
  connections[name] = { main: [[{ node: 'Render Email', type: 'main', index: 0 }]] };
}
connections['Render Email'] = { main: [[{ node: 'Send Email', type: 'main', index: 0 }]] };

const workflow = {
  name: 'Re-Guard — Customer E-mails',
  nodes,
  connections,
  pinData: {},
  settings: { executionOrder: 'v1', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' },
  active: false,
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};

writeFileSync(OUT, JSON.stringify(workflow, null, 2) + '\n');
console.log(`Wrote ${OUT} (${nodes.length} nodes, Render Email code ${jsCode.length} chars)`);

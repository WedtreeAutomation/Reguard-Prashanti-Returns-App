# Re-Guard by Prashanti — Returns & Exchange Portal

Customer self-service returns/exchanges for Prashanti Sarees plus the agent dashboard that processes
them (pickups, inspection, restock, refunds, exchanges, reports).

| Part | Tech | Folder |
|---|---|---|
| Web app (customer portal + staff dashboard) | React 18, TypeScript, Vite 5, Tailwind CSS 4 | `src/` |
| API | Python 3.12, Flask on Firebase Cloud Functions (2nd gen) | `functions/` |
| Data | Firestore, Firebase Storage, Firebase Authentication (custom tokens) | `firestore.rules`, `storage.rules`, `firestore.indexes.json` |
| Integrations | Shopify Admin GraphQL, BlueDart, n8n + Gmail | `functions/shopify_service.py`, `functions/bluedart.py`, `n8n/` |

Brand colour: **#560835** (applied app-wide; see "Theme" below).

---

## 1. What changed in this release

### Security (all items from the code review)
- **No shared API key any more.** The old `VITE_FLASK_API_KEY` was compiled into the public bundle. Staff now sign
  in with email + password; the API mints a Firebase custom token and every staff call carries a verified Firebase
  ID token. Each request re-loads the agent record, so role changes and deactivations apply immediately.
- **Role checks happen on the server** (refund to original payment = admin / super admin only; agents & settings
  management restricted). Nothing role-related is read from request bodies.
- **Passwords are hashed** (scrypt). The "phone number as first password" flow and the unauthenticated
  `setup-password` takeover are gone: set/reset password = e-mail OTP (secure random, 10-min expiry, attempt
  limits, daily budget) → single-use reset token → new password.
- **Firestore is locked down.** Customers never touch Firestore directly; staff access is authorised from a
  server-maintained `staff_access` document; money/guard fields on return documents can only be written by the server.
- **Customer portal goes through the API.** Order lookup needs order number + the e-mail/phone on that order and returns
  a short-lived token scoped to that one order. Eligibility (return window, final sale, custom items, India only,
  active request) is enforced on the server. A second request on an order can no longer overwrite the first one.
- **Refund password** is stored hashed on the server and checked by the refund endpoints (rate-limited) — it is no
  longer readable from Firestore.
- **E-mails can't be abused for phishing:** notification payloads are built on the server from Firestore/Shopify data
  (never from request bodies) and n8n webhooks require a shared header token.
- Rate limiting on login, OTP, order lookup, refunds; SSRF-safe image download proxy; no internal error text returned
  to clients; customer data trimmed from public responses; gift-card codes are no longer stored in readable documents
  (only the last 4 digits; the full code goes to the customer e-mail and is shown once to the agent).

### Money & operations safety
- Refunds: idempotency keys + a transactional lock (no double refunds from double clicks/retries), server-computed
  refund cap per order & line item (no over-refunds, shipping refunded at most once), every money movement written to a
  `refund_ledger` collection with agent details. Shopify timeouts are reported as "status unknown — check Shopify",
  never silently retried.
- Exchanges are resumable (a failed refund step never re-runs the Shopify exchange), discounts matched by variant, an
  unreadable balance is flagged for review instead of silently closing the request, order notes are never wiped.
- Restock is capped server-side and recorded in `restock_history` by the server (no double stock).
- BlueDart: no duplicate waybills, a failed cancellation is no longer recorded as cancelled, serviceability failures
  are no longer cached forever, label links work with locked storage.
- Fixed: "wrong color" reason mapping, tracking "UNDELIVERED"/"RTO" shown as delivered, Mark Received e-mailing on
  failure, editing an agent wiping their password, endless Firestore read loop on the customer page, unbounded
  collection reads on the dashboard/analytics, and many crash/edge cases.

### Features requested
- **Theme:** brand colour #560835 everywhere (staff dashboard + customer pages + e-mails).
- **Customer page:** removed "From handwoven silk to contemporary collections, your order is in good hands."; the
  *Track Return* button near the questions section now opens our own status page (`/ReturnStatusPage`).
- **Status page:** search by order number + e-mail/phone; e-mail links prefill the order (`?order=P905422`).
- **Restock History:** *Download report* with presets (Today … Last month) or a custom date range, Excel or CSV.
- **Return details → customer panel:** Total Orders, Total Spent, **Total Returns** (return + exchange requests
  raised by the customer), **Total Return Value** (product value of those requests) and **Total Balance**
  (store credit + gift cards).
- **Analytics → Report Center:** pick a date range and download any report individually (Excel / CSV / preview), or
  **Download all** as one organised workbook (summary sheet + one sheet per report):
  Gift Vouchers issued · Refunds issued (original payment & manual) · Store Credit issued · All money movements ·
  Exchanges · All return/exchange requests · Most returned products · Return reasons · Agent performance · Restocks.
  Money reports include date & time, RAN, order number, customer name/e-mail/phone, value, and agent name/e-mail/role.
- **E-mails (n8n):** one professional template for all 13 e-mails with the Re-Guard logo, brand colours and only the
  fields each e-mail needs. See `n8n/README.md`.
- **Mobile friendly:** every page works from 360 px wide (drawer navigation, stacked cards, scrollable tables,
  bottom-sheet modals, 16 px inputs so iOS doesn't zoom).

---

## 2. Project layout

```
src/
  App.tsx                     routes (lazy-loaded), auth provider, error boundary, toasts
  Interfaces/
    http.ts                   axios clients: apiClient (staff, Bearer token), publicClient (customer token)
    authApi.ts                login / OTP / password / agents admin / refund password
    publicApi.ts              customer portal API
    api.ts                    agent operations API (orders, refunds, exchanges, pickups, restock, notify)
    reportsApi.ts             report definitions + fetch
    firebase.ts, types.ts, permissions.ts
  components/
    Pages/                    CustomerPage, ReturnStatusPage, Home, Returns, ReturnDetailsPage, RestockHistory,
                              Analytics (+ Report Center), Agents, Settings, LoginPage
    Customer/ Agent/ Reports/ common/ Layout/
  Modals/                     refund, exchange, pickup create/cancel, self-ship, mark received, reject
  utils/excel.ts, dates.ts    report export (xlsx loaded on demand) and IST date ranges
functions/
  main.py                     Flask app + Cloud Function entry point (prashanti_returns_api)
  security.py                 auth decorators, password hashing, customer tokens, rate limiting
  core.py                     config (env), shared helpers, n8n sender
  routes_public.py            customer portal API (/api/public/*)
  routes_auth.py, routes_admin.py
  routes_refunds.py, routes_exchange.py, guards.py (idempotency, locks, ledger, refund caps)
  routes_orders.py, routes_notifications.py, routes_reports.py, bluedart.py, shopify_service.py
  notifications.py, settings_store.py
  scripts/                    one-off maintenance scripts (dry-run by default)
  tests/                      unit tests (run without credentials)
n8n/                          e-mail workflow, template source, sample payloads, previews
firestore.rules  storage.rules  firestore.indexes.json  firebase.json
```

---

## 3. Configuration

### Frontend — `.env.local` / `.env.production` (see `.env.example`)
`VITE_FLASK_API_URL` (default `/api`) and the Firebase web config (`VITE_API_KEY`, `VITE_AUTH_DOMAIN`,
`VITE_PROJECT_ID`, `VITE_STORAGE_BUCKET`, `VITE_MESSAGING_SENDER_ID`, `VITE_APP_ID`, `VITE_MEASUREMENT_ID`).
**Delete `VITE_FLASK_API_KEY` and any `VITE_SHOPIFY_*` / BlueDart secrets from the frontend env files.**

### Backend — `functions/.env` (see `functions/.env.example`, every variable is documented there)
Required: `FB_PROJECT_ID`, `FB_CLIENT_EMAIL`, `FB_PRIVATE_KEY`, `STORAGE_BUCKET`, **`APP_SECRET_KEY`** (≥ 32 random
characters: `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`), `PUBLIC_APP_URL`,
`SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_API_VERSION`, `SHOPIFY_WEBHOOK_SECRET`,
`SHOPIFY_STOREFRONT_TOKEN`, the `BLUEDART_*` / `BD_*` values, `N8N_WEBHOOK_TOKEN` and the `N8N_*_WEBHOOK` URLs
(or a single `N8N_NOTIFY_WEBHOOK`).
Old `VITE_`-prefixed backend names still work as a fallback (a deprecation warning is logged) — rename them.

**Rotate secrets:** the old Flask API key was public; also rotate the Shopify Admin token if it was ever stored in a
frontend `.env` file.

### Static files
`public/` must contain `icon.png` (favicon) and **`reguard-logo.png`** (used by the e-mails at
`https://prashantireturns.web.app/reguard-logo.png`). They were not part of the uploaded source — keep your existing
files there.

---

## 4. Local development

```bash
# frontend
npm ci
cp .env.example .env.local        # fill in Firebase web config
npm run dev                       # http://localhost:5173
npm run typecheck && npm run build

# backend
cd functions
python3.12 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env              # fill in
python -m unittest discover -s tests -v      # 190+ tests, no credentials needed
firebase emulators:start --only functions    # or deploy to a staging project
```

---

## 5. Deployment (first deploy of this version — order matters)

1. **Firebase console:** Authentication → *Get started* (custom-token sign-in needs Authentication enabled; no
   provider has to be switched on).
2. **Backend config:** create `functions/.env` from `functions/.env.example`.
3. **Migrate existing data** (each script is a dry run unless you pass `--no-dry-run`):
   ```bash
   cd functions
   python scripts/migrate_agents.py                  # review output
   python scripts/migrate_agents.py --no-dry-run     # hashes existing agent passwords, creates staff_access,
                                                     # moves the refund password out of settings/returnSettings
   python scripts/backfill_ledger.py --no-dry-run    # historical refunds → refund_ledger (for reports)
   python scripts/set_refund_password.py --help      # optional: set/replace the refund password
   ```
   Agents keep their current passwords. Agents who never set one use *Forgot / set password* on the login page.
4. **Deploy:**
   ```bash
   firebase deploy --only functions
   firebase deploy --only firestore:rules,firestore:indexes,storage   # storage rules read Firestore: accept the
                                                                      # one-time permission prompt
   npm ci && npm run build && firebase deploy --only hosting
   ```
5. **Firestore TTL (cleanup of short-lived docs):**
   ```bash
   gcloud firestore fields ttls update expireAt --collection-group=rate_limits --enable-ttl
   gcloud firestore fields ttls update expireAt --collection-group=idempotency --enable-ttl
   ```
6. **n8n:** follow `n8n/README.md` (import `n8n/reguard-email-workflow.json`, create the header-auth credential with
   the same value as `N8N_WEBHOOK_TOKEN`, re-link Gmail, deactivate the old workflow).
7. **Shopify webhook:** sign in as super admin and call `POST /api/setup/register-payment-webhook` once (it always
   uses `PUBLIC_APP_URL`), or keep the existing subscription if it already points at
   `https://<your domain>/api/webhooks/shopify/orders-paid`.
8. **Rate-limit IP check:** open the function logs for one request and confirm `TRUSTED_PROXY_HOPS` picks the real
   client IP (default 2 for Hosting → Functions). Restrict the function's ingress to Hosting/internal traffic if possible.

### Smoke test after deploying
- Customer: look up an order (order no. + e-mail), submit a return with photos, receive the e-mail, track it on the
  status page from the e-mail link; try a second request on the same order (must be refused while the first is open).
- Agent: log in, open the return, create & cancel a pickup, mark received with restock, issue a store-credit refund
  (try double-clicking — only one refund), check the Restock report and the Report Center downloads.
- Admin: create an agent (they set a password via OTP), deactivate them (their session ends immediately).

---

## 6. Roles

| Role | Can do |
|---|---|
| `agent` | Everything on returns: pickups, self-ship, receive/restock, reject, exchanges, refunds by gift card, store credit or manual (with the refund password). Restock report. |
| `admin` | Agent rights + refunds to the original payment method, Analytics & Report Center, Settings (incl. refund password). |
| `super_admin` | Admin rights + Agents management + Shopify webhook setup. |

---

## 7. Theme

The brand scale (600 = **#560835**) is defined once in `src/index.css` (`@theme`) and mapped onto Tailwind's indigo,
violet, purple, fuchsia, pink and blue palettes, so every accent in the dashboard uses the brand colour. Customer pages
use the CSS variables in `src/components/Customer/theme.ts`; chart colours are the `CHART_PALETTE` constants in
`Analytics.tsx` / `Home.tsx`; e-mail colours live in `n8n/src/render-email.js`. Green/amber/red/cyan remain for
status meaning (success / warning / error / info).

---

## 8. API overview

All routes are under `/api` (Hosting rewrites `/api/**` to the function). Errors are
`{ "success": false, "error": "…", "code": "…" }`.

- **Public (customer):** `GET /public/settings`, `POST /public/orders/verify`, `POST /public/returns`,
  `POST /public/returns/:id/images`, `POST /public/returns/:id/finalize`, `POST /public/returns/lookup`,
  `GET /public/returns`, `GET /public/balances`, `GET /products/:id`.
- **Auth:** `POST /auth/login`, `/auth/send-otp`, `/auth/verify-otp`, `/auth/setup-password`, `GET /auth/me`,
  `POST /auth/change-password`, `/auth/verify-refund-password`.
- **Staff:** orders/products/customer balances, `/refund/{gift-card|store-credit|original-payment|manual}`,
  `/exchange/{preview|process|active-price|reconcile-hold}`, `/orders/:id/restock`, `/returns/:id/convert-action`,
  `/returns/self-ship`, `/notify/{return-rejected|item-rejected|return-received}`,
  `/bluedart/{serviceability|waybill/generate|waybill/cancel|tracking}`, `/download/*`, `/reports/:type`.
- **Admin:** `/admin/agents` (CRUD, super admin), `/admin/settings/refund-password`, `/money/resolve-unknown`.
- **Webhook:** `POST /webhooks/shopify/orders-paid` (Shopify HMAC verified).

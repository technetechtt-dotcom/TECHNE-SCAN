# Techne Scan AI

Operations app for asset custody, sectional stocktakes, scanner imports, and stock-ledger intelligence. The browser is a no-build PWA. The server is Node.js with PostgreSQL (embedded for local use, or `DATABASE_URL`).

## Start

From the `server` directory run:

```sh
npm install
npm start
```

Open `http://localhost:8080`. Outside production, a localhost sign-in screen can show the sample company. `NODE_ENV=production` never seeds that company and never returns its password. Set `SEED_DEMO=0` to skip it in development too. Set `DATABASE_URL` to use an external PostgreSQL database. Set `EMAIL_WEBHOOK_URL` to deliver password-reset tokens, and `ALERT_WEBHOOK_URL` for server error alerts. Set `OPENAI_API_KEY` only if Intelligence should call a model; the call is limited to the signed-in company's summary and cannot post stock on its own. Set `BACKUP_KEY` so backups are encrypted, and `BACKUP_WEBHOOK_URL` to send that encrypted file off the server. Scanner subscriptions use Stripe when `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_COUNTER`, and `STRIPE_PRICE_WIRELESS` are set. The billing portal opens after Stripe has stored a customer on that checkout. Xero needs `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`. Sage needs `SAGE_CLIENT_ID` and `SAGE_CLIENT_SECRET`. SMS needs Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`) or `SMS_WEBHOOK_URL`. WhatsApp needs `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID`. Pastel, POS, and ERP do not need a vendor SDK.

The browser keeps an IndexedDB copy and retries failed writes. Counts, labels, and approvals need the server for the ledger. Scheduled counts run every 30 seconds while this process is up.

## Implemented

- Company, branch, and employee logins with role permissions. Owners and admins see every branch. Other roles stay on their branch.
- Asset custody with return location, QR and Code 128 labels, and a custody log
- Stock ledger. Count approval posts the residual after movements during the count. A non-owner cannot approve a count they submitted.
- Daily, weekly, and monthly schedules that open counts in the company timezone
- Device register, quoted CSV import, and apply-to-open-count. Phone scanning is on Starter. USB and Opticon scanners need the Counter plan. Bluetooth and wireless scanners need Wireless.
- Session list and sign-out of other sessions. Authenticator setup no longer turns itself off without a password and a current code. Production backups and subscription changes require an authenticator for owners and admins.
- Bookings are listed on Assets and released after the end date. Condition photos are fetched one at a time by an authorised user, not copied into the offline sync.
- In-app notifications for overdue assets, assignments, and submitted counts
- IndexedDB keeps each queued write as its own record. A rejected change stays on the Conflicts screen until it is retried or discarded.
- Sectional counts can combine department, aisle, shelf, and category. Checkout accepts an employee code such as TT-EMP-001.
- Techne Intelligence: recommendations, discrepancy explanations, days of cover from recorded issues, and plain-language questions over that data
- Directed picking. Open orders, including POS and ERP orders, release into a wave sorted by aisle, shelf, rack, and bin. A scan is accepted only for the next location, and the pick posts to the stock ledger.
- Connections for Xero, Sage, Pastel, POS, ERP, SMS, and WhatsApp. Pastel sync is a CSV import file. POS and ERP use a signed webhook. SMS uses Twilio or `SMS_WEBHOOK_URL`. WhatsApp uses the Cloud API. OAuth for Xero and Sage runs when the client id and secret are set.
- Stripe billing portal for owners who already have a card customer. Subscription cancellation returns the company to Starter.
- Camera scanning uses BarcodeDetector when the browser has it, and a built-in QR, Code 128, and EAN-13 decoder otherwise.
- USB keyboard wedge and Opticon HID (vendor 065A) in the browser. `connect/techne-connect.mjs --stream` reads a COM-port or line file. Neither path clears scanner memory.

## Still outstanding

These items are not done, and the app does not pretend they are:

- The Opticon OPN-2001 USB SDK is not bundled, because it is Opticon's proprietary Windows library. Live USB input is keyboard wedge, HID, or a streamed COM port. No physical scanner was certified here.
- There is no penetration-test report, pilot customer, or mobile-lab certificate in this repo. `npm test` is the automated check. A certificate has to come from an outside firm and a real pilot.
- Privacy controls are technical and described in `docs/POPIA.md`. That is not a legal compliance certificate.
- Playwright and a physical OPN-2001 are not in this repo. Camera decoding is covered for generated Code 128 and EAN-13 images, not for every phone camera.

## Suggested production architecture

- Web/PWA: React + TypeScript, accessible component library, IndexedDB local queue
- Server: ASP.NET Core + PostgreSQL; tenant-scoped RBAC, OIDC/MFA and event-based stock ledger
- Windows agent: C#/.NET, Opticon official SDK, SQLite durable outbox
- Scheduler: hosted persistent worker, timezone-aware recurrence and notifications
- Scanner adapters: OPN-2001 batch imports, USB-HID, Bluetooth and mobile QR
- Approval system: immutable count snapshots, concurrent movement reconciliation, 4-eyes variance approval
- Security: secure IDs/tokenised QR routes, signed event receipts, rate limiting, backup/restore, retention controls, POPIA compliance

## Quality acceptance gates

1. All asset check-out/check-in transitions tested with real staff and devices.
2. Full and filtered sectional scopes reconciled against physical items.
3. Real USB disconnections, repeated imports and device failures tested with at least three OPN-2001 units.
4. Browser-local prototype migrated to authenticated, synced multi-user backend.
5. Concurrent transactions, offline sync conflicts, schedule execution, security review and database recovery tests pass.

## Files

- `index.html`: application shell
- `styles.css`: responsive styling
- `app.js`: screens, forms, and sync
- `idb.js` / `api.js`: offline store and API client
- `code128.js`: Code 128 labels
- `symbology.js`: QR, Code 128, and EAN-13 camera decoding
- `scanner-input.js`: USB keyboard wedge and Opticon HID
- `sw.js`: network-first offline cache
- `../server`: PostgreSQL API, scheduler, and permissions
- `manifest.webmanifest`: installable app metadata
- `vendor/qr.js`: QR encoder, based on Kazuhiko Arase QRCode for JavaScript (MIT licence, vendored through qrcode-terminal)
- `icons/icon.svg`: app icon

## Notes

Example data is seeded on first launch outside production. Production never creates that sample company.

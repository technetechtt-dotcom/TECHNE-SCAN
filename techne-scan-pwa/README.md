# Techne Scan AI

Operations app for asset custody, sectional stocktakes, scanner imports, and stock-ledger intelligence. The browser is a no-build PWA. The server is Node.js with PostgreSQL (embedded for local use, or `DATABASE_URL`).

## Start

From the `server` directory run:

```sh
npm install
npm start
```

Open `http://localhost:8080`. Outside production, a localhost sign-in screen can show the sample company. `NODE_ENV=production` never seeds that company and never returns its password. Set `SEED_DEMO=0` to skip it in development too. Set `DATABASE_URL` to use an external PostgreSQL database. Set `EMAIL_WEBHOOK_URL` to deliver password-reset tokens, and `ALERT_WEBHOOK_URL` for server error alerts. Set `OPENAI_API_KEY` only if Intelligence should call a model; the call is limited to the signed-in company's summary and cannot post stock on its own.

The browser keeps an IndexedDB copy and retries failed writes. Counts, labels, and approvals need the server for the ledger. Scheduled counts run every 30 seconds while this process is up.

## Implemented

- Company, branch, and employee logins with role permissions. Owners and admins see every branch. Other roles stay on their branch.
- Asset custody with return location, QR and Code 128 labels, and a custody log
- Stock ledger. Count approval posts the residual after movements during the count. A non-owner cannot approve a count they submitted.
- Daily, weekly, and monthly schedules that open counts in the company timezone
- Device register, quoted CSV import, and apply-to-open-count
- In-app notifications for overdue assets, assignments, and submitted counts
- IndexedDB keeps each queued write as its own record. A rejected change stays on the Conflicts screen until it is retried or discarded.
- Sectional counts can combine department, aisle, shelf, and category. Checkout accepts an employee code such as TT-EMP-001.
- Techne Intelligence: recommendations, discrepancy explanations, days of cover from recorded issues, and plain-language questions over that data

## Still outstanding

These items are not done, and the app does not pretend they are:

- The Opticon OPN-2001 USB SDK is not bundled. `connect/techne-connect.mjs` posts a CSV batch and does not clear scanner memory. No physical scanner was tested.
- There is no payment processor, Xero, Sage, SMS, or WhatsApp connection. Webhooks can be registered over HTTPS only.
- POPIA controls here are technical: export, login removal, retention of sessions and notices, and an in-app notice. That is not a legal compliance certificate.
- No penetration test, pilot customer, or mobile-lab certification has been run.
- Camera scanning still depends on BarcodeDetector.
- Playwright browser tests are not in this repo. `npm test` covers the API, queue, restore, and a production HTTP boot.

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
- `sw.js`: network-first offline cache
- `../server`: PostgreSQL API, scheduler, and permissions
- `manifest.webmanifest`: installable app metadata
- `vendor/qr.js`: QR encoder, based on Kazuhiko Arase QRCode for JavaScript (MIT licence, vendored through qrcode-terminal)
- `icons/icon.svg`: app icon

## Notes

Example data is seeded on first launch outside production. Production never creates that sample company.

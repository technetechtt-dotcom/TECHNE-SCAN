# Techne Scan AI

Operations app for asset custody, sectional stocktakes, scanner imports, and stock-ledger intelligence. The browser is a no-build PWA. The server is Node.js with PostgreSQL (embedded for local use, or `DATABASE_URL`).

## Start

From the `server` directory run:

```sh
npm install
npm start
```

Open `http://localhost:8080`. On this machine the sign-in screen shows the local demo owner and a clerk login. Create a company from that screen when you want a separate tenant. Set `DATABASE_URL` to use an external PostgreSQL database instead of the built-in PostgreSQL data directory. Set `SEED_DEMO=0` to skip the sample company.

The browser keeps an IndexedDB copy and retries failed writes. Counts, labels, and approvals need the server for the ledger. Scheduled counts run every 30 seconds while this process is up.

## Implemented

- Company, branch, and employee logins with role permissions. Owners and admins see every branch. Other roles stay on their branch.
- Asset custody with return location, QR and Code 128 labels, and a custody log
- Stock ledger. Count approval posts the residual after movements during the count. A non-owner cannot approve a count they submitted.
- Daily, weekly, and monthly schedules that open counts in the company timezone
- Device register, quoted CSV import, and apply-to-open-count
- In-app notifications for overdue assets, assignments, and submitted counts
- IndexedDB outbox: writes made offline sync when the connection returns
- Techne Intelligence: recommendations, discrepancy explanations, days of cover from recorded issues, and plain-language questions over that data

## Still outstanding

- No direct USB link to an OPN-2001. Imports are CSV from the Companion app, tied to a registered device.
- Camera QR scanning needs BarcodeDetector, which is not in every browser.
- Intelligence does not call an external model. It explains the ledger and count history.
- Sessions are httpOnly cookies with scrypt passwords. This is not yet OIDC, MFA, or a signed label token.
- Do not point this demo database at real customer data until backup, retention, and a security review are in place.

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

Example data is automatically seeded on first launch. This is a new starter, not linked to an existing GitHub repository and no remote changes have been made.

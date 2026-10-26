# Privacy and retention controls

This note describes the technical controls in Techne Scan. It is not a legal POPIA certificate, an operator agreement, or a substitute for the company's own privacy notice.

## What the app stores

Company records include employee names and emails, asset custody, stock quantities, scanner imports, and optional condition photographs. Passwords are stored as scrypt hashes. Session tokens and MFA backup codes are stored only as SHA-256 hashes. MFA secrets stay on the employee row and are not sent to the browser in the sync payload. Condition photographs are not included in the offline sync copy; an authorised user fetches one photo at a time.

## Who can see it

Every query is limited to the signed-in company. Owners and admins can see every branch in that company. Other roles stay on their own branch. A user in another company receives "not found" rather than the record.

## Retention

The daily housekeeping job deletes expired sessions after 30 days, revoked sessions after 7 days, notifications after 365 days, rate-limit rows after 2 days, idempotency records after 30 days, and stale MFA challenges and password resets. Audit rows and stock ledger rows cannot be updated or deleted by the application. Account erasure anonymises the login, revokes sessions, and records the request. It refuses to remove the last owner.

## Backups and recovery

Set `BACKUP_KEY` before production. Backups are then AES-256-GCM files. Without that key, production refuses to write a backup. Set `BACKUP_WEBHOOK_URL` to receive the encrypted file at another location. Recovery is: create an empty database, set the same `BACKUP_KEY`, and restore the snapshot. That restores application tables. It is not a PostgreSQL point-in-time recovery of the database server itself. Forward SQL migrations are recorded in `schema_migrations` only after the file succeeds. A failed migration is not marked applied, so it can be corrected and run again. Rolling an applied migration backward is a restore from the encrypted backup taken before that migration.

## Sessions and authenticator

A person can sign out other sessions for the same login. Turning an authenticator on or off revokes those other sessions. Turning it off requires the password and a current code. In production, an owner or admin must have an authenticator on before taking a backup or changing the scanner subscription. Password reset revokes every session for that person.

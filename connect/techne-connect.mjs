import fs from "node:fs";
import { randomUUID } from "node:crypto";

const base = process.env.TECHNE_URL || "http://127.0.0.1:8080";
const file = process.argv[2];
const serial = process.env.SCANNER_SERIAL || "OPN-UNKNOWN";
const firmware = process.env.SCANNER_FIRMWARE || "";
const email = process.env.TECHNE_EMAIL || "";
const password = process.env.TECHNE_PASSWORD || "";
const stocktakeId = process.env.TECHNE_STOCKTAKE || "";

if (!file || !email || !password) {
  console.error("Usage: TECHNE_EMAIL=... TECHNE_PASSWORD=... node techne-connect.mjs scans.csv");
  console.error("This agent posts a verified CSV batch. It does not clear scanner memory.");
  console.error("The Opticon OPN-2001 USB SDK is not bundled, and physical units were not tested from this machine.");
  process.exit(1);
}

const csv = fs.readFileSync(file, "utf8");
const batchKey = `batch:${serial}:${randomUUID()}`;
const login = await fetch(`${base}/api/v1/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-techne-client": "1" },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) {
  console.error("Sign-in failed", login.status);
  process.exit(1);
}
const cookie = (login.headers.getSetCookie?.() || []).map((item) => item.split(";")[0]).join("; ");
const imported = await fetch(`${base}/api/v1/imports`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-techne-client": "1", cookie, "idempotency-key": randomUUID() },
  body: JSON.stringify({ csv, name: file, serial, firmware, batchKey }),
});
const body = await imported.json();
if (!imported.ok) {
  console.error(body.error || "Import failed");
  process.exit(1);
}
await fetch(`${base}/api/v1/scanners/batch`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-techne-client": "1", cookie },
  body: JSON.stringify({ serial, firmware }),
});
console.log(`Accepted ${body.lineCount} rows as ${body.id}. Repeated barcodes were kept.`);
if (stocktakeId) {
  const applied = await fetch(`${base}/api/v1/imports/${body.id}/apply`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-techne-client": "1", cookie, "idempotency-key": randomUUID() },
    body: JSON.stringify({ stocktakeId }),
  });
  const result = await applied.json();
  if (!applied.ok) {
    console.error(result.error || "Apply failed");
    process.exit(1);
  }
  console.log(`Applied ${result.applied} barcodes. Unknown: ${(result.unmatched || []).join(", ") || "none"}.`);
}
console.log("Server accepted the batch. Clear the scanner memory only after you have checked this result.");

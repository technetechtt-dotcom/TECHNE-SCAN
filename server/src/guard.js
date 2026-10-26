import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, tx } from "./db.js";
import { bad } from "./errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BACKUP_TABLES = [
  "companies",
  "billing_checkouts",
  "branches",
  "employees",
  "counters",
  "assets",
  "products",
  "stock_ledger",
  "custody_events",
  "schedules",
  "stocktakes",
  "stocktake_lines",
  "devices",
  "imports",
  "notifications",
  "audit_log",
  "asset_reservations",
  "asset_maintenance",
  "contractors",
  "asset_categories",
  "stocktake_assignees",
  "stocktake_evidence",
  "blackout_dates",
  "device_events",
  "goods_receipts",
  "stock_transfers",
];

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function log(level, message, fields = {}) {
  const safe = { ...fields };
  for (const key of ["password", "token", "secret", "authorization", "mfa_secret", "password_hash"]) delete safe[key];
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...safe }));
}

export async function alertError(error, req) {
  log("error", error.message || "request failed", { path: req?.originalUrl || "", method: req?.method || "" });
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `Techne Scan error on ${req?.method || ""} ${req?.path || ""}` }),
  }).catch(() => {});
}

export async function rateLimit(key, limit, windowMs) {
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
  const rows = await query(
    `INSERT INTO rate_limits (bucket, hits, window_start) VALUES ($1, 1, $2)
     ON CONFLICT (bucket) DO UPDATE SET
       hits = CASE WHEN rate_limits.window_start = EXCLUDED.window_start THEN rate_limits.hits + 1 ELSE 1 END,
       window_start = EXCLUDED.window_start
     RETURNING hits`,
    [String(key).slice(0, 200), windowStart],
  );
  if (Number(rows[0].hits) > limit) throw bad(429, "Too many attempts. Wait and try again.");
}

export async function runIdempotent(user, method, path, body, key, fn) {
  if (!key || method === "GET" || method === "HEAD") return fn();
  if (!/^[A-Za-z0-9-]{8,80}$/.test(String(key))) throw bad(400, "Idempotency key is not valid.");
  const hash = createHash("sha256").update(`${method}\n${path}\n${stable(body || {})}`).digest("hex");
  const replay = async () => {
    const existing = await query(
      `SELECT request_hash, status_code, response, created_at FROM idempotency_keys WHERE company_id = $1 AND key = $2`,
      [user.companyId, key],
    );
    const row = existing[0];
    if (!row) return null;
    if (row.request_hash !== hash) throw bad(409, "This idempotency key was already used for a different transaction.");
    if (Number(row.status_code) === 0) {
      const age = Date.now() - new Date(row.created_at).getTime();
      if (age < 120000) throw bad(409, "That transaction is still being saved.");
      await query(`DELETE FROM idempotency_keys WHERE company_id = $1 AND key = $2 AND status_code = 0`, [user.companyId, key]);
      return null;
    }
    if (Number(row.status_code) >= 400) throw bad(Number(row.status_code), row.response?.error || "Request failed.");
    return row.response;
  };
  const stored = await replay();
  if (stored) return stored;
  const claimed = await query(
    `INSERT INTO idempotency_keys (company_id, key, request_hash, status_code, response)
     VALUES ($1,$2,$3,0,'null'::jsonb) ON CONFLICT DO NOTHING RETURNING key`,
    [user.companyId, key, hash],
  );
  if (!claimed[0]) {
    const again = await replay();
    if (again) return again;
    throw bad(409, "That transaction is still being saved.");
  }
  try {
    const result = await fn();
    await query(
      `UPDATE idempotency_keys SET status_code = 200, response = $3::jsonb WHERE company_id = $1 AND key = $2`,
      [user.companyId, key, JSON.stringify(result ?? { ok: true })],
    );
    return result;
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      await query(`DELETE FROM idempotency_keys WHERE company_id = $1 AND key = $2 AND status_code = 0`, [user.companyId, key]);
    } else {
      await query(
        `UPDATE idempotency_keys SET status_code = $3, response = $4::jsonb WHERE company_id = $1 AND key = $2`,
        [user.companyId, key, status, JSON.stringify({ error: error.message })],
      );
    }
    throw error;
  }
}

function backupDir() {
  const dir = path.join(__dirname, "..", "data", "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupKey() {
  const raw = process.env.BACKUP_KEY || "";
  if (raw.length < 16) return null;
  return scryptSync(raw, "techne-backup-v1", 32);
}

export function sealBackup(dump) {
  const json = JSON.stringify(dump);
  const key = backupKey();
  if (!key) {
    if (process.env.NODE_ENV === "production") throw bad(503, "Set BACKUP_KEY before writing a backup.");
    return { body: json, encrypted: false };
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const body = JSON.stringify({
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
  return { body, encrypted: true };
}

export function openBackup(text) {
  const parsed = JSON.parse(text);
  if (parsed?.tables) return parsed;
  if (parsed?.alg !== "aes-256-gcm") throw bad(400, "That backup cannot be read.");
  const key = backupKey();
  if (!key) throw bad(503, "Set BACKUP_KEY to read this backup.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const json = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(json);
}

export async function exportSnapshot() {
  const tables = {};
  for (const table of BACKUP_TABLES) tables[table] = await query(`SELECT * FROM ${table}`);
  return { exportedAt: new Date().toISOString(), tables };
}

export async function writeBackup() {
  const dump = await exportSnapshot();
  const sealed = sealBackup(dump);
  const file = path.join(backupDir(), `backup-${Date.now()}${sealed.encrypted ? ".json.enc" : ".json"}`);
  fs.writeFileSync(file, sealed.body);
  const names = fs.readdirSync(backupDir()).filter((name) => name.startsWith("backup-")).sort();
  while (names.length > 14) fs.unlinkSync(path.join(backupDir(), names.shift()));
  const webhook = process.env.BACKUP_WEBHOOK_URL;
  if (webhook && sealed.encrypted) {
    const response = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: sealed.body });
    if (!response.ok) throw bad(502, "The off-site backup store rejected the encrypted copy.");
  }
  return { file: path.basename(file), companies: dump.tables.companies.length, encrypted: sealed.encrypted };
}

export async function restoreSnapshot(dump) {
  const existing = await query(`SELECT count(*)::int AS n FROM companies`);
  if (Number(existing[0].n) > 0) throw bad(409, "Restore only runs into an empty database.");
  if (!dump?.tables?.companies?.length) throw bad(400, "That backup has no company.");
  await tx(async (q) => {
    for (const table of BACKUP_TABLES) {
      if (!Object.hasOwn(dump.tables, table)) continue;
      for (const row of dump.tables[table] || []) {
        const keys = Object.keys(row).filter((key) => /^[a-z0-9_]+$/.test(key));
        if (!keys.length) continue;
        const values = keys.map((key) => {
          const value = row[key];
          if (value && typeof value === "object" && !(value instanceof Date)) return JSON.stringify(value);
          return value;
        });
        const placeholders = keys.map((_, index) => `$${index + 1}`).join(",");
        await q(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${placeholders})`, values);
      }
    }
  });
  return { companies: dump.tables.companies.length };
}

export async function housekeeping() {
  await query(`DELETE FROM sessions WHERE expires_at < now() - interval '30 days' OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`);
  await query(`DELETE FROM notifications WHERE created_at < now() - interval '365 days'`);
  await query(`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`);
  await query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '30 days'`);
  await query(`DELETE FROM mfa_challenges WHERE expires_at < now()`);
  await query(`DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'`);
  await query(`UPDATE companies SET plan = 'starter', plan_status = 'cancelled' WHERE plan <> 'starter' AND plan_until IS NOT NULL AND plan_until < now()`);
  await query(`UPDATE asset_reservations SET status = 'expired' WHERE status = 'booked' AND ends_on < CURRENT_DATE`);
  await query(
    `UPDATE assets SET status = 'available', holder = '', version = version + 1, updated_at = now()
     WHERE status = 'reserved' AND NOT EXISTS (
       SELECT 1 FROM asset_reservations r WHERE r.asset_id = assets.id AND r.status = 'booked' AND r.ends_on >= CURRENT_DATE
     )`,
  );
  const dir = backupDir();
  const names = fs.readdirSync(dir).filter((name) => name.startsWith("backup-"));
  const newest = names.map((name) => fs.statSync(path.join(dir, name)).mtimeMs).sort((a, b) => b - a)[0] || 0;
  if (Date.now() - newest > 24 * 60 * 60 * 1000) await writeBackup();
}

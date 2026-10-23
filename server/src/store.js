import { randomUUID } from "node:crypto";
import { query, tx } from "./db.js";
import { bad } from "./errors.js";
import { explainLine } from "./reconcile.js";
import { parseScanCsv } from "./csv.js";
import { addDays, nextRunAt, todayInTz, weekdayInTz } from "./time.js";
import {
  ROLES,
  assertCap,
  assertPassword,
  asUuid,
  capsFor,
  cleanEmail,
  clip,
  companyWide,
  hashPassword,
  hashToken,
  maybeUuid,
  newToken,
  optionalText,
  verifyPassword,
} from "./security.js";

const DEMO_EMAIL = "admin@techne.local";
const DEMO_PASSWORD = "TechneDemo#2026";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateOnly(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function num(value) {
  return Number(value || 0);
}

function mapUser(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    timezone: row.timezone,
    branchId: row.branch_id,
    branchName: row.branch_name,
    name: row.name,
    email: row.email,
    role: row.role,
    caps: capsFor(row.role),
  };
}

function mapBranch(row) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    address: row.address,
    active: row.active,
    updatedAt: iso(row.updated_at),
  };
}

function mapEmployee(row, viewer) {
  const item = {
    id: row.id,
    branchId: row.branch_id,
    name: row.name,
    role: row.role,
    active: row.active,
  };
  if (viewer && (viewer.role === "owner" || viewer.role === "admin")) item.email = row.email;
  return item;
}

function mapAsset(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    publicId: row.public_id,
    name: row.name,
    category: row.category,
    department: row.department,
    location: row.location,
    serial: row.serial,
    status: row.status,
    holder: row.holder,
    due: dateOnly(row.due),
    condition: row.condition,
    version: row.version,
    updatedAt: iso(row.updated_at),
  };
}

function mapProduct(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    sku: row.sku,
    name: row.name,
    department: row.department,
    aisle: row.aisle,
    category: row.category,
    qty: num(row.qty),
    version: row.version,
    updatedAt: iso(row.updated_at),
  };
}

function mapSchedule(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    name: row.name,
    scope: row.scope,
    scopeValue: row.scope_value,
    frequency: row.frequency,
    timeOfDay: row.time_of_day,
    weekday: row.weekday,
    dayOfMonth: row.day_of_month,
    assignedEmployeeId: row.assigned_employee_id,
    active: row.active,
    nextRunAt: iso(row.next_run_at),
    lastRunAt: iso(row.last_run_at),
  };
}

function mapDevice(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    name: row.name,
    kind: row.kind,
    serial: row.serial,
    status: row.status,
    lastSeenAt: iso(row.last_seen_at),
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    assetId: row.asset_id,
    kind: row.kind,
    person: row.person,
    condition: row.condition,
    notes: row.notes,
    location: row.location,
    at: iso(row.at),
  };
}

function mapNotification(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    href: row.href,
    readAt: iso(row.read_at),
    createdAt: iso(row.created_at),
  };
}

function branchFilter(user, params, column = "branch_id") {
  if (companyWide(user)) return "";
  params.push(user.branchId);
  return ` AND ${column} = $${params.length}`;
}

function assertBranch(user, branchId) {
  const id = asUuid(branchId, "Branch");
  if (!companyWide(user) && id !== user.branchId) throw bad(403, "That branch is outside your access.");
  return id;
}

async function ownedBranch(q, user, branchId) {
  const id = assertBranch(user, branchId);
  const rows = await q(`SELECT id FROM branches WHERE id = $1 AND company_id = $2 AND active`, [id, user.companyId]);
  if (!rows[0]) throw bad(400, "Choose an active branch.");
  return id;
}

function friendly(error) {
  if (error?.code === "23505") {
    const message = String(error.message || "");
    if (message.includes("email")) return bad(409, "That email is already in use.");
    if (message.includes("sku") || message.includes("products")) return bad(409, "That SKU already exists.");
    if (message.includes("code")) return bad(409, "That branch code already exists.");
    return bad(409, "That record already exists.");
  }
  return error;
}

async function audit(q, user, action, entity, entityId, detail = {}) {
  await q(
    `INSERT INTO audit_log (id, company_id, actor_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [randomUUID(), user.companyId, user.id, action, entity, entityId, JSON.stringify(detail)],
  );
}

async function notify(q, { companyId, employeeId, kind, title, body, href = "" }) {
  await q(
    `INSERT INTO notifications (id, company_id, employee_id, kind, title, body, href) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), companyId, employeeId, kind, title, body, href],
  );
}

async function userById(id) {
  const rows = await query(
    `SELECT e.*, c.name AS company_name, c.timezone, b.name AS branch_name
     FROM employees e
     JOIN companies c ON c.id = e.company_id
     JOIN branches b ON b.id = e.branch_id
     WHERE e.id = $1`,
    [id],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function createSession(employeeId) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_MS);
  await query(
    `INSERT INTO sessions (id, employee_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)`,
    [randomUUID(), employeeId, hashToken(token), expires.toISOString()],
  );
  return { token, maxAge: Math.floor(SESSION_MS / 1000) };
}

export async function userForToken(token) {
  if (!token) return null;
  const rows = await query(
    `SELECT e.*, c.name AS company_name, c.timezone, b.name AS branch_name
     FROM sessions s
     JOIN employees e ON e.id = s.employee_id
     JOIN companies c ON c.id = e.company_id
     JOIN branches b ON b.id = e.branch_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND e.active`,
    [hashToken(token)],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function logout(token) {
  if (!token) return;
  await query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

export async function setupStatus(localHost) {
  const rows = await query(`SELECT email FROM employees WHERE lower(email) = $1 LIMIT 1`, [DEMO_EMAIL]);
  return {
    demoLogin: localHost && rows[0] ? { email: DEMO_EMAIL, password: DEMO_PASSWORD } : null,
  };
}

function roleRank(role) {
  return ROLES.indexOf(role);
}

export async function setupCompany(input) {
  const companyName = clip(input.companyName, 80, "Company name");
  const branchName = clip(input.branchName, 80, "Branch name");
  const adminName = clip(input.adminName, 80, "Your name");
  const email = cleanEmail(input.email);
  assertPassword(input.password);
  const timezone = String(input.timezone || "Africa/Johannesburg");
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw bad(400, "Choose a valid timezone.");
  }
  const passwordHash = await hashPassword(input.password);
  try {
    const employeeId = await tx(async (q) => {
      const companyId = randomUUID();
      const branchId = randomUUID();
      const id = randomUUID();
      await q(`INSERT INTO companies (id, name, timezone) VALUES ($1,$2,$3)`, [companyId, companyName, timezone]);
      await q(
        `INSERT INTO branches (id, company_id, name, code) VALUES ($1,$2,$3,'HO')`,
        [branchId, companyId, branchName],
      );
      await q(
        `INSERT INTO employees (id, company_id, branch_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6,'owner')`,
        [id, companyId, branchId, adminName, email, passwordHash],
      );
      await q(`INSERT INTO counters (company_id, name, value) VALUES ($1,'asset',0)`, [companyId]);
      return id;
    });
    return userById(employeeId);
  } catch (error) {
    throw friendly(error);
  }
}

export async function login(email, password) {
  const normalized = cleanEmail(email);
  const rows = await query(
    `SELECT e.*, c.name AS company_name, c.timezone, b.name AS branch_name
     FROM employees e
     JOIN companies c ON c.id = e.company_id
     JOIN branches b ON b.id = e.branch_id
     WHERE lower(e.email) = $1`,
    [normalized],
  );
  const row = rows[0];
  const hash = row?.password_hash || "scrypt$00$00";
  const match = await verifyPassword(password, hash);
  if (!row || !match || !row.active) throw bad(401, "Email or password is incorrect.");
  await query(
    `INSERT INTO audit_log (id, company_id, actor_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,'auth.login','employee',$3,'{}'::jsonb)`,
    [randomUUID(), row.company_id, row.id],
  );
  return mapUser(row);
}

export async function changePassword(user, input) {
  assertPassword(input.next);
  const rows = await query(`SELECT password_hash FROM employees WHERE id = $1`, [user.id]);
  const match = await verifyPassword(String(input.current || ""), rows[0]?.password_hash);
  if (!match) throw bad(400, "Current password is incorrect.");
  const passwordHash = await hashPassword(input.next);
  await query(`UPDATE employees SET password_hash = $1, updated_at = now() WHERE id = $2`, [passwordHash, user.id]);
  return { ok: true };
}

export async function updateCompany(user, input) {
  assertCap(user, "company");
  const name = clip(input.name, 80, "Company name");
  const timezone = String(input.timezone || "");
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw bad(400, "Choose a valid timezone.");
  }
  await query(`UPDATE companies SET name = $1, timezone = $2 WHERE id = $3`, [name, timezone, user.companyId]);
  return userById(user.id);
}

export async function listBranches(user) {
  const params = [user.companyId];
  let sql = `SELECT * FROM branches WHERE company_id = $1`;
  sql += branchFilter(user, params, "id");
  sql += ` ORDER BY name`;
  return (await query(sql, params)).map(mapBranch);
}

export async function createBranch(user, input) {
  assertCap(user, "branches");
  const name = clip(input.name, 80, "Branch name");
  const code = clip(input.code, 12, "Branch code").toUpperCase();
  const address = optionalText(input.address, 160);
  try {
    const id = randomUUID();
    const rows = await query(
      `INSERT INTO branches (id, company_id, name, code, address) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, user.companyId, name, code, address],
    );
    return mapBranch(rows[0]);
  } catch (error) {
    throw friendly(error);
  }
}

export async function updateBranch(user, id, input) {
  assertCap(user, "branches");
  const branchId = asUuid(id, "Branch");
  const name = clip(input.name, 80, "Branch name");
  const code = clip(input.code, 12, "Branch code").toUpperCase();
  const address = optionalText(input.address, 160);
  const active = Boolean(input.active);
  try {
    const rows = await query(
      `UPDATE branches SET name=$1, code=$2, address=$3, active=$4, updated_at=now()
       WHERE id=$5 AND company_id=$6 RETURNING *`,
      [name, code, address, active, branchId, user.companyId],
    );
    if (!rows[0]) throw bad(404, "Branch not found.");
    return mapBranch(rows[0]);
  } catch (error) {
    throw friendly(error);
  }
}

export async function listEmployees(user) {
  const params = [user.companyId];
  let sql = `SELECT * FROM employees WHERE company_id = $1`;
  sql += branchFilter(user, params);
  sql += ` ORDER BY name`;
  return (await query(sql, params)).map((row) => mapEmployee(row, user));
}

export async function createEmployee(user, input) {
  assertCap(user, "employees");
  const name = clip(input.name, 80, "Name");
  const email = cleanEmail(input.email);
  const role = String(input.role || "");
  if (!ROLES.includes(role)) throw bad(400, "Choose a valid role.");
  if (user.role !== "owner" && role === "owner") throw bad(403, "Only an owner can add another owner.");
  if (roleRank(role) < roleRank(user.role)) throw bad(403, "You cannot assign a role above your own.");
  const branchId = await ownedBranch(query, user, input.branchId);
  assertPassword(input.password);
  const passwordHash = await hashPassword(input.password);
  try {
    const id = randomUUID();
    await query(
      `INSERT INTO employees (id, company_id, branch_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, user.companyId, branchId, name, email, passwordHash, role],
    );
    await audit(query, user, "employee.create", "employee", id, { role });
    const rows = await query(`SELECT * FROM employees WHERE id = $1`, [id]);
    return mapEmployee(rows[0], user);
  } catch (error) {
    throw friendly(error);
  }
}

export async function updateEmployee(user, id, input) {
  assertCap(user, "employees");
  const employeeId = asUuid(id, "Employee");
  if (employeeId === user.id && input.active === false) throw bad(400, "You cannot deactivate your own login.");
  const existing = await query(`SELECT * FROM employees WHERE id = $1 AND company_id = $2`, [employeeId, user.companyId]);
  if (!existing[0]) throw bad(404, "Employee not found.");
  const role = String(input.role || existing[0].role);
  if (!ROLES.includes(role)) throw bad(400, "Choose a valid role.");
  if (user.role !== "owner" && role === "owner") throw bad(403, "Only an owner can assign the owner role.");
  if (employeeId === user.id && role !== user.role) throw bad(400, "You cannot change your own role.");
  const branchId = await ownedBranch(query, user, input.branchId || existing[0].branch_id);
  const name = clip(input.name || existing[0].name, 80, "Name");
  const active = input.active !== false;
  if (!active && existing[0].role === "owner") {
    const owners = await query(`SELECT count(*)::int AS n FROM employees WHERE company_id = $1 AND role = 'owner' AND active`, [user.companyId]);
    if (num(owners[0].n) <= 1) throw bad(400, "Keep at least one active owner.");
  }
  await query(
    `UPDATE employees SET name=$1, role=$2, branch_id=$3, active=$4, updated_at=now() WHERE id=$5`,
    [name, role, branchId, active, employeeId],
  );
  if (input.password) {
    assertPassword(input.password);
    const passwordHash = await hashPassword(input.password);
    await query(`UPDATE employees SET password_hash=$1 WHERE id=$2`, [passwordHash, employeeId]);
  }
  const rows = await query(`SELECT * FROM employees WHERE id = $1`, [employeeId]);
  return mapEmployee(rows[0], user);
}

async function nextAssetCode(q, companyId) {
  const rows = await q(
    `INSERT INTO counters (company_id, name, value) VALUES ($1,'asset',1)
     ON CONFLICT (company_id, name) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [companyId],
  );
  return `TT-AST-${String(rows[0].value).padStart(3, "0")}`;
}

export async function listAssets(user) {
  const params = [user.companyId];
  let sql = `SELECT * FROM assets WHERE company_id = $1`;
  sql += branchFilter(user, params);
  sql += ` ORDER BY public_id`;
  return (await query(sql, params)).map(mapAsset);
}

export async function createAsset(user, input) {
  assertCap(user, "assets");
  const branchId = await ownedBranch(query, user, input.branchId || user.branchId);
  const name = clip(input.name, 120, "Asset name");
  const category = clip(input.category, 60, "Category");
  const department = clip(input.department, 60, "Department");
  const location = clip(input.location, 80, "Location");
  const serial = optionalText(input.serial, 80);
  const condition = optionalText(input.condition, 40) || "Good";
  const id = maybeUuid(input.id) || randomUUID();
  const asset = await tx(async (q) => {
    const publicId = await nextAssetCode(q, user.companyId);
    const rows = await q(
      `INSERT INTO assets (id, company_id, branch_id, public_id, name, category, department, location, serial, condition)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, user.companyId, branchId, publicId, name, category, department, location, serial, condition],
    );
    return mapAsset(rows[0]);
  });
  return asset;
}

async function assetForUpdate(q, user, id) {
  const assetId = asUuid(id, "Asset");
  const params = [assetId, user.companyId];
  let sql = `SELECT * FROM assets WHERE id = $1 AND company_id = $2`;
  sql += branchFilter(user, params);
  const rows = await q(sql, params);
  if (!rows[0]) throw bad(404, "Asset not found.");
  return rows[0];
}

export async function checkoutAsset(user, id, input) {
  assertCap(user, "assets");
  const person = clip(input.person, 80, "Employee");
  const due = String(input.due || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw bad(400, "Enter an expected return date.");
  const notes = optionalText(input.notes, 400);
  return tx(async (q) => {
    const current = await assetForUpdate(q, user, id);
    if (current.status !== "available") throw bad(409, "That asset is already checked out.");
    const rows = await q(
      `UPDATE assets SET status='out', holder=$1, due=$2, version=version+1, updated_at=now()
       WHERE id=$3 AND status='available' RETURNING *`,
      [person, due, current.id],
    );
    if (!rows[0]) throw bad(409, "That asset changed. Refresh and try again.");
    await q(
      `INSERT INTO custody_events (id, company_id, asset_id, kind, person, condition, notes, location, actor_id)
       VALUES ($1,$2,$3,'out',$4,$5,$6,$7,$8)`,
      [randomUUID(), user.companyId, current.id, person, current.condition, notes, current.location, user.id],
    );
    await audit(q, user, "asset.checkout", "asset", current.id, { person, due });
    return mapAsset(rows[0]);
  });
}

export async function checkinAsset(user, id, input) {
  assertCap(user, "assets");
  const person = clip(input.person, 80, "Received by");
  const condition = clip(input.condition, 40, "Condition");
  const location = clip(input.location, 80, "Return location");
  const notes = optionalText(input.notes, 400);
  return tx(async (q) => {
    const current = await assetForUpdate(q, user, id);
    if (current.status !== "out") throw bad(409, "That asset is already checked in.");
    const rows = await q(
      `UPDATE assets SET status='available', holder='', due=NULL, condition=$1, location=$2, version=version+1, updated_at=now()
       WHERE id=$3 AND status='out' RETURNING *`,
      [condition, location, current.id],
    );
    if (!rows[0]) throw bad(409, "That asset changed. Refresh and try again.");
    await q(
      `INSERT INTO custody_events (id, company_id, asset_id, kind, person, condition, notes, location, actor_id)
       VALUES ($1,$2,$3,'in',$4,$5,$6,$7,$8)`,
      [randomUUID(), user.companyId, current.id, person, condition, notes, location, user.id],
    );
    await audit(q, user, "asset.checkin", "asset", current.id, { person, condition, location });
    return mapAsset(rows[0]);
  });
}

export async function listProducts(user) {
  const params = [user.companyId];
  let sql = `SELECT * FROM products WHERE company_id = $1`;
  sql += branchFilter(user, params);
  sql += ` ORDER BY name`;
  return (await query(sql, params)).map(mapProduct);
}

async function postLedger(q, { companyId, branchId, productId, delta, reason, refType = "", refId = null, note = "", actorId = null, at = null }) {
  const rows = await q(`SELECT qty FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE`, [productId, companyId]);
  if (!rows[0]) throw bad(404, "Product not found.");
  const next = num(rows[0].qty) + num(delta);
  await q(`UPDATE products SET qty = $1, version = version + 1, updated_at = now() WHERE id = $2`, [next, productId]);
  await q(
    `INSERT INTO stock_ledger (id, company_id, branch_id, product_id, qty_delta, balance_after, reason, ref_type, ref_id, note, actor_id, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12::timestamptz, now()))`,
    [randomUUID(), companyId, branchId, productId, delta, next, reason, refType, refId, note, actorId, at],
  );
  return next;
}

export async function createProduct(user, input) {
  assertCap(user, "products");
  const branchId = await ownedBranch(query, user, input.branchId || user.branchId);
  const name = clip(input.name, 120, "Product name");
  const sku = clip(input.sku, 40, "SKU");
  const department = clip(input.department, 60, "Department");
  const category = clip(input.category, 60, "Category");
  const aisle = clip(input.aisle, 60, "Aisle");
  const qty = Number(input.qty);
  if (!Number.isInteger(qty) || qty < 0 || qty > 1_000_000) throw bad(400, "Enter an opening quantity of 0 or more.");
  const id = maybeUuid(input.id) || randomUUID();
  try {
    return await tx(async (q) => {
      const rows = await q(
        `INSERT INTO products (id, company_id, branch_id, sku, name, department, aisle, category, qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0) RETURNING *`,
        [id, user.companyId, branchId, sku, name, department, aisle, category],
      );
      if (qty > 0) {
        await postLedger(q, {
          companyId: user.companyId,
          branchId,
          productId: id,
          delta: qty,
          reason: "opening",
          note: "Opening balance",
          actorId: user.id,
        });
      }
      const saved = await q(`SELECT * FROM products WHERE id = $1`, [id]);
      return mapProduct(saved[0] || rows[0]);
    });
  } catch (error) {
    throw friendly(error);
  }
}

export async function updateProduct(user, id, input) {
  assertCap(user, "products");
  const productId = asUuid(id, "Product");
  const name = clip(input.name, 120, "Product name");
  const department = clip(input.department, 60, "Department");
  const category = clip(input.category, 60, "Category");
  const aisle = clip(input.aisle, 60, "Aisle");
  const params = [name, department, aisle, category, productId, user.companyId];
  let sql = `UPDATE products SET name=$1, department=$2, aisle=$3, category=$4, version=version+1, updated_at=now()
             WHERE id=$5 AND company_id=$6`;
  sql += branchFilter(user, params);
  sql += ` RETURNING *`;
  const rows = await query(sql, params);
  if (!rows[0]) throw bad(404, "Product not found.");
  return mapProduct(rows[0]);
}

function scopeSql() {
  return `(
    $3 = 'full'
    OR ($3 = 'aisle' AND lower(aisle) = lower($4))
    OR ($3 = 'department' AND lower(department) = lower($4))
    OR ($3 = 'category' AND lower(category) = lower($4))
    OR ($3 = 'range' AND lower(sku) LIKE lower($4) ESCAPE '\\')
  )`;
}

function scopeArgs(scope, value) {
  const kind = String(scope || "");
  if (!["full", "aisle", "department", "category", "range"].includes(kind)) throw bad(400, "Choose a count scope.");
  const raw = String(value || "").trim();
  if (kind !== "full" && !raw) throw bad(400, "Enter the aisle, department, category, or SKU prefix.");
  if (raw.length > 60) throw bad(400, "Scope value is too long.");
  const pattern = kind === "range" ? `${raw.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : raw;
  return { kind, raw, pattern };
}

async function productsInScope(q, companyId, branchId, scope, pattern) {
  return q(
    `SELECT * FROM products WHERE company_id = $1 AND branch_id = $2 AND ${scopeSql()} ORDER BY name`,
    [companyId, branchId, scope, pattern],
  );
}

function mapStocktake(row, lines = []) {
  return {
    id: row.id,
    branchId: row.branch_id,
    scheduleId: row.schedule_id,
    name: row.name,
    scope: row.scope,
    scopeValue: row.scope_value,
    status: row.status,
    assignedEmployeeId: row.assigned_employee_id,
    snapshotAt: iso(row.snapshot_at),
    submittedAt: iso(row.submitted_at),
    approvedAt: iso(row.approved_at),
    createdAt: iso(row.created_at),
    lines: lines.map((line) => ({
      productId: line.product_id,
      sku: line.sku || "",
      name: line.name || "",
      expected: num(line.expected),
      counted: line.counted === null || line.counted === undefined ? null : num(line.counted),
      movement: num(line.movement),
      variance: line.variance === null || line.variance === undefined ? null : num(line.variance),
    })),
  };
}

async function stocktakeBundle(q, user, id) {
  const stocktakeId = asUuid(id, "Stocktake");
  const params = [stocktakeId, user.companyId];
  let sql = `SELECT * FROM stocktakes WHERE id = $1 AND company_id = $2`;
  sql += branchFilter(user, params);
  const rows = await q(sql, params);
  if (!rows[0]) throw bad(404, "Stocktake not found.");
  const lines = await q(
    `SELECT l.*, p.name, p.sku FROM stocktake_lines l JOIN products p ON p.id = l.product_id WHERE l.stocktake_id = $1 ORDER BY p.name`,
    [stocktakeId],
  );
  return { row: rows[0], lines };
}

export async function listStocktakes(user) {
  const params = [user.companyId];
  let sql = `SELECT * FROM stocktakes WHERE company_id = $1`;
  sql += branchFilter(user, params);
  sql += ` ORDER BY created_at DESC`;
  const rows = await query(sql, params);
  const ids = rows.map((row) => row.id);
  const lines = ids.length
    ? await query(
      `SELECT l.*, p.sku, p.name FROM stocktake_lines l JOIN products p ON p.id = l.product_id WHERE l.stocktake_id = ANY($1::uuid[])`,
      [ids],
    )
    : [];
  return rows.map((row) => mapStocktake(row, lines.filter((line) => line.stocktake_id === row.id)));
}

async function insertStocktake(q, { user, id, branchId, scheduleId, name, scope, scopeValue, pattern, assignedEmployeeId }) {
  const products = await productsInScope(q, user.companyId, branchId, scope, pattern);
  if (!products.length) throw bad(400, "No products match that scope.");
  const stocktakeId = id || randomUUID();
  const rows = await q(
    `INSERT INTO stocktakes (id, company_id, branch_id, schedule_id, name, scope, scope_value, status, assigned_employee_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9) RETURNING *`,
    [stocktakeId, user.companyId, branchId, scheduleId, name, scope, scopeValue, assignedEmployeeId, user.id],
  );
  for (const product of products) {
    await q(
      `INSERT INTO stocktake_lines (stocktake_id, product_id, expected, counted) VALUES ($1,$2,$3,NULL)`,
      [stocktakeId, product.id, num(product.qty)],
    );
  }
  if (assignedEmployeeId) {
    await notify(q, {
      companyId: user.companyId,
      employeeId: assignedEmployeeId,
      kind: "assignment",
      title: "Count assigned",
      body: `${name} is assigned to you.`,
      href: `stocktake:${stocktakeId}`,
    });
  }
  const lines = await q(`SELECT * FROM stocktake_lines WHERE stocktake_id = $1`, [stocktakeId]);
  return mapStocktake(rows[0], lines);
}

export async function createStocktake(user, input) {
  assertCap(user, "stocktakes");
  const branchId = await ownedBranch(query, user, input.branchId || user.branchId);
  const name = clip(input.name, 120, "Count name");
  const scope = scopeArgs(input.scope, input.scopeValue);
  const id = maybeUuid(input.id) || randomUUID();
  let assigned = null;
  if (input.assignedEmployeeId) {
    assertCap(user, "assign");
    assigned = asUuid(input.assignedEmployeeId, "Employee");
    const staff = await query(`SELECT id, branch_id FROM employees WHERE id = $1 AND company_id = $2 AND active`, [assigned, user.companyId]);
    if (!staff[0] || staff[0].branch_id !== branchId) throw bad(400, "Assign someone at the same branch.");
  }
  return tx((q) => insertStocktake(q, {
    user,
    id,
    branchId,
    scheduleId: null,
    name,
    scope: scope.kind,
    scopeValue: scope.kind === "full" ? "" : scope.raw,
    pattern: scope.pattern,
    assignedEmployeeId: assigned,
  }));
}

export async function setCounts(user, id, input) {
  assertCap(user, "stocktakes");
  const counts = Array.isArray(input.counts) ? input.counts : [];
  if (!counts.length) throw bad(400, "No counts were sent.");
  return tx(async (q) => {
    const bundle = await stocktakeBundle(q, user, id);
    if (bundle.row.status !== "active") throw bad(409, "This count is no longer editable.");
    for (const entry of counts) {
      const productId = asUuid(entry.productId, "Product");
      if (!bundle.lines.some((line) => line.product_id === productId)) throw bad(400, "That product is outside this count.");
      if (entry.count === null || entry.count === "") {
        await q(`UPDATE stocktake_lines SET counted = NULL WHERE stocktake_id = $1 AND product_id = $2`, [bundle.row.id, productId]);
        continue;
      }
      const count = Number(entry.count);
      if (!Number.isInteger(count) || count < 0 || count > 1_000_000) throw bad(400, "Counts must be whole numbers of 0 or more.");
      await q(`UPDATE stocktake_lines SET counted = $1 WHERE stocktake_id = $2 AND product_id = $3`, [count, bundle.row.id, productId]);
    }
    await q(`UPDATE stocktakes SET version = version + 1, updated_at = now() WHERE id = $1`, [bundle.row.id]);
    const fresh = await stocktakeBundle(q, user, bundle.row.id);
    return mapStocktake(fresh.row, fresh.lines);
  });
}

async function supervisors(q, companyId, branchId) {
  return q(
    `SELECT id FROM employees WHERE company_id = $1 AND active AND (
      role IN ('owner','admin') OR (branch_id = $2 AND role IN ('manager','supervisor'))
    )`,
    [companyId, branchId],
  );
}

export async function submitStocktake(user, id) {
  assertCap(user, "stocktakes");
  return tx(async (q) => {
    const bundle = await stocktakeBundle(q, user, id);
    if (bundle.row.status !== "active") throw bad(409, "This count was already submitted.");
    if (bundle.lines.some((line) => line.counted === null)) throw bad(400, "Count every product before submitting.");
    const rows = await q(
      `UPDATE stocktakes SET status='completed', submitted_at=now(), version=version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [bundle.row.id],
    );
    const people = await supervisors(q, user.companyId, bundle.row.branch_id);
    for (const person of people) {
      await notify(q, {
        companyId: user.companyId,
        employeeId: person.id,
        kind: "approval",
        title: "Count ready for approval",
        body: `${bundle.row.name} has been submitted.`,
        href: `stocktake:${bundle.row.id}`,
      });
    }
    return mapStocktake(rows[0], bundle.lines);
  });
}

export async function reconciliation(user, id) {
  const bundle = await stocktakeBundle(query, user, id);
  const items = [];
  for (const line of bundle.lines) {
    const moves = await query(
      `SELECT COALESCE(SUM(qty_delta),0)::int AS delta FROM stock_ledger
       WHERE product_id = $1 AND at > $2 AND (ref_id IS DISTINCT FROM $3)`,
      [line.product_id, bundle.row.snapshot_at, bundle.row.id],
    );
    const explained = explainLine({
      name: line.name,
      expected: num(line.expected),
      movements: num(moves[0].delta),
      counted: num(line.counted),
    });
    items.push({ productId: line.product_id, sku: line.sku, name: line.name, ...explained });
  }
  return { stocktakeId: bundle.row.id, status: bundle.row.status, items };
}

export async function approveStocktake(user, id) {
  assertCap(user, "approve");
  return tx(async (q) => {
    const bundle = await stocktakeBundle(q, user, id);
    if (bundle.row.status !== "completed") throw bad(409, "Only a submitted count can be approved.");
    if (bundle.row.created_by === user.id && user.role !== "owner") {
      throw bad(403, "Someone else must approve a count you submitted.");
    }
    for (const line of bundle.lines) {
      const moves = await q(
        `SELECT COALESCE(SUM(qty_delta),0)::int AS delta FROM stock_ledger
         WHERE product_id = $1 AND at > $2 AND (ref_id IS DISTINCT FROM $3)`,
        [line.product_id, bundle.row.snapshot_at, bundle.row.id],
      );
      const explained = explainLine({
        name: line.name,
        expected: num(line.expected),
        movements: num(moves[0].delta),
        counted: num(line.counted),
      });
      if (explained.variance !== 0) {
        await postLedger(q, {
          companyId: user.companyId,
          branchId: bundle.row.branch_id,
          productId: line.product_id,
          delta: explained.variance,
          reason: "count_adjustment",
          refType: "stocktake",
          refId: bundle.row.id,
          note: explained.narrative,
          actorId: user.id,
        });
      }
      await q(
        `UPDATE stocktake_lines SET movement = $1, variance = $2 WHERE stocktake_id = $3 AND product_id = $4`,
        [explained.movements, explained.variance, bundle.row.id, line.product_id],
      );
    }
    const rows = await q(
      `UPDATE stocktakes SET status='approved', approved_by=$1, approved_at=now(), version=version+1, updated_at=now()
       WHERE id=$2 RETURNING *`,
      [user.id, bundle.row.id],
    );
    await audit(q, user, "stocktake.approve", "stocktake", bundle.row.id, { name: bundle.row.name });
    const lines = await q(`SELECT * FROM stocktake_lines WHERE stocktake_id = $1`, [bundle.row.id]);
    return mapStocktake(rows[0], lines);
  });
}

export async function assignStocktake(user, id, input) {
  assertCap(user, "assign");
  const employeeId = asUuid(input.employeeId, "Employee");
  return tx(async (q) => {
    const bundle = await stocktakeBundle(q, user, id);
    const staff = await q(`SELECT id, branch_id FROM employees WHERE id = $1 AND company_id = $2 AND active`, [employeeId, user.companyId]);
    if (!staff[0] || staff[0].branch_id !== bundle.row.branch_id) throw bad(400, "Assign someone at the same branch.");
    const rows = await q(
      `UPDATE stocktakes SET assigned_employee_id = $1, version = version + 1, updated_at = now() WHERE id = $2 RETURNING *`,
      [employeeId, bundle.row.id],
    );
    await notify(q, {
      companyId: user.companyId,
      employeeId,
      kind: "assignment",
      title: "Count assigned",
      body: `${bundle.row.name} is assigned to you.`,
      href: `stocktake:${bundle.row.id}`,
    });
    return mapStocktake(rows[0], bundle.lines);
  });
}

function scheduleSpec(user, input) {
  const frequency = String(input.frequency || "").toLowerCase();
  if (!["daily", "weekly", "monthly"].includes(frequency)) throw bad(400, "Choose daily, weekly, or monthly.");
  const timeOfDay = String(input.timeOfDay || "");
  if (!/^\d{2}:\d{2}$/.test(timeOfDay)) throw bad(400, "Enter a scheduled time.");
  const weekday = frequency === "weekly" ? Number(input.weekday ?? weekdayInTz(user.timezone)) : null;
  const dayOfMonth = frequency === "monthly" ? Number(input.dayOfMonth || todayInTz(user.timezone).slice(8)) : null;
  if (frequency === "weekly" && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) throw bad(400, "Choose a weekday.");
  if (frequency === "monthly" && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28)) {
    throw bad(400, "Monthly counts use a day from 1 to 28.");
  }
  return { frequency, timeOfDay, weekday, dayOfMonth };
}

export async function listSchedules(user) {
  const params = [user.companyId];
  let sql = `SELECT * FROM schedules WHERE company_id = $1 AND active`;
  sql += branchFilter(user, params);
  sql += ` ORDER BY name`;
  return (await query(sql, params)).map(mapSchedule);
}

export async function createSchedule(user, input) {
  assertCap(user, "schedules");
  const branchId = await ownedBranch(query, user, input.branchId || user.branchId);
  const name = clip(input.name, 120, "Schedule name");
  const scope = scopeArgs(input.scope, input.scopeValue);
  const spec = scheduleSpec(user, input);
  let assigned = null;
  if (input.assignedEmployeeId) {
    assigned = asUuid(input.assignedEmployeeId, "Employee");
    const staff = await query(`SELECT branch_id FROM employees WHERE id = $1 AND company_id = $2 AND active`, [assigned, user.companyId]);
    if (!staff[0] || staff[0].branch_id !== branchId) throw bad(400, "Assign someone at the same branch.");
  }
  let next;
  try {
    next = nextRunAt({ ...spec, timeZone: user.timezone });
  } catch (error) {
    throw bad(400, error.message);
  }
  const id = maybeUuid(input.id) || randomUUID();
  const rows = await query(
    `INSERT INTO schedules (id, company_id, branch_id, name, scope, scope_value, frequency, time_of_day, weekday, day_of_month, assigned_employee_id, next_run_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [id, user.companyId, branchId, name, scope.kind, scope.kind === "full" ? "" : scope.raw, spec.frequency, spec.timeOfDay, spec.weekday, spec.dayOfMonth, assigned, next.toISOString(), user.id],
  );
  return mapSchedule(rows[0]);
}

export async function deleteSchedule(user, id) {
  assertCap(user, "schedules");
  const scheduleId = asUuid(id, "Schedule");
  const params = [scheduleId, user.companyId];
  let sql = `UPDATE schedules SET active = false, updated_at = now() WHERE id = $1 AND company_id = $2`;
  sql += branchFilter(user, params);
  sql += ` RETURNING id`;
  const rows = await query(sql, params);
  if (!rows[0]) throw bad(404, "Schedule not found.");
  return { ok: true };
}

async function openScheduledCount(q, schedule, actor) {
  const scope = scopeArgs(schedule.scope, schedule.scope_value);
  const products = await productsInScope(q, schedule.company_id, schedule.branch_id, scope.kind, scope.pattern);
  const recipients = schedule.assigned_employee_id
    ? [{ id: schedule.assigned_employee_id }]
    : await supervisors(q, schedule.company_id, schedule.branch_id);
  if (!products.length) {
    for (const person of recipients) {
      await notify(q, {
        companyId: schedule.company_id,
        employeeId: person.id,
        kind: "schedule",
        title: "Scheduled count skipped",
        body: `${schedule.name} matched no products.`,
        href: "schedules",
      });
    }
    return null;
  }
  const user = {
    id: actor.id,
    companyId: schedule.company_id,
    branchId: schedule.branch_id,
  };
  const stocktake = await insertStocktake(q, {
    user,
    id: randomUUID(),
    branchId: schedule.branch_id,
    scheduleId: schedule.id,
    name: schedule.name,
    scope: scope.kind,
    scopeValue: scope.kind === "full" ? "" : scope.raw,
    pattern: scope.pattern,
    assignedEmployeeId: schedule.assigned_employee_id,
  });
  for (const person of recipients) {
    if (person.id === schedule.assigned_employee_id) continue;
    await notify(q, {
      companyId: schedule.company_id,
      employeeId: person.id,
      kind: "schedule",
      title: "Scheduled count opened",
      body: `${schedule.name} is ready to count.`,
      href: `stocktake:${stocktake.id}`,
    });
  }
  return stocktake;
}

export async function runSchedule(user, id) {
  assertCap(user, "schedules");
  const scheduleId = asUuid(id, "Schedule");
  return tx(async (q) => {
    const params = [scheduleId, user.companyId];
    let sql = `SELECT * FROM schedules WHERE id = $1 AND company_id = $2 AND active`;
    sql += branchFilter(user, params);
    const rows = await q(sql, params);
    if (!rows[0]) throw bad(404, "Schedule not found.");
    const stocktake = await openScheduledCount(q, rows[0], user);
    if (!stocktake) throw bad(400, "No products match that schedule.");
    return stocktake;
  });
}

export async function runDueSchedules() {
  const due = await query(
    `SELECT s.*, c.timezone FROM schedules s
     JOIN companies c ON c.id = s.company_id
     WHERE s.active AND s.next_run_at <= now()`,
  );
  for (const schedule of due) {
    const spec = {
      frequency: schedule.frequency,
      timeOfDay: schedule.time_of_day,
      weekday: schedule.weekday,
      dayOfMonth: schedule.day_of_month,
      timeZone: schedule.timezone,
    };
    const upcoming = nextRunAt(spec, new Date());
    await tx(async (q) => {
      const locked = await q(
        `UPDATE schedules SET next_run_at = $2, last_run_at = now(), updated_at = now(), version = version + 1
         WHERE id = $1 AND active AND next_run_at <= now() RETURNING *`,
        [schedule.id, upcoming.toISOString()],
      );
      if (!locked[0]) return;
      const actor = { id: locked[0].created_by };
      await openScheduledCount(q, locked[0], actor);
    });
  }
}

export async function overdueNotices() {
  const companies = await query(`SELECT id, timezone FROM companies`);
  for (const company of companies) {
    const today = todayInTz(company.timezone);
    const assets = await query(
      `SELECT * FROM assets WHERE company_id = $1 AND status = 'out' AND due IS NOT NULL AND due < $2::date`,
      [company.id, today],
    );
    const people = await query(`SELECT id, name, role, branch_id FROM employees WHERE company_id = $1 AND active`, [company.id]);
    for (const asset of assets) {
      const recipients = people.filter((person) => {
        if (person.role === "owner" || person.role === "admin") return true;
        if (person.branch_id !== asset.branch_id) return false;
        if (person.role === "manager" || person.role === "supervisor") return true;
        return person.name.toLowerCase() === String(asset.holder || "").toLowerCase();
      });
      for (const person of recipients) {
        const href = `asset:${asset.id}`;
        const recent = await query(
          `SELECT id FROM notifications WHERE employee_id = $1 AND kind = 'overdue' AND href = $2 AND created_at > now() - interval '20 hours' LIMIT 1`,
          [person.id, href],
        );
        if (recent[0]) continue;
        await notify(query, {
          companyId: company.id,
          employeeId: person.id,
          kind: "overdue",
          title: "Overdue asset",
          body: `${asset.name} was due back on ${dateOnly(asset.due)}.`,
          href,
        });
      }
    }
  }
}

export async function listDevices(user) {
  const params = [user.companyId];
  let sql = `SELECT * FROM devices WHERE company_id = $1`;
  sql += branchFilter(user, params);
  sql += ` ORDER BY name`;
  return (await query(sql, params)).map(mapDevice);
}

export async function createDevice(user, input) {
  assertCap(user, "devices");
  const branchId = await ownedBranch(query, user, input.branchId || user.branchId);
  const name = clip(input.name, 80, "Device name");
  const kind = String(input.kind || "");
  if (!["OPN-2001", "Phone", "Other"].includes(kind)) throw bad(400, "Choose a device type.");
  const serial = optionalText(input.serial, 80);
  const id = maybeUuid(input.id) || randomUUID();
  const rows = await query(
    `INSERT INTO devices (id, company_id, branch_id, name, kind, serial) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, user.companyId, branchId, name, kind, serial],
  );
  return mapDevice(rows[0]);
}

export async function updateDevice(user, id, input) {
  assertCap(user, "devices");
  const deviceId = asUuid(id, "Device");
  const name = clip(input.name, 80, "Device name");
  const status = input.status === "retired" ? "retired" : "active";
  const serial = optionalText(input.serial, 80);
  const params = [name, status, serial, deviceId, user.companyId];
  let sql = `UPDATE devices SET name=$1, status=$2, serial=$3, version=version+1, updated_at=now() WHERE id=$4 AND company_id=$5`;
  sql += branchFilter(user, params);
  sql += ` RETURNING *`;
  const rows = await query(sql, params);
  if (!rows[0]) throw bad(404, "Device not found.");
  return mapDevice(rows[0]);
}

function mapImport(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    deviceId: row.device_id,
    name: row.name,
    records: row.records || [],
    lineCount: Array.isArray(row.records) ? row.records.length : 0,
    appliedStocktakeId: row.applied_stocktake_id,
    createdAt: iso(row.created_at),
  };
}

export async function listImports(user) {
  const params = [user.companyId];
  let sql = `SELECT * FROM imports WHERE company_id = $1`;
  sql += branchFilter(user, params);
  sql += ` ORDER BY created_at DESC`;
  return (await query(sql, params)).map(mapImport);
}

export async function createImport(user, input) {
  assertCap(user, "imports");
  const branchId = await ownedBranch(query, user, input.branchId || user.branchId);
  const records = input.csv ? parseScanCsv(input.csv) : input.records;
  if (!Array.isArray(records) || !records.length) throw bad(400, "No scan rows were provided.");
  const name = clip(input.name || "Scanner import", 120, "Import name");
  let deviceId = null;
  if (input.deviceId) {
    deviceId = asUuid(input.deviceId, "Device");
    const devices = await query(`SELECT id FROM devices WHERE id = $1 AND company_id = $2 AND branch_id = $3`, [deviceId, user.companyId, branchId]);
    if (!devices[0]) throw bad(400, "Choose a device at this branch.");
    await query(`UPDATE devices SET last_seen_at = now(), updated_at = now() WHERE id = $1`, [deviceId]);
  }
  const id = maybeUuid(input.id) || randomUUID();
  const rows = await query(
    `INSERT INTO imports (id, company_id, branch_id, device_id, name, records, created_by) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,
    [id, user.companyId, branchId, deviceId, name, JSON.stringify(records), user.id],
  );
  return mapImport(rows[0]);
}

export async function applyImport(user, id, input) {
  assertCap(user, "imports");
  assertCap(user, "stocktakes");
  const importId = asUuid(id, "Import");
  const stocktakeId = asUuid(input.stocktakeId, "Stocktake");
  return tx(async (q) => {
    const params = [importId, user.companyId];
    let sql = `SELECT * FROM imports WHERE id = $1 AND company_id = $2`;
    sql += branchFilter(user, params);
    const imports = await q(sql, params);
    if (!imports[0]) throw bad(404, "Import not found.");
    const bundle = await stocktakeBundle(q, user, stocktakeId);
    if (bundle.row.status !== "active") throw bad(409, "Apply scans to an open count.");
    if (bundle.row.branch_id !== imports[0].branch_id) throw bad(400, "The count and the import are at different branches.");
    const totals = new Map();
    for (const record of imports[0].records || []) {
      const key = String(record.barcode || "").trim().toLowerCase();
      totals.set(key, (totals.get(key) || 0) + num(record.quantity));
    }
    const unmatched = [];
    let applied = 0;
    for (const [barcode, quantity] of totals) {
      const line = bundle.lines.find((item) => String(item.sku || "").toLowerCase() === barcode);
      if (!line) {
        unmatched.push(barcode);
        continue;
      }
      await q(
        `UPDATE stocktake_lines SET counted = COALESCE(counted, 0) + $1 WHERE stocktake_id = $2 AND product_id = $3`,
        [quantity, bundle.row.id, line.product_id],
      );
      applied += 1;
    }
    await q(`UPDATE imports SET applied_stocktake_id = $1 WHERE id = $2`, [bundle.row.id, importId]);
    await q(`UPDATE stocktakes SET version = version + 1, updated_at = now() WHERE id = $1`, [bundle.row.id]);
    await audit(q, user, "import.apply", "import", importId, { stocktakeId: bundle.row.id, applied, unmatched });
    const fresh = await stocktakeBundle(q, user, bundle.row.id);
    return { applied, unmatched, stocktake: mapStocktake(fresh.row, fresh.lines) };
  });
}

export async function listEvents(user) {
  const params = [user.companyId];
  let sql = `SELECT e.* FROM custody_events e JOIN assets a ON a.id = e.asset_id WHERE e.company_id = $1`;
  if (!companyWide(user)) {
    params.push(user.branchId);
    sql += ` AND a.branch_id = $${params.length}`;
  }
  sql += ` ORDER BY e.at DESC LIMIT 200`;
  return (await query(sql, params)).map(mapEvent);
}

export async function listAudits(user) {
  const rows = await query(
    `SELECT id, action, entity, entity_id, detail, at FROM audit_log
     WHERE company_id = $1 AND action IN ('stocktake.approve','import.apply','asset.checkout','asset.checkin')
     ORDER BY at DESC LIMIT 100`,
    [user.companyId],
  );
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    detail: row.detail || {},
    at: iso(row.at),
  }));
}

export async function listNotifications(user) {
  const rows = await query(
    `SELECT * FROM notifications WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [user.id],
  );
  return rows.map(mapNotification);
}

export async function markNotification(user, id) {
  const notificationId = asUuid(id, "Notification");
  await query(`UPDATE notifications SET read_at = now() WHERE id = $1 AND employee_id = $2 AND read_at IS NULL`, [notificationId, user.id]);
  return { ok: true };
}

export async function markAllNotifications(user) {
  await query(`UPDATE notifications SET read_at = now() WHERE employee_id = $1 AND read_at IS NULL`, [user.id]);
  return { ok: true };
}

export async function pull(user) {
  const [branches, employees, assets, products, stocktakes, schedules, devices, imports, events, audits, notifications] = await Promise.all([
    listBranches(user),
    listEmployees(user),
    listAssets(user),
    listProducts(user),
    listStocktakes(user),
    listSchedules(user),
    listDevices(user),
    listImports(user),
    listEvents(user),
    listAudits(user),
    listNotifications(user),
  ]);
  return {
    serverTime: new Date().toISOString(),
    company: { id: user.companyId, name: user.companyName, timezone: user.timezone },
    branches,
    employees,
    assets,
    products,
    stocktakes,
    schedules,
    devices,
    imports,
    events,
    audits,
    notifications,
  };
}

export async function seedDemo() {
  if (process.env.SEED_DEMO === "0") return;
  const existing = await query(`SELECT id FROM companies LIMIT 1`);
  if (existing[0]) return;
  const admin = await setupCompany({
    companyName: "Techne Tech",
    timezone: "Africa/Johannesburg",
    branchName: "Head Office",
    adminName: "Techne Admin",
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
  });
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const thaboId = randomUUID();
  await query(
    `INSERT INTO employees (id, company_id, branch_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6,'clerk')`,
    [thaboId, admin.companyId, admin.branchId, "Thabo Mokoena", "thabo@techne.local", passwordHash],
  );
  const yesterday = addDays(todayInTz(admin.timezone), -1);
  const assets = [
    ["Dell Latitude 5420", "IT Equipment", "IT", "Head Office", "DL-5420-A", "available", "", null, "Good"],
    ["Epson EB-X49 Projector", "AV Equipment", "Training", "Training Room", "EP-X49-18", "out", "Thabo Mokoena", yesterday, "Good"],
    ["Makita Cordless Drill", "Tools", "Maintenance", "Store Room", "MK-22-90", "available", "", null, "Good"],
    ["HP ProBook 450", "IT Equipment", "Operations", "Head Office", "HP-450-11", "available", "", null, "Fair"],
  ];
  const assetIds = [];
  for (const asset of assets) {
    const id = randomUUID();
    assetIds.push(id);
    const code = await tx((q) => nextAssetCode(q, admin.companyId));
    await query(
      `INSERT INTO assets (id, company_id, branch_id, public_id, name, category, department, location, serial, status, holder, due, condition)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, admin.companyId, admin.branchId, code, ...asset],
    );
  }
  await query(
    `INSERT INTO custody_events (id, company_id, asset_id, kind, person, condition, notes, location, actor_id, at)
     VALUES ($1,$2,$3,'out',$4,'Good','Training session',$5,$6,$7)`,
    [randomUUID(), admin.companyId, assetIds[1], "Thabo Mokoena", "Training Room", admin.id, new Date(Date.now() - 86400000).toISOString()],
  );
  const catalog = [
    ["BVG-001", "Still Water 500ml", "Retail", "Aisle 1", "Beverages", 150, [-10, -10, -10]],
    ["BVG-002", "Orange Juice 1L", "Retail", "Aisle 1", "Beverages", 57, [-4, -4, -4]],
    ["CLN-001", "Multipurpose Cleaner", "Retail", "Aisle 2", "Household", 80, []],
    ["CLN-002", "Dishwashing Liquid", "Retail", "Aisle 2", "Household", 30, []],
    ["IT-001", "USB-C Cable", "IT", "IT Store", "Accessories", 38, []],
    ["IT-002", "Wireless Mouse", "IT", "IT Store", "Accessories", 17, []],
  ];
  const productIds = {};
  for (const [sku, name, department, aisle, category, opening, issues] of catalog) {
    const id = randomUUID();
    productIds[sku] = id;
    await query(
      `INSERT INTO products (id, company_id, branch_id, sku, name, department, aisle, category, qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0)`,
      [id, admin.companyId, admin.branchId, sku, name, department, aisle, category],
    );
    await tx((q) => postLedger(q, {
      companyId: admin.companyId,
      branchId: admin.branchId,
      productId: id,
      delta: opening,
      reason: "opening",
      note: "Opening balance",
      actorId: admin.id,
      at: new Date(Date.now() - 30 * 86400000).toISOString(),
    }));
    for (let i = 0; i < issues.length; i++) {
      await tx((q) => postLedger(q, {
        companyId: admin.companyId,
        branchId: admin.branchId,
        productId: id,
        delta: issues[i],
        reason: "issue",
        note: "Recorded issue",
        actorId: admin.id,
        at: new Date(Date.now() - (21 - i * 7) * 86400000).toISOString(),
      }));
    }
  }
  const stocktakeId = randomUUID();
  await query(
    `INSERT INTO stocktakes (id, company_id, branch_id, name, scope, scope_value, status, created_by, snapshot_at, submitted_at, approved_by, approved_at, created_at)
     VALUES ($1,$2,$3,'Aisle 2 household count','aisle','Aisle 2','approved',$4,$5,$5,$4,$5,$5)`,
    [stocktakeId, admin.companyId, admin.branchId, admin.id, new Date(Date.now() - 10 * 86400000).toISOString()],
  );
  await query(
    `INSERT INTO stocktake_lines (stocktake_id, product_id, expected, counted, movement, variance) VALUES
     ($1,$2,80,80,0,0), ($1,$3,30,25,0,-5)`,
    [stocktakeId, productIds["CLN-001"], productIds["CLN-002"]],
  );
  await tx((q) => postLedger(q, {
    companyId: admin.companyId,
    branchId: admin.branchId,
    productId: productIds["CLN-002"],
    delta: -5,
    reason: "count_adjustment",
    refType: "stocktake",
    refId: stocktakeId,
    note: "Approved aisle 2 count",
    actorId: admin.id,
    at: new Date(Date.now() - 10 * 86400000 + 3600000).toISOString(),
  }));
  const next = nextRunAt({
    frequency: "daily",
    timeOfDay: "08:00",
    timeZone: admin.timezone,
  });
  await query(
    `INSERT INTO schedules (id, company_id, branch_id, name, scope, scope_value, frequency, time_of_day, next_run_at, created_by, assigned_employee_id)
     VALUES ($1,$2,$3,'Daily Aisle 1 count','aisle','Aisle 1','daily','08:00',$4,$5,$6)`,
    [randomUUID(), admin.companyId, admin.branchId, next.toISOString(), admin.id, thaboId],
  );
  await query(
    `INSERT INTO devices (id, company_id, branch_id, name, kind, serial) VALUES ($1,$2,$3,'Front counter OPN-2001','OPN-2001','OPN-DEMO-1')`,
    [randomUUID(), admin.companyId, admin.branchId],
  );
}

export { DEMO_EMAIL, DEMO_PASSWORD };

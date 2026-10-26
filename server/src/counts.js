import { randomUUID } from "node:crypto";
import { query, tx } from "./db.js";
import { bad } from "./errors.js";
import { assertCap, asUuid, clip, companyWide, optionalText } from "./security.js";

function branchSql(user, params) {
  if (companyWide(user)) return "";
  params.push(user.branchId);
  return ` AND branch_id = $${params.length}`;
}

async function bundle(q, user, id, lock = false) {
  const stocktakeId = asUuid(id, "Stocktake");
  const params = [stocktakeId, user.companyId];
  let sql = `SELECT * FROM stocktakes WHERE id = $1 AND company_id = $2${branchSql(user, params)}`;
  if (lock) sql += ` FOR UPDATE`;
  const rows = await q(sql, params);
  if (!rows[0]) throw bad(404, "Stocktake not found.");
  const lines = await q(
    `SELECT l.*, p.sku, p.name FROM stocktake_lines l JOIN products p ON p.id = l.product_id WHERE l.stocktake_id = $1 ORDER BY p.name`,
    [stocktakeId],
  );
  return { row: rows[0], lines };
}

export async function previewScope(user, input) {
  assertCap(user, "stocktakes");
  const branchId = asUuid(input.branchId || user.branchId, "Branch");
  if (!companyWide(user) && branchId !== user.branchId) throw bad(403, "That branch is outside your access.");
  const scope = String(input.scope || "full");
  const value = String(input.scopeValue || "").trim();
  if (!["full", "aisle", "department", "category", "range", "shelf", "rack", "bin", "abc", "list", "combined"].includes(scope)) {
    throw bad(400, "Choose a count scope.");
  }
  if (scope !== "full" && !value) throw bad(400, "Enter a scope value.");
  if (scope === "combined") {
    let filters = {};
    try { filters = JSON.parse(value); } catch { throw bad(400, "Combined filters are not valid."); }
    const rows = await query(
      `SELECT id, sku, name, aisle, department, category, qty FROM products
       WHERE company_id = $1 AND branch_id = $2
         AND ($3 = '' OR lower(department) = lower($3))
         AND ($4 = '' OR lower(aisle) = lower($4))
         AND ($5 = '' OR lower(shelf) = lower($5))
         AND ($6 = '' OR lower(category) = lower($6))
       ORDER BY name`,
      [user.companyId, branchId, filters.department || "", filters.aisle || "", filters.shelf || "", filters.category || ""],
    );
    return { count: rows.length, products: rows.map((row) => ({ id: row.id, sku: row.sku, name: row.name, aisle: row.aisle, qty: Number(row.qty) })) };
  }
  const pattern = scope === "range" ? `${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : scope === "list" ? value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean).join(",") : value;
  const rows = await query(
    `SELECT id, sku, name, aisle, department, category, qty FROM products
     WHERE company_id = $1 AND branch_id = $2 AND (
       $3 = 'full'
       OR ($3 = 'aisle' AND lower(aisle) = lower($4))
       OR ($3 = 'department' AND lower(department) = lower($4))
       OR ($3 = 'category' AND lower(category) = lower($4))
       OR ($3 = 'shelf' AND lower(shelf) = lower($4))
       OR ($3 = 'rack' AND lower(rack) = lower($4))
       OR ($3 = 'bin' AND lower(bin) = lower($4))
       OR ($3 = 'abc' AND lower(abc_class) = lower($4))
       OR ($3 = 'range' AND lower(sku) LIKE lower($4) ESCAPE '\\')
       OR ($3 = 'list' AND lower(sku) = ANY(string_to_array(lower($4), ',')))
     ) ORDER BY name`,
    [user.companyId, branchId, scope, pattern],
  );
  return { count: rows.length, products: rows.map((row) => ({ id: row.id, sku: row.sku, name: row.name, aisle: row.aisle, qty: Number(row.qty) })) };
}

async function setStatus(user, id, from, to, extraSql = "", extraParams = []) {
  assertCap(user, "stocktakes");
  return tx(async (q) => {
    const current = await bundle(q, user, id, true);
    if (!from.includes(current.row.status)) throw bad(409, "That count cannot change from its current state.");
    const params = [to, current.row.id, ...extraParams];
    const rows = await q(
      `UPDATE stocktakes SET status = $1, version = version + 1, updated_at = now() ${extraSql} WHERE id = $2 RETURNING id, status`,
      params,
    );
    return { id: rows[0].id, status: rows[0].status };
  });
}

export function pauseStocktake(user, id) {
  return setStatus(user, id, ["active"], "paused", ", paused_at = now()");
}
export function resumeStocktake(user, id) {
  return setStatus(user, id, ["paused"], "active", ", paused_at = NULL");
}
export function cancelStocktake(user, id) {
  return setStatus(user, id, ["active", "paused"], "cancelled", ", cancelled_at = now()");
}

export async function reopenStocktake(user, id) {
  assertCap(user, "approve");
  return setStatus(user, id, ["cancelled"], "active", ", cancelled_at = NULL, paused_at = NULL");
}

export async function recountStocktake(user, id, input) {
  assertCap(user, "stocktakes");
  const productId = input.productId ? asUuid(input.productId, "Product") : null;
  return tx(async (q) => {
    const current = await bundle(q, user, id, true);
    if (!["completed", "active", "paused"].includes(current.row.status)) throw bad(409, "This count cannot be recounted.");
    const targets = productId ? current.lines.filter((line) => line.product_id === productId) : current.lines;
    if (!targets.length) throw bad(404, "That product is outside this count.");
    for (const line of targets) {
      await q(
        `UPDATE stocktake_lines SET recount = counted, counted = NULL, exception = '' WHERE stocktake_id = $1 AND product_id = $2`,
        [current.row.id, line.product_id],
      );
    }
    await q(
      `UPDATE stocktakes SET status = 'active', submitted_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
      [current.row.id],
    );
    return { id: current.row.id, status: "active", lines: targets.length };
  });
}

export async function addEvidence(user, id, input) {
  assertCap(user, "stocktakes");
  const note = clip(input.note, 500, "Note");
  const productId = input.productId ? asUuid(input.productId, "Product") : null;
  const current = await bundle(query, user, id);
  if (productId && !current.lines.some((line) => line.product_id === productId)) throw bad(400, "That product is outside this count.");
  const evidenceId = randomUUID();
  await query(
    `INSERT INTO stocktake_evidence (id, company_id, stocktake_id, product_id, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [evidenceId, user.companyId, current.row.id, productId, note, user.id],
  );
  return { id: evidenceId };
}

export async function setReview(user, id, input) {
  assertCap(user, "approve");
  const note = clip(input.note, 500, "Review note");
  const current = await bundle(query, user, id);
  await query(`UPDATE stocktakes SET review_note = $1, version = version + 1, updated_at = now() WHERE id = $2`, [note, current.row.id]);
  return { id: current.row.id, reviewNote: note };
}

export async function assignCounters(user, id, input) {
  assertCap(user, "assign");
  const people = Array.isArray(input.assignees) ? input.assignees : [];
  if (!people.length || people.length > 20) throw bad(400, "Choose who is counting.");
  return tx(async (q) => {
    const current = await bundle(q, user, id, true);
    if (!["active", "paused"].includes(current.row.status)) throw bad(409, "Assign people on an open count.");
    for (const person of people) {
      const employeeId = asUuid(person.employeeId, "Employee");
      const zone = optionalText(person.zone, 60);
      const staff = await q(`SELECT branch_id FROM employees WHERE id = $1 AND company_id = $2 AND active`, [employeeId, user.companyId]);
      if (!staff[0] || staff[0].branch_id !== current.row.branch_id) throw bad(400, "Assign someone at the same branch.");
      await q(
        `INSERT INTO stocktake_assignees (stocktake_id, employee_id, zone) VALUES ($1,$2,$3)
         ON CONFLICT (stocktake_id, employee_id) DO UPDATE SET zone = EXCLUDED.zone`,
        [current.row.id, employeeId, zone],
      );
    }
    return { id: current.row.id, assignees: people.length };
  });
}

export async function addBlackout(user, input) {
  assertCap(user, "schedules");
  const day = String(input.day || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw bad(400, "Enter a date.");
  const reason = optionalText(input.reason, 120);
  await query(
    `INSERT INTO blackout_dates (company_id, day, reason) VALUES ($1,$2::date,$3)
     ON CONFLICT (company_id, day) DO UPDATE SET reason = EXCLUDED.reason`,
    [user.companyId, day, reason],
  );
  return { day, reason };
}

export async function pauseSchedule(user, id, input) {
  assertCap(user, "schedules");
  const scheduleId = asUuid(id, "Schedule");
  const paused = input.paused !== false;
  const params = [paused, scheduleId, user.companyId];
  let sql = `UPDATE schedules SET paused = $1, updated_at = now() WHERE id = $2 AND company_id = $3`;
  if (!companyWide(user)) {
    params.push(user.branchId);
    sql += ` AND branch_id = $${params.length}`;
  }
  sql += ` RETURNING id, paused`;
  const rows = await query(sql, params);
  if (!rows[0]) throw bad(404, "Schedule not found.");
  return { id: rows[0].id, paused: rows[0].paused };
}

export async function scheduleCalendar(user) {
  const params = [user.companyId];
  let sql = `SELECT id, name, frequency, time_of_day, next_run_at, paused, scope, scope_value FROM schedules WHERE company_id = $1 AND active`;
  sql += branchSql(user, params);
  sql += ` ORDER BY next_run_at`;
  const rows = await query(sql, params);
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      frequency: row.frequency,
      timeOfDay: row.time_of_day,
      nextRunAt: row.next_run_at,
      paused: row.paused,
      scope: row.scope,
      scopeValue: row.scope_value,
    })),
  };
}

export async function coverageReport(user) {
  assertCap(user, "stocktakes");
  const params = [user.companyId];
  const rows = await query(
    `SELECT
       count(*)::int AS products,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM stocktake_lines l WHERE l.product_id = p.id))::int AS counted
     FROM products p WHERE p.company_id = $1${branchSql(user, params).replaceAll("branch_id", "p.branch_id")}`,
    params,
  );
  const products = Number(rows[0].products);
  const counted = Number(rows[0].counted);
  const variance = await query(
    `SELECT COALESCE(SUM(ABS(l.variance)),0)::int AS shrinkage, count(*) FILTER (WHERE l.variance <> 0)::int AS lines
     FROM stocktake_lines l JOIN stocktakes s ON s.id = l.stocktake_id
     WHERE s.company_id = $1 AND s.status = 'approved'`,
    [user.companyId],
  );
  return {
    products,
    counted,
    coverage: products ? Math.round((100 * counted) / products) : 0,
    shrinkageUnits: Number(variance[0].shrinkage),
    varianceLines: Number(variance[0].lines),
  };
}

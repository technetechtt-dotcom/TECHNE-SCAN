import { randomUUID } from "node:crypto";
import { query, tx } from "./db.js";
import { bad } from "./errors.js";
import { asUuid, assertCap, companyWide, optionalText } from "./security.js";
import { audit, postLedger } from "./store.js";

function whole(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 1_000_000) throw bad(400, `${label} must be a whole number above zero.`);
  return number;
}

async function branchFor(user, branchId) {
  const id = branchId || user.branchId;
  if (!companyWide(user) && id !== user.branchId) throw bad(403, "That branch is outside your access.");
  const rows = await query(`SELECT id, name FROM branches WHERE id = $1 AND company_id = $2 AND active`, [id, user.companyId]);
  if (!rows[0]) throw bad(404, "Branch not found.");
  return rows[0];
}

function parseLines(input) {
  if (Array.isArray(input.lines) && input.lines.length) {
    return input.lines.map((line) => ({ sku: String(line.sku || "").trim(), qty: whole(line.qty, "Quantity") }));
  }
  if (input.sku) return [{ sku: String(input.sku).trim(), qty: whole(input.qty, "Quantity") }];
  const lines = [];
  for (const raw of String(input.text || "").split(/\r?\n/)) {
    const part = raw.trim();
    if (!part) continue;
    const [sku, qty] = part.split(/[,;\t]/).map((cell) => cell.trim());
    lines.push({ sku, qty: whole(qty, "Quantity") });
  }
  return lines;
}

async function productBySku(q, user, branchId, sku) {
  const rows = await q(
    `SELECT * FROM products WHERE company_id = $1 AND branch_id = $2 AND lower(sku) = lower($3)`,
    [user.companyId, branchId, sku],
  );
  if (!rows[0]) throw bad(404, `SKU ${sku} is not at this branch.`);
  return rows[0];
}

function mapOrder(row, lines) {
  return {
    id: row.id,
    branchId: row.branch_id,
    source: row.source,
    externalRef: row.external_ref,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    lines: lines.map((line) => ({
      id: line.id,
      productId: line.product_id,
      sku: line.sku,
      name: line.name,
      qty: Number(line.qty),
    })),
  };
}

function locationOf(product) {
  return [product.aisle, product.shelf, product.rack, product.bin].filter(Boolean).join(" · ") || "Unassigned location";
}

export async function listPicking(user) {
  assertCap(user, "picking");
  const params = [user.companyId];
  let orderSql = `SELECT * FROM sales_orders WHERE company_id = $1 AND status <> 'cancelled'`;
  if (!companyWide(user)) {
    params.push(user.branchId);
    orderSql += ` AND branch_id = $2`;
  }
  orderSql += ` ORDER BY created_at DESC LIMIT 100`;
  const orders = await query(orderSql, params);
  const orderLines = orders.length
    ? await query(
      `SELECT l.*, p.sku, p.name FROM sales_order_lines l JOIN products p ON p.id = l.product_id WHERE l.order_id = ANY($1::uuid[])`,
      [orders.map((order) => order.id)],
    )
    : [];
  const waveParams = [user.companyId];
  let waveSql = `SELECT * FROM pick_waves WHERE company_id = $1 AND status <> 'cancelled'`;
  if (!companyWide(user)) {
    waveParams.push(user.branchId);
    waveSql += ` AND branch_id = $2`;
  }
  waveSql += ` ORDER BY created_at DESC LIMIT 40`;
  const waves = await query(waveSql, waveParams);
  const pickLines = waves.length
    ? await query(
      `SELECT l.*, p.sku, p.name, p.aisle, p.shelf, p.rack, p.bin
       FROM pick_lines l JOIN products p ON p.id = l.product_id
       WHERE l.wave_id = ANY($1::uuid[]) ORDER BY l.sequence`,
      [waves.map((wave) => wave.id)],
    )
    : [];
  return {
    orders: orders.map((order) => mapOrder(order, orderLines.filter((line) => line.order_id === order.id))),
    waves: waves.map((wave) => {
      const lines = pickLines.filter((line) => line.wave_id === wave.id).map((line) => ({
        id: line.id,
        orderId: line.order_id,
        productId: line.product_id,
        sku: line.sku,
        name: line.name,
        location: locationOf(line),
        sequence: Number(line.sequence),
        qtyRequested: Number(line.qty_requested),
        qtyPicked: Number(line.qty_picked),
        remaining: Number(line.qty_requested) - Number(line.qty_picked),
        status: line.status,
      }));
      const next = lines.find((line) => line.status === "pending") || null;
      return {
        id: wave.id,
        branchId: wave.branch_id,
        name: wave.name,
        status: wave.status,
        assignedEmployeeId: wave.assigned_employee_id,
        releasedAt: new Date(wave.released_at).toISOString(),
        lines,
        next,
      };
    }),
  };
}

export async function createOrder(user, input, source = "manual", externalRef = "") {
  assertCap(user, "picking");
  const branch = await branchFor(user, input.branchId);
  const requested = parseLines(input);
  if (!requested.length || requested.length > 100) throw bad(400, "Enter between 1 and 100 order lines.");
  if (requested.some((line) => !line.sku)) throw bad(400, "Each line needs a SKU.");
  return tx(async (q) => {
    if (externalRef) {
      const existing = await q(
        `SELECT id FROM sales_orders WHERE company_id = $1 AND source = $2 AND external_ref = $3`,
        [user.companyId, source, externalRef],
      );
      if (existing[0]) return { id: existing[0].id, duplicate: true };
    }
    const orderId = randomUUID();
    await q(
      `INSERT INTO sales_orders (id, company_id, branch_id, source, external_ref, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'open',$6)`,
      [orderId, user.companyId, branch.id, source, externalRef, user.id],
    );
    const lines = [];
    for (const line of requested) {
      const product = await productBySku(q, user, branch.id, line.sku);
      const id = randomUUID();
      await q(
        `INSERT INTO sales_order_lines (id, order_id, product_id, qty) VALUES ($1,$2,$3,$4)`,
        [id, orderId, product.id, line.qty],
      );
      lines.push({ id, product_id: product.id, sku: product.sku, name: product.name, qty: line.qty });
    }
    await audit(q, user, "order.create", "sales_order", orderId, { source, lines: lines.length });
    return mapOrder({ id: orderId, branch_id: branch.id, source, external_ref: externalRef, status: "open", created_at: new Date() }, lines);
  });
}

export async function releaseWave(user, input) {
  assertCap(user, "picking");
  const branch = await branchFor(user, input.branchId);
  const name = optionalText(input.name, 120) || `Wave ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  return tx(async (q) => {
    const params = [user.companyId, branch.id];
    let sql = `SELECT * FROM sales_orders WHERE company_id = $1 AND branch_id = $2 AND status = 'open'`;
    if (Array.isArray(input.orderIds) && input.orderIds.length) {
      const ids = input.orderIds.map((id) => asUuid(id, "Order"));
      params.push(ids);
      sql += ` AND id = ANY($${params.length}::uuid[])`;
    }
    sql += ` ORDER BY created_at FOR UPDATE`;
    const orders = await q(sql, params);
    if (!orders.length) throw bad(409, "There is no open order to release.");
    const lineRows = await q(
      `SELECT l.*, p.sku, p.name, p.aisle, p.shelf, p.rack, p.bin
       FROM sales_order_lines l JOIN products p ON p.id = l.product_id
       WHERE l.order_id = ANY($1::uuid[])`,
      [orders.map((order) => order.id)],
    );
    lineRows.sort((a, b) => [a.aisle, a.shelf, a.rack, a.bin, a.sku].join("\u0000").localeCompare([b.aisle, b.shelf, b.rack, b.bin, b.sku].join("\u0000"), "en"));
    const waveId = randomUUID();
    let assigned = null;
    if (input.assignedEmployeeId) {
      assigned = asUuid(input.assignedEmployeeId, "Employee");
      const staff = await q(`SELECT id FROM employees WHERE id = $1 AND company_id = $2 AND branch_id = $3 AND active`, [assigned, user.companyId, branch.id]);
      if (!staff[0]) throw bad(400, "Assign someone at the same branch.");
    }
    await q(
      `INSERT INTO pick_waves (id, company_id, branch_id, name, status, assigned_employee_id, created_by)
       VALUES ($1,$2,$3,$4,'released',$5,$6)`,
      [waveId, user.companyId, branch.id, name, assigned, user.id],
    );
    for (let index = 0; index < lineRows.length; index++) {
      const line = lineRows[index];
      await q(
        `INSERT INTO pick_lines (id, wave_id, order_id, order_line_id, product_id, sequence, qty_requested)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), waveId, line.order_id, line.id, line.product_id, index + 1, line.qty],
      );
    }
    await q(`UPDATE sales_orders SET status = 'waved' WHERE id = ANY($1::uuid[])`, [orders.map((order) => order.id)]);
    await audit(q, user, "wave.release", "pick_wave", waveId, { orders: orders.length, lines: lineRows.length });
    return { id: waveId, name, lines: lineRows.length, first: locationOf(lineRows[0]) };
  });
}

async function refreshOrders(q, orderIds) {
  for (const orderId of orderIds) {
    const lines = await q(`SELECT status FROM pick_lines WHERE order_id = $1`, [orderId]);
    const open = lines.some((line) => line.status === "pending");
    const short = lines.some((line) => line.status === "short");
    const status = open ? "picking" : short ? "short" : "picked";
    await q(`UPDATE sales_orders SET status = $2 WHERE id = $1`, [orderId, status]);
  }
}

export async function confirmPick(user, waveId, input) {
  assertCap(user, "picking");
  const id = asUuid(waveId, "Wave");
  const barcode = String(input.barcode || "").trim();
  if (!barcode) throw bad(400, "Scan the product barcode.");
  const short = input.short === true || input.short === "true";
  const qty = input.qty === undefined || input.qty === "" ? null : (short && Number(input.qty) === 0 ? 0 : whole(input.qty, "Quantity"));
  return tx(async (q) => {
    const waves = await q(`SELECT * FROM pick_waves WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, user.companyId]);
    const wave = waves[0];
    if (!wave) throw bad(404, "Wave not found.");
    if (!companyWide(user) && wave.branch_id !== user.branchId) throw bad(403, "That branch is outside your access.");
    if (!["released", "picking"].includes(wave.status)) throw bad(409, "This wave is not open for picking.");
    const lines = await q(
      `SELECT l.*, p.sku, p.name FROM pick_lines l JOIN products p ON p.id = l.product_id
       WHERE l.wave_id = $1 ORDER BY l.sequence FOR UPDATE OF l`,
      [id],
    );
    const pending = lines.filter((line) => line.status === "pending");
    const line = input.lineId ? pending.find((item) => item.id === asUuid(input.lineId, "Line")) : pending[0];
    if (!line) throw bad(409, "This wave has no remaining pick.");
    if (line.sku.toLowerCase() !== barcode.toLowerCase() && line.product_id !== barcode) {
      throw bad(409, `The next pick is ${line.sku}, not ${barcode}.`);
    }
    const remaining = Number(line.qty_requested) - Number(line.qty_picked);
    const taken = qty === null ? remaining : qty;
    if (taken > remaining) throw bad(409, `Only ${remaining} remains on this line.`);
    if (taken > 0) {
      await postLedger(q, {
        companyId: user.companyId,
        branchId: wave.branch_id,
        productId: line.product_id,
        delta: -taken,
        reason: "pick",
        refType: "pick_wave",
        refId: wave.id,
        note: `Directed pick ${line.sku} from ${wave.name}`,
        actorId: user.id,
      });
    } else if (!short) throw bad(400, "Enter a quantity.");
    const picked = Number(line.qty_picked) + taken;
    const status = picked === Number(line.qty_requested) ? "picked" : short ? "short" : "pending";
    await q(`UPDATE pick_lines SET qty_picked = $1, status = $2 WHERE id = $3`, [picked, status, line.id]);
    const stillOpen = lines.some((item) => item.id !== line.id && item.status === "pending") || status === "pending";
    await q(
      `UPDATE pick_waves SET status = $2, completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END WHERE id = $1`,
      [wave.id, stillOpen ? "picking" : "completed"],
    );
    await refreshOrders(q, [...new Set(lines.map((item) => item.order_id))]);
    await audit(q, user, "wave.pick", "pick_wave", wave.id, { sku: line.sku, qty: taken, status });
    return { waveId: wave.id, sku: line.sku, qty: taken, lineStatus: status, waveStatus: stillOpen ? "picking" : "completed" };
  });
}

export async function cancelWave(user, waveId) {
  assertCap(user, "picking");
  const id = asUuid(waveId, "Wave");
  return tx(async (q) => {
    const waves = await q(`SELECT * FROM pick_waves WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, user.companyId]);
    if (!waves[0]) throw bad(404, "Wave not found.");
    if (!companyWide(user) && waves[0].branch_id !== user.branchId) throw bad(403, "That branch is outside your access.");
    const picked = await q(`SELECT id FROM pick_lines WHERE wave_id = $1 AND qty_picked > 0 LIMIT 1`, [id]);
    if (picked[0]) throw bad(409, "This wave already moved stock.");
    const orders = await q(`SELECT DISTINCT order_id FROM pick_lines WHERE wave_id = $1`, [id]);
    await q(`UPDATE pick_waves SET status = 'cancelled' WHERE id = $1`, [id]);
    await q(`UPDATE sales_orders SET status = 'open' WHERE id = ANY($1::uuid[]) AND status = 'waved'`, [orders.map((order) => order.order_id)]);
    await audit(q, user, "wave.cancel", "pick_wave", id, {});
    return { id, status: "cancelled" };
  });
}

export function pickingRoutes() {
  return [
    ["GET", /^\/api\/picking$/, (user) => listPicking(user)],
    ["POST", /^\/api\/orders$/, (user, body) => createOrder(user, body)],
    ["POST", /^\/api\/waves$/, (user, body) => releaseWave(user, body)],
    ["POST", /^\/api\/waves\/([^/]+)\/pick$/, (user, body, id) => confirmPick(user, id, body)],
    ["POST", /^\/api\/waves\/([^/]+)\/cancel$/, (user, _body, id) => cancelWave(user, id)],
  ];
}

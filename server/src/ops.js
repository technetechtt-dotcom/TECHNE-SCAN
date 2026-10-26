import { randomUUID } from "node:crypto";
import { query, tx } from "./db.js";
import { assertScannerAllowed, confirmDemoCheckout, startCheckout } from "./billing.js";
import { bad } from "./errors.js";
import { writeBackup } from "./guard.js";
import { readLabel, signLabel } from "./labels.js";
import {
  ROLES,
  assertCap,
  assertFreshMfa,
  assertPassword,
  asUuid,
  cleanEmail,
  clip,
  companyWide,
  hashPassword,
  hashToken,
  newToken,
  optionalText,
  verifyPassword,
} from "./security.js";
import { audit, postLedger, userById } from "./store.js";
import { newMfaSecret, verifyTotp } from "./totp.js";

const LIFECYCLE = ["lost", "damaged", "stolen", "retired", "written_off", "maintenance", "available"];
const REASONS = ["damage", "found", "correction", "theft", "expiry", "other"];

function day(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw bad(400, "Enter a date.");
  return text;
}

function whole(value, label, min = 0) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > 1_000_000) throw bad(400, `${label} must be a whole number.`);
  return number;
}

async function holder(q, companyId, name) {
  const rows = await q(
    `SELECT name FROM employees WHERE company_id = $1 AND active AND lower(name) = lower($2)
     UNION ALL
     SELECT name FROM contractors WHERE company_id = $1 AND active AND lower(name) = lower($2)`,
    [companyId, name],
  );
  if (!rows[0]) throw bad(400, "Choose an employee or contractor in this company.");
  return rows[0].name;
}

async function assetRow(q, user, id, lock = false) {
  const assetId = asUuid(id, "Asset");
  const params = [assetId, user.companyId];
  let sql = `SELECT * FROM assets WHERE id = $1 AND company_id = $2`;
  if (!companyWide(user)) {
    params.push(user.branchId);
    sql += ` AND branch_id = $${params.length}`;
  }
  if (lock) sql += ` FOR UPDATE`;
  const rows = await q(sql, params);
  if (!rows[0]) throw bad(404, "Asset not found.");
  return rows[0];
}

async function secretFor(companyId) {
  const rows = await query(`SELECT qr_secret FROM companies WHERE id = $1`, [companyId]);
  if (rows[0]?.qr_secret) return rows[0].qr_secret;
  const secret = newToken();
  await query(`UPDATE companies SET qr_secret = $1 WHERE id = $2 AND qr_secret IS NULL`, [secret, companyId]);
  const again = await query(`SELECT qr_secret FROM companies WHERE id = $1`, [companyId]);
  return again[0].qr_secret;
}

export async function reserveAsset(user, id, input) {
  assertCap(user, "assets");
  const starts = day(input.startsOn);
  const ends = day(input.endsOn);
  if (ends < starts) throw bad(400, "The booking must end on or after it starts.");
  const notes = optionalText(input.notes, 400);
  return tx(async (q) => {
    const person = await holder(q, user.companyId, clip(input.person, 80, "Person"));
    const asset = await assetRow(q, user, id, true);
    if (!["available", "reserved"].includes(asset.status)) throw bad(409, "That asset cannot be reserved while it is out.");
    const clash = await q(
      `SELECT id FROM asset_reservations WHERE asset_id = $1 AND status = 'booked' AND starts_on <= $3::date AND ends_on >= $2::date LIMIT 1`,
      [asset.id, starts, ends],
    );
    if (clash[0]) throw bad(409, "Those dates overlap another booking.");
    const reservationId = randomUUID();
    await q(
      `INSERT INTO asset_reservations (id, company_id, asset_id, person, starts_on, ends_on, notes, created_by)
       VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8)`,
      [reservationId, user.companyId, asset.id, person, starts, ends, notes, user.id],
    );
    await q(`UPDATE assets SET status = 'reserved', holder = $1, version = version + 1, updated_at = now() WHERE id = $2`, [person, asset.id]);
    await q(
      `INSERT INTO custody_events (id, company_id, asset_id, kind, person, notes, location, actor_id, signature_name)
       VALUES ($1,$2,$3,'reserve',$4,$5,$6,$7,$4)`,
      [randomUUID(), user.companyId, asset.id, person, notes, asset.location, user.id],
    );
    await audit(q, user, "asset.reserve", "asset", asset.id, { person, starts, ends });
    return { id: reservationId, status: "reserved" };
  });
}

export async function transferAsset(user, id, input) {
  assertCap(user, "assets");
  const notes = optionalText(input.notes, 400);
  return tx(async (q) => {
    const person = await holder(q, user.companyId, clip(input.person, 80, "Person"));
    const signature = clip(input.acknowledgement, 80, "Acknowledgement");
    if (signature.toLowerCase() !== person.toLowerCase()) throw bad(400, "Type the recipient's name to acknowledge the handover.");
    const asset = await assetRow(q, user, id, true);
    if (asset.status !== "out") throw bad(409, "Only a checked-out asset can be transferred.");
    await q(`UPDATE assets SET holder = $1, version = version + 1, updated_at = now() WHERE id = $2`, [person, asset.id]);
    await q(
      `INSERT INTO custody_events (id, company_id, asset_id, kind, person, notes, location, actor_id, signature_name)
       VALUES ($1,$2,$3,'transfer',$4,$5,$6,$7,$8)`,
      [randomUUID(), user.companyId, asset.id, person, notes, asset.location, user.id, signature],
    );
    await audit(q, user, "asset.transfer", "asset", asset.id, { person });
    return { id: asset.id, holder: person };
  });
}

export async function bulkCheckout(user, input) {
  assertCap(user, "assets");
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length || items.length > 50) throw bad(400, "Choose between 1 and 50 assets.");
  return tx(async (q) => {
    const done = [];
    for (const item of items) {
      const person = await holder(q, user.companyId, clip(item.person, 80, "Employee"));
      const due = day(item.due);
      const signature = clip(item.acknowledgement, 80, "Acknowledgement");
      if (signature.toLowerCase() !== person.toLowerCase()) throw bad(400, "Type each recipient's name to acknowledge the handover.");
      const asset = await assetRow(q, user, item.assetId, true);
      if (asset.status !== "available") throw bad(409, `${asset.public_id} is not available.`);
      await q(
        `UPDATE assets SET status = 'out', holder = $1, due = $2::date, version = version + 1, updated_at = now() WHERE id = $3 AND status = 'available'`,
        [person, due, asset.id],
      );
      await q(
        `INSERT INTO custody_events (id, company_id, asset_id, kind, person, notes, location, actor_id, signature_name)
         VALUES ($1,$2,$3,'out',$4,'',$5,$6,$7)`,
        [randomUUID(), user.companyId, asset.id, person, asset.location, user.id, signature],
      );
      done.push(asset.id);
    }
    await audit(q, user, "asset.bulk_checkout", "asset", null, { count: done.length });
    return { count: done.length };
  });
}

export async function setLifecycle(user, id, input) {
  assertCap(user, "assets");
  const status = String(input.status || "");
  if (!LIFECYCLE.includes(status)) throw bad(400, "Choose a valid asset status.");
  const notes = optionalText(input.notes, 400);
  return tx(async (q) => {
    const asset = await assetRow(q, user, id, true);
    await q(
      `UPDATE assets SET status = $1, holder = CASE WHEN $1 = 'available' THEN '' ELSE holder END, due = CASE WHEN $1 = 'available' THEN NULL ELSE due END, version = version + 1, updated_at = now() WHERE id = $2`,
      [status, asset.id],
    );
    await q(
      `INSERT INTO custody_events (id, company_id, asset_id, kind, person, notes, location, actor_id)
       VALUES ($1,$2,$3,'lifecycle',$4,$5,$6,$7)`,
      [randomUUID(), user.companyId, asset.id, user.name, notes || status, asset.location, user.id],
    );
    await audit(q, user, "asset.lifecycle", "asset", asset.id, { status });
    return { id: asset.id, status };
  });
}

export async function addMaintenance(user, id, input) {
  assertCap(user, "assets");
  const kind = clip(input.kind, 40, "Work type");
  const detail = optionalText(input.detail, 400);
  const cost = Number(input.cost || 0);
  if (!Number.isFinite(cost) || cost < 0 || cost > 100000000) throw bad(400, "Enter a valid cost.");
  const asset = await assetRow(query, user, id);
  const maintenanceId = randomUUID();
  await query(
    `INSERT INTO asset_maintenance (id, company_id, asset_id, kind, detail, cost, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [maintenanceId, user.companyId, asset.id, kind, detail, cost, user.id],
  );
  await query(`UPDATE assets SET status = 'maintenance', version = version + 1, updated_at = now() WHERE id = $1 AND status <> 'out'`, [asset.id]);
  return { id: maintenanceId };
}

export async function addContractor(user, input) {
  assertCap(user, "assets");
  const name = clip(input.name, 80, "Name");
  const companyName = optionalText(input.companyName, 80);
  const id = randomUUID();
  await query(`INSERT INTO contractors (id, company_id, name, company_name) VALUES ($1,$2,$3,$4)`, [id, user.companyId, name, companyName]);
  return { id, name, companyName };
}

export async function updatePurchase(user, id, input) {
  assertCap(user, "assets");
  const asset = await assetRow(query, user, id);
  const supplier = optionalText(input.supplier, 120);
  const policy = optionalText(input.insurancePolicy, 80);
  const cost = input.purchaseCost === undefined || input.purchaseCost === "" ? null : Number(input.purchaseCost);
  if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw bad(400, "Enter a purchase cost.");
  const life = whole(input.usefulLifeMonths || 36, "Useful life", 1);
  await query(
    `UPDATE assets SET supplier = $1, purchase_cost = $2, purchase_date = $3::date, warranty_until = $4::date,
      insurance_policy = $5, insurance_until = $6::date, useful_life_months = $7, residual_value = $8, version = version + 1, updated_at = now()
     WHERE id = $9`,
    [
      supplier,
      cost,
      input.purchaseDate ? day(input.purchaseDate) : null,
      input.warrantyUntil ? day(input.warrantyUntil) : null,
      policy,
      input.insuranceUntil ? day(input.insuranceUntil) : null,
      life,
      Number(input.residualValue || 0),
      asset.id,
    ],
  );
  return { id: asset.id };
}

export async function depreciationReport(user) {
  assertCap(user, "assets");
  const params = [user.companyId];
  let sql = `SELECT public_id, name, purchase_cost, residual_value, useful_life_months, purchase_date, status FROM assets WHERE company_id = $1`;
  if (!companyWide(user)) {
    params.push(user.branchId);
    sql += ` AND branch_id = $2`;
  }
  const rows = await query(sql, params);
  return {
    items: rows.map((row) => {
      const cost = Number(row.purchase_cost || 0);
      const residual = Number(row.residual_value || 0);
      const life = Math.max(1, Number(row.useful_life_months || 36));
      const start = row.purchase_date ? new Date(row.purchase_date) : null;
      const elapsed = start ? Math.max(0, (Date.now() - start.getTime()) / (30.44 * 86400000)) : 0;
      const book = cost ? Math.max(residual, Math.round((cost - (cost - residual) * Math.min(elapsed, life) / life) * 100) / 100) : null;
      return { publicId: row.public_id, name: row.name, status: row.status, cost, bookValue: book };
    }),
  };
}

export async function relabel(user, id) {
  assertCap(user, "assets");
  const asset = await assetRow(query, user, id);
  const rows = await query(`UPDATE assets SET qr_version = qr_version + 1, version = version + 1, updated_at = now() WHERE id = $1 RETURNING public_id, qr_version`, [asset.id]);
  const secret = await secretFor(user.companyId);
  await audit(query, user, "asset.relabel", "asset", asset.id, { version: rows[0].qr_version });
  return { publicId: rows[0].public_id, qrPayload: signLabel(secret, rows[0].public_id, rows[0].qr_version) };
}

export async function verifyLabel(user, input) {
  const secret = await secretFor(user.companyId);
  const parsed = readLabel(secret, input.payload);
  if (!parsed) throw bad(400, "That label is not valid for this company.");
  const rows = await query(
    `SELECT id, public_id, name, status, qr_version FROM assets WHERE company_id = $1 AND public_id = $2`,
    [user.companyId, parsed.publicId],
  );
  if (!rows[0] || Number(rows[0].qr_version) !== parsed.version) throw bad(409, "That label has been replaced. Print the current one.");
  return { id: rows[0].id, publicId: rows[0].public_id, name: rows[0].name, status: rows[0].status };
}

export async function addPhoto(user, id, input) {
  assertCap(user, "assets");
  const asset = await assetRow(query, user, id);
  const dataUrl = String(input.dataUrl || "");
  if (!dataUrl.startsWith("data:image/") || dataUrl.length > 200000) throw bad(400, "Attach a photo under 150 KB.");
  const kind = ["before", "after", "damage"].includes(input.kind) ? input.kind : "damage";
  const idPhoto = randomUUID();
  await query(
    `INSERT INTO asset_photos (id, company_id, asset_id, kind, note, data_url, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [idPhoto, user.companyId, asset.id, kind, optionalText(input.note, 200), dataUrl, user.id],
  );
  return { id: idPhoto };
}

export async function saveCategory(user, input) {
  assertCap(user, "assets");
  const name = clip(input.name, 60, "Category");
  const attributes = Array.isArray(input.attributes) ? input.attributes.map((item) => clip(item, 40, "Attribute")).slice(0, 20) : [];
  const id = randomUUID();
  await query(
    `INSERT INTO asset_categories (id, company_id, name, attributes) VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (company_id, name) DO UPDATE SET attributes = EXCLUDED.attributes`,
    [id, user.companyId, name, JSON.stringify(attributes)],
  );
  return { name, attributes };
}

async function productInCompany(q, user, productId) {
  const rows = await q(`SELECT * FROM products WHERE id = $1 AND company_id = $2`, [asUuid(productId, "Product"), user.companyId]);
  if (!rows[0]) throw bad(404, "Product not found.");
  if (!companyWide(user) && rows[0].branch_id !== user.branchId) throw bad(403, "That product is outside your branch.");
  return rows[0];
}

export async function receiveGoods(user, input) {
  assertCap(user, "products");
  const supplier = clip(input.supplier, 120, "Supplier");
  const reference = optionalText(input.reference, 80);
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length || lines.length > 200) throw bad(400, "Add at least one receipt line.");
  return tx(async (q) => {
    const id = randomUUID();
    const stored = [];
    for (const line of lines) {
      const product = await productInCompany(q, user, line.productId);
      const qty = whole(line.qty, "Quantity", 1);
      const balance = await postLedger(q, {
        companyId: user.companyId,
        branchId: product.branch_id,
        productId: product.id,
        delta: qty,
        reason: "receipt",
        refType: "goods_receipt",
        refId: id,
        note: supplier,
        actorId: user.id,
      });
      stored.push({ productId: product.id, qty, balance });
    }
    await q(
      `INSERT INTO goods_receipts (id, company_id, branch_id, supplier, reference, lines, created_by) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [id, user.companyId, user.branchId, supplier, reference, JSON.stringify(stored), user.id],
    );
    await audit(q, user, "stock.receipt", "goods_receipt", id, { supplier, lines: stored.length });
    return { id, lines: stored };
  });
}

export async function stockMove(user, input, reason) {
  assertCap(user, "products");
  const productId = input.productId;
  const qty = whole(input.qty, "Quantity", 1);
  const note = clip(input.note || input.supplier || "Return", 200, "Note");
  return tx(async (q) => {
    const product = await productInCompany(q, user, productId);
    const delta = reason === "customer_return" ? qty : -qty;
    const balance = await postLedger(q, {
      companyId: user.companyId,
      branchId: product.branch_id,
      productId: product.id,
      delta,
      reason,
      refType: reason,
      note,
      actorId: user.id,
    });
    await audit(q, user, `stock.${reason}`, "product", product.id, { qty, note });
    return { productId: product.id, balance };
  });
}

export async function transferStock(user, input) {
  assertCap(user, "products");
  const toBranch = asUuid(input.toBranchId, "Branch");
  const note = optionalText(input.note, 200);
  return tx(async (q) => {
    const product = await productInCompany(q, user, input.productId);
    const qty = whole(input.qty, "Quantity", 1);
    if (qty !== Number(product.qty)) throw bad(400, "Transfer the full on-hand quantity. Each SKU is one company record.");
    const branch = await q(`SELECT id FROM branches WHERE id = $1 AND company_id = $2 AND active`, [toBranch, user.companyId]);
    if (!branch[0] || branch[0].id === product.branch_id) throw bad(400, "Choose a different active branch.");
    await q(`UPDATE products SET branch_id = $1, version = version + 1, updated_at = now() WHERE id = $2`, [toBranch, product.id]);
    const id = randomUUID();
    await q(
      `INSERT INTO stock_transfers (id, company_id, from_branch_id, to_branch_id, product_id, qty, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, user.companyId, product.branch_id, toBranch, product.id, qty, note, user.id],
    );
    await postLedger(q, {
      companyId: user.companyId,
      branchId: toBranch,
      productId: product.id,
      delta: 0,
      reason: "transfer",
      refType: "stock_transfer",
      refId: id,
      note,
      actorId: user.id,
    });
    return { id, productId: product.id, toBranchId: toBranch };
  });
}

export async function adjustStock(user, input) {
  if (!["owner", "admin", "manager", "supervisor"].includes(user.role)) throw bad(403, "A supervisor must approve stock adjustments.");
  const reason = String(input.reason || "");
  if (!REASONS.includes(reason)) throw bad(400, "Choose a reason code.");
  const note = clip(input.note, 200, "Note");
  const delta = Number(input.delta);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000) throw bad(400, "Enter a non-zero whole-number adjustment.");
  return tx(async (q) => {
    const product = await productInCompany(q, user, input.productId);
    const balance = await postLedger(q, {
      companyId: user.companyId,
      branchId: product.branch_id,
      productId: product.id,
      delta,
      reason: "adjustment",
      refType: "adjustment",
      note: `${reason}: ${note}`,
      actorId: user.id,
    });
    await audit(q, user, "stock.adjust", "product", product.id, { delta, reason, note });
    return { productId: product.id, balance };
  });
}

export async function setProductControls(user, id, input) {
  assertCap(user, "products");
  const product = await productInCompany(query, user, id);
  const reorder = input.reorderLevel === undefined ? Number(product.reorder_level) : whole(input.reorderLevel, "Reorder level");
  const unit = clip(input.unit || product.unit || "each", 20, "Unit");
  const shelf = optionalText(input.shelf ?? product.shelf, 60);
  const rack = optionalText(input.rack ?? product.rack, 60);
  const bin = optionalText(input.bin ?? product.bin, 60);
  const abc = String(input.abcClass ?? product.abc_class ?? "").toUpperCase();
  if (abc && !["A", "B", "C"].includes(abc)) throw bad(400, "ABC class is A, B, or C.");
  const lot = optionalText(input.lot ?? product.lot, 60);
  const serial = optionalText(input.serialNo ?? product.serial_no, 80);
  const cost = input.cost === undefined ? Number(product.cost) : Number(input.cost);
  if (!Number.isFinite(cost) || cost < 0) throw bad(400, "Enter a cost.");
  await query(
    `UPDATE products SET reorder_level=$1, unit=$2, shelf=$3, rack=$4, bin=$5, abc_class=$6, lot=$7, serial_no=$8, expires_on=$9::date, cost=$10, version=version+1, updated_at=now()
     WHERE id=$11 AND company_id=$12`,
    [reorder, unit, shelf, rack, bin, abc, lot, serial, input.expiresOn ? day(input.expiresOn) : product.expires_on, cost, product.id, user.companyId],
  );
  return { id: product.id, reorderLevel: reorder, abcClass: abc };
}

export async function importProducts(user, input) {
  assertCap(user, "products");
  const text = String(input.csv || "");
  if (text.length > 500000) throw bad(400, "That file is too large.");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const header = lines.shift()?.toLowerCase() || "";
  if (!header.includes("sku") || !header.includes("name")) throw bad(400, "The file needs sku and name columns.");
  const columns = header.split(",").map((item) => item.trim());
  const preview = [];
  const errors = [];
  for (const line of lines.slice(0, 500)) {
    const cells = line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
    const row = Object.fromEntries(columns.map((column, index) => [column, cells[index] || ""]));
    if (!row.sku || !row.name) errors.push(`Missing sku or name on: ${line.slice(0, 80)}`);
    else preview.push(row);
  }
  if (input.commit !== true) return { preview: preview.slice(0, 50), errors, total: preview.length };
  const branchId = asUuid(input.branchId || user.branchId, "Branch");
  if (!companyWide(user) && branchId !== user.branchId) throw bad(403, "That branch is outside your access.");
  let created = 0;
  for (const row of preview) {
    const qty = whole(row.qty || 0, "Quantity");
    const id = randomUUID();
    try {
      await tx(async (q) => {
        await q(
          `INSERT INTO products (id, company_id, branch_id, sku, name, department, aisle, category, qty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, user.companyId, branchId, row.sku.slice(0, 40), row.name.slice(0, 120), (row.department || "General").slice(0, 60), (row.aisle || "").slice(0, 60), (row.category || "General").slice(0, 60), 0],
        );
        if (qty) {
          await postLedger(q, {
            companyId: user.companyId,
            branchId,
            productId: id,
            delta: qty,
            reason: "opening",
            note: "Spreadsheet import",
            actorId: user.id,
          });
        }
      });
      created += 1;
    } catch (error) {
      errors.push(`${row.sku}: ${error.message || "could not import"}`);
    }
  }
  return { created, errors };
}

export async function searchRecords(user, term) {
  const q = `%${String(term || "").trim().toLowerCase().slice(0, 60)}%`;
  if (q === "%%") return { assets: [], products: [], stocktakes: [] };
  const params = [user.companyId, q];
  const branch = companyWide(user) ? "" : ` AND branch_id = $${params.push(user.branchId)}`;
  const assets = await query(`SELECT id, public_id, name, status FROM assets WHERE company_id = $1 AND (lower(name) LIKE $2 OR lower(public_id) LIKE $2 OR lower(holder) LIKE $2)${branch} LIMIT 8`, params);
  const products = await query(`SELECT id, sku, name, qty FROM products WHERE company_id = $1 AND (lower(name) LIKE $2 OR lower(sku) LIKE $2)${branch} LIMIT 8`, params);
  const stocktakes = await query(`SELECT id, name, status FROM stocktakes WHERE company_id = $1 AND lower(name) LIKE $2${branch} LIMIT 8`, params);
  return {
    assets: assets.map((row) => ({ id: row.id, label: `${row.public_id} ${row.name}`, status: row.status })),
    products: products.map((row) => ({ id: row.id, label: `${row.sku} ${row.name}`, qty: Number(row.qty) })),
    stocktakes: stocktakes.map((row) => ({ id: row.id, label: row.name, status: row.status })),
  };
}

export async function reportCsv(user, kind) {
  if (kind === "valuation") {
    const rows = await query(`SELECT sku, name, qty, cost, qty * cost AS value FROM products WHERE company_id = $1 ORDER BY sku`, [user.companyId]);
    return csv("valuation.csv", ["sku", "name", "qty", "cost", "value"], rows.map((row) => [row.sku, row.name, row.qty, row.cost, row.value]));
  }
  if (kind === "movements") {
    const rows = await query(`SELECT at, reason, qty_delta, balance_after, note FROM stock_ledger WHERE company_id = $1 ORDER BY at DESC LIMIT 500`, [user.companyId]);
    return csv("movements.csv", ["at", "reason", "delta", "balance", "note"], rows.map((row) => [row.at, row.reason, row.qty_delta, row.balance_after, row.note]));
  }
  if (kind === "overdue-assets") {
    const rows = await query(`SELECT public_id, name, holder, due FROM assets WHERE company_id = $1 AND status = 'out' AND due < CURRENT_DATE ORDER BY due`, [user.companyId]);
    return csv("overdue-assets.csv", ["id", "name", "holder", "due"], rows.map((row) => [row.public_id, row.name, row.holder, row.due]));
  }
  if (kind === "custody") {
    const rows = await query(
      `SELECT e.at, e.kind, a.public_id, a.name, e.person, e.location FROM custody_events e JOIN assets a ON a.id = e.asset_id WHERE e.company_id = $1 ORDER BY e.at DESC LIMIT 500`,
      [user.companyId],
    );
    return csv("custody.csv", ["at", "kind", "id", "name", "person", "location"], rows.map((row) => [row.at, row.kind, row.public_id, row.name, row.person, row.location]));
  }
  throw bad(404, "That report does not exist.");
}

function csv(filename, header, rows) {
  const body = [header, ...rows].map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  return { filename, csv: body };
}

export async function privacyExport(user) {
  const employee = await query(`SELECT id, name, email, role, branch_id, created_at FROM employees WHERE id = $1`, [user.id]);
  const notices = await query(`SELECT kind, title, body, created_at FROM notifications WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 100`, [user.id]);
  return {
    purpose: "Techne Scan stores company, branch, employee, asset, and stock records so the organisation can run custody and stocktaking.",
    retention: "Sessions and reset tokens are removed after they expire. Notifications are removed after 12 months. Stock and audit records are kept for the life of the company account because they support the books.",
    employee: employee[0],
    notifications: notices,
  };
}

export async function eraseAccount(user, input) {
  const rows = await query(`SELECT password_hash, role FROM employees WHERE id = $1`, [user.id]);
  const match = await verifyPassword(String(input.password || ""), rows[0]?.password_hash);
  if (!match) throw bad(400, "Current password is incorrect.");
  if (rows[0].role === "owner") {
    const owners = await query(`SELECT count(*)::int AS n FROM employees WHERE company_id = $1 AND role = 'owner' AND active`, [user.companyId]);
    if (Number(owners[0].n) <= 1) throw bad(400, "Add another owner before closing this login.");
  }
  const email = `removed-${user.id}@deleted.local`;
  await query(
    `UPDATE employees SET name = 'Removed person', email = $1, active = false, password_hash = $2, mfa_secret = NULL, mfa_enabled = false, updated_at = now() WHERE id = $3`,
    [email, await hashPassword(newToken()), user.id],
  );
  await query(`UPDATE sessions SET revoked_at = now() WHERE employee_id = $1`, [user.id]);
  await query(`INSERT INTO deletion_requests (id, company_id, employee_id, status) VALUES ($1,$2,$3,'completed')`, [randomUUID(), user.companyId, user.id]);
  return { ok: true };
}

export async function forgotPassword(email) {
  const normalized = cleanEmail(email);
  const rows = await query(`SELECT id FROM employees WHERE lower(email) = $1 AND active`, [normalized]);
  const result = { ok: true };
  if (!rows[0]) return result;
  const token = newToken();
  await query(
    `INSERT INTO password_resets (token_hash, employee_id, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`,
    [hashToken(token), rows[0].id],
  );
  if (process.env.EMAIL_WEBHOOK_URL) {
    await fetch(process.env.EMAIL_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: normalized, subject: "Techne Scan password reset", text: `Reset token: ${token}` }),
    }).catch(() => {});
  } else if (process.env.NODE_ENV !== "production") result.resetToken = token;
  return result;
}

export async function resetPassword(input) {
  const token = String(input.token || "");
  assertPassword(input.password);
  const rows = await query(
    `SELECT employee_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  if (!rows[0]) throw bad(400, "That reset link is no longer valid.");
  const passwordHash = await hashPassword(input.password);
  await query(`UPDATE employees SET password_hash = $1, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $2`, [passwordHash, rows[0].employee_id]);
  await query(`UPDATE password_resets SET used_at = now() WHERE token_hash = $1`, [hashToken(token)]);
  await query(`UPDATE sessions SET revoked_at = now() WHERE employee_id = $1`, [rows[0].employee_id]);
  return { ok: true };
}

export async function beginMfa(user) {
  const existing = await query(`SELECT mfa_enabled FROM employees WHERE id = $1`, [user.id]);
  if (existing[0]?.mfa_enabled) throw bad(409, "Authenticator is already on. Turn it off with your password and a current code first.");
  const secret = newMfaSecret();
  await query(`UPDATE employees SET mfa_secret = $1, mfa_enabled = false WHERE id = $2`, [secret, user.id]);
  const label = encodeURIComponent(user.email || user.name);
  return { secret, uri: `otpauth://totp/TechneScan:${label}?secret=${secret}&issuer=TechneScan&digits=6&period=30` };
}

export async function confirmMfa(user, input) {
  const rows = await query(`SELECT mfa_secret FROM employees WHERE id = $1`, [user.id]);
  if (!verifyTotp(rows[0]?.mfa_secret, input.code)) throw bad(400, "That code is not valid.");
  const backups = Array.from({ length: 8 }, () => randomBytesHex());
  await query(`DELETE FROM mfa_backup_codes WHERE employee_id = $1`, [user.id]);
  for (const code of backups) {
    await query(`INSERT INTO mfa_backup_codes (id, employee_id, code_hash) VALUES ($1,$2,$3)`, [randomUUID(), user.id, hashToken(code)]);
  }
  await query(`UPDATE employees SET mfa_enabled = true WHERE id = $1`, [user.id]);
  if (user.sessionId) {
    await query(`UPDATE sessions SET revoked_at = now() WHERE employee_id = $1 AND id <> $2 AND revoked_at IS NULL`, [user.id, user.sessionId]);
  }
  return { backupCodes: backups };
}

export async function disableMfa(user, input) {
  const rows = await query(`SELECT password_hash, mfa_secret, mfa_enabled FROM employees WHERE id = $1`, [user.id]);
  if (!rows[0]?.mfa_enabled) throw bad(400, "Authenticator is not on.");
  if (!(await verifyPassword(String(input.password || ""), rows[0].password_hash))) throw bad(401, "Password is wrong.");
  if (!verifyTotp(rows[0].mfa_secret, input.code)) throw bad(401, "That code is not valid.");
  await query(`UPDATE employees SET mfa_enabled = false, mfa_secret = NULL, updated_at = now() WHERE id = $1`, [user.id]);
  await query(`DELETE FROM mfa_backup_codes WHERE employee_id = $1`, [user.id]);
  if (user.sessionId) {
    await query(`UPDATE sessions SET revoked_at = now() WHERE employee_id = $1 AND id <> $2 AND revoked_at IS NULL`, [user.id, user.sessionId]);
  }
  return { ok: true };
}

function randomBytesHex() {
  return newToken().slice(0, 8);
}

export async function startMfaChallenge(employeeId) {
  const challenge = newToken();
  await query(`INSERT INTO mfa_challenges (token_hash, employee_id, expires_at) VALUES ($1,$2, now() + interval '5 minutes')`, [hashToken(challenge), employeeId]);
  return challenge;
}

export async function completeMfa(input) {
  const challenge = String(input.challenge || "");
  const rows = await query(
    `SELECT c.employee_id, e.mfa_secret FROM mfa_challenges c JOIN employees e ON e.id = c.employee_id
     WHERE c.token_hash = $1 AND c.expires_at > now()`,
    [hashToken(challenge)],
  );
  if (!rows[0]) throw bad(401, "That sign-in challenge expired. Sign in again.");
  let ok = verifyTotp(rows[0].mfa_secret, input.code);
  if (!ok) {
    const backups = await query(`SELECT id, code_hash FROM mfa_backup_codes WHERE employee_id = $1 AND used_at IS NULL`, [rows[0].employee_id]);
    const code = String(input.code || "").trim().toLowerCase();
    const match = backups.find((row) => row.code_hash === hashToken(code));
    if (match) {
      await query(`UPDATE mfa_backup_codes SET used_at = now() WHERE id = $1`, [match.id]);
      ok = true;
    }
  }
  if (!ok) throw bad(401, "That code is not valid.");
  await query(`DELETE FROM mfa_challenges WHERE employee_id = $1`, [rows[0].employee_id]);
  return userById(rows[0].employee_id);
}

export async function createInvitation(user, input) {
  assertCap(user, "employees");
  const email = cleanEmail(input.email);
  const role = String(input.role || "clerk");
  if (!ROLES.includes(role) || role === "owner") throw bad(400, "Choose a role other than owner.");
  const branchId = asUuid(input.branchId || user.branchId, "Branch");
  const token = newToken();
  await query(
    `INSERT INTO invitations (id, company_id, email, role, branch_id, token_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '7 days')`,
    [randomUUID(), user.companyId, email, role, branchId, hashToken(token)],
  );
  const result = { ok: true };
  if (process.env.NODE_ENV !== "production") result.token = token;
  return result;
}

export async function acceptInvitation(input) {
  assertPassword(input.password);
  const name = clip(input.name, 80, "Name");
  const rows = await query(
    `SELECT * FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
    [hashToken(String(input.token || ""))],
  );
  if (!rows[0]) throw bad(400, "That invitation is no longer valid.");
  const passwordHash = await hashPassword(input.password);
  const id = randomUUID();
  await query(
    `INSERT INTO employees (id, company_id, branch_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, rows[0].company_id, rows[0].branch_id, name, rows[0].email, passwordHash, rows[0].role],
  );
  await query(`UPDATE invitations SET accepted_at = now() WHERE id = $1`, [rows[0].id]);
  return { ok: true };
}

export async function createApiKey(user, input) {
  assertCap(user, "company");
  const name = clip(input.name, 60, "Key name");
  const token = `tkn_${newToken()}`;
  await query(
    `INSERT INTO api_keys (id, company_id, name, token_hash, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), user.companyId, name, hashToken(token), user.id],
  );
  return { token, name };
}

export async function userForApiKey(token) {
  if (!String(token || "").startsWith("tkn_")) return null;
  const rows = await query(
    `SELECT created_by FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
  if (!rows[0]?.created_by) return null;
  return userById(rows[0].created_by);
}

export async function createWebhook(user, input) {
  assertCap(user, "company");
  let url;
  try {
    url = new URL(String(input.url || ""));
  } catch {
    throw bad(400, "Enter a webhook URL.");
  }
  if (url.protocol !== "https:") throw bad(400, "Webhooks must use HTTPS.");
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) throw bad(400, "That webhook address is not allowed.");
  const event = ["stock.adjusted", "asset.checkout", "stocktake.approved"].includes(input.event) ? input.event : "";
  if (!event) throw bad(400, "Choose a webhook event.");
  const id = randomUUID();
  await query(`INSERT INTO webhooks (id, company_id, url, event) VALUES ($1,$2,$3,$4)`, [id, user.companyId, url.toString(), event]);
  return { id, event };
}

export async function deviceHealth(user) {
  assertCap(user, "devices");
  const params = [user.companyId];
  let sql = `SELECT id, name, kind, serial, firmware, status, holder, last_seen_at FROM devices WHERE company_id = $1`;
  if (!companyWide(user)) {
    params.push(user.branchId);
    sql += ` AND branch_id = $2`;
  }
  const devices = await query(sql, params);
  const events = await query(
    `SELECT device_id, kind, detail, at FROM device_events WHERE company_id = $1 ORDER BY at DESC LIMIT 50`,
    [user.companyId],
  );
  return { devices, events };
}

export async function recordScannerBatch(user, input) {
  assertCap(user, "imports");
  const serial = clip(input.serial || "unknown", 80, "Serial");
  const firmware = optionalText(input.firmware, 40);
  let deviceId = null;
  const found = await query(`SELECT id, kind FROM devices WHERE company_id = $1 AND lower(serial) = lower($2)`, [user.companyId, serial]);
  if (found[0]) {
    await assertScannerAllowed(user.companyId, found[0].kind);
    deviceId = found[0].id;
    await query(`UPDATE devices SET last_seen_at = now(), firmware = CASE WHEN $2 = '' THEN firmware ELSE $2 END, updated_at = now() WHERE id = $1`, [deviceId, firmware]);
    await query(`INSERT INTO device_events (id, company_id, device_id, kind, detail) VALUES ($1,$2,$3,'sync',$4)`, [randomUUID(), user.companyId, deviceId, firmware || "batch accepted"]);
  }
  return { deviceId, serial, verified: true };
}

export async function updateSettings(user, input) {
  assertCap(user, "company");
  const current = await query(`SELECT settings FROM companies WHERE id = $1`, [user.companyId]);
  const settings = { ...(current[0]?.settings || {}) };
  if (input.locale && ["en", "af", "tn"].includes(input.locale)) settings.locale = input.locale;
  if (typeof input.negativeStock === "boolean") settings.negativeStock = input.negativeStock;
  await query(`UPDATE companies SET settings = $1::jsonb WHERE id = $2`, [JSON.stringify(settings), user.companyId]);
  return settings;
}

export async function listPhotos(user, assetId) {
  assertCap(user, "assets");
  const id = asUuid(assetId, "Asset");
  const params = [id, user.companyId];
  let sql = `SELECT p.id, p.kind, p.note, p.created_at FROM asset_photos p JOIN assets a ON a.id = p.asset_id WHERE p.asset_id = $1 AND p.company_id = $2`;
  if (!companyWide(user)) {
    params.push(user.branchId);
    sql += ` AND a.branch_id = $${params.length}`;
  }
  sql += ` ORDER BY p.created_at`;
  const rows = await query(sql, params);
  return rows.map((row) => ({ id: row.id, kind: row.kind, note: row.note, createdAt: row.created_at }));
}

export async function readPhoto(user, photoId) {
  assertCap(user, "assets");
  const id = asUuid(photoId, "Photo");
  const params = [id, user.companyId];
  let sql = `SELECT p.data_url, p.kind FROM asset_photos p JOIN assets a ON a.id = p.asset_id WHERE p.id = $1 AND p.company_id = $2`;
  if (!companyWide(user)) {
    params.push(user.branchId);
    sql += ` AND a.branch_id = $${params.length}`;
  }
  const rows = await query(sql, params);
  if (!rows[0]) throw bad(404, "Photo not found.");
  return { kind: rows[0].kind, dataUrl: rows[0].data_url };
}

export async function backupNow(user) {
  assertCap(user, "company");
  assertFreshMfa(user);
  if (user.role !== "owner") throw bad(403, "Only an owner can take a backup.");
  return writeBackup();
}

export function opsRoutes() {
  return [
    ["POST", /^\/api\/assets\/([^/]+)\/reserve$/, (user, body, id) => reserveAsset(user, id, body)],
    ["POST", /^\/api\/assets\/([^/]+)\/transfer$/, (user, body, id) => transferAsset(user, id, body)],
    ["POST", /^\/api\/assets\/bulk-checkout$/, (user, body) => bulkCheckout(user, body)],
    ["POST", /^\/api\/assets\/([^/]+)\/lifecycle$/, (user, body, id) => setLifecycle(user, id, body)],
    ["POST", /^\/api\/assets\/([^/]+)\/maintenance$/, (user, body, id) => addMaintenance(user, id, body)],
    ["POST", /^\/api\/assets\/([^/]+)\/purchase$/, (user, body, id) => updatePurchase(user, id, body)],
    ["POST", /^\/api\/assets\/([^/]+)\/relabel$/, (user, _body, id) => relabel(user, id)],
    ["POST", /^\/api\/assets\/([^/]+)\/photo$/, (user, body, id) => addPhoto(user, id, body)],
    ["POST", /^\/api\/assets\/verify-label$/, (user, body) => verifyLabel(user, body)],
    ["GET", /^\/api\/assets\/depreciation$/, (user) => depreciationReport(user)],
    ["POST", /^\/api\/contractors$/, (user, body) => addContractor(user, body)],
    ["POST", /^\/api\/categories$/, (user, body) => saveCategory(user, body)],
    ["POST", /^\/api\/goods-receipts$/, (user, body) => receiveGoods(user, body)],
    ["POST", /^\/api\/stock\/supplier-return$/, (user, body) => stockMove(user, body, "supplier_return")],
    ["POST", /^\/api\/stock\/customer-return$/, (user, body) => stockMove(user, body, "customer_return")],
    ["POST", /^\/api\/stock\/transfer$/, (user, body) => transferStock(user, body)],
    ["POST", /^\/api\/stock\/adjust$/, (user, body) => adjustStock(user, body)],
    ["PATCH", /^\/api\/products\/([^/]+)\/controls$/, (user, body, id) => setProductControls(user, id, body)],
    ["POST", /^\/api\/products\/import$/, (user, body) => importProducts(user, body)],
    ["GET", /^\/api\/search$/, (user, body) => searchRecords(user, body.q)],
    ["GET", /^\/api\/reports\/([^/]+)$/, (user, _body, kind) => reportCsv(user, kind)],
    ["GET", /^\/api\/privacy$/, (user) => privacyExport(user)],
    ["POST", /^\/api\/privacy\/erase$/, (user, body) => eraseAccount(user, body)],
    ["POST", /^\/api\/mfa\/setup$/, (user) => beginMfa(user)],
    ["POST", /^\/api\/mfa\/confirm$/, (user, body) => confirmMfa(user, body)],
    ["POST", /^\/api\/mfa\/disable$/, (user, body) => disableMfa(user, body)],
    ["GET", /^\/api\/assets\/([^/]+)\/photos$/, (user, _body, id) => listPhotos(user, id)],
    ["GET", /^\/api\/photos\/([^/]+)$/, (user, _body, id) => readPhoto(user, id)],
    ["POST", /^\/api\/invitations$/, (user, body) => createInvitation(user, body)],
    ["POST", /^\/api\/api-keys$/, (user, body) => createApiKey(user, body)],
    ["POST", /^\/api\/webhooks$/, (user, body) => createWebhook(user, body)],
    ["GET", /^\/api\/devices\/health$/, (user) => deviceHealth(user)],
    ["POST", /^\/api\/scanners\/batch$/, (user, body) => recordScannerBatch(user, body)],
    ["PATCH", /^\/api\/company\/settings$/, (user, body) => updateSettings(user, body)],
    ["POST", /^\/api\/admin\/backup$/, (user) => backupNow(user)],
    ["POST", /^\/api\/billing\/checkout$/, (user, body) => startCheckout(user, body)],
    ["POST", /^\/api\/billing\/demo$/, (user, body) => confirmDemoCheckout(user, body)],
  ];
}

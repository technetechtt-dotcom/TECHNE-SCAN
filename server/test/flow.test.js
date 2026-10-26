import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { confirmDemoCheckout, startCheckout } from "../src/billing.js";
import { cancelStocktake, reopenStocktake } from "../src/counts.js";
import { parseScanCsv } from "../src/csv.js";
import { closeDb, initDb, query } from "../src/db.js";
import { ask, summary } from "../src/intelligence.js";
import { explainLine } from "../src/reconcile.js";
import { nextRunAt } from "../src/time.js";
import {
  approveStocktake,
  checkoutAsset,
  checkinAsset,
  createDevice,
  createEmployee,
  createImport,
  createStocktake,
  DEMO_PASSWORD,
  listAssets,
  listDevices,
  login,
  overdueNotices,
  reconciliation,
  runDueSchedules,
  seedDemo,
  setCounts,
  setupCompany,
  submitStocktake,
} from "../src/store.js";

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "techne-"));
process.env.SEED_DEMO = "1";
process.env.NODE_ENV = "test";

test("schedule math and reconciliation math", () => {
  const next = nextRunAt({ frequency: "daily", timeOfDay: "08:00", timeZone: "Africa/Johannesburg" }, new Date("2026-10-23T05:00:00Z"));
  assert.equal(next.toISOString(), "2026-10-23T06:00:00.000Z");
  const line = explainLine({ name: "Water", expected: 10, movements: -2, counted: 7 });
  assert.equal(line.adjusted, 8);
  assert.equal(line.variance, -1);
  const rows = parseScanCsv('barcode,quantity\n"BVG-001","2"\nCLN-001,1\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].barcode, "BVG-001");
});

test("tenant isolation, ledger approval, and scheduled counts", async () => {
  await initDb();
  await seedDemo();
  await assert.rejects(() => login("admin@techne.local", "wrong-password"), /incorrect/);
  const admin = await login("admin@techne.local", DEMO_PASSWORD);
  const clerk = await login("thabo@techne.local", DEMO_PASSWORD);
  await assert.rejects(() => createEmployee(clerk, {
    name: "Nope",
    email: "nope@techne.local",
    role: "clerk",
    branchId: clerk.branchId,
    password: "longpassword1",
  }), /permission/);

  const other = await setupCompany({
    companyName: "Other Co",
    timezone: "UTC",
    branchName: "Plant",
    adminName: "Other Owner",
    email: "owner@other.test",
    password: "longpassword1",
  });
  const otherUser = await login("owner@other.test", "longpassword1");
  assert.equal((await listAssets(otherUser)).length, 0);
  assert.ok((await listAssets(admin)).length >= 4);

  const products = await query(`SELECT id, sku, qty FROM products WHERE company_id = $1 AND sku = 'CLN-002'`, [admin.companyId]);
  const before = Number(products[0].qty);
  const stocktake = await createStocktake(admin, { name: "Household check", scope: "aisle", scopeValue: "Aisle 2", branchId: admin.branchId });
  assert.equal(stocktake.lines.length, 2);
  await setCounts(admin, stocktake.id, {
    counts: stocktake.lines.map((line) => ({ productId: line.productId, count: line.expected })),
  });
  await query(
    `UPDATE products SET qty = qty - 2 WHERE id = $1`,
    [products[0].id],
  );
  await query(
    `INSERT INTO stock_ledger (id, company_id, branch_id, product_id, qty_delta, balance_after, reason, note, at)
     VALUES (gen_random_uuid(), $1, $2, $3, -2, $4, 'issue', 'Sale during count', now())`,
    [admin.companyId, admin.branchId, products[0].id, before - 2],
  );
  await submitStocktake(admin, stocktake.id);
  const preview = await reconciliation(admin, stocktake.id);
  const liquid = preview.items.find((item) => item.sku === "CLN-002");
  assert.equal(liquid.movements, -2);
  assert.equal(liquid.variance, 2);
  const approved = await approveStocktake(admin, stocktake.id);
  assert.equal(approved.status, "approved");
  const after = await query(`SELECT qty FROM products WHERE id = $1`, [products[0].id]);
  assert.equal(Number(after[0].qty), before);

  const manager = await createEmployee(admin, {
    name: "Branch Manager",
    email: "manager@techne.local",
    role: "manager",
    branchId: admin.branchId,
    password: "longpassword1",
  });
  const managerUser = await login("manager@techne.local", "longpassword1");
  const own = await createStocktake(managerUser, { name: "Manager count", scope: "category", scopeValue: "Accessories", branchId: manager.branchId });
  await setCounts(managerUser, own.id, { counts: own.lines.map((line) => ({ productId: line.productId, count: line.expected })) });
  await submitStocktake(managerUser, own.id);
  await assert.rejects(() => approveStocktake(managerUser, own.id), /Someone else/);
  await approveStocktake(admin, own.id);

  const asset = (await listAssets(admin)).find((item) => item.status === "available");
  await checkoutAsset(admin, asset.id, { person: "Techne Admin", due: "2026-10-30", notes: "Site visit", acknowledgement: "Techne Admin" });
  await checkinAsset(admin, asset.id, { person: "Stores", condition: "Good", location: "Cage A", notes: "" });
  const back = (await listAssets(admin)).find((item) => item.id === asset.id);
  assert.equal(back.location, "Cage A");
  assert.equal(back.status, "available");

  await query(`UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE company_id = $1`, [admin.companyId]);
  const beforeCounts = await query(`SELECT count(*)::int AS n FROM stocktakes WHERE company_id = $1`, [admin.companyId]);
  await runDueSchedules();
  const afterCounts = await query(`SELECT count(*)::int AS n FROM stocktakes WHERE company_id = $1`, [admin.companyId]);
  assert.equal(Number(afterCounts[0].n), Number(beforeCounts[0].n) + 1);
  await runDueSchedules();
  const stable = await query(`SELECT count(*)::int AS n FROM stocktakes WHERE company_id = $1`, [admin.companyId]);
  assert.equal(Number(stable[0].n), Number(afterCounts[0].n));

  await overdueNotices();
  const notes = await query(`SELECT count(*)::int AS n FROM notifications WHERE company_id = $1 AND kind = 'overdue'`, [admin.companyId]);
  assert.ok(Number(notes[0].n) >= 1);
  await overdueNotices();
  const notesAgain = await query(`SELECT count(*)::int AS n FROM notifications WHERE company_id = $1 AND kind = 'overdue'`, [admin.companyId]);
  assert.equal(Number(notesAgain[0].n), Number(notes[0].n));

  const intel = await summary(admin);
  assert.ok(intel.recommendations.some((item) => item.id.startsWith("overdue:")));
  assert.ok(intel.forecast.some((item) => item.sku === "BVG-001" && item.dailyUse > 0));
  const answer = await ask(admin, "Which assets are overdue?");
  assert.match(answer.answer, /Projector/);
  assert.equal(other.companyId === admin.companyId, false);

  const combined = await createStocktake(admin, {
    name: "IT accessories",
    scope: "combined",
    scopeValue: JSON.stringify({ department: "IT", aisle: "IT Store", shelf: "", category: "Accessories" }),
    branchId: admin.branchId,
  });
  const skus = await query(
    `SELECT p.sku FROM stocktake_lines l JOIN products p ON p.id = l.product_id WHERE l.stocktake_id = $1 ORDER BY p.sku`,
    [combined.id],
  );
  assert.deepEqual(skus.map((row) => row.sku), ["IT-001", "IT-002"]);
  await cancelStocktake(admin, combined.id);
  assert.equal((await reopenStocktake(admin, combined.id)).status, "active");

  const code = await query(`SELECT public_id FROM employees WHERE company_id = $1 AND lower(name) = 'techne admin'`, [admin.companyId]);
  assert.match(code[0].public_id, /^TT-EMP-\d{3}$/);
  const free = (await listAssets(admin)).find((item) => item.status === "available");
  await assert.rejects(
    () => checkoutAsset(admin, free.id, { employeeCode: code[0].public_id, due: "2026-11-02", acknowledgement: "Someone Else" }),
    /acknowledge/,
  );
  await checkoutAsset(admin, free.id, { person: "Wrong Name", employeeCode: code[0].public_id, due: "2026-11-02", acknowledgement: "Techne Admin" });
  const issued = (await listAssets(admin)).find((item) => item.id === free.id);
  assert.equal(issued.holder, "Techne Admin");

  await assert.rejects(() => createDevice(admin, { name: "Belt scanner", kind: "Bluetooth", branchId: admin.branchId }), /Wireless/);
  const opn = (await listDevices(admin)).find((item) => item.kind === "OPN-2001");
  await assert.rejects(
    () => createImport(admin, { name: "Locked batch", deviceId: opn.id, records: [{ barcode: "IT-001", quantity: 1 }], branchId: admin.branchId }),
    /Counter/,
  );
  await createDevice(admin, { name: "Stores phone", kind: "Phone", branchId: admin.branchId });
  const checkout = await startCheckout(admin, { plan: "counter" });
  assert.equal(checkout.mode, "demo");
  assert.equal(checkout.plan.label, "R499.00");
  const subscribed = await confirmDemoCheckout(admin, { checkoutId: checkout.checkoutId });
  assert.equal(subscribed.plan, "counter");
  await createImport(admin, { name: "Counter batch", deviceId: opn.id, records: [{ barcode: "IT-001", quantity: 1 }], branchId: admin.branchId });
  await assert.rejects(() => createDevice(admin, { name: "Belt scanner", kind: "Bluetooth", branchId: admin.branchId }), /Wireless/);
  await closeDb();
});

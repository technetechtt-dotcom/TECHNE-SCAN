import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { openBackup, runIdempotent, sealBackup, housekeeping } from "../src/guard.js";
import { adjustStock, reserveAsset } from "../src/ops.js";
import { closeDb, initDb, query } from "../src/db.js";
import {
  approveStocktake,
  checkoutAsset,
  createStocktake,
  DEMO_PASSWORD,
  listAssets,
  login,
  seedDemo,
  setCounts,
  setupCompany,
  submitStocktake,
} from "../src/store.js";

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "techne-conc-"));
process.env.SEED_DEMO = "1";
process.env.NODE_ENV = "test";

test("simultaneous checkout, approval, stock, and tenant boundaries", async () => {
  process.env.BACKUP_KEY = "local-backup-key-not-for-prod";
  const sealed = sealBackup({ exportedAt: "t", tables: { companies: [{ name: "Secret Co" }] } });
  assert.equal(sealed.encrypted, true);
  assert.equal(sealed.body.includes("Secret Co"), false);
  assert.equal(openBackup(sealed.body).tables.companies[0].name, "Secret Co");
  delete process.env.BACKUP_KEY;
  await initDb();
  await seedDemo();
  const admin = await login("admin@techne.local", DEMO_PASSWORD);
  const asset = (await listAssets(admin)).find((item) => item.status === "available");
  const handed = { person: "Techne Admin", due: "2026-12-01", acknowledgement: "Techne Admin" };
  const checkouts = await Promise.allSettled([
    checkoutAsset(admin, asset.id, handed),
    checkoutAsset(admin, asset.id, handed),
  ]);
  assert.equal(checkouts.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(checkouts.filter((item) => item.status === "rejected").length, 1);

  const other = await setupCompany({
    companyName: "Isolation Co",
    timezone: "Africa/Johannesburg",
    branchName: "Cape",
    adminName: "Other Owner",
    email: "isolation@techne.local",
    password: "longpassword1",
  });
  await assert.rejects(() => checkoutAsset(other, asset.id, { person: "Other Owner", due: "2026-12-02", acknowledgement: "Other Owner" }), /not found|outside|already/i);

  const stocktake = await createStocktake(admin, { name: "Parallel approve", scope: "list", scopeValue: "IT-001", branchId: admin.branchId });
  await setCounts(admin, stocktake.id, { counts: stocktake.lines.map((line) => ({ productId: line.productId, count: line.expected + 1 })) });
  await submitStocktake(admin, stocktake.id);
  const approvals = await Promise.allSettled([approveStocktake(admin, stocktake.id), approveStocktake(admin, stocktake.id)]);
  assert.equal(approvals.filter((item) => item.status === "fulfilled").length, 1);

  const product = (await query(`SELECT id, qty::int AS qty FROM products WHERE company_id = $1 AND sku = 'BVG-001'`, [admin.companyId]))[0];
  await Promise.all(Array.from({ length: 8 }, () => adjustStock(admin, { productId: product.id, delta: 1, reason: "found", note: "parallel" })));
  const after = await query(`SELECT qty::int AS qty FROM products WHERE id = $1`, [product.id]);
  assert.equal(Number(after[0].qty), Number(product.qty) + 8);

  let runs = 0;
  const key = randomUUID();
  await Promise.allSettled([
    runIdempotent(admin, "POST", "/api/example", { n: 1 }, key, async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true };
    }),
    runIdempotent(admin, "POST", "/api/example", { n: 1 }, key, async () => {
      runs += 1;
      return { ok: true };
    }),
  ]);
  assert.equal(runs, 1);

  const booking = await reserveAsset(admin, (await listAssets(admin)).find((item) => item.status === "available").id, {
    person: "Techne Admin",
    startsOn: "2026-01-01",
    endsOn: "2026-01-02",
  });
  await query(`UPDATE asset_reservations SET ends_on = CURRENT_DATE - 1 WHERE id = $1`, [booking.id]);
  await housekeeping();
  const expired = await query(`SELECT status FROM asset_reservations WHERE id = $1`, [booking.id]);
  assert.equal(expired[0].status, "expired");
  process.env.NODE_ENV = "production";
  assert.throws(() => sealBackup({ tables: { companies: [] } }), /BACKUP_KEY/);
  process.env.NODE_ENV = "test";
  await closeDb();
});

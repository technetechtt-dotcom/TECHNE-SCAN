import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { closeDb, initDb, query } from "../src/db.js";
import { exportSnapshot, restoreSnapshot, runIdempotent, writeBackup } from "../src/guard.js";
import { adjustStock, forgotPassword, resetPassword } from "../src/ops.js";
import {
  approveStocktake,
  checkoutAsset,
  createAsset,
  createStocktake,
  DEMO_PASSWORD,
  listAssets,
  login,
  seedDemo,
  setCounts,
  submitStocktake,
} from "../src/store.js";
import { checkSchema } from "../src/schema.js";
import { totp } from "../src/totp.js";

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "techne-sec-"));
process.env.SEED_DEMO = "1";
process.env.NODE_ENV = "test";

test("totp matches the published test vector", () => {
  assert.equal(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59 * 1000), "287082");
});

test("critical writes reject the wrong shape", () => {
  assert.throws(
    () => checkSchema("POST", "/api/assets/11111111-1111-4111-8111-111111111111/checkout", { person: "Ada", acknowledgement: "Ada" }),
    /Expected return/,
  );
  assert.throws(
    () => checkSchema("POST", "/api/products", { name: "Cable", sku: "IT-9", department: "IT", category: "Accessories", aisle: "IT Store", qty: "lots" }),
    /whole number/,
  );
  assert.deepEqual(checkSchema("POST", "/api/branches", { name: "Cape" }).name, "Cape");
});

test("offline queue keeps separate posts and merges count lines", () => {
  const context = { globalThis: {} };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(new URL("../../techne-scan-pwa/queue.js", import.meta.url), "utf8"), context);
  const first = context.mergeOutbox([], { method: "POST", path: "/api/products", body: { sku: "A" }, idempotencyKey: "11111111-1111-4111-8111-111111111111" });
  const second = context.mergeOutbox(first, { method: "POST", path: "/api/products", body: { sku: "B" }, idempotencyKey: "22222222-2222-4222-8222-222222222222" });
  assert.equal(second.length, 2);
  assert.equal(second[0].body.sku, "A");
  const counts = context.mergeOutbox([], { method: "PUT", path: "/api/stocktakes/x/counts", body: { counts: [{ productId: "p1", count: 1 }] }, idempotencyKey: "33333333-3333-4333-8333-333333333333" });
  const merged = context.mergeOutbox(counts, { method: "PUT", path: "/api/stocktakes/x/counts", body: { counts: [{ productId: "p2", count: 4 }, { productId: "p1", count: 2 }] } });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].idempotencyKey, "33333333-3333-4333-8333-333333333333");
  assert.equal([...merged[0].body.counts].map((row) => row.count).join(","), "2,4");
});

test("idempotency, approval lock, restore, and privacy reset", async () => {
  await initDb();
  await seedDemo();
  const admin = await login("admin@techne.local", DEMO_PASSWORD);
  const body = { name: "Idempotent ladder", category: "Tools", department: "Stores", location: "Cage", branchId: admin.branchId };
  const key = "44444444-4444-4444-8444-444444444444";
  const created = await runIdempotent(admin, "POST", "/api/assets", body, key, () => createAsset(admin, body));
  const replay = await runIdempotent(admin, "POST", "/api/assets", body, key, () => createAsset(admin, { ...body, name: "Should not run" }));
  assert.equal(replay.id, created.id);
  await assert.rejects(() => runIdempotent(admin, "POST", "/api/assets", { ...body, name: "Other" }, key, () => createAsset(admin, body)), /different transaction/);
  const assets = await listAssets(admin);
  assert.equal(assets.filter((item) => item.name === "Idempotent ladder").length, 1);
  assert.ok(assets[0].qrPayload);

  const stocktake = await createStocktake(admin, { name: "Lock count", scope: "category", scopeValue: "Accessories", branchId: admin.branchId });
  await setCounts(admin, stocktake.id, { counts: stocktake.lines.map((line) => ({ productId: line.productId, count: line.expected })) });
  await submitStocktake(admin, stocktake.id);
  await approveStocktake(admin, stocktake.id);
  await assert.rejects(() => approveStocktake(admin, stocktake.id), /already|Only a submitted/);

  const product = (await query(`SELECT id, qty FROM products WHERE company_id = $1 LIMIT 1`, [admin.companyId]))[0];
  const before = Number(product.qty);
  await assert.rejects(() => adjustStock(admin, { productId: product.id, delta: -1_000_000, reason: "correction", note: "too much" }), /below zero/);
  const after = await query(`SELECT qty FROM products WHERE id = $1`, [product.id]);
  assert.equal(Number(after[0].qty), before);
  await assert.rejects(() => query(`UPDATE audit_log SET action = 'tamper' WHERE company_id = $1`, [admin.companyId]), /immutable/);

  await assert.rejects(() => checkoutAsset(admin, created.id, { person: "Not A Person", due: "2026-11-01", acknowledgement: "Not A Person" }), /employee or contractor/);

  const reset = await forgotPassword("admin@techne.local");
  assert.ok(reset.resetToken);
  await resetPassword({ token: reset.resetToken, password: "replacement-pass" });
  await assert.rejects(() => login("admin@techne.local", DEMO_PASSWORD), /incorrect/);
  await login("admin@techne.local", "replacement-pass");

  const dump = JSON.parse(JSON.stringify(await exportSnapshot()));
  const file = await writeBackup();
  assert.ok(file.companies >= 1);
  await assert.rejects(() => restoreSnapshot(dump), /empty database/);
  await closeDb();

  process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "techne-restore-"));
  await initDb();
  const restored = await restoreSnapshot(dump);
  assert.equal(restored.companies, dump.tables.companies.length);
  const names = await query(`SELECT name FROM companies`);
  assert.equal(names[0].name, "Techne Tech");
  await closeDb();
});

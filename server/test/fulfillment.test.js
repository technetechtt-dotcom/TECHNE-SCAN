import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { applyStripeEvent, portalSession } from "../src/billing.js";
import { connectChannel, pastelCsv, receiveErp, receivePos, syncChannel } from "../src/channels.js";
import { closeDb, initDb, query } from "../src/db.js";
import { setProductControls } from "../src/ops.js";
import { confirmPick, createOrder, listPicking, releaseWave } from "../src/picking.js";
import { createProduct, login, setupCompany } from "../src/store.js";

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "techne-fulfill-"));
process.env.SEED_DEMO = "0";
process.env.NODE_ENV = "test";

function paint(bits) {
  const full = `${"0".repeat(12)}${bits}${"0".repeat(12)}`;
  const modulePx = 2;
  const width = full.length * modulePx;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dark = full[Math.floor(x / modulePx)] === "1";
      const i = (y * width + x) * 4;
      const color = dark ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = color;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

test("camera decoder reads EAN-13 and Code 128 without BarcodeDetector", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "techne-scan-pwa", "symbology.js");
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox);
  const decoder = sandbox.TechneSymbology;
  const ean = paint(decoder.ean13Bits("5901234123457"));
  assert.equal(decoder.readImage(ean.data, ean.width, ean.height), "5901234123457");
  const code = paint(decoder.code128Bits("CLN-001"));
  assert.equal(decoder.readImage(code.data, code.width, code.height), "CLN-001");
});

test("picking, signed channels, pastel export, and the billing portal", async () => {
  await initDb();
  const owner = await setupCompany({
    companyName: "Channel Co",
    timezone: "Africa/Johannesburg",
    branchName: "Floor",
    adminName: "Owner",
    email: "owner@channel.test",
    password: "longpassword1",
  });
  const user = await login("owner@channel.test", "longpassword1");
  assert.equal(user.companyId, owner.companyId);
  const far = await createProduct(user, { name: "Far item", sku: "FAR-1", department: "Store", category: "Goods", aisle: "B", qty: 10, branchId: user.branchId });
  const near = await createProduct(user, { name: "Near item", sku: "NEAR-1", department: "Store", category: "Goods", aisle: "A", qty: 10, branchId: user.branchId });
  await setProductControls(user, far.id, { shelf: "2", bin: "2", reorderLevel: 0 });
  await setProductControls(user, near.id, { shelf: "1", bin: "1", reorderLevel: 0 });

  await createOrder(user, { branchId: user.branchId, lines: [{ sku: "FAR-1", qty: 2 }, { sku: "NEAR-1", qty: 1 }] });
  const wave = await releaseWave(user, { branchId: user.branchId, name: "Morning" });
  assert.equal(wave.first, "A · 1 · 1");
  const open = await listPicking(user);
  assert.equal(open.waves[0].next.sku, "NEAR-1");
  await assert.rejects(() => confirmPick(user, wave.id, { barcode: "FAR-1", qty: 1 }), /next pick is NEAR-1/);
  await confirmPick(user, wave.id, { barcode: "NEAR-1" });
  const after = await listPicking(user);
  assert.equal(after.waves[0].next.sku, "FAR-1");
  const qty = await query(`SELECT qty FROM products WHERE id = $1`, [near.id]);
  assert.equal(Number(qty[0].qty), 9);

  const csv = pastelCsv([{ sku: "NEAR-1", name: "Near item", qty: 9, aisle: "A", shelf: "1", bin: "1" }], "Floor");
  assert.match(csv, /NEAR-1/);
  await connectChannel(user, { provider: "pastel" });
  const exported = await syncChannel(user, "pastel");
  assert.match(exported.csv, /FAR-1/);

  const pos = await connectChannel(user, { provider: "pos" });
  const body = Buffer.from(JSON.stringify({ externalRef: "TILL-1", fulfill: "issue", lines: [{ sku: "FAR-1", qty: 2 }] }));
  const signature = createHmac("sha256", pos.secret).update(body).digest("hex");
  await assert.rejects(() => receivePos(user.companyId, body, "abcd"), /signature/);
  await receivePos(user.companyId, body, signature);
  const sold = await query(`SELECT qty FROM products WHERE id = $1`, [far.id]);
  assert.equal(Number(sold[0].qty), 8);
  const duplicate = await receivePos(user.companyId, body, signature);
  assert.equal(duplicate.duplicate, true);
  assert.equal(Number((await query(`SELECT qty FROM products WHERE id = $1`, [far.id]))[0].qty), 8);

  const erp = await connectChannel(user, { provider: "erp", webhookUrl: "https://erp.example/techne" });
  const receipt = Buffer.from(JSON.stringify({ kind: "receipt", externalRef: "GRN-1", lines: [{ sku: "FAR-1", qty: 4 }] }));
  const erpSig = createHmac("sha256", erp.secret).update(receipt).digest("hex");
  await receiveErp(user.companyId, receipt, erpSig);
  assert.equal(Number((await query(`SELECT qty FROM products WHERE id = $1`, [far.id]))[0].qty), 12);

  process.env.SMS_WEBHOOK_URL = "https://sms.example/send";
  await connectChannel(user, { provider: "sms", phone: "+27821234567" });
  let smsBody = "";
  await syncChannel(user, "sms", async (_url, options) => {
    smsBody = options.body;
    return { ok: true };
  });
  assert.match(smsBody, /\+27821234567/);
  delete process.env.SMS_WEBHOOK_URL;

  await query(
    `INSERT INTO integrations (id, company_id, provider, status, external_id, access_token)
     VALUES ($1,$2,'xero','connected','tenant-1','token-1')`,
    [randomUUID(), user.companyId],
  );
  let xeroBody = "";
  await syncChannel(user, "xero", async (_url, options) => {
    xeroBody = options.body;
    return { ok: true, json: async () => ({}) };
  });
  assert.match(xeroBody, /NEAR-1/);

  const checkoutId = randomUUID();
  await query(
    `INSERT INTO billing_checkouts (id, company_id, plan, amount_cents, currency, status, provider)
     VALUES ($1,$2,'counter',49900,'ZAR','pending','stripe')`,
    [checkoutId, user.companyId],
  );
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const raw = Buffer.from(JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { metadata: { checkoutId }, customer: "cus_test_123" } },
  }));
  const stamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", "whsec_test").update(`${stamp}.${raw.toString("utf8")}`).digest("hex");
  await applyStripeEvent(raw, `t=${stamp},v1=${digest}`);
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  const portal = await portalSession(user, { origin: "http://localhost:8080" }, async () => ({ ok: true, json: async () => ({ url: "https://billing.stripe.com/p/session/test" }) }));
  assert.equal(portal.url, "https://billing.stripe.com/p/session/test");
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  await closeDb();
});

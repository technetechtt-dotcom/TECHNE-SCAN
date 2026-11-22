import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { query, tx } from "./db.js";
import { bad } from "./errors.js";
import { createOrder, releaseWave } from "./picking.js";
import { assertCap, assertFreshMfa, newToken, optionalText } from "./security.js";
import { audit, postLedger } from "./store.js";

export const PROVIDERS = [
  { id: "xero", name: "Xero", summary: "OAuth connection. Sync upserts items and sends on-hand quantities." },
  { id: "sage", name: "Sage", summary: "OAuth connection to Sage Accounting. Sync sends item codes, names, and on-hand notes." },
  { id: "pastel", name: "Pastel", summary: "Pastel Partner has no cloud API here. Sync downloads an inventory CSV for Pastel to import." },
  { id: "pos", name: "POS", summary: "The till posts signed sales. Choose issue to move stock now, or pick to open a directed wave." },
  { id: "erp", name: "ERP", summary: "Signed receipts and orders come in. Sync posts the on-hand snapshot to the ERP webhook." },
  { id: "sms", name: "SMS", summary: "Overdue asset alerts go out through Twilio, or through SMS_WEBHOOK_URL." },
  { id: "whatsapp", name: "WhatsApp", summary: "Overdue asset alerts go out through the WhatsApp Cloud API." },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function providerReady(id) {
  if (id === "xero") return Boolean(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET);
  if (id === "sage") return Boolean(process.env.SAGE_CLIENT_ID && process.env.SAGE_CLIENT_SECRET);
  if (id === "sms") return Boolean((process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) || process.env.SMS_WEBHOOK_URL);
  if (id === "whatsapp") return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
  return true;
}

function readyMessage(id) {
  if (id === "xero") return "Set XERO_CLIENT_ID and XERO_CLIENT_SECRET before connecting Xero.";
  if (id === "sage") return "Set SAGE_CLIENT_ID and SAGE_CLIENT_SECRET before connecting Sage.";
  if (id === "sms") return "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM, or set SMS_WEBHOOK_URL.";
  if (id === "whatsapp") return "Set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID before connecting WhatsApp.";
  return "That connection is not available.";
}

function assertOwner(user) {
  assertCap(user, "company");
  assertFreshMfa(user);
  if (user.role !== "owner" && user.role !== "admin") throw bad(403, "Only an owner or admin can change connections.");
}

function phoneOf(value) {
  const text = String(value || "").trim();
  if (!/^\+?[0-9]{8,15}$/.test(text)) throw bad(400, "Enter a phone number with the country code.");
  return text;
}

function configOf(row) {
  if (!row?.config) return {};
  if (typeof row.config === "string") {
    try { return JSON.parse(row.config); } catch { return {}; }
  }
  return row.config;
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function pastelCsv(products, branchName) {
  const lines = [["ItemCode", "Description", "QtyOnHand", "Warehouse", "Aisle", "Shelf", "Bin"].map(csvCell).join(",")];
  for (const product of products) {
    lines.push([product.sku, product.name, product.qty, branchName, product.aisle, product.shelf, product.bin].map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function safeView(row) {
  const known = PROVIDERS.find((item) => item.id === row.provider);
  const config = configOf(row);
  return {
    provider: row.provider,
    name: known?.name || row.provider,
    summary: known?.summary || "",
    status: row.status,
    connected: row.status === "connected",
    ready: providerReady(row.provider),
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
    lastError: row.last_error || "",
    hasWebhook: Boolean(config.webhookUrl),
    webhookPath: row.provider === "pos" ? "/api/hooks/pos" : row.provider === "erp" ? "/api/hooks/erp" : "",
  };
}

async function productsFor(user) {
  const params = [user.companyId];
  let sql = `SELECT p.*, b.name AS branch_name FROM products p JOIN branches b ON b.id = p.branch_id WHERE p.company_id = $1`;
  if (user.role !== "owner" && user.role !== "admin") {
    params.push(user.branchId);
    sql += ` AND p.branch_id = $2`;
  }
  sql += ` ORDER BY p.sku`;
  return query(sql, params);
}

export async function listChannels(user) {
  assertCap(user, "company");
  const rows = await query(`SELECT * FROM integrations WHERE company_id = $1 ORDER BY provider`, [user.companyId]);
  const byId = new Map(rows.map((row) => [row.provider, row]));
  return PROVIDERS.map((item) => safeView(byId.get(item.id) || { provider: item.id, status: "disconnected", config: {}, last_error: "", last_sync_at: null }));
}

async function saveIntegration(companyId, provider, fields) {
  const id = randomUUID();
  const rows = await query(
    `INSERT INTO integrations (id, company_id, provider, status, external_id, access_token, refresh_token, token_expires_at, secret, config, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
     ON CONFLICT (company_id, provider) DO UPDATE SET
       status = EXCLUDED.status,
       external_id = EXCLUDED.external_id,
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       token_expires_at = EXCLUDED.token_expires_at,
       secret = CASE WHEN EXCLUDED.secret = '' THEN integrations.secret ELSE EXCLUDED.secret END,
       config = CASE WHEN EXCLUDED.config = '{}'::jsonb THEN integrations.config ELSE EXCLUDED.config END,
       last_error = EXCLUDED.last_error,
       updated_at = now()
     RETURNING *`,
    [
      id,
      companyId,
      provider,
      fields.status || "connected",
      fields.externalId || "",
      fields.accessToken || "",
      fields.refreshToken || "",
      fields.tokenExpiresAt || null,
      fields.secret || "",
      JSON.stringify(fields.config || {}),
      fields.lastError || "",
    ],
  );
  return rows[0];
}

function oauthConfig(provider, origin) {
  if (provider === "xero") {
    return {
      authorize: "https://login.xero.com/identity/connect/authorize",
      token: "https://identity.xero.com/connect/token",
      clientId: process.env.XERO_CLIENT_ID || "",
      secret: process.env.XERO_CLIENT_SECRET || "",
      scope: "offline_access accounting.transactions accounting.settings",
      redirect: process.env.XERO_REDIRECT_URI || `${origin}/api/channels/xero/callback`,
    };
  }
  return {
    authorize: "https://www.sageone.com/oauth2/auth/central",
    token: "https://oauth.accounting.sage.com/token",
    clientId: process.env.SAGE_CLIENT_ID || "",
    secret: process.env.SAGE_CLIENT_SECRET || "",
    scope: "full_access",
    redirect: process.env.SAGE_REDIRECT_URI || `${origin}/api/channels/sage/callback`,
    extra: { filter: "apiv3.1" },
  };
}

export async function connectChannel(user, input) {
  assertOwner(user);
  const provider = String(input.provider || "");
  if (!PROVIDERS.some((item) => item.id === provider)) throw bad(400, "Choose a connection.");
  if (!providerReady(provider)) throw bad(503, readyMessage(provider));
  if (provider === "xero" || provider === "sage") {
    const origin = String(input.origin || "").replace(/\/$/, "");
    if (!/^https?:\/\//.test(origin)) throw bad(400, "Connection needs the app address.");
    const cfg = oauthConfig(provider, origin);
    const nonce = randomUUID();
    await query(
      `INSERT INTO channel_nonces (id, company_id, provider, redirect, expires_at) VALUES ($1,$2,$3,$4, now() + interval '15 minutes')`,
      [nonce, user.companyId, provider, cfg.redirect],
    );
    const url = new URL(cfg.authorize);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", cfg.redirect);
    url.searchParams.set("scope", cfg.scope);
    url.searchParams.set("state", nonce);
    if (cfg.extra) for (const [key, value] of Object.entries(cfg.extra)) url.searchParams.set(key, value);
    return { mode: "redirect", url: url.toString() };
  }
  if (provider === "pos" || provider === "erp") {
    const secret = newToken();
    let webhookUrl = "";
    if (provider === "erp" && input.webhookUrl) {
      let url;
      try { url = new URL(String(input.webhookUrl)); } catch { throw bad(400, "Enter the ERP webhook URL."); }
      if (url.protocol !== "https:" && process.env.NODE_ENV === "production") throw bad(400, "The ERP webhook must use HTTPS.");
      webhookUrl = url.toString();
    }
    await saveIntegration(user.companyId, provider, { secret, config: webhookUrl ? { webhookUrl } : {} });
    return { provider, secret, webhookPath: provider === "pos" ? "/api/hooks/pos" : "/api/hooks/erp" };
  }
  if (provider === "sms" || provider === "whatsapp") {
    const phone = phoneOf(input.phone);
    await saveIntegration(user.companyId, provider, { config: { phone } });
    return { provider, connected: true };
  }
  await saveIntegration(user.companyId, "pastel", {});
  return { provider: "pastel", connected: true };
}

export async function disconnectChannel(user, provider) {
  assertOwner(user);
  if (!PROVIDERS.some((item) => item.id === provider)) throw bad(400, "Choose a connection.");
  await query(
    `UPDATE integrations SET status = 'disconnected', access_token = '', refresh_token = '', secret = '', last_error = '', updated_at = now()
     WHERE company_id = $1 AND provider = $2`,
    [user.companyId, provider],
  );
  return { provider, connected: false };
}

async function markSync(companyId, provider, error) {
  await query(
    `UPDATE integrations SET last_sync_at = CASE WHEN $3 = '' THEN now() ELSE last_sync_at END, last_error = $3, updated_at = now()
     WHERE company_id = $1 AND provider = $2`,
    [companyId, provider, error],
  );
}

async function tokenRequest(url, clientId, secret, body, fetcher) {
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw bad(502, "The provider rejected the connection.");
  return payload;
}

export async function completeOAuth(provider, code, state, fetcher = globalThis.fetch) {
  if (!UUID.test(String(state || "")) || !code) throw bad(400, "That connection request expired. Start it again.");
  const nonces = await query(`SELECT * FROM channel_nonces WHERE id = $1 AND provider = $2`, [state, provider]);
  const nonce = nonces[0];
  if (!nonce || new Date(nonce.expires_at).getTime() < Date.now()) throw bad(400, "That connection request expired. Start it again.");
  await query(`DELETE FROM channel_nonces WHERE id = $1`, [nonce.id]);
  const cfg = oauthConfig(provider, "");
  const token = await tokenRequest(cfg.token, cfg.clientId, cfg.secret, {
    grant_type: "authorization_code",
    code: String(code),
    redirect_uri: nonce.redirect,
  }, fetcher);
  let externalId = "";
  if (provider === "xero") {
    const response = await fetcher("https://api.xero.com/connections", { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" } });
    const connections = await response.json().catch(() => []);
    externalId = connections?.[0]?.tenantId || "";
    if (!externalId) throw bad(502, "Xero did not return a tenant.");
  } else {
    const response = await fetcher("https://api.accounting.sage.com/v3.1/businesses", { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));
    const first = payload?.$items?.[0] || payload?.[0] || {};
    externalId = first.id || first.displayed_as || "";
  }
  const expires = token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null;
  await saveIntegration(nonce.company_id, provider, {
    externalId,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    tokenExpiresAt: expires,
  });
  return { provider };
}

async function ensureToken(row, fetcher) {
  if (!row.token_expires_at || new Date(row.token_expires_at).getTime() > Date.now() + 60_000) return row.access_token;
  if (!row.refresh_token) throw bad(409, "Reconnect this provider. The access token expired.");
  const cfg = oauthConfig(row.provider, "");
  const token = await tokenRequest(cfg.token, cfg.clientId, cfg.secret, { grant_type: "refresh_token", refresh_token: row.refresh_token }, fetcher);
  const expires = token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null;
  await query(
    `UPDATE integrations SET access_token = $3, refresh_token = $4, token_expires_at = $5, updated_at = now() WHERE company_id = $1 AND provider = $2`,
    [row.company_id, row.provider, token.access_token, token.refresh_token || row.refresh_token, expires],
  );
  return token.access_token;
}

async function pushAccounting(row, products, fetcher) {
  const token = await ensureToken(row, fetcher);
  if (row.provider === "xero") {
    const response = await fetcher("https://api.xero.com/api.xro/2.0/Items", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "xero-tenant-id": row.external_id,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        Items: products.slice(0, 50).map((product) => ({
          Code: product.sku,
          Name: product.name,
          Description: `${product.qty} on hand`,
          IsTrackedAsInventory: true,
          QuantityOnHand: Number(product.qty),
        })),
      }),
    });
    if (!response.ok) throw bad(502, "Xero rejected the item sync.");
    return products.length;
  }
  for (const product of products.slice(0, 20)) {
    const response = await fetcher("https://api.accounting.sage.com/v3.1/products", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ product: { item_code: product.sku, description: product.name, notes: `On hand ${product.qty}` } }),
    });
    if (!response.ok) throw bad(502, "Sage rejected the item sync.");
  }
  return Math.min(products.length, 20);
}

export async function sendMessage(companyId, provider, text, fetcher = globalThis.fetch) {
  const rows = await query(`SELECT * FROM integrations WHERE company_id = $1 AND provider = $2 AND status = 'connected'`, [companyId, provider]);
  const row = rows[0];
  const phone = configOf(row).phone;
  if (!row || !phone) return { sent: false };
  if (!providerReady(provider)) throw bad(503, readyMessage(provider));
  if (provider === "sms" && process.env.SMS_WEBHOOK_URL) {
    const response = await fetcher(process.env.SMS_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: phone, body: text }),
    });
    if (!response.ok) throw bad(502, "The SMS webhook rejected the message.");
  } else if (provider === "sms") {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const response = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phone, From: process.env.TWILIO_FROM, Body: text }),
    });
    if (!response.ok) throw bad(502, "Twilio rejected the SMS.");
  } else {
    const response = await fetcher(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: phone.replace(/\D/g, ""), type: "text", text: { body: text } }),
    });
    if (!response.ok) throw bad(502, "WhatsApp rejected the message.");
  }
  await query(
    `INSERT INTO integration_events (id, company_id, provider, direction, kind, status, detail) VALUES ($1,$2,$3,'out','message','ok',$4::jsonb)`,
    [randomUUID(), companyId, provider, JSON.stringify({ to: phone })],
  );
  return { sent: true };
}

export async function syncChannel(user, provider, fetcher = globalThis.fetch) {
  assertOwner(user);
  if (!PROVIDERS.some((item) => item.id === provider)) throw bad(400, "Choose a connection.");
  const rows = await query(`SELECT * FROM integrations WHERE company_id = $1 AND provider = $2`, [user.companyId, provider]);
  const row = rows[0];
  if (!row || row.status !== "connected") throw bad(409, "Connect that provider first.");
  const products = await productsFor(user);
  try {
    if (provider === "pastel") {
      const branchName = products[0]?.branch_name || "Warehouse";
      const csv = pastelCsv(products.map((product) => ({ ...product, qty: Number(product.qty) })), branchName);
      await markSync(user.companyId, provider, "");
      return { provider, count: products.length, filename: "pastel-inventory.csv", csv };
    }
    if (provider === "xero" || provider === "sage") {
      const count = await pushAccounting(row, products, fetcher);
      await markSync(user.companyId, provider, "");
      return { provider, count };
    }
    if (provider === "erp") {
      const webhook = configOf(row).webhookUrl;
      if (!webhook) throw bad(409, "Add the ERP webhook URL when you connect it.");
      const body = JSON.stringify({
        source: "techne-scan",
        products: products.map((product) => ({ sku: product.sku, name: product.name, qty: Number(product.qty), aisle: product.aisle, bin: product.bin })),
      });
      const response = await fetcher(webhook, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-techne-signature": createHmac("sha256", row.secret).update(body).digest("hex"),
        },
        body,
      });
      if (!response.ok) throw bad(502, "The ERP webhook rejected the snapshot.");
      await markSync(user.companyId, provider, "");
      return { provider, count: products.length };
    }
    if (provider === "sms" || provider === "whatsapp") {
      await sendMessage(user.companyId, provider, "Techne Scan test message. Overdue assets will use this number.", fetcher);
      await markSync(user.companyId, provider, "");
      return { provider, sent: true };
    }
    throw bad(400, "POS sales arrive on the webhook. There is nothing to push.");
  } catch (error) {
    await markSync(user.companyId, provider, error.message || "Sync failed.");
    throw error;
  }
}

function verifySignature(secret, raw, signature) {
  const given = Buffer.from(String(signature || ""), "hex");
  const expected = createHmac("sha256", secret).update(raw).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw bad(401, "That signature was rejected.");
}

async function hookRow(provider, companyId, raw, signature) {
  if (!UUID.test(String(companyId || ""))) throw bad(401, "That signature was rejected.");
  const rows = await query(
    `SELECT * FROM integrations WHERE company_id = $1 AND provider = $2 AND status = 'connected' AND secret <> ''`,
    [companyId, provider],
  );
  if (!rows[0]) throw bad(401, "That signature was rejected.");
  verifySignature(rows[0].secret, raw, signature);
  return rows[0];
}

function parseHook(raw) {
  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { throw bad(400, "The payload is not JSON."); }
  const externalRef = optionalText(body.externalRef, 80);
  if (!externalRef) throw bad(400, "externalRef is required.");
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) throw bad(400, "Enter between 1 and 100 lines.");
  const lines = body.lines.map((line) => {
    const sku = optionalText(line.sku, 40);
    const qty = Number(line.qty);
    if (!sku || !Number.isInteger(qty) || qty < 1 || qty > 1_000_000) throw bad(400, "Each line needs a SKU and a whole quantity.");
    return { sku, qty };
  });
  return { externalRef, lines, fulfill: body.fulfill === "pick" ? "pick" : "issue" };
}

async function alreadyDone(companyId, provider, externalRef) {
  const rows = await query(
    `SELECT id FROM integration_events WHERE company_id = $1 AND provider = $2 AND external_ref = $3 AND status = 'ok' LIMIT 1`,
    [companyId, provider, externalRef],
  );
  return Boolean(rows[0]);
}

async function oneBranch(companyId, lines) {
  let branchId = "";
  for (const line of lines) {
    const products = await query(`SELECT branch_id FROM products WHERE company_id = $1 AND lower(sku) = lower($2)`, [companyId, line.sku]);
    if (!products[0]) throw bad(404, `SKU ${line.sku} was not found.`);
    if (branchId && branchId !== products[0].branch_id) throw bad(409, "A pick order has to stay on one branch.");
    branchId = products[0].branch_id;
  }
  return branchId;
}

async function actorFor(companyId) {
  const rows = await query(
    `SELECT id, company_id, branch_id, role FROM employees WHERE company_id = $1 AND role = 'owner' AND active ORDER BY created_at LIMIT 1`,
    [companyId],
  );
  if (!rows[0]) throw bad(409, "This company has no owner to attach the document to.");
  return { id: rows[0].id, companyId: rows[0].company_id, branchId: rows[0].branch_id, role: rows[0].role };
}

export async function receivePos(companyId, raw, signature) {
  const row = await hookRow("pos", companyId, raw, signature);
  const body = parseHook(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
  if (await alreadyDone(row.company_id, "pos", body.externalRef)) return { ok: true, duplicate: true };
  const actor = await actorFor(row.company_id);
  if (body.fulfill === "pick") {
    const branchId = await oneBranch(row.company_id, body.lines);
    const created = await createOrder(actor, { branchId, lines: body.lines }, "pos", body.externalRef);
    if (!created.duplicate) {
      await releaseWave(actor, { branchId: created.branchId, orderIds: [created.id], name: `POS ${body.externalRef}` });
    } else {
      const open = await query(`SELECT id, branch_id, status FROM sales_orders WHERE id = $1 AND company_id = $2`, [created.id, row.company_id]);
      if (open[0]?.status === "open") await releaseWave(actor, { branchId: open[0].branch_id, orderIds: [created.id], name: `POS ${body.externalRef}` });
    }
    await query(
      `INSERT INTO integration_events (id, company_id, provider, direction, kind, external_ref, status, detail)
       VALUES ($1,$2,'pos','in','pick',$3,'ok',$4::jsonb)`,
      [randomUUID(), row.company_id, body.externalRef, JSON.stringify({ orderId: created.id })],
    );
    return { ok: true, orderId: created.id, duplicate: Boolean(created.duplicate) };
  }
  await tx(async (q) => {
    for (const line of body.lines) {
      const products = await q(`SELECT * FROM products WHERE company_id = $1 AND lower(sku) = lower($2)`, [row.company_id, line.sku]);
      if (!products[0]) throw bad(404, `SKU ${line.sku} was not found.`);
      await postLedger(q, {
        companyId: row.company_id,
        branchId: products[0].branch_id,
        productId: products[0].id,
        delta: -line.qty,
        reason: "pos_sale",
        refType: "pos",
        note: `POS ${body.externalRef}`,
        actorId: actor.id,
      });
    }
    await q(
      `INSERT INTO integration_events (id, company_id, provider, direction, kind, external_ref, status, detail)
       VALUES ($1,$2,'pos','in','issue',$3,'ok',$4::jsonb)`,
      [randomUUID(), row.company_id, body.externalRef, JSON.stringify({ lines: body.lines.length })],
    );
    await audit(q, actor, "pos.sale", "integration", row.id, { externalRef: body.externalRef });
  });
  return { ok: true, posted: body.lines.length };
}

export async function receiveErp(companyId, raw, signature) {
  const row = await hookRow("erp", companyId, raw, signature);
  const body = parseHook(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
  let payload;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { throw bad(400, "The payload is not JSON."); }
  const kind = payload.kind === "order" ? "order" : "receipt";
  if (await alreadyDone(row.company_id, "erp", body.externalRef)) return { ok: true, duplicate: true };
  const actor = await actorFor(row.company_id);
  if (kind === "order") {
    const branchId = await oneBranch(row.company_id, body.lines);
    const created = await createOrder(actor, { branchId, lines: body.lines }, "erp", body.externalRef);
    await query(
      `INSERT INTO integration_events (id, company_id, provider, direction, kind, external_ref, status, detail)
       VALUES ($1,$2,'erp','in','order',$3,'ok',$4::jsonb)`,
      [randomUUID(), row.company_id, body.externalRef, JSON.stringify({ orderId: created.id })],
    );
    return { ok: true, orderId: created.id, duplicate: Boolean(created.duplicate) };
  }
  await tx(async (q) => {
    for (const line of body.lines) {
      const products = await q(`SELECT * FROM products WHERE company_id = $1 AND lower(sku) = lower($2)`, [row.company_id, line.sku]);
      if (!products[0]) throw bad(404, `SKU ${line.sku} was not found.`);
      await postLedger(q, {
        companyId: row.company_id,
        branchId: products[0].branch_id,
        productId: products[0].id,
        delta: line.qty,
        reason: "erp_receipt",
        refType: "erp",
        note: `ERP ${body.externalRef}`,
        actorId: actor.id,
      });
    }
    await q(
      `INSERT INTO integration_events (id, company_id, provider, direction, kind, external_ref, status, detail)
       VALUES ($1,$2,'erp','in','receipt',$3,'ok',$4::jsonb)`,
      [randomUUID(), row.company_id, body.externalRef, JSON.stringify({ lines: body.lines.length })],
    );
  });
  return { ok: true, received: body.lines.length };
}

export async function dispatchOverdueMessages(fetcher = globalThis.fetch) {
  const rows = await query(
    `SELECT i.company_id, i.provider, a.name, a.due
     FROM integrations i
     JOIN assets a ON a.company_id = i.company_id AND a.status = 'out' AND a.due IS NOT NULL AND a.due < CURRENT_DATE
     WHERE i.provider IN ('sms','whatsapp') AND i.status = 'connected'`,
  );
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.company_id}:${row.provider}`;
    const bucket = grouped.get(key) || { companyId: row.company_id, provider: row.provider, names: [] };
    bucket.names.push(`${row.name} (due ${String(row.due).slice(0, 10)})`);
    grouped.set(key, bucket);
  }
  for (const bucket of grouped.values()) {
    const recent = await query(
      `SELECT id FROM integration_events WHERE company_id = $1 AND provider = $2 AND kind = 'overdue' AND at > now() - interval '20 hours' LIMIT 1`,
      [bucket.companyId, bucket.provider],
    );
    if (recent[0]) continue;
    const text = `Techne Scan overdue: ${bucket.names.slice(0, 5).join("; ")}`;
    try {
      const result = await sendMessage(bucket.companyId, bucket.provider, text, fetcher);
      if (result.sent) {
        await query(
          `INSERT INTO integration_events (id, company_id, provider, direction, kind, status) VALUES ($1,$2,$3,'out','overdue','ok')`,
          [randomUUID(), bucket.companyId, bucket.provider],
        );
      }
    } catch {
      await query(
        `UPDATE integrations SET last_error = $3, updated_at = now() WHERE company_id = $1 AND provider = $2`,
        [bucket.companyId, bucket.provider, "Overdue message was not delivered."],
      );
    }
  }
}

export function channelRoutes() {
  return [
    ["GET", /^\/api\/channels$/, (user) => listChannels(user)],
    ["POST", /^\/api\/channels\/connect$/, (user, body) => connectChannel(user, body)],
    ["POST", /^\/api\/channels\/([^/]+)\/sync$/, (user, _body, provider) => syncChannel(user, provider)],
    ["POST", /^\/api\/channels\/([^/]+)\/disconnect$/, (user, _body, provider) => disconnectChannel(user, provider)],
  ];
}

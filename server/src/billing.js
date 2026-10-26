import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { query } from "./db.js";
import { bad } from "./errors.js";
import { assertCap, assertFreshMfa } from "./security.js";

const PLANS = [
  {
    id: "starter",
    name: "Starter",
    monthlyCents: 0,
    scanners: ["Phone"],
    summary: "Phone camera scanning is included.",
  },
  {
    id: "counter",
    name: "Counter",
    monthlyCents: 49900,
    scanners: ["Phone", "USB", "OPN-2001"],
    summary: "Adds USB scanners and the Opticon OPN-2001.",
  },
  {
    id: "wireless",
    name: "Wireless",
    monthlyCents: 99900,
    scanners: ["Phone", "USB", "OPN-2001", "Bluetooth", "Wireless", "Other"],
    summary: "Adds Bluetooth and wireless scanners on top of every Counter scanner.",
  },
];

const PRICE_ENV = { counter: "STRIPE_PRICE_COUNTER", wireless: "STRIPE_PRICE_WIRELESS" };

function money(cents) {
  return `R${(cents / 100).toFixed(2)}`;
}

function planById(id) {
  return PLANS.find((plan) => plan.id === id) || null;
}

function rank(id) {
  return PLANS.findIndex((plan) => plan.id === id);
}

function publicPlan(plan, currentId) {
  return {
    id: plan.id,
    name: plan.name,
    monthlyCents: plan.monthlyCents,
    currency: "ZAR",
    label: money(plan.monthlyCents),
    scanners: plan.scanners,
    summary: plan.summary,
    current: plan.id === currentId,
  };
}

function effective(row) {
  if (!row || row.plan === "starter" || row.plan_status === "cancelled") return planById("starter");
  if (row.plan_until && new Date(row.plan_until).getTime() <= Date.now()) return planById("starter");
  return planById(row.plan) || planById("starter");
}

async function companyRow(companyId) {
  const rows = await query(`SELECT plan, plan_status, plan_until FROM companies WHERE id = $1`, [companyId]);
  if (!rows[0]) throw bad(404, "Company not found.");
  return rows[0];
}

export async function billingView(companyId) {
  const row = await companyRow(companyId);
  const plan = effective(row);
  return {
    plan: plan.id,
    planName: plan.name,
    status: row.plan_status || "active",
    until: row.plan_until ? new Date(row.plan_until).toISOString() : null,
    scanners: plan.scanners,
    plans: PLANS.map((item) => publicPlan(item, plan.id)),
  };
}

export async function assertScannerAllowed(companyId, kind) {
  const view = await billingView(companyId);
  if (view.scanners.includes(kind)) return view;
  const needed = PLANS.find((plan) => plan.scanners.includes(kind));
  const price = needed ? `${needed.name} plan at ${money(needed.monthlyCents)} per month` : "a higher plan";
  throw bad(402, `${kind} scanners need the ${price}. The ${view.planName} plan does not include that scanner.`);
}

async function activate(companyId, planId, checkoutId) {
  const paid = await query(
    `UPDATE billing_checkouts SET status = 'paid', paid_at = now()
     WHERE id = $1 AND company_id = $2 AND status = 'pending'
     RETURNING id, plan`,
    [checkoutId, companyId],
  );
  if (!paid[0] || paid[0].plan !== planId) throw bad(409, "That checkout is no longer open.");
  const rows = await query(
    `UPDATE companies
     SET plan = $2, plan_status = 'active', plan_until = now() + interval '1 month'
     WHERE id = $1
     RETURNING plan, plan_until`,
    [companyId, planId],
  );
  return { plan: rows[0].plan, until: new Date(rows[0].plan_until).toISOString() };
}

export async function startCheckout(user, input) {
  assertCap(user, "company");
  assertFreshMfa(user);
  if (user.role !== "owner") throw bad(403, "Only an owner can change the scanner subscription.");
  const plan = planById(String(input.plan || ""));
  if (!plan || plan.monthlyCents <= 0) throw bad(400, "Choose a paid scanner plan.");
  const current = await billingView(user.companyId);
  if (rank(plan.id) <= rank(current.plan)) throw bad(400, "Choose a higher scanner plan.");
  const checkoutId = randomUUID();
  if (process.env.STRIPE_SECRET_KEY) {
    const priceEnv = PRICE_ENV[plan.id];
    const price = process.env[priceEnv];
    if (!price) throw bad(503, "Card checkout is missing the Stripe price for that plan.");
    const origin = String(input.origin || "").replace(/\/$/, "");
    if (!/^https?:\/\//.test(origin)) throw bad(400, "Checkout needs the app address.");
    const body = new URLSearchParams({
      mode: "subscription",
      success_url: `${origin}/?billing=success`,
      cancel_url: `${origin}/?billing=cancel`,
      client_reference_id: checkoutId,
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      "metadata[checkoutId]": checkoutId,
      "metadata[companyId]": user.companyId,
      "metadata[plan]": plan.id,
    });
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const session = await response.json();
    if (!response.ok || !session.url) throw bad(502, "Card checkout could not be opened.");
    await query(
      `INSERT INTO billing_checkouts (id, company_id, plan, amount_cents, currency, status, provider, provider_ref)
       VALUES ($1,$2,$3,$4,'ZAR','pending','stripe',$5)`,
      [checkoutId, user.companyId, plan.id, plan.monthlyCents, session.id],
    );
    return { mode: "stripe", url: session.url, checkoutId, plan: publicPlan(plan, current.plan) };
  }
  if (process.env.NODE_ENV === "production") {
    throw bad(503, "Card checkout is not configured. The plan stays unchanged until Stripe is connected.");
  }
  await query(
    `INSERT INTO billing_checkouts (id, company_id, plan, amount_cents, currency, status, provider)
     VALUES ($1,$2,$3,$4,'ZAR','pending','demo')`,
    [checkoutId, user.companyId, plan.id, plan.monthlyCents],
  );
  return {
    mode: "demo",
    checkoutId,
    plan: publicPlan(plan, current.plan),
    note: "This local checkout records the monthly plan and does not charge a card.",
  };
}

export async function confirmDemoCheckout(user, input) {
  if (process.env.NODE_ENV === "production") throw bad(403, "Demo checkout is disabled.");
  assertCap(user, "company");
  if (user.role !== "owner") throw bad(403, "Only an owner can change the scanner subscription.");
  const checkoutId = String(input.checkoutId || "");
  const rows = await query(
    `SELECT id, plan, provider FROM billing_checkouts WHERE id = $1 AND company_id = $2`,
    [checkoutId, user.companyId],
  );
  if (!rows[0] || rows[0].provider !== "demo") throw bad(404, "That checkout was not found.");
  await activate(user.companyId, rows[0].plan, rows[0].id);
  return billingView(user.companyId);
}

function stripeSignatureOk(raw, header) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(",").map((part) => part.split("=")));
  if (!parts.t || !parts.v1) return false;
  const digest = createHmac("sha256", secret).update(`${parts.t}.${raw.toString("utf8")}`).digest("hex");
  const given = Buffer.from(parts.v1);
  const expected = Buffer.from(digest);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function applyStripeEvent(raw, header) {
  if (!stripeSignatureOk(raw, header)) throw bad(400, "Stripe signature was rejected.");
  const event = JSON.parse(raw.toString("utf8"));
  if (event.type !== "checkout.session.completed") return { ok: true, ignored: true };
  const session = event.data?.object || {};
  const checkoutId = session.metadata?.checkoutId || session.client_reference_id;
  const rows = await query(`SELECT id, company_id, plan, status FROM billing_checkouts WHERE id = $1 AND provider = 'stripe'`, [checkoutId]);
  if (!rows[0]) throw bad(404, "That checkout was not found.");
  if (rows[0].status === "paid") return { ok: true, duplicate: true };
  await activate(rows[0].company_id, rows[0].plan, rows[0].id);
  return { ok: true };
}

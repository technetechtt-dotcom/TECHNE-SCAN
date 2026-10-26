import { query } from "./db.js";
import { bad } from "./errors.js";
import { explainLine } from "./reconcile.js";
import { companyWide } from "./security.js";
import { todayInTz } from "./time.js";

function day(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text.slice(0, 10);
}

function branchSql(user, params, column) {
  if (companyWide(user)) return "";
  params.push(user.branchId);
  return ` AND ${column} = $${params.length}`;
}

export async function summary(user) {
  const today = todayInTz(user.timezone);
  const assetParams = [user.companyId, today];
  const assets = await query(
    `SELECT id, name, holder, due FROM assets
     WHERE company_id = $1 AND status = 'out' AND due IS NOT NULL AND due < $2::date${branchSql(user, assetParams, "branch_id")}
     ORDER BY due`,
    assetParams,
  );
  const productParams = [user.companyId];
  const products = await query(
    `SELECT p.*, EXISTS (
       SELECT 1 FROM stocktake_lines l WHERE l.product_id = p.id
     ) AS counted_before
     FROM products p WHERE p.company_id = $1${branchSql(user, productParams, "p.branch_id")}
     ORDER BY p.name`,
    productParams,
  );
  const varianceParams = [user.companyId];
  const variances = await query(
    `SELECT s.id AS stocktake_id, s.name AS stocktake_name, s.status, p.sku, p.name, l.expected, l.counted, l.movement, l.variance
     FROM stocktake_lines l
     JOIN stocktakes s ON s.id = l.stocktake_id
     JOIN products p ON p.id = l.product_id
     WHERE s.company_id = $1${branchSql(user, varianceParams, "s.branch_id")}
       AND l.counted IS NOT NULL
       AND ((l.variance IS NOT NULL AND l.variance <> 0) OR (s.status = 'completed' AND l.counted <> l.expected))
     ORDER BY s.created_at DESC
     LIMIT 12`,
    varianceParams,
  );
  const recommendations = [];
  for (const asset of assets) {
    recommendations.push({
      id: `overdue:${asset.id}`,
      severity: "high",
      title: `${asset.name} is overdue`,
      detail: `Due back ${day(asset.due)} from ${asset.holder || "the custodian"}.`,
    });
  }
  for (const product of products) {
    if (Number(product.qty) <= 20) {
      recommendations.push({
        id: `low:${product.id}`,
        severity: "medium",
        title: `${product.name} is low`,
        detail: `${product.qty} on hand at ${product.aisle}. SKU ${product.sku}.`,
      });
    }
    if (!product.counted_before) {
      recommendations.push({
        id: `uncounted:${product.id}`,
        severity: "low",
        title: `${product.name} has never been counted`,
        detail: `${product.sku} is in ${product.aisle}. Include it in the next sectional count.`,
      });
    }
    if (Number(product.reorder_level) > 0 && Number(product.qty) <= Number(product.reorder_level)) {
      recommendations.push({
        id: `reorder:${product.id}`,
        severity: "high",
        title: `${product.name} is at its reorder level`,
        detail: `${product.qty} on hand. Reorder level is ${product.reorder_level}.`,
      });
    }
  }
  const discrepancies = variances.map((row) => {
    const variance = row.variance === null || row.variance === undefined ? Number(row.counted) - Number(row.expected) : Number(row.variance);
    const explained = explainLine({
      name: row.name,
      expected: Number(row.expected),
      movements: Number(row.movement || 0),
      counted: Number(row.counted),
    });
    return {
      stocktakeId: row.stocktake_id,
      stocktake: row.stocktake_name,
      sku: row.sku,
      name: row.name,
      status: row.status,
      variance,
      narrative: row.status === "approved" ? explained.narrative : `${row.name} was submitted at ${row.counted} against a snapshot of ${row.expected}. Approval will subtract movements recorded after the snapshot before posting.`,
    };
  });
  for (const item of discrepancies.slice(0, 4)) {
    recommendations.push({
      id: `variance:${item.stocktakeId}:${item.sku}`,
      severity: "medium",
      title: `${item.name} has a discrepancy`,
      detail: item.narrative,
    });
  }
  const issueParams = [user.companyId];
  const issues = await query(
    `SELECT l.product_id, l.qty_delta, l.at FROM stock_ledger l
     JOIN products p ON p.id = l.product_id
     WHERE l.company_id = $1 AND l.reason = 'issue'${branchSql(user, issueParams, "p.branch_id")}`,
    issueParams,
  );
  const byProduct = new Map();
  for (const issue of issues) {
    const bucket = byProduct.get(issue.product_id) || [];
    bucket.push(issue);
    byProduct.set(issue.product_id, bucket);
  }
  const forecast = [];
  for (const product of products) {
    const rows = byProduct.get(product.id) || [];
    if (!rows.length) {
      forecast.push({ sku: product.sku, name: product.name, qty: Number(product.qty), dailyUse: null, daysOfCover: null, note: "No issue history yet." });
      continue;
    }
    const first = Math.min(...rows.map((row) => new Date(row.at).getTime()));
    const days = Math.max(1, (Date.now() - first) / 86400000);
    const used = rows.reduce((sum, row) => sum + Math.abs(Number(row.qty_delta)), 0);
    const dailyUse = used / days;
    const daysOfCover = dailyUse > 0 ? Number(product.qty) / dailyUse : null;
    forecast.push({
      sku: product.sku,
      name: product.name,
      qty: Number(product.qty),
      dailyUse: Math.round(dailyUse * 10) / 10,
      daysOfCover: daysOfCover === null ? null : Math.round(daysOfCover),
      note: daysOfCover !== null && daysOfCover < 14 ? "Cover is under 14 days." : "Usage is estimated from recorded issues.",
    });
  }
  return {
    method: "Stock ledger, count snapshots, and custody dates. No external model is called.",
    recommendations: recommendations.slice(0, 12),
    discrepancies,
    forecast,
  };
}

export async function ask(user, question) {
  const text = String(question || "").trim();
  if (!text) throw bad(400, "Ask a question about assets, stock, or counts.");
  if (text.length > 500) throw bad(400, "That question is too long.");
  const normalized = text.toLowerCase();
  const data = await summary(user);
  if (/overdue|late return/.test(normalized)) {
    const items = data.recommendations.filter((item) => item.id.startsWith("overdue:"));
    return { answer: items.length ? items.map((item) => `${item.title}. ${item.detail}`).join(" ") : "No assets are overdue.", details: items };
  }
  if (/checked out|who has|custodian/.test(normalized)) {
    const params = [user.companyId];
    const rows = await query(
      `SELECT name, holder, due FROM assets WHERE company_id = $1 AND status = 'out'${branchSql(user, params, "branch_id")} ORDER BY name`,
      params,
    );
    if (!rows.length) return { answer: "Nothing is checked out.", details: [] };
    return {
      answer: rows.map((row) => `${row.name} is with ${row.holder || "an unnamed person"}${row.due ? `, due ${String(row.due).slice(0, 10)}` : ""}`).join(". ") + ".",
      details: rows,
    };
  }
  if (/low stock|reorder|running out|days of cover|forecast|demand/.test(normalized)) {
    const short = data.forecast.filter((item) => item.daysOfCover !== null && item.daysOfCover < 21);
    const low = data.recommendations.filter((item) => item.id.startsWith("low:"));
    const answer = [
      low.length ? low.map((item) => item.detail).join(" ") : "No product is at or below 20 on hand.",
      short.length ? short.map((item) => `${item.name} has about ${item.daysOfCover} days of cover.`).join(" ") : "No product with issue history is under 21 days of cover.",
    ].join(" ");
    return { answer, details: data.forecast };
  }
  if (/variance|discrep|short|overage|investigat/.test(normalized)) {
    if (!data.discrepancies.length) return { answer: "No count discrepancies are on record.", details: [] };
    return { answer: data.discrepancies.slice(0, 4).map((item) => item.narrative).join(" "), details: data.discrepancies };
  }
  if (/schedule|when is the next/.test(normalized)) {
    const params = [user.companyId];
    const rows = await query(
      `SELECT name, frequency, time_of_day, next_run_at FROM schedules WHERE company_id = $1 AND active${branchSql(user, params, "branch_id")} ORDER BY next_run_at`,
      params,
    );
    if (!rows.length) return { answer: "There are no active count schedules.", details: [] };
    return {
      answer: rows.map((row) => `${row.name} runs ${row.frequency} at ${row.time_of_day}. Next run ${new Date(row.next_run_at).toLocaleString("en-ZA")}.`).join(" "),
      details: rows,
    };
  }
  const params = [user.companyId, `%${text.slice(0, 40).toLowerCase()}%`];
  const found = await query(
    `SELECT name, sku, qty, aisle FROM products WHERE company_id = $1 AND (lower(name) LIKE $2 OR lower(sku) LIKE $2)${branchSql(user, params, "branch_id")} LIMIT 5`,
    params,
  );
  if (found.length) {
    return {
      answer: found.map((row) => `${row.name} (${row.sku}) has ${row.qty} on hand in ${row.aisle}.`).join(" "),
      details: found,
    };
  }
  if (process.env.OPENAI_API_KEY) {
    const modelled = await externalAnswer(text, data);
    if (modelled) return { answer: modelled, details: [], method: "External model limited to this company's summary. Suggested stock changes still need a person to approve them." };
  }
  return {
    answer: "I can answer questions about overdue assets, who has equipment, low stock, days of cover, count discrepancies, and schedules.",
    details: [],
  };
}

async function externalAnswer(question, data) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [
          { role: "system", content: "Answer only from the JSON for this organisation. Do not use or infer another company's data. Do not invent quantities. If a write is requested, say a person must approve it in Techne Scan." },
          { role: "user", content: JSON.stringify({ question, recommendations: data.recommendations, forecast: data.forecast }).slice(0, 12000) },
        ],
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

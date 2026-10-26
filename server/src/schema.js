import { bad } from "./errors.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const rules = [
  {
    method: "POST",
    pattern: /^\/api\/assets\/[^/]+\/checkout$/,
    fields: {
      person: { type: "string", max: 80, label: "Employee" },
      employeeCode: { type: "string", max: 20, label: "Employee code" },
      due: { type: "string", date: true, required: true, label: "Expected return" },
      acknowledgement: { type: "string", max: 80, required: true, label: "Acknowledgement" },
      notes: { type: "string", max: 400, label: "Notes" },
      version: { type: "int", label: "Version" },
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/assets\/[^/]+\/checkin$/,
    fields: {
      person: { type: "string", max: 80, required: true, label: "Received by" },
      condition: { type: "string", max: 40, required: true, label: "Condition" },
      location: { type: "string", max: 80, required: true, label: "Return location" },
      notes: { type: "string", max: 400, label: "Notes" },
      acknowledgement: { type: "string", max: 80, label: "Acknowledgement" },
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/stock\/adjust$/,
    fields: {
      productId: { type: "string", required: true, max: 40, label: "Product" },
      delta: { type: "int", required: true, label: "Adjustment" },
      reason: { type: "string", required: true, max: 40, label: "Reason" },
      note: { type: "string", required: true, max: 200, label: "Note" },
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/stocktakes$/,
    fields: {
      id: { type: "string", max: 40, label: "Id" },
      name: { type: "string", required: true, max: 120, label: "Count name" },
      scope: { type: "string", required: true, max: 20, label: "Scope" },
      scopeValue: { type: "string", max: 500, label: "Scope value" },
      branchId: { type: "string", max: 40, label: "Branch" },
      assignedEmployeeId: { type: "string", max: 40, label: "Employee" },
      zone: { type: "string", max: 60, label: "Zone" },
      doubleCount: { type: "boolean", label: "Double count" },
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/products$/,
    fields: {
      id: { type: "string", max: 40, label: "Id" },
      name: { type: "string", required: true, max: 120, label: "Product name" },
      sku: { type: "string", required: true, max: 40, label: "SKU" },
      department: { type: "string", required: true, max: 60, label: "Department" },
      category: { type: "string", required: true, max: 60, label: "Category" },
      aisle: { type: "string", required: true, max: 60, label: "Aisle" },
      qty: { type: "int", required: true, label: "Opening quantity" },
      branchId: { type: "string", max: 40, label: "Branch" },
    },
  },
];

function read(value, spec) {
  if (spec.type === "string") {
    if (typeof value !== "string") throw bad(400, `${spec.label} must be text.`);
    const text = value.trim();
    if (spec.required && !text) throw bad(400, `${spec.label} is required.`);
    if (spec.max && text.length > spec.max) throw bad(400, `${spec.label} is too long.`);
    if (spec.date && !DATE.test(text)) throw bad(400, `${spec.label} must be a date.`);
    return text;
  }
  if (spec.type === "int") {
    const number = typeof value === "number" ? value : Number(String(value));
    if (!Number.isInteger(number)) throw bad(400, `${spec.label} must be a whole number.`);
    return number;
  }
  if (spec.type === "boolean") {
    if (typeof value !== "boolean" && value !== "true" && value !== "false") throw bad(400, `${spec.label} must be yes or no.`);
    return value === true || value === "true";
  }
  throw bad(400, `${spec.label} is not valid.`);
}

export function checkSchema(method, path, body) {
  const rule = rules.find((item) => item.method === method && item.pattern.test(path));
  if (!rule) return body || {};
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const out = {};
  for (const [key, spec] of Object.entries(rule.fields)) {
    const value = source[key];
    const empty = value === undefined || value === null || value === "";
    if (empty) {
      if (spec.required) throw bad(400, `${spec.label} is required.`);
      continue;
    }
    out[key] = read(value, spec);
  }
  if (rule.pattern.source.includes("checkout") && !out.person && !out.employeeCode) {
    throw bad(400, "Employee is required.");
  }
  return out;
}

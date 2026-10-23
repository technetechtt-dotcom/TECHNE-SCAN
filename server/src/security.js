import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { bad } from "./errors.js";

const scrypt = promisify(scryptCb);
const CAPS = {
  owner: ["company", "branches", "employees", "assets", "products", "stocktakes", "approve", "schedules", "devices", "imports", "assign", "intelligence"],
  admin: ["company", "branches", "employees", "assets", "products", "stocktakes", "approve", "schedules", "devices", "imports", "assign", "intelligence"],
  manager: ["assets", "products", "stocktakes", "approve", "schedules", "devices", "imports", "assign", "intelligence"],
  supervisor: ["assets", "products", "stocktakes", "approve", "imports", "assign", "intelligence"],
  clerk: ["assets", "products", "stocktakes", "imports", "intelligence"],
  viewer: ["intelligence"],
};

export const ROLES = Object.keys(CAPS);

export function capsFor(role) {
  return CAPS[role] ? [...CAPS[role]] : [];
}

export function companyWide(user) {
  return user.role === "owner" || user.role === "admin";
}

export function assertCap(user, cap) {
  if (!capsFor(user.role).includes(cap)) throw bad(403, "You do not have permission for that.");
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const buf = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${buf.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const actual = await scrypt(password, salt, 64);
  const expected = Buffer.from(hex, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function newToken() {
  return randomBytes(32).toString("hex");
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function sessionCookie(token, { secure = false, maxAge = 60 * 60 * 24 * 7 } = {}) {
  const bits = [
    `techne_session=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function assertPassword(password) {
  if (typeof password !== "string" || password.length < 10 || password.length > 200) {
    throw bad(400, "Use a password of at least 10 characters.");
  }
}

export function cleanEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 160) {
    throw bad(400, "Enter a valid email address.");
  }
  return value;
}

export function clip(value, max, label) {
  const text = String(value ?? "").trim();
  if (!text) throw bad(400, `${label} is required.`);
  if (text.length > max) throw bad(400, `${label} is too long.`);
  return text;
}

export function optionalText(value, max) {
  const text = String(value ?? "").trim();
  if (text.length > max) throw bad(400, "That text is too long.");
  return text;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function asUuid(value, label = "Id") {
  const text = String(value || "").trim();
  if (!UUID.test(text)) throw bad(400, `${label} is not valid.`);
  return text;
}

export function maybeUuid(value) {
  if (!value) return null;
  return asUuid(value);
}

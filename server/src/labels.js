import { createHmac } from "node:crypto";

export function signLabel(secret, publicId, version = 1) {
  const body = `${publicId}.${version}`;
  const sig = createHmac("sha256", String(secret || "")).update(body).digest("base64url").slice(0, 16);
  return `${body}.${sig}`;
}

export function readLabel(secret, payload) {
  const match = String(payload || "").match(/^([A-Za-z0-9_-]+)\.(\d+)\.([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const expected = signLabel(secret, match[1], Number(match[2]));
  if (expected !== String(payload)) return null;
  return { publicId: match[1], version: Number(match[2]) };
}

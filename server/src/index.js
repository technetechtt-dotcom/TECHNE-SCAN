import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { databaseMode, initDb } from "./db.js";
import { bad } from "./errors.js";
import { handleProtected } from "./routes.js";
import { startScheduler } from "./scheduler.js";
import { readCookie, sessionCookie } from "./security.js";
import { createSession, login, logout, seedDemo, setupCompany, setupStatus, userForToken } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const attempts = new Map();

function clientIp(req) {
  return req.socket.remoteAddress || "local";
}

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = (attempts.get(key) || []).filter((time) => now - time < windowMs);
  if (bucket.length >= limit) throw bad(429, "Too many attempts. Wait a few minutes and try again.");
  bucket.push(now);
  attempts.set(key, bucket);
}

function localHost(req) {
  const host = String(req.headers.host || "").split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function requireClient(req) {
  if (req.get("x-techne-client") !== "1") throw bad(403, "Blocked request.");
}

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, database: databaseMode() });
});

app.get("/api/setup/status", async (req, res, next) => {
  try {
    res.json(await setupStatus(localHost(req)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/setup", async (req, res, next) => {
  try {
    requireClient(req);
    rateLimit(`setup:${clientIp(req)}`, 5, 60 * 60 * 1000);
    const user = await setupCompany(req.body || {});
    const session = await createSession(user.id);
    res.setHeader("Set-Cookie", sessionCookie(session.token, { secure: Boolean(req.secure), maxAge: session.maxAge }));
    res.status(201).json({ user });
  } catch (error) {
    next(error);
  }
});

app.post("/api/login", async (req, res, next) => {
  try {
    requireClient(req);
    const email = String(req.body?.email || "").toLowerCase();
    rateLimit(`login:${clientIp(req)}:${email}`, 8, 15 * 60 * 1000);
    const user = await login(email, String(req.body?.password || ""));
    const session = await createSession(user.id);
    res.setHeader("Set-Cookie", sessionCookie(session.token, { secure: Boolean(req.secure), maxAge: session.maxAge }));
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

app.post("/api/logout", async (req, res, next) => {
  try {
    requireClient(req);
    await logout(readCookie(req, "techne_session"));
    res.setHeader("Set-Cookie", sessionCookie("", { maxAge: 0 }));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use("/api", async (req, res, next) => {
  try {
    if (!["GET", "HEAD"].includes(req.method)) requireClient(req);
    const user = await userForToken(readCookie(req, "techne_session"));
    if (!user) return res.status(401).json({ error: "Sign in required." });
    const pathOnly = req.originalUrl.split("?")[0];
    if (pathOnly === "/api/me" && req.method === "GET") return res.json({ user });
    const result = await handleProtected(user, req.method, pathOnly, req.body);
    res.json(result ?? { ok: true });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, "..", "..", "techne-scan-pwa"), { index: "index.html" }));

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? "Something went wrong." : error.message });
});

const port = Number(process.env.PORT || 8080);
await initDb();
await seedDemo();
startScheduler();
app.listen(port, () => {
  console.log(`Techne Scan running at http://localhost:${port}`);
});

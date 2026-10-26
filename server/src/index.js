import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { applyStripeEvent } from "./billing.js";
import { databaseMode, initDb } from "./db.js";
import { bad } from "./errors.js";
import { alertError, log, rateLimit, runIdempotent } from "./guard.js";
import { acceptInvitation, completeMfa, forgotPassword, resetPassword, startMfaChallenge, userForApiKey } from "./ops.js";
import { handleProtected } from "./routes.js";
import { startScheduler } from "./scheduler.js";
import { readCookie, sessionCookie } from "./security.js";
import { createSession, login, logout, seedDemo, setupCompany, setupStatus, userForToken } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

function clientIp(req) {
  return req.socket.remoteAddress || "local";
}

function localHost(req) {
  const host = String(req.headers.host || "").split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function cookieSecure(req) {
  return process.env.NODE_ENV === "production" || Boolean(req.secure);
}

function requireClient(req) {
  if (req.get("x-techne-client") !== "1") throw bad(403, "Blocked request.");
  const origin = req.get("origin");
  if (!origin) return;
  let host = "";
  try {
    host = new URL(origin).host;
  } catch {
    throw bad(403, "Blocked request.");
  }
  if (host !== req.get("host")) throw bad(403, "Blocked request.");
}

function apiPath(req) {
  const url = new URL(req.originalUrl, "http://localhost");
  return {
    path: url.pathname.replace(/^\/api\/v1(?=\/)/, "/api"),
    query: Object.fromEntries(url.searchParams),
  };
}

app.disable("x-powered-by");
app.use((req, res, next) => {
  if (req.url.startsWith("/api/v1/")) req.url = req.url.replace(/^\/api\/v1/, "/api");
  next();
});
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=()");
  res.setHeader("X-Techne-Api", "1");
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (req.path.startsWith("/api")) {
    res.on("finish", () => log("info", "request", { method: req.method, path: req.path, status: res.statusCode }));
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: 1, database: databaseMode() });
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
    await rateLimit(`setup:${clientIp(req)}`, 5, 60 * 60 * 1000);
    const user = await setupCompany(req.body || {});
    const session = await createSession(user.id, req.get("user-agent"));
    res.setHeader("Set-Cookie", sessionCookie(session.token, { secure: cookieSecure(req), maxAge: session.maxAge }));
    res.status(201).json({ user });
  } catch (error) {
    next(error);
  }
});

app.post("/api/login", async (req, res, next) => {
  try {
    requireClient(req);
    const email = String(req.body?.email || "").toLowerCase();
    await rateLimit(`login:${clientIp(req)}:${email}`, 8, 15 * 60 * 1000);
    const user = await login(email, String(req.body?.password || ""));
    if (user.mfaEnabled) {
      const challenge = await startMfaChallenge(user.id);
      return res.json({ mfaRequired: true, challenge });
    }
    const session = await createSession(user.id, req.get("user-agent"));
    res.setHeader("Set-Cookie", sessionCookie(session.token, { secure: cookieSecure(req), maxAge: session.maxAge }));
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

app.post("/api/login/mfa", async (req, res, next) => {
  try {
    requireClient(req);
    await rateLimit(`mfa:${clientIp(req)}`, 8, 15 * 60 * 1000);
    const user = await completeMfa(req.body || {});
    const session = await createSession(user.id, req.get("user-agent"));
    res.setHeader("Set-Cookie", sessionCookie(session.token, { secure: cookieSecure(req), maxAge: session.maxAge }));
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

app.post("/api/password/forgot", async (req, res, next) => {
  try {
    requireClient(req);
    await rateLimit(`reset:${clientIp(req)}`, 5, 60 * 60 * 1000);
    res.json(await forgotPassword(req.body?.email));
  } catch (error) {
    next(error);
  }
});

app.post("/api/password/reset", async (req, res, next) => {
  try {
    requireClient(req);
    await rateLimit(`reset-complete:${clientIp(req)}`, 8, 60 * 60 * 1000);
    res.json(await resetPassword(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/invitations/accept", async (req, res, next) => {
  try {
    requireClient(req);
    await rateLimit(`invite:${clientIp(req)}`, 8, 60 * 60 * 1000);
    res.json(await acceptInvitation(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/billing/stripe", async (req, res, next) => {
  try {
    res.json(await applyStripeEvent(req.rawBody || Buffer.from(""), req.get("stripe-signature")));
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
    const header = req.get("authorization") || "";
    const bearer = header.startsWith("Bearer ") ? await userForApiKey(header.slice(7).trim()) : null;
    const user = bearer || await userForToken(readCookie(req, "techne_session"));
    if (!user) return res.status(401).json({ error: "Sign in required." });
    const { path: pathOnly, query } = apiPath(req);
    if (pathOnly === "/api/me" && req.method === "GET") return res.json({ user });
    const body = req.method === "GET" || req.method === "HEAD" ? query : req.body;
    const result = await runIdempotent(user, req.method, pathOnly, body, req.get("idempotency-key"), () => handleProtected(user, req.method, pathOnly, body));
    res.json(result ?? { ok: true });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, "..", "..", "techne-scan-pwa"), { index: "index.html" }));

app.use((error, req, res, _next) => {
  const status = error.status || 500;
  if (status >= 500) alertError(error, req);
  res.status(status).json({ error: status >= 500 ? "Something went wrong." : error.message });
});

const port = Number(process.env.PORT || 8080);
await initDb();
await seedDemo();
startScheduler();
app.listen(port, () => {
  log("info", "Techne Scan listening", { port });
});

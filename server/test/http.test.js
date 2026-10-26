import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("production server hides demo accounts and requires the client header", async () => {
  const port = 18765;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "techne-http-"));
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), PGLITE_DIR: dir, NODE_ENV: "production", SEED_DEMO: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  try {
    const started = Date.now();
    while (!log.includes("listening") && Date.now() - started < 90000) await new Promise((resolve) => setTimeout(resolve, 200));
    assert.match(log, /listening/);
    const status = await fetch(`http://127.0.0.1:${port}/api/v1/setup/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).demoLogin, null);
    const blocked = await fetch(`http://127.0.0.1:${port}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(blocked.status, 403);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal((await health.json()).version, 1);
    assert.equal(health.headers.get("x-frame-options"), "DENY");
  } finally {
    child.kill();
  }
});

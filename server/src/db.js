import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mode = "pglite";
let pglite;
let pool;

export function databaseMode() {
  return mode;
}

export async function initDb() {
  if (process.env.DATABASE_URL) {
    mode = "postgres";
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query("SELECT 1");
  } else {
    mode = "pglite";
    const dir = process.env.PGLITE_DIR || path.join(__dirname, "..", "data", "pg");
    fs.mkdirSync(dir, { recursive: true });
    pglite = new PGlite(dir);
    await pglite.waitReady;
  }
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  await exec(schema);
  await migrate();
}

function splitSql(sql) {
  const parts = [];
  let current = "";
  let dollar = false;
  for (const line of sql.split("\n")) {
    const marks = line.match(/\$\$/g);
    if (marks && marks.length % 2 === 1) dollar = !dollar;
    current += `${line}\n`;
    if (!dollar && line.trim().endsWith(";")) {
      const statement = current.trim();
      if (statement && !statement.startsWith("--")) parts.push(statement);
      current = "";
    }
  }
  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

export async function exec(sql) {
  if (mode === "pglite") {
    await pglite.exec(sql);
    return;
  }
  for (const statement of splitSql(sql)) await pool.query(statement);
}

async function migrate() {
  await exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const dir = path.join(__dirname, "..", "migrations");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const applied = await query(`SELECT version FROM schema_migrations WHERE version = $1`, [version]);
    if (applied[0]) continue;
    await exec(fs.readFileSync(path.join(dir, file), "utf8"));
    await query(`INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`, [version]);
  }
}

export async function query(text, params = []) {
  if (mode === "postgres") {
    const result = await pool.query(text, params);
    return result.rows;
  }
  const result = await pglite.query(text, params);
  return result.rows;
}

export async function tx(fn) {
  if (mode === "postgres") {
    const client = await pool.connect();
    const q = async (text, params = []) => (await client.query(text, params)).rows;
    try {
      await client.query("BEGIN");
      const result = await fn(q);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return pglite.transaction(async (trx) => fn((text, params = []) => trx.query(text, params).then((result) => result.rows)));
}

export async function closeDb() {
  if (pool) await pool.end();
  if (pglite) await pglite.close();
  pool = undefined;
  pglite = undefined;
}

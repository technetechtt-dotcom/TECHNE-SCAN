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
  if (mode === "pglite") await pglite.exec(schema);
  else {
    const statements = schema.split(";").map((part) => part.trim()).filter(Boolean);
    for (const statement of statements) await pool.query(statement);
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

import "dotenv/config";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import pg from "pg";
const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const db = await pool.connect();
try {
  // Prevent concurrent deployment processes from applying the same migration.
  await db.query("SELECT pg_advisory_lock(702426)");
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const directory = new URL("./migrations/", import.meta.url);
  const files = (await fs.readdir(directory)).filter(n => /^\d+.*\.sql$/.test(n)).sort();
  for (const name of files) {
    const sql = await fs.readFile(new URL(name, directory), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    const applied = await db.query("SELECT checksum FROM schema_migrations WHERE name=$1", [name]);
    if (applied.rowCount) {
      if (applied.rows[0].checksum !== checksum) throw new Error(`Already-applied migration changed: ${name}`);
      continue;
    }
    await db.query("BEGIN");
    try {
      await db.query(sql);
      await db.query("INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)", [name, checksum]);
      await db.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await db.query("SELECT pg_advisory_unlock(702426)");
  db.release();
  await pool.end();
}

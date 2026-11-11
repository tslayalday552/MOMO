import "dotenv/config";
import fs from "node:fs/promises";
import pg from "pg";
const { Pool } = pg;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

const sql = await fs.readFile(new URL("./migrations/001_init.sql", import.meta.url), "utf8");
await pool.query(sql);
console.log("Database migration complete.");
await pool.end();

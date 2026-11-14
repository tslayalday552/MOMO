import "dotenv/config";
import pg from "pg";
import { z } from "zod";
import { sendPushToUser } from "./firebase.js";
const userId = process.argv[2];
if (!z.string().uuid().safeParse(userId).success) throw new Error("Usage: node send-push.js POSTGRES_USER_UUID");
if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try { console.log(await sendPushToUser(pool, userId)); }
finally { await pool.end(); }

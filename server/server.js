import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import pg from "pg";
import OpenAI from "openai";
import { z } from "zod";
import { registerFirebaseRoutes } from "./firebase-routes.js";
import { assertMomoUserActive } from "./firebase.js";

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === "production";

for (const key of ["DATABASE_URL", "JWT_SECRET", "OPENAI_API_KEY"]) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}
if (process.env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: isProd ? { rejectUnauthorized: false } : undefined
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 2 });

const origins = (process.env.CORS_ORIGIN || "http://localhost:8080").split(",").map(s => s.trim()).filter(Boolean);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "256kb", verify(req, _res, buffer) { req.rawBody = Buffer.from(buffer); } }));
app.use(cors({
  origin(origin, cb) { if (!origin || origins.includes(origin)) return cb(null, true); cb(new Error("CORS origin not allowed")); },
  credentials: true,
  methods: ["GET","POST","PATCH","DELETE"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  limit: Number(process.env.RATE_LIMIT_MAX || 30),
  standardHeaders: "draft-8",
  legacyHeaders: false
});
app.use("/api", limiter);

const authSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(12).max(200)
});
const messageSchema = z.object({ content: z.string().trim().min(1).max(Number(process.env.MAX_INPUT_CHARS || 20000)) });
const idSchema = z.string().uuid();

function tokenFor(user) {
  return jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });
}
function setAuth(res, token) {
  res.cookie?.("auth", token);
}
function authMiddleware(req, res, next) {
  authFromAccess(req).then(payload => { req.user = payload; next(); })
    .catch(() => res.status(401).json({ error: "Invalid or expired session" }));
}
function authCookie(res, token) {
  res.setHeader("Set-Cookie",
    `auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${isProd ? "; Secure" : ""}`);
}
function clearCookie(res) {
  res.setHeader("Set-Cookie", `auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? "; Secure" : ""}`);
}
function id() { return crypto.randomUUID(); }
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function issueAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, type: "access" }, process.env.JWT_SECRET, {
    expiresIn: process.env.ACCESS_TOKEN_TTL || "15m"
  });
}
async function issueRefreshToken(userId) {
  const raw = crypto.randomBytes(48).toString("base64url");
  const days = Number(process.env.REFRESH_TOKEN_DAYS || 30);
  await pool.query(
    "INSERT INTO refresh_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+($4 || ' days')::interval)",
    [id(), userId, hashToken(raw), String(days)]
  );
  return raw;
}
async function authFromAccess(req) {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearer || req.headers.cookie?.match(/(?:^|; )auth=([^;]+)/)?.[1];
  if (!token) throw new Error("Authentication required");
  const payload = jwt.verify(decodeURIComponent(token), process.env.JWT_SECRET);
  if (payload.type && payload.type !== "access") throw new Error("Invalid access token");
  await assertMomoUserActive(pool, payload.sub, payload.iat);
  return payload;
}

registerFirebaseRoutes(app, { pool, authMiddleware, issueAccessToken, issueRefreshToken, authCookie });

app.get("/health", async (_req,res) => {
  try { await pool.query("SELECT 1"); res.json({ok:true, db:true}); }
  catch { res.status(503).json({ok:false, db:false}); }
});

app.post("/api/auth/signup", async (req,res) => {
  const p = authSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({error:"Use a valid email and a password of at least 12 characters."});
  const {email,password} = p.data;
  const hash = await bcrypt.hash(password, 12);
  try {
    const user = { id:id(), email };
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)", [user.id,email,hash]);
    const accessToken = issueAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id);
    authCookie(res, accessToken);
    res.status(201).json({user, accessToken, refreshToken});
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({error:"An account with that email already exists."});
    console.error(e); res.status(500).json({error:"Could not create account"});
  }
});

app.post("/api/auth/login", async (req,res) => {
  const p = authSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({error:"Invalid credentials"});
  const {email,password} = p.data;
  const r = await pool.query("SELECT id,email,password_hash,firebase_uid FROM users WHERE email=$1", [email]);
  if (!r.rowCount || r.rows[0].firebase_uid || !r.rows[0].password_hash || !(await bcrypt.compare(password,r.rows[0].password_hash)))
    return res.status(401).json({error:"Invalid email or password"});
  const user = {id:r.rows[0].id,email:r.rows[0].email};
  const accessToken = issueAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id);
  authCookie(res, accessToken);
  res.json({user, accessToken, refreshToken});
});

app.post("/api/auth/logout", async (req, res) => {
  const parsed = z.object({ refreshToken: z.string().min(40).max(200).optional() }).strict().safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({error:"Invalid logout request"});
  if (parsed.data.refreshToken) {
    await pool.query(
      "UPDATE refresh_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL",
      [hashToken(parsed.data.refreshToken)]
    );
  }
  clearCookie(res);
  res.json({ok:true});
});

app.post("/api/auth/refresh", async (req,res) => {
  const schema = z.object({refreshToken:z.string().min(40).max(200)});
  const p = schema.safeParse(req.body);
  if (!p.success) return res.status(401).json({error:"Invalid refresh token"});
  const r = await pool.query(
    `SELECT rs.id, rs.user_id, rs.created_at, u.email
     FROM refresh_sessions rs JOIN users u ON u.id=rs.user_id
     WHERE rs.token_hash=$1 AND rs.revoked_at IS NULL AND rs.expires_at>now()`,
    [hashToken(p.data.refreshToken)]
  );
  if (!r.rowCount) return res.status(401).json({error:"Refresh token expired or revoked"});
  try {
    await assertMomoUserActive(pool, r.rows[0].user_id, new Date(r.rows[0].created_at).getTime() / 1000);
  } catch { return res.status(401).json({error:"Account session revoked. Sign in again."}); }
  const oldId = r.rows[0].id;
  await pool.query("UPDATE refresh_sessions SET revoked_at=now() WHERE id=$1", [oldId]);
  const user = {id:r.rows[0].user_id,email:r.rows[0].email};
  const accessToken = issueAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id);
  res.json({accessToken,refreshToken});
});

app.get("/api/me", authMiddleware, async (req,res) => {
  const r = await pool.query("SELECT id,email,created_at FROM users WHERE id=$1", [req.user.sub]);
  if (!r.rowCount) return res.status(401).json({error:"Account not found"});
  res.json({user:r.rows[0]});
});

app.get("/api/conversations", authMiddleware, async (req,res) => {
  const r = await pool.query(
    "SELECT id,title,created_at,updated_at FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100",
    [req.user.sub]
  );
  res.json({conversations:r.rows});
});

app.post("/api/conversations", authMiddleware, async (req,res) => {
  const cid=id();
  const r = await pool.query(
    "INSERT INTO conversations(id,user_id,title) VALUES($1,$2,'New conversation') RETURNING id,title,created_at,updated_at",
    [cid,req.user.sub]
  );
  res.status(201).json({conversation:r.rows[0]});
});

app.get("/api/conversations/:id/messages", authMiddleware, async (req,res) => {
  if (!idSchema.safeParse(req.params.id).success) return res.status(400).json({error:"Invalid conversation id"});
  const r = await pool.query(
    `SELECT m.id,m.role,m.content,m.created_at
     FROM messages m JOIN conversations c ON c.id=m.conversation_id
     WHERE m.conversation_id=$1 AND c.user_id=$2 ORDER BY m.created_at ASC`,
    [req.params.id,req.user.sub]
  );
  res.json({messages:r.rows});
});

app.delete("/api/conversations/:id", authMiddleware, async (req,res) => {
  const r = await pool.query("DELETE FROM conversations WHERE id=$1 AND user_id=$2", [req.params.id,req.user.sub]);
  if (!r.rowCount) return res.status(404).json({error:"Conversation not found"});
  res.status(204).end();
});

app.post("/api/conversations/:id/messages", authMiddleware, async (req,res) => {
  if (!idSchema.safeParse(req.params.id).success) return res.status(400).json({error:"Invalid conversation id"});
  const p = messageSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({error:"Message is invalid or too long"});
  const {content} = p.data;

  const conv = await pool.query("SELECT id,provider_response_id FROM conversations WHERE id=$1 AND user_id=$2",
    [req.params.id,req.user.sub]);
  if (!conv.rowCount) return res.status(404).json({error:"Conversation not found"});

  const userMessageId=id();
  await pool.query("INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$2,'user',$3)",
    [userMessageId,req.params.id,content]);

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
      instructions: "You are a helpful assistant. Be accurate, clear and concise. If uncertain, say so.",
      input: content,
      ...(conv.rows[0].provider_response_id ? {previous_response_id: conv.rows[0].provider_response_id} : {})
    });
    const text = response.output_text || "";
    await pool.query("INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$2,'assistant',$3)",
      [id(),req.params.id,text]);
    await pool.query(
      `UPDATE conversations SET provider_response_id=$1, updated_at=now(),
       title=CASE WHEN title='New conversation' THEN LEFT($2,80) ELSE title END
       WHERE id=$3`,
      [response.id,content,req.params.id]
    );
    res.json({id:response.id,text});
  } catch (e) {
    console.error("AI request failed", {status:e?.status, requestId:e?.request_id});
    res.status(502).json({error:"The AI service could not complete the request."});
  }
});

app.get("/api/billing/entitlements", authMiddleware, async (req,res) => {
  const r = await pool.query(
    `SELECT entitlement_id,expires_at,store,environment,product_id
     FROM entitlements WHERE user_id=$1 AND (expires_at IS NULL OR expires_at>now())`,
    [req.user.sub]
  );
  res.json({entitlements:r.rows});
});

app.post("/api/billing/webhook", express.raw({type:"application/json"}), async (req,res) => {
  const auth = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (auth && req.headers.authorization !== auth) return res.status(401).json({error:"Unauthorized"});
  const raw = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {})));
  const signature = req.headers["x-revenuecat-webhook-signature"];
  const secret = process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET;
  if (secret) {
    if (!signature) return res.status(401).json({error:"Missing signature"});
    const parts = Object.fromEntries(String(signature).split(",").map(p => p.split("=",2)));
    const ts = Number(parts.t), sig = parts.v1;
    if (!ts || !sig || Math.abs(Date.now()/1000-ts)>300) return res.status(401).json({error:"Invalid signature"});
    const expected = crypto.createHmac("sha256",secret).update(`${ts}.${raw.toString()}`).digest("hex");
    if (!/^[0-9a-f]{64}$/i.test(sig) || !crypto.timingSafeEqual(Buffer.from(expected, "hex"),Buffer.from(sig, "hex"))) return res.status(401).json({error:"Invalid signature"});
  }
  let body;
  try { body=JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({error:"Invalid JSON"}); }
  const e=body?.event;
  if (!e?.id || !e?.app_user_id) return res.status(400).json({error:"Invalid webhook"});
  res.status(200).json({received:true});
  try {
    const inserted=await pool.query("INSERT INTO billing_webhook_events(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id",[e.id]);
    if (!inserted.rowCount) return;
    const type=String(e.type||"").toUpperCase();
    const userId=e.app_user_id;
    const ids=Array.isArray(e.entitlement_ids)?e.entitlement_ids:[];
    const expires=e.expiration_at_ms ? new Date(Number(e.expiration_at_ms)) : null;
    if (["INITIAL_PURCHASE","RENEWAL","UNCANCELLATION","PRODUCT_CHANGE","NON_RENEWING_PURCHASE"].includes(type)) {
      for (const ent of ids) await pool.query(
        `INSERT INTO entitlements(user_id,entitlement_id,expires_at,store,environment,product_id)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(user_id,entitlement_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,store=EXCLUDED.store,environment=EXCLUDED.environment,product_id=EXCLUDED.product_id,updated_at=now()`,
        [userId,ent,expires,e.store,e.environment,e.product_id]
      );
    } else if (["EXPIRATION"].includes(type)) {
      for (const ent of ids) await pool.query("DELETE FROM entitlements WHERE user_id=$1 AND entitlement_id=$2",[userId,ent]);
    } else if (type==="TRANSFER") {
      // RevenueCat transfer events can contain transferred_from/to. Leave entitlement
      // reconciliation to the next subscriber sync rather than guessing ownership.
    }
  } catch(err) { console.error("RevenueCat webhook processing failed",err); }
});

app.use((err,_req,res,_next) => {
  if (err.message === "CORS origin not allowed") return res.status(403).json({error:err.message});
  console.error(err); res.status(500).json({error:"Internal server error"});
});

app.listen(port, () => console.log(`Server listening on ${port}`));

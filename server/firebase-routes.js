import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { firebaseAuth } from "./firebase.js";

const exchangeSchema = z.object({
  idToken: z.string().min(100).max(20000),
  // Optional one-time proof of ownership of an OLD MOMO bcrypt account.
  legacyPassword: z.string().min(12).max(200).optional(),
}).strict();
const deviceSchema = z.object({
  token: z.string().min(20).max(4096),
  installationId: z.string().uuid(),
  platform: z.enum(["ios", "android"]),
}).strict();

export function registerFirebaseRoutes(app, {
  pool, authMiddleware, issueAccessToken, issueRefreshToken, authCookie,
}) {
  app.post("/api/auth/firebase", async (req, res) => {
    const parsed = exchangeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid sign-in request" });
    let decoded;
    try {
      // Checks signature, audience, issuer, expiry, revocation AND disabled users.
      decoded = await firebaseAuth.verifyIdToken(parsed.data.idToken, true);
    } catch {
      return res.status(401).json({ error: "Firebase session is invalid or expired" });
    }
    const email = typeof decoded.email === "string" ? decoded.email.trim().toLowerCase() : "";
    if (!email || !z.string().email().max(320).safeParse(email).success || decoded.email_verified !== true) {
      return res.status(403).json({ error: "Verify your email, then sign in again." });
    }

    const db = await pool.connect();
    let user;
    try {
      await db.query("BEGIN");
      const linked = await db.query("SELECT id,email FROM users WHERE firebase_uid=$1 FOR UPDATE", [decoded.uid]);
      if (linked.rowCount) {
        // UID is identity. Do not silently change an existing Postgres email.
        user = linked.rows[0];
      } else {
        const existing = await db.query(
          "SELECT id,email,password_hash,firebase_uid FROM users WHERE email=$1 FOR UPDATE", [email]
        );
        if (existing.rowCount) {
          const old = existing.rows[0];
          // Verified email alone is NOT sufficient to merge accounts.
          if (old.firebase_uid || !old.password_hash || !parsed.data.legacyPassword ||
              !(await bcrypt.compare(parsed.data.legacyPassword, old.password_hash))) {
            await db.query("ROLLBACK");
            return res.status(409).json({
              error: "This email already has a MOMO account. Supply its old MOMO password to link it, or sign in with the already linked Firebase account.",
            });
          }
          await db.query("UPDATE users SET firebase_uid=$1 WHERE id=$2", [decoded.uid, old.id]);
          user = { id: old.id, email: old.email };
        } else {
          const inserted = await db.query(
            "INSERT INTO users(id,email,password_hash,firebase_uid) VALUES($1,$2,NULL,$3) RETURNING id,email",
            [crypto.randomUUID(), email, decoded.uid]
          );
          user = inserted.rows[0];
        }
      }
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      if (error.code === "23505") return res.status(409).json({ error: "Account changed during sign-in. Please try again." });
      throw error;
    } finally {
      db.release();
    }
    const accessToken = issueAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id);
    authCookie(res, accessToken);
    res.json({ user, accessToken, refreshToken });
  });

  app.post("/api/push/devices", authMiddleware, async (req, res) => {
    const parsed = deviceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid device registration" });
    const { token, installationId, platform } = parsed.data;
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      // A rotated token or account switch must leave one owner per device/token.
      await db.query("DELETE FROM push_device_tokens WHERE token=$1 AND installation_id<>$2", [token, installationId]);
      await db.query(
        `INSERT INTO push_device_tokens(installation_id,user_id,token,platform)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(installation_id) DO UPDATE SET
           user_id=EXCLUDED.user_id, token=EXCLUDED.token,
           platform=EXCLUDED.platform, updated_at=now()`,
        [installationId, req.user.sub, token, platform]
      );
      await db.query("COMMIT");
      res.json({ ok: true });
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  });

  app.delete("/api/push/devices", authMiddleware, async (req, res) => {
    const parsed = z.object({ installationId: z.string().uuid() }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid installation" });
    await pool.query("DELETE FROM push_device_tokens WHERE installation_id=$1 AND user_id=$2", [parsed.data.installationId, req.user.sub]);
    res.status(204).end();
  });
}

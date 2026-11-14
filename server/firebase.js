import "dotenv/config";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getMessaging } from "firebase-admin/messaging";

if (!process.env.FIREBASE_PROJECT_ID) throw new Error("Missing FIREBASE_PROJECT_ID");
const firebaseApp = getApps().find(a => a.name === "momo-server") || initializeApp({
  credential: applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID,
}, "momo-server");
export const firebaseAuth = getAuth(firebaseApp);
export const firebaseMessaging = getMessaging(firebaseApp);

// Server-only helper. Never accept an arbitrary userId from an unprivileged client.
// Deliberately omit chat text, email, conversation titles, and identifiers.
export async function sendPushToUser(pool, userId) {
  const { rows } = await pool.query(
    "SELECT token FROM push_device_tokens WHERE user_id=$1 AND updated_at>now()-interval '90 days'",
    [userId]
  );
  let successCount = 0;
  let failureCount = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const tokens = rows.slice(i, i + 500).map(row => row.token);
    const result = await firebaseMessaging.sendEachForMulticast({
      tokens,
      notification: { title: "MOMO", body: "Open MOMO for an update." },
      data: { kind: "account_update" },
      android: { priority: "normal" },
      apns: { payload: { aps: { sound: "default" } } },
    });
    successCount += result.successCount;
    failureCount += result.failureCount;
    for (let j = 0; j < result.responses.length; j++) {
      const code = result.responses[j].error?.code;
      if (["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(code)) {
        await pool.query("DELETE FROM push_device_tokens WHERE token=$1 AND user_id=$2", [tokens[j], userId]);
      }
    }
  }
  return { successCount, failureCount };
}

// Keep Firebase disable/delete/revoke actions effective for existing MOMO sessions.
// This simple version checks Firebase on every authorized request; budget for latency.
export async function assertMomoUserActive(pool, userId, issuedAtSeconds) {
  if (!Number.isFinite(Number(issuedAtSeconds))) throw new Error("Invalid session timestamp");
  const result = await pool.query("SELECT firebase_uid FROM users WHERE id=$1", [userId]);
  if (!result.rowCount) throw new Error("Account not found");
  if (!result.rows[0].firebase_uid) return; // Unmigrated bcrypt account.
  const user = await firebaseAuth.getUser(result.rows[0].firebase_uid);
  if (user.disabled) throw new Error("Account disabled");
  const validAfterSeconds = Date.parse(user.tokensValidAfterTime) / 1000;
  if (Number(issuedAtSeconds) < validAfterSeconds) throw new Error("Session revoked");
}

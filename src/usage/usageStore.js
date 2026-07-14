// src/usage/usageStore.js
import { dayKeyLA } from "../db/db.js";

export function parseOwner(userId, isAuthed) {
  if (isAuthed) return { ownerType: "user", ownerKey: userId };
  const ownerKey = String(userId).startsWith("trial:") ? userId.slice(6) : userId;
  return { ownerType: "trial", ownerKey };
}

export async function getUsageRow(db, ownerType, ownerKey) {
  const day = dayKeyLA();
  const row = await db.get(
    `SELECT tokens_used, requests
       FROM usage_daily
      WHERE owner_type=? AND owner_key=? AND day_key=?`,
    [ownerType, ownerKey, day]
  );

  return row || { tokens_used: 0, requests: 0 };
}

export async function addUsage(db, ownerType, ownerKey, addTokens, addRequests = 0) {
  const day = dayKeyLA();
  const now = Date.now();

  await db.run(
    `
    INSERT INTO usage_daily (owner_type, owner_key, day_key, tokens_used, requests, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_type, owner_key, day_key)
    DO UPDATE SET
      tokens_used = tokens_used + excluded.tokens_used,
      requests = requests + excluded.requests,
      updated_at = excluded.updated_at
    `,
    [ownerType, ownerKey, day, addTokens, addRequests, now]
  );
}

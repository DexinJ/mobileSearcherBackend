// src/utils/rateLimit.js
const startBuckets = new Map();

/**
 * Simple in-memory rate limit bucket.
 * key: string
 * limit: { windowMs: number, max: number }
 */
export function rateLimitStart(key, limit) {
  const now = Date.now();
  const bucket = startBuckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    startBuckets.set(key, { count: 1, resetAt: now + limit.windowMs });
    return { ok: true };
  }

  if (bucket.count >= limit.max) {
    return { ok: false, retryAfterMs: bucket.resetAt - now };
  }

  bucket.count += 1;
  return { ok: true };
}

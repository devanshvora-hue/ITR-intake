// Fixed-window abuse limits stored in the database (ported from app.py
// `_within_limit` / `_limit_reached`). Buckets hold a hash of the key, never
// an address or e-mail.

import type { Db } from "./db";
import { sha256Hex } from "./ids";

export const HOUR = 3600;

export function rateWindow(name: string, key: string, windowSeconds: number, now: Date = new Date()) {
  const epoch = Math.floor(now.getTime() / 1000);
  const start = new Date((epoch - (epoch % windowSeconds)) * 1000);
  return { bucket: `${name}:${sha256Hex(key).slice(0, 32)}`, start };
}

/** True if the counter is already at `limit` in this window (does not count a hit). */
export async function limitReached(db: Db, name: string, key: string, limit: number, windowSeconds: number,
                                   now?: Date): Promise<boolean> {
  const { bucket, start } = rateWindow(name, key, windowSeconds, now);
  const rows = await db.query<{ count: number }>(
    "SELECT count FROM rate_limits WHERE bucket = $1 AND window_start = $2", [bucket, start]);
  return (rows[0]?.count ?? 0) >= limit;
}

/** Count one hit; false once `limit` is exceeded in the current window. */
export async function withinLimit(db: Db, name: string, key: string, limit: number, windowSeconds: number,
                                  now: Date = new Date()): Promise<boolean> {
  const { bucket, start } = rateWindow(name, key, windowSeconds, now);
  const rows = await db.query<{ count: number }>(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`, [bucket, start]);
  const count = rows[0].count;
  if (count === 1) {
    // A new counter: drop windows from before the previous day.
    await db.query("DELETE FROM rate_limits WHERE window_start < $1", [new Date(now.getTime() - 86_400_000)]);
  }
  return count <= limit;
}

/** Count a hit on every limit (no short-circuit) and report whether all allow it. */
export async function withinAll(db: Db, checks: [name: string, key: string, limit: number, windowSeconds: number][],
                                now?: Date): Promise<boolean> {
  const results = [];
  for (const [name, key, limit, windowSeconds] of checks) {
    results.push(await withinLimit(db, name, key, limit, windowSeconds, now));
  }
  return results.every(Boolean);
}

/**
 * Order ID generator — PRD §8.2.
 * Format CTW-YYMMDD-nn. Daily counter via Redis INCR on oid:YYMMDD (race-safe).
 */

import { getRedis } from "./redisClient.js";

const COUNTER_TTL_SECONDS = 48 * 60 * 60;

function todayYYMMDD(): string {
  const now = new Date();
  const yy = String(now.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/** Assigns the next order id for today, e.g. CTW-250614-03. */
export async function nextOrderId(): Promise<string> {
  const redis = getRedis();
  const dateKey = todayYYMMDD();
  const counterKey = `oid:${dateKey}`;
  // INCR + EXPIRE in one round-trip. The TTL is refreshed each time so the
  // counter survives just past midnight if needed.
  const pipeline = (redis as unknown as {
    pipeline(): {
      incr(key: string): unknown;
      expire(key: string, seconds: number): unknown;
      exec<T extends unknown[]>(): Promise<T>;
    };
  }).pipeline();
  pipeline.incr(counterKey);
  pipeline.expire(counterKey, COUNTER_TTL_SECONDS);
  const [n] = await pipeline.exec<[number, unknown]>();
  const seq = String(n).padStart(2, "0");
  return `CTW-${dateKey}-${seq}`;
}

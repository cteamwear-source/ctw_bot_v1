import { getRedis } from "../session/redisClient.js";
import crypto from "node:crypto";

export const ORDER_APPROVAL_TTL_SECONDS = 30 * 60; // 30 minutes
export const MOCKUP_APPROVAL_TTL_SECONDS = 120; // 2 minutes

export interface PendingApproval {
  type: "order" | "mockup";
  id: string; // orderId or generationId
  code: string;
  adminChatId?: string;
  createdAt: number;
}

function codeKey(code: string): string {
  return `admin:approval:code:${code}`;
}

function entityKey(type: "order" | "mockup", id: string): string {
  return `admin:approval:entity:${type}:${id}`;
}

function cooldownKey(type: "order" | "mockup", id: string): string {
  return `admin:approval:cooldown:${type}:${id}`;
}

function attemptsKey(type: "order" | "mockup", id: string): string {
  return `admin:approval:attempts:${type}:${id}`;
}

/**
 * Wrong guesses allowed against one active code before it is burned. A
 * 6-digit code has 10^6 values; with 5 guesses per code (and a 30s resend
 * cooldown) brute force over the code's 30-minute life is impractical.
 */
export const MAX_FAILED_CODE_ATTEMPTS = 5;

/** Fresh codes that can be requested per entity per 24h. */
export const MAX_RESENDS_PER_DAY = 10;

function resendCountKey(type: "order" | "mockup", id: string): string {
  return `admin:approval:resends:${type}:${id}`;
}

/**
 * Generates a cryptographically random 6-digit approval code valid for 30 minutes (orders) or 2 mins (mockups).
 * Associates both code -> entity and entity -> code in Redis.
 */
export async function createApprovalCode(
  type: "order" | "mockup",
  id: string,
  adminChatId?: string,
  ttlSeconds = type === "order" ? ORDER_APPROVAL_TTL_SECONDS : MOCKUP_APPROVAL_TTL_SECONDS,
): Promise<string> {
  const redis = getRedis();

  // Clear any existing pending code for this entity
  const existingCode = await redis.get<string>(entityKey(type, id));
  if (existingCode) {
    await redis.del(codeKey(existingCode));
  }

  // Generate 6 digit numeric string
  const num = crypto.randomInt(100000, 1000000);
  const code = String(num);

  const pending: PendingApproval = {
    type,
    id,
    code,
    adminChatId,
    createdAt: Date.now(),
  };

  await redis.set(codeKey(code), pending, { ex: ttlSeconds });
  await redis.set(entityKey(type, id), code, { ex: ttlSeconds });
  await redis.del(attemptsKey(type, id));

  return code;
}

export type EntityCodeResult = "ok" | "invalid" | "locked";

/**
 * Verifies a code against ONE specific entity (e.g. the order whose portal
 * page submitted it) and consumes it on success. Unlike the global
 * verifyAndConsumeApprovalCode lookup, a guess can never match or burn
 * another order's code. Every wrong guess is counted; after
 * MAX_FAILED_CODE_ATTEMPTS the active code is deleted ("locked") and a new
 * one must be requested.
 */
export async function verifyAndConsumeApprovalCodeFor(
  type: "order" | "mockup",
  id: string,
  code: string,
): Promise<EntityCodeResult> {
  const cleanCode = code.trim();
  const redis = getRedis();
  const active = await redis.get<string | number>(entityKey(type, id));
  if (active === null || active === undefined) return "invalid";
  const activeCode = String(active);

  const aKey = attemptsKey(type, id);
  const attempts = await redis.incr(aKey);
  if (attempts === 1) {
    await redis.expire(aKey, type === "order" ? ORDER_APPROVAL_TTL_SECONDS : MOCKUP_APPROVAL_TTL_SECONDS);
  }

  const matches =
    /^\d{6}$/.test(cleanCode) &&
    cleanCode.length === activeCode.length &&
    crypto.timingSafeEqual(Buffer.from(cleanCode), Buffer.from(activeCode));

  if (matches && attempts <= MAX_FAILED_CODE_ATTEMPTS) {
    await redis.del(codeKey(activeCode), entityKey(type, id), aKey);
    return "ok";
  }

  if (attempts >= MAX_FAILED_CODE_ATTEMPTS) {
    // Burn the code: further guesses (even a correct one) are useless.
    await redis.del(codeKey(activeCode), entityKey(type, id));
    return "locked";
  }
  return "invalid";
}

/**
 * Generates a secondary/fresh OTP code with rate-limit cooldown (30s) to prevent spam.
 */
export async function resendApprovalCode(
  type: "order" | "mockup",
  id: string,
): Promise<{ ok: boolean; code?: string; cooldownRemaining?: number; limitReached?: boolean }> {
  const redis = getRedis();
  const cKey = cooldownKey(type, id);

  const inCooldown = await redis.get<string>(cKey);
  if (inCooldown) {
    const ttl = typeof (redis as any).ttl === "function" ? await (redis as any).ttl(cKey) : 30;
    return { ok: false, cooldownRemaining: Math.max(1, ttl) };
  }

  // Daily cap: each fresh code grants MAX_FAILED_CODE_ATTEMPTS new guesses,
  // so unlimited resends would re-open brute force.
  const rKey = resendCountKey(type, id);
  const resends = await redis.incr(rKey);
  if (resends === 1) await redis.expire(rKey, 24 * 60 * 60);
  if (resends > MAX_RESENDS_PER_DAY) {
    return { ok: false, limitReached: true };
  }

  // Set 30 second cooldown
  await redis.set(cKey, "1", { ex: 30 });

  const code = await createApprovalCode(type, id);
  return { ok: true, code };
}

/**
 * Validates and consumes the 6-digit approval code.
 * Returns the PendingApproval record if valid and not expired, null otherwise.
 */
export async function verifyAndConsumeApprovalCode(code: string): Promise<PendingApproval | null> {
  const cleanCode = code.trim();
  if (!/^\d{6}$/.test(cleanCode)) return null;

  const redis = getRedis();
  const cKey = codeKey(cleanCode);
  const data = await redis.get<PendingApproval | string>(cKey);
  if (!data) return null;

  const pending: PendingApproval = typeof data === "string" ? JSON.parse(data) : data;

  // Consume code immediately so it cannot be reused
  await redis.del(cKey);
  await redis.del(entityKey(pending.type, pending.id));

  return pending;
}

/**
 * Gets currently active approval code for an entity, if any.
 */
export async function getActiveApprovalCode(type: "order" | "mockup", id: string): Promise<string | null> {
  const redis = getRedis();
  return redis.get<string>(entityKey(type, id));
}

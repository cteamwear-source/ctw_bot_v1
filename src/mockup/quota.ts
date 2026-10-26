/**
 * Monthly free-mockup quota — commit-on-success model.
 *
 * RULES:
 *  - Each chat gets MOCKUP_FREE_PER_MONTH (default 3) FREE mockup
 *    generations per Asia/Kolkata calendar month.
 *  - A generation is a whole REQUEST, not an image: a front+back request
 *    counts as ONE generation regardless of how many views it produces.
 *  - Generation #4 onward in the same Kolkata month costs
 *    MOCKUP_PAID_PRICE_INR (default ₹20) each.
 *
 * WHY COMMIT-ON-SUCCESS (not on reservation):
 *  A free slot must only be "used up" once a generation SUCCEEDS. An
 *  internal generation failure must release the slot so the customer isn't
 *  silently charged/blocked for our error. So:
 *    - reserveGeneration() only DECIDES free-vs-paid (sticky per
 *      generationId) — it does NOT consume a slot.
 *    - commitFreeGeneration() is called on SUCCESS of a free generation and
 *      is what actually consumes the slot (idempotent per generationId).
 *    - releaseReservation() is called on internal FAILURE. For a free
 *      generation nothing was committed, so the slot is naturally free
 *      again; the sticky decision is preserved so a retry with the SAME
 *      generationId stays free and never re-charges.
 *
 * PAID STICKINESS:
 *  A paid decision is sticky per generationId, so a retry after an internal
 *  failure reuses the same decision and never asks for or charges another
 *  ₹20. releaseReservation() never downgrades a paid decision.
 *
 * CB-07 (cross-generation race):
 *  The read → decide → record window inside reserveGeneration is serialized
 *  per quota bucket with a short Redis SET NX PX lock (see quotaLockKey /
 *  acquireBucketLock). Without it, two concurrent reservations for the same
 *  bucket (two chats sharing a phone, or the fast in-process leg racing the
 *  background worker) could both read the committed counter before either
 *  decision landed and BOTH be decided free — double-spending the monthly
 *  allowance. The lock only serializes DECISIONS; commit-on-success and the
 *  no-consume-on-reservation model are unchanged.
 *
 * The Kolkata month boundary is computed by shifting UTC by +5:30 (India
 * has no DST) — enough to bucket a timestamp into the right local month.
 */

import { getRedis } from "../session/redisClient.js";
import { getEnv } from "../config/env.js";
import { computeMockupFee } from "../pricing/index.js";
import type { MockupView } from "../shared/types.js";

const IST_OFFSET_MINUTES = 5 * 60 + 30; // Asia/Kolkata is a fixed +05:30, no DST
const MONTH_TTL_SECONDS = 40 * 24 * 60 * 60; // > 1 month so the counter survives the whole billing month

// CB-07: per-bucket decision lock (mockupquota:lock:*) — SET NX PX with a
// short TTL so a crashed holder self-heals, briefly retried, fail-open.
const LOCK_TTL_MS = 8_000; // short: a crashed holder self-heals via TTL
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_MAX_ATTEMPTS = 20; // ~500ms of brief retries before failing open

/** Returns the Asia/Kolkata calendar-month key (YYYY-MM) for a given instant. */
export function kolkataMonthKey(at: Date = new Date()): string {
  const shifted = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

/** Extracts clean 10-digit Indian phone number for quota lookup. */
export function normalizePhoneForQuota(phone?: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits || null;
}

/** Numeric chat id from a "tg:<id>" prefixed field, or the raw string as a fallback bucket. */
function chatBucket(customerChatId: string): string {
  const match = /^tg:(\d+)$/.exec(customerChatId);
  return match ? match[1] : customerChatId;
}

/**
 * Counter key: phone-based if phone provided, otherwise per-chat — BOTH are
 * month-keyed so the free allowance resets at the Asia/Kolkata month
 * boundary.
 *
 * CB-06: the phone key previously had NO month component
 * (`mockupquota:phone:<last10>`, 1-year rolling TTL refreshed on every
 * INCR), which made the "monthly" free allowance behave like an annual
 * per-phone allowance for active customers. Old-format keys are simply
 * orphaned by this change (their counters reset to zero for the current
 * month) — no migration, no paid record is lost.
 */
function quotaCounterKey(bucket: string, monthKey: string, phone?: string): string {
  const clean = normalizePhoneForQuota(phone);
  return clean
    ? `mockupquota:phone:${clean}:${monthKey}`
    : `mockupquota:freecommitted:${bucket}:${monthKey}`;
}

/**
 * Bucket lock key (CB-07): mirrors quotaCounterKey's identity — phone-backed
 * when a phone is present, else per-chat — so every request that could touch
 * the SAME counter serializes on the SAME lock (two chats sharing a phone
 * included).
 */
export function quotaLockKey(bucket: string, monthKey: string, phone?: string): string {
  const clean = normalizePhoneForQuota(phone);
  return clean
    ? `mockupquota:lock:phone:${clean}:${monthKey}`
    : `mockupquota:lock:${bucket}:${monthKey}`;
}

/**
 * Acquires the per-bucket decision lock (CB-07) via SET NX PX. Briefly
 * retries; if the lock stays contended (e.g. a crashed holder holding it
 * until the PX TTL elapses) we FAIL OPEN after the retry budget rather than
 * breaking the customer flow — the worst case degrades to the old unlocked
 * behaviour for that one request, which is strictly better than wedging
 * every reservation for the bucket.
 */
async function acquireBucketLock(
  redis: ReturnType<typeof getRedis>,
  lockKey: string,
  generationId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    const ok = await redis.set(lockKey, generationId, { nx: true, px: LOCK_TTL_MS });
    if (ok === "OK") return true;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
  }
  return false;
}

/** Sticky free-vs-paid decision for a single generationId. */
function decisionKey(generationId: string): string {
  return `mockupquota:decision:${generationId}`;
}

/** Marker that a generationId's free slot has already been committed (idempotency). */
function committedMarkerKey(generationId: string): string {
  return `mockupquota:committed:${generationId}`;
}

export interface QuotaReservation {
  /** True when this generation is within the free monthly allowance. */
  free: boolean;
  /** Whole-rupee charge (0 when free). */
  amountInr: number;
  /** The Kolkata month this reservation is bucketed into. */
  monthKey: string;
  /** Committed (successful) free generations this month at decision time. */
  committedFreeThisMonth: number;
  /** Free allowance for the month. */
  freeAllowance: number;
}

export interface ReserveOptions {
  phone?: string;
  views?: MockupView[];
  at?: Date;
}

export interface CommitOptions {
  phone?: string;
  at?: Date;
}

/**
 * DECIDES whether a generation is free or paid, sticky per generationId.
 * Does NOT consume a slot — the slot is only consumed on success via
 * commitFreeGeneration(). Idempotent: a repeat call for the same
 * generationId replays the identical decision (so retries never flip
 * free↔paid or re-charge). CB-07: the read→decide→record window is
 * serialized per quota bucket with a short NX/PX lock so concurrent
 * reservations for the same bucket can't double-spend the free allowance.
 */
export async function reserveGeneration(
  customerChatId: string,
  generationId: string,
  optionsOrDate?: ReserveOptions | Date,
): Promise<QuotaReservation> {
  const at = optionsOrDate instanceof Date ? optionsOrDate : optionsOrDate?.at ?? new Date();
  const phone = optionsOrDate instanceof Date ? undefined : optionsOrDate?.phone;
  const views = optionsOrDate instanceof Date ? undefined : optionsOrDate?.views;

  const redis = getRedis();
  const env = getEnv();
  const freeAllowance = env.MOCKUP_FREE_PER_MONTH;
  const priceInr = computeMockupFee(views);
  const monthKey = kolkataMonthKey(at);
  const bucket = chatBucket(customerChatId);
  const counterKey = quotaCounterKey(bucket, monthKey, phone);

  // Sticky decision: replay if this generationId was already decided.
  const existing = await redis.get<QuotaReservation>(decisionKey(generationId));
  if (existing) return existing;

  // CB-07: serialize the read → decide → record window per quota bucket so
  // two concurrent reservations for the same bucket can't both read the
  // committed counter before either decision lands (free double-spend).
  // The sticky replay above already returned for decided generationIds, so
  // only NEW decisions take the lock.
  const lockKey = quotaLockKey(bucket, monthKey, phone);
  const lockAcquired = await acquireBucketLock(redis, lockKey, generationId);

  try {
    // Double-checked sticky decision (CB-07): a concurrent reservation with
    // the SAME generationId may have decided while we waited for the lock —
    // replay its decision verbatim instead of deciding again.
    const decided = await redis.get<QuotaReservation>(decisionKey(generationId));
    if (decided) return decided;

    const committedRaw = await redis.get<number>(counterKey);
    const committedFreeThisMonth = typeof committedRaw === "number" ? committedRaw : 0;

    const free = committedFreeThisMonth < freeAllowance;
    const reservation: QuotaReservation = {
      free,
      amountInr: free ? 0 : priceInr,
      monthKey,
      committedFreeThisMonth,
      freeAllowance,
    };

    // Persist the sticky decision. TTL covers the whole month + retry window.
    await redis.set(decisionKey(generationId), reservation, { ex: MONTH_TTL_SECONDS });
    return reservation;
  } finally {
    if (lockAcquired) {
      // Release the bucket lock. RedisLike has no compare-and-delete, so this
      // DEL is unconditional: if the decision somehow outlived the short PX
      // TTL and another request re-acquired the lock, we could release theirs
      // early — that merely degrades to the old unlocked race for that one
      // request and is still strictly better than never locking. A DEL
      // failure is harmless anyway (the PX TTL cleans the key up).
      await redis.del(lockKey).catch(() => {});
    }
  }
}

/**
 * Consumes the free slot for a SUCCESSFUL free generation. Idempotent per
 * generationId (guarded by a committed marker) so a duplicate success
 * callback / re-run never double-counts. No-op for paid generations.
 */
export async function commitFreeGeneration(
  customerChatId: string,
  generationId: string,
  optionsOrDate?: CommitOptions | Date,
): Promise<void> {
  const at = optionsOrDate instanceof Date ? optionsOrDate : optionsOrDate?.at ?? new Date();
  const phone = optionsOrDate instanceof Date ? undefined : optionsOrDate?.phone;

  const redis = getRedis();
  const decision = await redis.get<QuotaReservation>(decisionKey(generationId));
  if (!decision || !decision.free) return; // only free generations consume a free slot

  // Idempotency: only the first commit for this generationId increments.
  const claimed = await redis.set(committedMarkerKey(generationId), "1", {
    nx: true,
    ex: MONTH_TTL_SECONDS,
  });
  if (claimed !== "OK") return;

  const bucket = chatBucket(customerChatId);
  const monthKey = decision.monthKey || kolkataMonthKey(at);
  const counterKey = quotaCounterKey(bucket, monthKey, phone);
  await redis.incr(counterKey);
  // Both counter variants are month-keyed (CB-06), so one TTL covers both.
  await redis.expire(counterKey, MONTH_TTL_SECONDS);
}

/**
 * Releases a reservation after an internal FAILURE.
 *  - Free generation: nothing was ever committed, so the slot is already
 *    free. We keep the sticky free decision so a retry with the same
 *    generationId stays free (and a brand-new request also stays free
 *    because the committed counter never moved).
 *  - Paid generation: intentionally NOT downgraded — the ₹20 decision is
 *    sticky so a retry never re-charges. (If the customer's proof was
 *    accepted, the charge stands regardless of our generation retries.)
 *
 * This function exists mainly as the explicit, documented failure hook and
 * for symmetry; the commit-on-success model means a failed FREE generation
 * requires no counter mutation to be "released".
 */
export async function releaseReservation(_generationId: string): Promise<void> {
  // No-op by construction: nothing is consumed until commit-on-success.
  // Kept as the named hook the failure path calls so the intent is explicit
  // and future storage models can plug real release logic here.
  return;
}

/**
 * Reads current committed free usage for a chat this month WITHOUT
 * deciding/committing. Useful for telling the customer whether their next
 * generation is free.
 */
export async function peekUsage(
  customerChatId: string,
  optionsOrDate?: { phone?: string; at?: Date } | Date,
): Promise<{ committedFreeThisMonth: number; freeAllowance: number; nextIsFree: boolean; monthKey: string; priceInr: number }> {
  const at = optionsOrDate instanceof Date ? optionsOrDate : optionsOrDate?.at ?? new Date();
  const phone = optionsOrDate instanceof Date ? undefined : optionsOrDate?.phone;
  const redis = getRedis();
  const env = getEnv();
  const monthKey = kolkataMonthKey(at);
  const bucket = chatBucket(customerChatId);
  const counterKey = quotaCounterKey(bucket, monthKey, phone);
  const raw = await redis.get<number>(counterKey);
  const committedFreeThisMonth = typeof raw === "number" ? raw : 0;
  return {
    committedFreeThisMonth,
    freeAllowance: env.MOCKUP_FREE_PER_MONTH,
    nextIsFree: committedFreeThisMonth < env.MOCKUP_FREE_PER_MONTH,
    monthKey,
    priceInr: computeMockupFee(),
  };
}

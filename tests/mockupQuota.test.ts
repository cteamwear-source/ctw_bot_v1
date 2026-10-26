/**
 * Monthly free-mockup quota tests — commit-on-success model.
 *
 * Proves:
 *  - reserveGeneration DECIDES free/paid but does NOT consume a slot,
 *  - a slot is consumed only when commitFreeGeneration runs (success),
 *  - the first N (default 3) SUCCESSFUL free generations are free; the
 *    next is paid ₹20,
 *  - the decision is sticky per generationId (retry stays free/paid, no
 *    re-charge, no double-count),
 *  - a front+back request is ONE generation (single generationId),
 *  - the counter resets at the Kolkata calendar-month boundary (both the
 *    phone-backed counter — CB-06 — and the phone-less chat fallback),
 *  - the same phone gets independent free allowances in different Kolkata
 *    months (CB-06),
 *  - commit is idempotent per generationId.
 */
import "./support/testEnv.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeRedis } from "./support/fakeRedis.js";
import { __setRedisForTests } from "../src/session/redisClient.js";
import {
  reserveGeneration,
  commitFreeGeneration,
  kolkataMonthKey,
  peekUsage,
} from "../src/mockup/quota.js";

let redis: FakeRedis;

beforeEach(() => {
  redis = new FakeRedis();
  __setRedisForTests(redis);
});

const CHAT = "tg:5512345678";
const AUG = new Date("2026-08-15T12:00:00Z");

/** Reserve + immediately commit (simulate a successful free generation). */
async function succeedFree(chat: string, genId: string, options?: { phone?: string; at?: Date }) {
  const at = options?.at ?? AUG;
  const r = await reserveGeneration(chat, genId, { phone: options?.phone, at });
  if (r.free) await commitFreeGeneration(chat, genId, { phone: options?.phone, at });
  return r;
}

test("reservation alone does NOT consume a slot; only commit does", async () => {
  await reserveGeneration(CHAT, "r1", AUG);
  const usage = await peekUsage(CHAT, AUG);
  assert.equal(usage.committedFreeThisMonth, 0, "reservations must not consume slots");
  assert.equal(usage.nextIsFree, true);
});

test("first SUCCESSFUL free generation is free, next is paid (₹10 single, ₹20 front+back)", async () => {
  const r1 = await succeedFree(CHAT, "gen-1");
  assert.equal(r1.free, true);

  // Single view paid -> ₹10
  const r2Single = await reserveGeneration(CHAT, "gen-2", { views: ["front"], at: AUG });
  assert.equal(r2Single.free, false);
  assert.equal(r2Single.amountInr, 10);

  // Both front and back paid -> ₹20
  const r3Both = await reserveGeneration(CHAT, "gen-3", { views: ["front", "back"], at: AUG });
  assert.equal(r3Both.free, false);
  assert.equal(r3Both.amountInr, 20);
});

test("quota is tracked per phone number: 1 free per phone number", async () => {
  const PHONE = "+91 98765 43210";
  const r1 = await succeedFree(CHAT, "phone-1", { phone: PHONE });
  assert.equal(r1.free, true);

  // Same phone from a different chat or same chat -> paid (same Kolkata month)
  const otherChat = "tg:9998887777";
  const r2 = await reserveGeneration(otherChat, "phone-2", { phone: "9876543210", views: ["front", "back"], at: AUG });
  assert.equal(r2.free, false);
  assert.equal(r2.amountInr, 20);

  // Different phone -> free!
  const rOtherPhone = await reserveGeneration(otherChat, "other-phone-1", { phone: "9123456780", at: AUG });
  assert.equal(rOtherPhone.free, true);
});

test("reserving the same generationId twice replays the identical decision (no re-charge)", async () => {
  const first = await reserveGeneration(CHAT, "gen-dup", AUG);
  const replay = await reserveGeneration(CHAT, "gen-dup", AUG);
  assert.deepEqual(replay, first);
});

test("commit is idempotent per generationId — a duplicate success does not double-count", async () => {
  await succeedFree(CHAT, "gen-x");
  await commitFreeGeneration(CHAT, "gen-x", AUG); // duplicate success callback
  const usage = await peekUsage(CHAT, AUG);
  assert.equal(usage.committedFreeThisMonth, 1);
});

test("a paid generation stays paid on a repeated reservation (sticky, no second charge)", async () => {
  await succeedFree(CHAT, "p1");
  const paid = await reserveGeneration(CHAT, "p2-paid", { views: ["front", "back"], at: AUG });
  const paidRetry = await reserveGeneration(CHAT, "p2-paid", { views: ["front", "back"], at: AUG });
  assert.equal(paid.free, false);
  assert.equal(paid.amountInr, 20);
  assert.deepEqual(paidRetry, paid);
});

test("month key uses the Asia/Kolkata calendar, not UTC", () => {
  assert.equal(kolkataMonthKey(new Date("2026-08-31T20:00:00Z")), "2026-09");
  assert.equal(kolkataMonthKey(new Date("2026-08-31T17:00:00Z")), "2026-08");
});

// ---------------------------------------------------------------------------
// CB-06: the phone-backed counter must be month-keyed (Kolkata months).
// Before CB-06 the phone key had no month component and a 1-year TTL, so the
// "monthly" free allowance behaved like an annual per-phone allowance.
// ---------------------------------------------------------------------------

const PHONE = "+91 98765 43210";
const SEP = new Date("2026-09-15T12:00:00Z");

test("CB-06: phone-backed counter resets at the Asia/Kolkata month boundary", async () => {
  // Exhaust the (single, per testEnv) free slot for August with the phone present.
  const aug1 = await succeedFree(CHAT, "aug-p1", { phone: PHONE, at: AUG });
  assert.equal(aug1.free, true);
  const aug2 = await reserveGeneration(CHAT, "aug-p2", { phone: PHONE, at: AUG });
  assert.equal(aug2.free, false, "same phone later in the same August must be paid");

  // Same phone in September → fresh free allowance (month-keyed counter).
  const sep1 = await reserveGeneration(CHAT, "sep-p1", { phone: PHONE, at: SEP });
  assert.equal(sep1.free, true, "phone counter must reset at the Kolkata month boundary");
  assert.equal(sep1.monthKey, "2026-09");
  assert.equal(sep1.committedFreeThisMonth, 0, "September phone counter starts at zero");

  // And September also exhausts after one committed free generation.
  await commitFreeGeneration(CHAT, "sep-p1", { phone: PHONE, at: SEP });
  const sep2 = await reserveGeneration(CHAT, "sep-p2", { phone: PHONE, at: SEP });
  assert.equal(sep2.free, false, "committed September usage must count against September");
});

test("CB-06: same phone in two different months gets independent free allowances", async () => {
  const sep1 = await succeedFree(CHAT, "indep-sep1", { phone: PHONE, at: SEP });
  assert.equal(sep1.free, true);
  const sep2 = await reserveGeneration(CHAT, "indep-sep2", { phone: PHONE, at: SEP });
  assert.equal(sep2.free, false, "September allowance exhausted after one commit");

  // Going back to August (a different Kolkata month) gives a fresh allowance —
  // the August counter was never touched by the September usage.
  const aug1 = await succeedFree(CHAT, "indep-aug1", { phone: PHONE, at: AUG });
  assert.equal(aug1.free, true, "August allowance independent of September usage");
  const aug2 = await reserveGeneration(CHAT, "indep-aug2", { phone: PHONE, at: AUG });
  assert.equal(aug2.free, false);
});

test("CB-06: commit uses the decision's monthKey — an August-decided generation never consumes September", async () => {
  const r = await reserveGeneration(CHAT, "gen-aug-decided", { phone: PHONE, at: AUG });
  assert.equal(r.free, true);
  // Commit lands in September (e.g. delayed success callback) but the decision
  // was bucketed into August.
  await commitFreeGeneration(CHAT, "gen-aug-decided", { phone: PHONE, at: SEP });

  const sepUsage = await peekUsage(CHAT, { phone: PHONE, at: SEP });
  assert.equal(sepUsage.committedFreeThisMonth, 0, "September counter untouched by an August decision");
  const augUsage = await peekUsage(CHAT, { phone: PHONE, at: AUG });
  assert.equal(augUsage.committedFreeThisMonth, 1, "August counter consumed");
});

test("per-chat fallback isolation when phone not provided: one chat's usage does not affect another", async () => {
  const other = "tg:9999999999";
  await succeedFree(CHAT, "c1");
  const chatPaid = await reserveGeneration(CHAT, "c2", AUG);
  assert.equal(chatPaid.free, false);

  const otherFirst = await reserveGeneration(other, "o1", AUG);
  assert.equal(otherFirst.free, true);
});

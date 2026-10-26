/**
 * Launch security audit (2026-10-26) regression tests:
 *  - webhook POST authentication (HMAC / URL token / fail-closed in prod) + size cap
 *  - heartbeat fails closed in production without CRON_SECRET
 *  - sheet sanitizer can't be bypassed with leading whitespace
 *  - mockup free quota is charged per WhatsApp sender, not only typed phone
 *  - portal approval codes: per-order match, failed-attempt lockout, resend cap
 *  - triggerMockupDelivery never generates in-process (quota bypass)
 *  - admin notices never log approval codes / portal tokens
 */

import "./support/testEnv.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeRedis } from "./support/fakeRedis.js";
import { __setRedisForTests } from "../src/session/redisClient.js";
import { __resetEnvForTests } from "../src/config/env.js";
import webhookHandler from "../api/webhook.js";
import heartbeatHandler from "../api/heartbeat.js";
import { sanitizeName, sanitizeCity } from "../src/shared/sanitize.js";
import { reserveGeneration, commitFreeGeneration, peekUsage } from "../src/mockup/quota.js";
import {
  createApprovalCode,
  verifyAndConsumeApprovalCodeFor,
  resendApprovalCode,
  MAX_FAILED_CODE_ATTEMPTS,
  MAX_RESENDS_PER_DAY,
} from "../src/admin/approvalCode.js";
import { redactForLog } from "../src/admin/notify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let redis: FakeRedis;
const savedEnv = { ...process.env };

beforeEach(() => {
  redis = new FakeRedis();
  __setRedisForTests(redis);
});

afterEach(() => {
  for (const k of ["META_APP_SECRET", "META_WEBHOOK_URL_TOKEN", "VERCEL_ENV", "CRON_SECRET"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __resetEnvForTests();
  __setRedisForTests(undefined);
});

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetEnvForTests();
}

function fakeRes() {
  const r = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    setHeader(name: string, value: string) {
      r.headers[name.toLowerCase()] = value;
      return r;
    },
    send(body: unknown) {
      r.body = body;
      r.headersSent = true;
      return r;
    },
    json(body: unknown) {
      r.body = body;
      r.headersSent = true;
      return r;
    },
  };
  return r;
}

// A payload whose shape the handler doesn't process (no handleMessage call).
const BODY = Buffer.from(JSON.stringify({ object: "page", note: "noop" }));

function post(opts: { headers?: Record<string, string>; query?: Record<string, string>; body?: Buffer } = {}) {
  return {
    method: "POST",
    headers: opts.headers ?? {},
    query: opts.query ?? {},
    rawBody: opts.body ?? BODY,
  };
}

async function callWebhook(req: ReturnType<typeof post>) {
  const res = fakeRes();
  await webhookHandler(req as any, res as any);
  return res;
}

// ---------------------------------------------------------------------------
// Webhook authentication
// ---------------------------------------------------------------------------

test("webhook: production with no authenticator configured fails closed (503)", async () => {
  setEnv({ VERCEL_ENV: "production", META_APP_SECRET: undefined, META_WEBHOOK_URL_TOKEN: undefined });
  const res = await callWebhook(post());
  assert.equal(res.statusCode, 503);
});

test("webhook: META_APP_SECRET requires a valid X-Hub-Signature-256", async () => {
  setEnv({ VERCEL_ENV: "production", META_APP_SECRET: "app-secret-for-tests", META_WEBHOOK_URL_TOKEN: undefined });

  assert.equal((await callWebhook(post())).statusCode, 401, "missing signature");
  assert.equal(
    (await callWebhook(post({ headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) } }))).statusCode,
    401,
    "wrong signature",
  );

  const sig = crypto.createHmac("sha256", "app-secret-for-tests").update(BODY).digest("hex");
  const ok = await callWebhook(post({ headers: { "x-hub-signature-256": `sha256=${sig}` } }));
  assert.equal(ok.statusCode, 200);
});

test("webhook: META_WEBHOOK_URL_TOKEN requires a matching ?token=", async () => {
  const token = "url-token-0123456789abcdef0123";
  setEnv({ VERCEL_ENV: "production", META_APP_SECRET: undefined, META_WEBHOOK_URL_TOKEN: token });

  assert.equal((await callWebhook(post())).statusCode, 401, "missing token");
  assert.equal((await callWebhook(post({ query: { token: token + "x" } }))).statusCode, 401, "wrong token");
  assert.equal((await callWebhook(post({ query: { token } }))).statusCode, 200);
});

test("webhook: short META_WEBHOOK_URL_TOKEN is rejected at env validation", async () => {
  setEnv({ META_WEBHOOK_URL_TOKEN: "short" });
  const res = fakeRes();
  await assert.rejects(webhookHandler(post() as any, res as any), /at least 24 characters/);
});

test("webhook: bodies over 1 MB are rejected with 413", async () => {
  setEnv({ VERCEL_ENV: "preview", META_APP_SECRET: undefined, META_WEBHOOK_URL_TOKEN: undefined });
  const res = await callWebhook(post({ body: Buffer.alloc(1024 * 1024 + 1, 0x20) }));
  assert.equal(res.statusCode, 413);
});

test("webhook: GET handshake only echoes a sanitized challenge", async () => {
  setEnv({});
  const res = fakeRes();
  await webhookHandler(
    {
      method: "GET",
      headers: {},
      query: { "hub.mode": "subscribe", "hub.verify_token": process.env.META_WEBHOOK_SECRET!, "hub.challenge": "123<script>" },
    } as any,
    res as any,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "123script");

  const bad = fakeRes();
  await webhookHandler(
    { method: "GET", headers: {}, query: { "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" } } as any,
    bad as any,
  );
  assert.equal(bad.statusCode, 403);
});

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

test("heartbeat: production without CRON_SECRET refuses (503); wrong bearer → 401", async () => {
  setEnv({ VERCEL_ENV: "production", CRON_SECRET: undefined });
  const res = fakeRes();
  await heartbeatHandler({ method: "GET", headers: {}, query: {} } as any, res as any);
  assert.equal(res.statusCode, 503);

  setEnv({ VERCEL_ENV: "production", CRON_SECRET: "cron-secret-for-tests" });
  const res2 = fakeRes();
  await heartbeatHandler({ method: "GET", headers: { authorization: "Bearer wrong" }, query: {} } as any, res2 as any);
  assert.equal(res2.statusCode, 401);
});

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

test("sanitizer: leading whitespace cannot smuggle a formula past the strip", () => {
  assert.equal(sanitizeName(' =HYPERLINK("http://evil.example")'), 'HYPERLINK("http://evil.example")');
  assert.equal(sanitizeName("\u00a0\u00a0+cmd"), "cmd");
  assert.equal(sanitizeCity("  = - @Pune"), "Pune");
  assert.equal(sanitizeName("  Ravi Kumar  "), "Ravi Kumar");
});

// ---------------------------------------------------------------------------
// Mockup quota: per-sender
// ---------------------------------------------------------------------------

test("quota: a new typed phone number does NOT reset the sender's free allowance", async () => {
  const AUG = new Date("2026-08-15T12:00:00Z");
  const chat = "wa:919812345678";
  const r1 = await reserveGeneration(chat, "s-1", { phone: "9876543210", at: AUG });
  assert.equal(r1.free, true);
  await commitFreeGeneration(chat, "s-1", { phone: "9876543210", at: AUG });

  const r2 = await reserveGeneration(chat, "s-2", { phone: "9123456780", at: AUG });
  assert.equal(r2.free, false, "same WhatsApp sender with a different typed phone must be paid");

  // Prefix variants of the same sender share one bucket.
  const usage = await peekUsage("wa:wa:919812345678", { at: AUG });
  assert.equal(usage.committedFreeThisMonth, 1);
});

// ---------------------------------------------------------------------------
// Approval codes
// ---------------------------------------------------------------------------

test("approval code: verified only against its own order", async () => {
  const codeA = await createApprovalCode("order", "CTW-A");
  await createApprovalCode("order", "CTW-B");
  assert.equal(await verifyAndConsumeApprovalCodeFor("order", "CTW-B", codeA), "invalid");
  // Order A's code was not burned by the attempt against B.
  assert.equal(await verifyAndConsumeApprovalCodeFor("order", "CTW-A", codeA), "ok");
  assert.equal(await verifyAndConsumeApprovalCodeFor("order", "CTW-A", codeA), "invalid", "single use");
});

test("approval code: locked after too many wrong guesses, even for the right code", async () => {
  const code = await createApprovalCode("order", "CTW-L");
  const wrong = code === "111111" ? "222222" : "111111";
  for (let i = 1; i < MAX_FAILED_CODE_ATTEMPTS; i++) {
    assert.equal(await verifyAndConsumeApprovalCodeFor("order", "CTW-L", wrong), "invalid");
  }
  assert.equal(await verifyAndConsumeApprovalCodeFor("order", "CTW-L", wrong), "locked");
  assert.equal(await verifyAndConsumeApprovalCodeFor("order", "CTW-L", code), "invalid", "burned code stays dead");

  // A freshly issued code resets the attempt counter.
  const fresh = await createApprovalCode("order", "CTW-L");
  assert.equal(await verifyAndConsumeApprovalCodeFor("order", "CTW-L", fresh), "ok");
});

test("approval code: resends are capped per order per day", async () => {
  for (let i = 0; i < MAX_RESENDS_PER_DAY; i++) {
    const r = await resendApprovalCode("order", "CTW-R");
    assert.equal(r.ok, true, `resend ${i + 1}`);
    await redis.del("admin:approval:cooldown:order:CTW-R"); // skip the 30s cooldown
  }
  const capped = await resendApprovalCode("order", "CTW-R");
  assert.equal(capped.ok, false);
  assert.equal(capped.limitReached, true);
});

test("admin-approve never returns an approval code to the browser", () => {
  const src = readFileSync(path.resolve(__dirname, "../api/admin-approve.ts"), "utf8");
  assert.ok(!src.includes("[ ${resend.code} ]"), "code must not be shown in portal banners");
  assert.ok(!/error:\s*`[^`]*\$\{resend\.code/.test(src), "code must not be returned in JSON errors");
});

// ---------------------------------------------------------------------------
// Mockup dispatch + logging
// ---------------------------------------------------------------------------

test("triggerMockupDelivery has no in-process generation leg (quota bypass)", () => {
  const src = readFileSync(path.resolve(__dirname, "../src/mockup/deliverTrigger.ts"), "utf8");
  assert.ok(!src.includes('from "./deliver.js"'), "must not import the generator");
  assert.ok(!/await\s+deliverMockupForOrder\s*\(/.test(src), "must always dispatch to the quota-enforcing worker");
});

test("redactForLog strips approval codes and portal tokens but keeps order ids", () => {
  const text =
    "🔐 *Approval Code:* `482910` (Valid 30 mins)\n" +
    "Code: 123456\n" +
    "👉 https://x.example/api/admin-approve?orderId=CTW-261026-01&token=1700000000.abcdef";
  const out = redactForLog(text);
  assert.ok(!out.includes("482910"));
  assert.ok(!out.includes("123456"));
  assert.ok(!out.includes("abcdef"));
  assert.ok(out.includes("CTW-261026-01"));
});

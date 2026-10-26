/**
 * CB-04: portal-secret hardening + trigger/endpoint secret alignment.
 *
 * (a) getEnv() must FAIL FAST when neither ADMIN_PORTAL_SECRET nor
 *     META_WEBHOOK_SECRET is configured — the old hardcoded
 *     "ctw-portal-secret-key" default let anyone who knew this open-source
 *     literal mint valid 7-day admin-portal tokens for any order id (the
 *     `issue` action needs no OTP). Invariant #4: env validated once,
 *     fail-fast.
 * (b) The META_WEBHOOK_SECRET fallback still resolves (so existing
 *     deployments keep working) and an explicit ADMIN_PORTAL_SECRET wins.
 * (c) deliverTrigger sends ONLY INTERNAL_MOCKUP_SECRET in x-internal-secret
 *     (api/mockup-delivery fails closed on anything else) and skips the
 *     dispatch entirely — loudly — when that secret isn't configured,
 *     instead of firing requests guaranteed to 503.
 */

import "./support/testEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getEnv, __resetEnvForTests } from "../src/config/env.js";
import { FakeRedis } from "./support/fakeRedis.js";
import { __setRedisForTests } from "../src/session/redisClient.js";
import { triggerMockupDelivery } from "../src/mockup/deliverTrigger.js";

// Env values set by tests/support/testEnv.ts at import time — captured for
// faithful restore so later tests in this file (and the env cache) stay sane.
const PREV_PORTAL = process.env.ADMIN_PORTAL_SECRET;
const PREV_WEBHOOK = process.env.META_WEBHOOK_SECRET;
const PREV_INTERNAL = process.env.INTERNAL_MOCKUP_SECRET;
const PREV_BASE_URL = process.env.PUBLIC_BASE_URL;

function restoreOne(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv(): void {
  restoreOne("ADMIN_PORTAL_SECRET", PREV_PORTAL);
  restoreOne("META_WEBHOOK_SECRET", PREV_WEBHOOK);
  restoreOne("INTERNAL_MOCKUP_SECRET", PREV_INTERNAL);
  restoreOne("PUBLIC_BASE_URL", PREV_BASE_URL);
}

// ---------------------------------------------------------------------------
// (a)+(b): ADMIN_PORTAL_SECRET validation
// ---------------------------------------------------------------------------

test("getEnv throws when neither ADMIN_PORTAL_SECRET nor META_WEBHOOK_SECRET is set (CB-04)", () => {
  delete process.env.ADMIN_PORTAL_SECRET;
  delete process.env.META_WEBHOOK_SECRET;
  __resetEnvForTests();
  try {
    assert.throws(
      () => getEnv(),
      /ADMIN_PORTAL_SECRET/,
      "getEnv() must fail fast with a clear error naming the missing portal secret",
    );
  } finally {
    restoreEnv();
    __resetEnvForTests();
  }
});

test("getEnv falls back to META_WEBHOOK_SECRET for the portal HMAC key when ADMIN_PORTAL_SECRET is unset", () => {
  delete process.env.ADMIN_PORTAL_SECRET;
  process.env.META_WEBHOOK_SECRET = "cb04-webhook-fallback-secret";
  __resetEnvForTests();
  try {
    assert.equal(getEnv().ADMIN_PORTAL_SECRET, "cb04-webhook-fallback-secret");
  } finally {
    restoreEnv();
    __resetEnvForTests();
  }
});

test("an explicit ADMIN_PORTAL_SECRET wins over META_WEBHOOK_SECRET", () => {
  process.env.ADMIN_PORTAL_SECRET = "cb04-dedicated-portal-secret";
  process.env.META_WEBHOOK_SECRET = "cb04-other-webhook-secret";
  __resetEnvForTests();
  try {
    assert.equal(getEnv().ADMIN_PORTAL_SECRET, "cb04-dedicated-portal-secret");
  } finally {
    restoreEnv();
    __resetEnvForTests();
  }
});

// ---------------------------------------------------------------------------
// (c): deliverTrigger → /api/mockup-delivery secret alignment
// ---------------------------------------------------------------------------

test("deliverTrigger sends only INTERNAL_MOCKUP_SECRET as x-internal-secret (never the webhook secret)", async () => {
  process.env.ADMIN_PORTAL_SECRET = "unit-portal-secret";
  process.env.META_WEBHOOK_SECRET = "unit-webhook-secret";
  process.env.INTERNAL_MOCKUP_SECRET = "unit-internal-secret-ABC-123";
  process.env.PUBLIC_BASE_URL = "https://unit.example.com";
  __resetEnvForTests();
  // No order snapshot in (fake) Redis -> the fast in-process leg is skipped
  // and the code reaches the HTTP dispatch leg under test.
  __setRedisForTests(new FakeRedis());

  const calls: { url: string; init?: any }[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    calls.push({ url: String(input), init });
    return new Response("Accepted", { status: 202 });
  }) as typeof fetch;

  try {
    await triggerMockupDelivery("CTW-261026-01");
    assert.equal(calls.length, 1, "must dispatch exactly one trigger request");
    assert.equal(calls[0]!.url, "https://unit.example.com/api/mockup-delivery");
    const sent = calls[0]!.init?.headers?.["x-internal-secret"];
    assert.equal(sent, "unit-internal-secret-ABC-123", "must send INTERNAL_MOCKUP_SECRET");
    assert.notEqual(sent, "unit-webhook-secret", "must never fall back to META_WEBHOOK_SECRET (endpoint rejects it)");
  } finally {
    globalThis.fetch = prevFetch;
    restoreEnv();
    __resetEnvForTests();
  }
});

test("deliverTrigger skips the HTTP dispatch (with a loud error) when INTERNAL_MOCKUP_SECRET is unset", async () => {
  process.env.ADMIN_PORTAL_SECRET = "unit-portal-secret";
  process.env.META_WEBHOOK_SECRET = "unit-webhook-secret";
  process.env.PUBLIC_BASE_URL = "https://unit.example.com";
  delete process.env.INTERNAL_MOCKUP_SECRET;
  __resetEnvForTests();
  __setRedisForTests(new FakeRedis());

  const calls: unknown[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: any[]) => {
    calls.push(args[0]);
    return new Response("Accepted", { status: 202 });
  }) as typeof fetch;

  const errors: unknown[][] = [];
  const prevError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    await triggerMockupDelivery("CTW-261026-02");
    assert.equal(calls.length, 0, "must NOT fire a request the endpoint would reject with 503");
    const logged = errors.flat().map(String).join(" ");
    assert.ok(
      logged.includes("INTERNAL_MOCKUP_SECRET"),
      "must log a loud error naming the missing secret and the consequence",
    );
  } finally {
    globalThis.fetch = prevFetch;
    console.error = prevError;
    restoreEnv();
    __resetEnvForTests();
  }
});

// ---------------------------------------------------------------------------
// Structural guard: the endpoint keeps failing closed on its OWN secret.
// ---------------------------------------------------------------------------

test("the endpoint still fails closed on INTERNAL_MOCKUP_SECRET and the trigger carries no webhook-secret fallback", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const triggerSrc = readFileSync(path.resolve(__dirname, "../src/mockup/deliverTrigger.ts"), "utf8");
  const endpointSrc = readFileSync(path.resolve(__dirname, "../api/mockup-delivery.ts"), "utf8");

  assert.ok(
    !triggerSrc.includes("env.META_WEBHOOK_SECRET"),
    "deliverTrigger must not reintroduce a META_WEBHOOK_SECRET fallback (the endpoint rejects it)",
  );
  assert.ok(
    endpointSrc.includes("env.INTERNAL_MOCKUP_SECRET"),
    "api/mockup-delivery must keep gating on its dedicated INTERNAL_MOCKUP_SECRET",
  );
  assert.ok(
    !endpointSrc.includes("META_WEBHOOK_SECRET:") && !endpointSrc.includes("|| env.META_WEBHOOK_SECRET"),
    "api/mockup-delivery must not accept META_WEBHOOK_SECRET as the internal secret",
  );
});

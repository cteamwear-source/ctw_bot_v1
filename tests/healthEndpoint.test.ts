/**
 * CB-03: /api/health must be safe to expose publicly.
 *
 * (a) The default GET response keeps its deploy-lag diagnostics (build
 *     stamp, commit, feature flags, config-presence booleans/counts) but
 *     leaks NO email address, key/token prefix, or secret value.
 * (b) `?test_resend=1` (which fires a real outbound email) is gated behind
 *     INTERNAL_MOCKUP_SECRET — without the correct secret it must 401/403
 *     (or 503 when no secret is configured at all) and must NOT send.
 * (c) With the correct secret (header or query param) the resend path runs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import "./support/testEnv.js";
import { __resetEnvForTests } from "../src/config/env.js";
import handler from "../api/health.js";

// Distinctive throwaway values so substring assertions are strong.
const TEST_RESEND_KEY = "re_live_cb03SuperSecretKey123";
const TEST_ADMIN_EMAILS = "alice.alpha@example.com,bob.bravo@example.org";
const TEST_ADMIN_EMAIL_FROM = "Custom Teamwear <sender.cb03@example.net>";
const TEST_OPENAI_KEY = "sk-cb03-super-secret-openai-987";
const TEST_INTERNAL_SECRET = "cb03-internal-secret-xyz-ABC-789";

function applyEnv(): void {
  process.env.RESEND_API_KEY = TEST_RESEND_KEY;
  process.env.ADMIN_EMAILS = TEST_ADMIN_EMAILS;
  process.env.ADMIN_EMAIL_FROM = TEST_ADMIN_EMAIL_FROM;
  process.env.OPENAI_API_KEY = TEST_OPENAI_KEY;
  process.env.INTERNAL_MOCKUP_SECRET = TEST_INTERNAL_SECRET;
  process.env.MOCKUP_IMAGE_PROVIDER = "gemini";
  process.env.MOCKUP_IMAGE_MODEL = "test-model";
}

// --- fetch recording stub (no network) -------------------------------------

let fetchCalls: { url: string; init?: any }[] = [];
const originalFetch = globalThis.fetch;

test.beforeEach(() => {
  applyEnv();
  __resetEnvForTests();
  fetchCalls = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    fetchCalls.push({ url, init });
    if (url.includes("api.resend.com")) {
      return new Response(JSON.stringify({ id: "mock_email_id" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

// --- req/res fakes ----------------------------------------------------------

function createMockReqRes(options: {
  query?: Record<string, string>;
  headers?: Record<string, string>;
}) {
  const req: any = {
    method: "GET",
    query: options.query || {},
    body: {},
    headers: options.headers || {},
  };

  let statusCode = 200;
  let responseData: any = null;

  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    setHeader(_key: string, _val: string) {
      return res;
    },
    send(data: any) {
      responseData = data;
      return res;
    },
    json(data: any) {
      responseData = data;
      return res;
    },
  };

  return {
    req,
    res,
    getStatusCode: () => statusCode,
    getData: () => responseData,
  };
}

function resendFetches() {
  return fetchCalls.filter((c) => c.url.includes("api.resend.com"));
}

// --- tests ------------------------------------------------------------------

test("health: default GET keeps deploy-lag diagnostics but leaks no emails, key prefixes or secrets", async () => {
  const { req, res, getStatusCode, getData } = createMockReqRes({});
  await handler(req, res);

  assert.equal(getStatusCode(), 200);
  const data = getData();
  assert.equal(data.ok, true);
  assert.equal(data.service, "custom-teamwear-bot");

  // Deploy-lag diagnosis must keep working.
  assert.ok(typeof data.buildStamp === "string" && data.buildStamp.length > 0, "buildStamp present");
  assert.ok(typeof data.commitSha === "string", "commitSha present");
  assert.equal(data.features.deterministicMockup, true);
  assert.equal(data.features.catalogColourFlow, true);

  // Coarse env snapshot: booleans/counts only.
  const envStatus = data.envStatus;
  assert.equal(envStatus.hasResendApiKey, true);
  assert.equal(envStatus.adminEmailsConfigured, 2, "admin emails reduced to a count");
  assert.equal(envStatus.adminEmailFromConfigured, true, "sender reduced to a boolean");
  assert.equal(envStatus.hasOpenAiApiKey, true);
  assert.equal(envStatus.hasInternalMockupSecret, true);
  assert.equal(envStatus.mockupImageProvider, "gemini");
  assert.equal(envStatus.mockupImageModel, "test-model");

  // No value-bearing fields may exist at all.
  assert.ok(!("resendPrefix" in envStatus), "resendPrefix removed");
  assert.ok(!("openAiPrefix" in envStatus), "openAiPrefix removed");
  assert.ok(!("adminEmails" in envStatus), "adminEmails list removed");
  assert.ok(!("adminEmailFrom" in envStatus), "adminEmailFrom address removed");

  // And the full serialized payload must not contain any actual env value.
  const serialized = JSON.stringify(data);
  assert.ok(!serialized.includes("alice.alpha@example.com"), "no admin email address");
  assert.ok(!serialized.includes("bob.bravo@example.org"), "no admin email address");
  assert.ok(!serialized.includes("sender.cb03@example.net"), "no sender address");
  assert.ok(!serialized.includes("alice.alpha") && !serialized.includes("sender.cb03"), "not even partial addresses");
  assert.ok(!serialized.includes(TEST_RESEND_KEY.slice(0, 6)), "no Resend key prefix");
  assert.ok(!serialized.includes(TEST_RESEND_KEY), "no Resend key");
  assert.ok(!serialized.includes(TEST_OPENAI_KEY.slice(0, 10)), "no OpenAI key prefix");
  assert.ok(!serialized.includes(TEST_OPENAI_KEY), "no OpenAI key");
  assert.ok(!serialized.includes(TEST_INTERNAL_SECRET), "no internal secret");

  // A plain GET never triggers outbound email.
  assert.equal(resendFetches().length, 0);
});

test("health: ?test_resend=1 without secret is rejected (401) and sends NO email", async () => {
  const { req, res, getStatusCode, getData } = createMockReqRes({ query: { test_resend: "1" } });
  await handler(req, res);

  assert.equal(getStatusCode(), 401);
  assert.equal(getData().ok, false);
  assert.equal(resendFetches().length, 0, "no outbound email on unauthenticated test_resend");
});

test("health: ?test_resend=1 with a WRONG secret is rejected (401) and sends NO email", async () => {
  const { req, res, getStatusCode } = createMockReqRes({
    query: { test_resend: "1", secret: "not-the-right-secret" },
  });
  await handler(req, res);

  assert.equal(getStatusCode(), 401);
  assert.equal(resendFetches().length, 0, "no outbound email on wrong secret");
});

test("health: ?test_resend=1 is disabled entirely (503) when no internal secret is configured", async () => {
  delete process.env.INTERNAL_MOCKUP_SECRET;
  __resetEnvForTests();

  const { req, res, getStatusCode } = createMockReqRes({ query: { test_resend: "1", secret: TEST_INTERNAL_SECRET } });
  await handler(req, res);

  assert.equal(getStatusCode(), 503);
  assert.equal(resendFetches().length, 0, "no outbound email when feature is fail-closed");
});

test("health: ?test_resend=1 with the correct secret via query param runs the resend path", async () => {
  const { req, res, getStatusCode, getData } = createMockReqRes({
    query: { test_resend: "1", secret: TEST_INTERNAL_SECRET },
  });
  await handler(req, res);

  assert.equal(getStatusCode(), 200);
  const data = getData();
  assert.equal(data.ok, true);
  assert.ok(data.testResult, "testResult embedded");
  assert.equal(data.testResult.ok, true);

  const calls = resendFetches();
  assert.equal(calls.length, 1, "exactly one outbound Resend dispatch");
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  // Bearer token used for dispatch but never echoed into the response.
  assert.equal((calls[0].init?.headers as Record<string, string> | undefined)?.Authorization, `Bearer ${TEST_RESEND_KEY}`);
  assert.ok(!JSON.stringify(data).includes(TEST_RESEND_KEY), "response still leaks no key");
});

test("health: ?test_resend=1 with the correct secret via x-internal-secret header runs the resend path", async () => {
  const { req, res, getStatusCode, getData } = createMockReqRes({
    query: { test_resend: "1" },
    headers: { "x-internal-secret": TEST_INTERNAL_SECRET },
  });
  await handler(req, res);

  assert.equal(getStatusCode(), 200);
  assert.equal(getData().testResult?.ok, true);
  assert.equal(resendFetches().length, 1, "one outbound Resend dispatch via header auth");
});

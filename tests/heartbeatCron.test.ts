/**
 * CB-05: /api/heartbeat (daily cron) must not be an open relay for admin pings.
 *
 * (a) No CRON_SECRET configured → invocation stays permissive (existing
 *     deployments keep working) but the response flags `authConfigured:false`.
 * (b) CRON_SECRET set + correct `Authorization: Bearer <secret>` → 200 and
 *     the ping goes out.
 * (c) CRON_SECRET set + missing/wrong header → 401 and NO ping is sent
 *     (no outbound WhatsApp/Meta call happens).
 *
 * The Meta Graph API hop is recorded via a fetch stub (see
 * tests/support/testEnv.ts for the standard graph.facebook.com stub) so no
 * network/WhatsApp traffic ever occurs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import "./support/testEnv.js";
import { __resetEnvForTests } from "../src/config/env.js";
import handler from "../api/heartbeat.js";

const TEST_CRON_SECRET = "cb05-cron-secret-XYZ-789-abc";

// --- fetch recording stub (no network) --------------------------------------

let fetchCalls: { url: string; init?: any }[] = [];
const originalFetch = globalThis.fetch;

test.beforeEach(() => {
  // Isolate from any ambient CRON_SECRET; each test sets its own posture.
  delete process.env.CRON_SECRET;
  __resetEnvForTests();
  fetchCalls = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    fetchCalls.push({ url, init });
    return new Response(JSON.stringify({ messages: [{ id: "mock_wamid_heartbeat" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

// --- req/res fakes ----------------------------------------------------------

function createMockReqRes(headers?: Record<string, string>) {
  const req: any = {
    method: "GET",
    query: {},
    body: {},
    headers: headers || {},
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

function graphSendCount(): number {
  return fetchCalls.filter((c) => c.url.includes("graph.facebook.com")).length;
}

// --- tests ------------------------------------------------------------------

test("heartbeat: no CRON_SECRET configured stays permissive but flags authConfigured:false", async () => {
  const { req, res, getStatusCode, getData } = createMockReqRes();
  await handler(req, res);

  assert.equal(getStatusCode(), 200);
  const data = getData();
  assert.equal(data.ok, true);
  assert.equal(data.authConfigured, false, "unauthenticated posture must be visible in the response");
  // The legacy behaviour is preserved: the daily ping still goes out.
  assert.equal(graphSendCount(), 1, "heartbeat ping sent when permissive");
});

test("heartbeat: CRON_SECRET set + correct Bearer header → 200 and ping sent", async () => {
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  __resetEnvForTests();

  const { req, res, getStatusCode, getData } = createMockReqRes({
    authorization: `Bearer ${TEST_CRON_SECRET}`,
  });
  await handler(req, res);

  assert.equal(getStatusCode(), 200);
  assert.equal(getData().ok, true);
  assert.equal(getData().authConfigured, true);
  assert.equal(graphSendCount(), 1, "authenticated heartbeat ping sent");

  // Response must not echo the secret back.
  assert.ok(!JSON.stringify(getData()).includes(TEST_CRON_SECRET), "no secret in response");
});

test("heartbeat: CRON_SECRET set + MISSING header → 401 and NO ping sent", async () => {
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  __resetEnvForTests();

  const { req, res, getStatusCode } = createMockReqRes();
  await handler(req, res);

  assert.equal(getStatusCode(), 401);
  assert.equal(graphSendCount(), 0, "no admin ping on unauthenticated invocation");
});

test("heartbeat: CRON_SECRET set + WRONG bearer token → 401 and NO ping sent", async () => {
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  __resetEnvForTests();

  const { req, res, getStatusCode } = createMockReqRes({
    authorization: "Bearer not-the-right-secret",
  });
  await handler(req, res);

  assert.equal(getStatusCode(), 401);
  assert.equal(graphSendCount(), 0, "no admin ping on wrong secret");
});

test("heartbeat: correct secret sent without the 'Bearer ' prefix is still rejected", async () => {
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  __resetEnvForTests();

  const { req, res, getStatusCode } = createMockReqRes({
    authorization: TEST_CRON_SECRET,
  });
  await handler(req, res);

  assert.equal(getStatusCode(), 401);
  assert.equal(graphSendCount(), 0, "no admin ping without the Bearer scheme");
});

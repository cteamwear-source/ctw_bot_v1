import test from "node:test";
import assert from "node:assert/strict";
import "./support/testEnv.js";
import { FakeRedis } from "./support/fakeRedis.js";
import { __setRedisForTests } from "../src/session/redisClient.js";
import {
  createApprovalCode,
  resendApprovalCode,
  verifyAndConsumeApprovalCode,
  getActiveApprovalCode,
} from "../src/admin/approvalCode.js";
import {
  createPortalToken,
  verifyPortalToken,
} from "../src/admin/approvalToken.js";
import handler from "../api/admin-approve.js";
import { saveOrderSnapshot, loadOrderSnapshot } from "../src/session/orderStore.js";
import { notifyAdmins } from "../src/admin/notify.js";
import { sendAdminOrderAlertEmail } from "../src/admin/email.js";
import { escapeHtml, jsonForScript } from "../src/shared/html.js";
import { __resetEnvForTests } from "../src/config/env.js";
import type { OrderData } from "../src/shared/types.js";

const originalFetch = globalThis.fetch;

test.beforeEach(() => {
  globalThis.fetch = (async (_url: any, _init: any) => {
    return new Response(
      JSON.stringify({ ok: true, id: "mock_id", messages: [{ id: "mock_msg" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as any;
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createMockOrder(orderId = "CTW-261014-01"): OrderData {
  return {
    orderId,
    status: "Pending Payment",
    tier: "standard",
    productId: "dry_fit_round_neck",
    qty: 100,
    sizeSplit: { S: 25, M: 25, L: 25, XL: 25, XXL: 0, "3XL": 0 },
    printMethod: "screen_print",
    city: "Bengaluru",
    name: "Suraj Admin",
    phone: "919742595677",
    timeline: "standard",
    timelineUrgent: false,
    logoReceived: true,
    logos: [{ fileId: "mock_logo_id", placement: "left_chest" }],
    garmentRate: 359,
    garmentTotal: 35900,
    printEstLow: 2500,
    printEstHigh: 3500,
    grandEstLow: 38400,
    grandEstHigh: 39400,
    advanceDue: 17950,
    customerChatId: "wa:919742595677",
    channel: "whatsapp",
    paymentScreenshotUrl: "https://example.com/mock-receipt.jpg",
  };
}

function createMockReqRes(options: {
  method?: string;
  query?: Record<string, string>;
  body?: any;
}) {
  const req: any = {
    method: options.method || "GET",
    query: options.query || {},
    body: options.body || {},
    headers: {},
  };

  let statusCode = 200;
  let responseData: any = null;
  const headers: Record<string, string> = {};

  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    setHeader(key: string, val: string) {
      headers[key] = val;
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
    getHeaders: () => headers,
  };
}

test("approvalToken: creates HMAC signed token and verifies correctly", () => {
  const orderId = "CTW-261014-01";
  const token = createPortalToken(orderId);
  assert.ok(token.includes("."), "token should have <timestamp>.<hmac>");

  // Valid token passes
  assert.equal(verifyPortalToken(orderId, token), true);

  // Tampered orderId fails
  assert.equal(verifyPortalToken("CTW-261014-02", token), false);

  // Tampered HMAC fails
  const [ts, hmac] = token.split(".");
  const tamperedHmac = hmac.slice(0, -2) + "aa";
  assert.equal(verifyPortalToken(orderId, `${ts}.${tamperedHmac}`), false);

  // Expired token (> 7 days) fails
  const pastTs = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const expiredToken = createPortalToken(orderId, pastTs);
  assert.equal(verifyPortalToken(orderId, expiredToken), false);
});

test("approvalCode & fail-safe: generates secondary OTP with cooldown protection", async () => {
  const redis = new FakeRedis();
  __setRedisForTests(redis);

  const orderId = "CTW-261014-02";
  const initialCode = await createApprovalCode("order", orderId);
  assert.match(initialCode, /^\d{6}$/);

  // Trigger fail-safe secondary OTP generation
  const resend1 = await resendApprovalCode("order", orderId);
  assert.equal(resend1.ok, true);
  assert.match(resend1.code!, /^\d{6}$/);
  assert.notEqual(resend1.code, initialCode, "secondary OTP should be newly generated");

  // Immediate next attempt should trigger cooldown protection
  const resend2 = await resendApprovalCode("order", orderId);
  assert.equal(resend2.ok, false);
  assert.ok(resend2.cooldownRemaining! > 0, "cooldown must be active");

  // Consuming the secondary code succeeds
  const verified = await verifyAndConsumeApprovalCode(resend1.code!);
  assert.ok(verified);
  assert.equal(verified?.id, orderId);

  // Re-consuming same code fails
  const reVerified = await verifyAndConsumeApprovalCode(resend1.code!);
  assert.equal(reVerified, null);
});

test("admin-approve GET: rejects invalid or missing tokens", async () => {
  const redis = new FakeRedis();
  __setRedisForTests(redis);

  // Missing query params
  const { req: req1, res: res1, getStatusCode: getCode1 } = createMockReqRes({
    method: "GET",
    query: {},
  });
  await handler(req1, res1);
  assert.equal(getCode1(), 400);

  // Invalid token
  const { req: req2, res: res2, getStatusCode: getCode2 } = createMockReqRes({
    method: "GET",
    query: { orderId: "CTW-261014-01", token: "invalid.token" },
  });
  await handler(req2, res2);
  assert.equal(getCode2(), 403);
});

test("admin-approve GET: renders order details, OTP popup modal, and fail-safe buttons", async () => {
  const redis = new FakeRedis();
  __setRedisForTests(redis);

  const order = createMockOrder("CTW-261014-03");
  await saveOrderSnapshot(order);

  const token = createPortalToken(order.orderId);
  const { req, res, getStatusCode, getData } = createMockReqRes({
    method: "GET",
    query: { orderId: order.orderId, token },
  });

  await handler(req, res);
  assert.equal(getStatusCode(), 200);

  const html = String(getData());
  assert.ok(html.includes("Order CTW-261014-03"), "must display order ID");
  assert.ok(html.includes("Suraj Admin"), "must display customer name");
  assert.ok(html.includes("₹17,950"), "must display advance due");
  assert.ok(html.includes('id="otpModal"'), "must include 2-step OTP modal");
  assert.ok(html.includes("Request Secondary OTP"), "must include fail-safe secondary OTP button");
});

test("admin-approve POST confirm: validates OTP and confirms order", async () => {
  const redis = new FakeRedis();
  __setRedisForTests(redis);

  const order = createMockOrder("CTW-261014-04");
  await saveOrderSnapshot(order);

  const token = createPortalToken(order.orderId);
  const code = await createApprovalCode("order", order.orderId);

  // 1. Wrong OTP code fails
  const { req: badReq, res: badRes, getStatusCode: badCode, getData: badData } = createMockReqRes({
    method: "POST",
    body: { orderId: order.orderId, token, code: "000000", action: "confirm" },
  });
  await handler(badReq, badRes);
  assert.equal(badCode(), 400);
  assert.ok(badData().error.includes("invalid or has expired"));

  // 2. Correct OTP code succeeds
  const { req: goodReq, res: goodRes, getStatusCode: goodCode, getData: goodData } = createMockReqRes({
    method: "POST",
    body: { orderId: order.orderId, token, code, action: "confirm" },
  });
  await handler(goodReq, goodRes);
  assert.equal(goodCode(), 200);
  assert.equal(goodData().ok, true);
  assert.ok(goodData().message.includes("confirmed successfully"));

  // 3. Duplicate confirmation attempt is rejected by idempotency lock
  const { req: dupReq, res: dupRes, getStatusCode: dupCode, getData: dupData } = createMockReqRes({
    method: "POST",
    body: { orderId: order.orderId, token, code, action: "confirm" },
  });
  await handler(dupReq, dupRes);
  assert.equal(dupCode(), 400);
  assert.ok(dupData().error.includes("already been"));
});

test("admin-approve POST resend_otp: generates secondary code via fail-safe", async () => {
  const redis = new FakeRedis();
  __setRedisForTests(redis);

  const order = createMockOrder("CTW-261014-05");
  await saveOrderSnapshot(order);
  const token = createPortalToken(order.orderId);

  const { req, res, getStatusCode, getData } = createMockReqRes({
    method: "POST",
    body: { orderId: order.orderId, token, action: "resend_otp" },
  });

  await handler(req, res);
  assert.equal(getStatusCode(), 200);
  assert.equal(getData().ok, true);
  assert.ok(getData().message.includes("Secondary verification code sent"));
});

test("notifyAdmins: snapshots order, generates OTP code, and does NOT send WhatsApp approval to admins", async () => {
  const redis = new FakeRedis();
  __setRedisForTests(redis);

  const fetchCalls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const body = init?.body ? (typeof init.body === "string" ? JSON.parse(init.body) : init.body) : {};
    fetchCalls.push({ url: String(url), body });
    return new Response(JSON.stringify({ id: "mock_res" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;

  const order = createMockOrder("CTW-261016-01");
  await notifyAdmins(order, "https://example.com/receipt.jpg");

  // 1. Order snapshot saved with payment screenshot URL
  const snapshot = await loadOrderSnapshot(order.orderId);
  assert.ok(snapshot);
  assert.equal(snapshot?.paymentScreenshotUrl, "https://example.com/receipt.jpg");

  // 2. Active 6-digit approval code generated
  const activeCode = await getActiveApprovalCode("order", order.orderId);
  assert.ok(activeCode);
  assert.match(activeCode!, /^\d{6}$/);

  // 3. No Meta Cloud API calls were made (no WhatsApp message sent to admins)
  assert.ok(!fetchCalls.some((c) => c.url.includes("graph.facebook.com")));
});

// ---------------------------------------------------------------------------
// CB-01: stored XSS — customer-controlled fields must be HTML-escaped in the
// admin portal page and the HTML parts of the order emails (the plain-text
// fallback keeps the raw values; it is not HTML).
// ---------------------------------------------------------------------------

const XSS_NAME = `<script>alert(1)</script>`;
const XSS_CITY = `"><img src=x onerror=alert(2)>`;
const XSS_PHONE = `+91' onmouseover='alert(3)`;
const XSS_ITEM = `Dri-Fit <b>Evil</b> Tee`;
const XSS_COLOR = `Red & "Blue"`;

function createXssMockOrder(orderId = "CTW-261026-01"): OrderData {
  const order = createMockOrder(orderId);
  order.name = XSS_NAME;
  order.city = XSS_CITY;
  order.phone = XSS_PHONE;
  order.catalogItemName = XSS_ITEM;
  order.catalogColor = XSS_COLOR;
  return order;
}

test("escapeHtml & jsonForScript: escape all HTML metacharacters and script-breakout sequences", () => {
  assert.equal(
    escapeHtml(`<script>alert("x") & 'y'</script>`),
    "&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;",
  );
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");

  // jsonForScript must not allow a </script> breakout from inlined JSON.
  const encoded = jsonForScript(`</script><img src=x onerror=alert(1)>`);
  assert.ok(!encoded.includes("</"), "encoded JSON must not contain a raw closing tag");
  assert.ok(encoded.includes("\\u003c"));
});

test("admin-approve GET: escapes customer-controlled fields in portal HTML (CB-01)", async () => {
  const redis = new FakeRedis();
  __setRedisForTests(redis);

  const order = createXssMockOrder("CTW-261026-02");
  await saveOrderSnapshot(order);

  const token = createPortalToken(order.orderId);
  const { req, res, getStatusCode, getData } = createMockReqRes({
    method: "GET",
    query: { orderId: order.orderId, token },
  });

  await handler(req, res);
  assert.equal(getStatusCode(), 200);

  const html = String(getData());

  // Payloads appear ESCAPED, never as live HTML.
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "name payload must be escaped");
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw script payload must never appear");
  assert.ok(
    html.includes("&quot;&gt;&lt;img src=x onerror=alert(2)&gt;"),
    "city payload (attribute breakout) must be escaped",
  );
  assert.ok(!html.includes("<img src=x onerror=alert(2)>"), "raw img payload must never appear");
  assert.ok(html.includes("&#39; onmouseover=&#39;alert(3)"), "phone payload (single-quote attr) must be escaped");
  assert.ok(html.includes("Dri-Fit &lt;b&gt;Evil&lt;/b&gt; Tee"), "catalogItemName payload must be escaped");

  // Sanity: order still renders normally alongside the escaping.
  assert.ok(html.includes("Order CTW-261026-02"), "must still display order ID");
  assert.ok(html.includes("₹17,950"), "must still display advance due");
});

test("sendAdminOrderAlertEmail: escapes HTML email, keeps plain-text fallback raw (CB-01)", async () => {
  const prevApiKey = process.env["RESEND_API_KEY"];
  process.env["RESEND_API_KEY"] = "re_test_live_fake";
  __resetEnvForTests();

  const captured: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    captured.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ id: "mock_res" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;

  try {
    const order = createXssMockOrder("CTW-261026-03");
    const result = await sendAdminOrderAlertEmail(
      order,
      "123456",
      "https://example.com/portal",
      "https://example.com/resend",
      `https://example.com/receipt.jpg?a="b"&c=<script>4</script>`,
    );
    assert.equal(result.ok, true);

    const resendCall = captured.find((c) => c.url.includes("api.resend.com"));
    assert.ok(resendCall, "must dispatch via Resend API");
    const html: string = resendCall!.body.html;
    const text: string = resendCall!.body.text;

    // HTML email: every customer-controlled payload appears escaped.
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "name payload must be escaped in HTML email");
    assert.ok(!html.includes("<script>alert(1)</script>"), "raw script payload must never appear in HTML email");
    assert.ok(
      html.includes("&quot;&gt;&lt;img src=x onerror=alert(2)&gt;"),
      "city payload must be escaped in HTML email",
    );
    assert.ok(html.includes("&#39; onmouseover=&#39;alert(3)"), "phone payload must be escaped in HTML email");
    assert.ok(html.includes("Dri-Fit &lt;b&gt;Evil&lt;/b&gt; Tee"), "catalogItemName must be escaped in HTML email");
    assert.ok(html.includes("Red &amp; &quot;Blue&quot;"), "catalogColor must be escaped in HTML email");
    // Screenshot URL is interpolated into quoted attributes — must be escaped there too.
    assert.ok(
      html.includes("https://example.com/receipt.jpg?a=&quot;b&quot;&amp;c=&lt;script&gt;4&lt;/script&gt;"),
      "screenshot URL must be attribute-escaped in HTML email",
    );

    // Plain-text fallback keeps the raw (unescaped) values and is not broken.
    assert.ok(text.includes(XSS_NAME), "text fallback must keep the raw name");
    assert.ok(text.includes(XSS_CITY), "text fallback must keep the raw city");
    assert.ok(text.includes("Customer: " + XSS_NAME), "text fallback customer line must be intact");
  } finally {
    if (prevApiKey === undefined) delete process.env["RESEND_API_KEY"];
    else process.env["RESEND_API_KEY"] = prevApiKey;
    __resetEnvForTests();
  }
});


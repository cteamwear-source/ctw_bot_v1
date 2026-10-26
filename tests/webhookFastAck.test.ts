/**
 * T3: the webhook answers 200 right after the HMAC check + JSON parse and
 * processes messages inside `waitUntil`. Chats run in parallel; messages
 * within one chat run in order. Statuses-only payloads cost 0 Redis calls.
 */

import "./support/testEnv.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { FakeRedis } from "./support/fakeRedis.js";
import { __setRedisForTests } from "../src/session/redisClient.js";
import { __resetEnvForTests } from "../src/config/env.js";
import handler, { __setWaitUntilForTests, __setHandleMessageForTests } from "../api/webhook.js";

let redis: FakeRedis;
let background: Promise<unknown>[];
let events: string[];

function fakeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      res.headersSent = true;
      events.push(`response:${res.statusCode}`);
      return res;
    },
  };
  return res;
}

function req(payload: unknown, headers: Record<string, string> = {}) {
  return { method: "POST", headers, query: {}, rawBody: Buffer.from(JSON.stringify(payload)) } as any;
}

function msg(id: string, from: string) {
  return { id, from, type: "text", text: { body: "hi" } };
}

function metaPayload(messages: unknown[], statuses: unknown[] = []) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "1", changes: [{ field: "messages", value: { messages, statuses } }] }],
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  redis = new FakeRedis();
  __setRedisForTests(redis);
  background = [];
  events = [];
  __setWaitUntilForTests((p) => {
    background.push(p);
  });
});

afterEach(() => {
  __setWaitUntilForTests(undefined);
  __setHandleMessageForTests(undefined);
  __setRedisForTests(undefined);
  delete process.env["META_APP_SECRET"];
  __resetEnvForTests();
});

test("responds 200 before a slow handleMessage resolves", async () => {
  let resolved = false;
  __setHandleMessageForTests(async () => {
    await sleep(100);
    resolved = true;
  });
  const res = fakeRes();
  await handler(req(metaPayload([msg("wamid.a", "911")])), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "EVENT_RECEIVED");
  assert.equal(resolved, false, "processing still running when the handler returned");
  assert.equal(background.length, 1, "work handed to waitUntil");
  await Promise.all(background);
  assert.equal(resolved, true);
});

test("two chats are processed concurrently", async () => {
  __setHandleMessageForTests(async (chatId) => {
    events.push(`start:${chatId}`);
    await sleep(50);
    events.push(`end:${chatId}`);
  });
  await handler(req(metaPayload([msg("wamid.1", "911"), msg("wamid.2", "922")])), fakeRes());
  await Promise.all(background);
  assert.deepEqual(events.slice(0, 3), ["response:200", "start:wa:911", "start:wa:922"]);
});

test("messages within one chat are processed in order", async () => {
  __setHandleMessageForTests(async (_chatId, m) => {
    events.push(`start:${m.id}`);
    await sleep(m.id === "wamid.1" ? 60 : 5);
    events.push(`end:${m.id}`);
  });
  await handler(req(metaPayload([msg("wamid.1", "911"), msg("wamid.2", "911")])), fakeRes());
  await Promise.all(background);
  assert.deepEqual(events, ["response:200", "start:wamid.1", "end:wamid.1", "start:wamid.2", "end:wamid.2"]);
});

test("one chat's failure does not stop another chat", async () => {
  const done: string[] = [];
  __setHandleMessageForTests(async (chatId) => {
    if (chatId === "wa:911") throw new Error("boom");
    done.push(chatId);
  });
  await handler(req(metaPayload([msg("wamid.1", "911"), msg("wamid.2", "922")])), fakeRes());
  await Promise.all(background);
  assert.deepEqual(done, ["wa:922"]);
});

test("statuses-only payload: 200 with 0 Redis calls and nothing scheduled", async () => {
  let called = 0;
  __setHandleMessageForTests(async () => {
    called++;
  });
  const res = fakeRes();
  await handler(req(metaPayload([], [{ id: "wamid.s", status: "delivered" }])), res);
  assert.equal(res.statusCode, 200);
  assert.equal(redis.commands, 0);
  assert.equal(background.length, 0);
  assert.equal(called, 0);
});

test("direct messages array shape is also processed", async () => {
  const seen: string[] = [];
  __setHandleMessageForTests(async (chatId) => {
    seen.push(chatId);
  });
  await handler(req({ messages: [msg("wamid.d", "933")] }), fakeRes());
  await Promise.all(background);
  assert.deepEqual(seen, ["wa:933"]);
});

test("bad signature -> 401 and nothing processed", async () => {
  process.env["META_APP_SECRET"] = "app-secret";
  __resetEnvForTests();
  let called = 0;
  __setHandleMessageForTests(async () => {
    called++;
  });
  const res = fakeRes();
  await handler(req(metaPayload([msg("wamid.x", "911")]), { "x-hub-signature-256": "sha256=" + "0".repeat(64) }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(background.length, 0);
  assert.equal(called, 0);

  // A correct signature is accepted.
  const r = req(metaPayload([msg("wamid.y", "911")]));
  r.headers["x-hub-signature-256"] =
    "sha256=" + crypto.createHmac("sha256", "app-secret").update(r.rawBody).digest("hex");
  const ok = fakeRes();
  await handler(r, ok);
  await Promise.all(background);
  assert.equal(ok.statusCode, 200);
  assert.equal(called, 1);
});

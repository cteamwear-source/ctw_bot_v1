/**
 * Latency budget harness.
 *
 * Drives a static step through the real `handleMessage` entry point with
 * the FakeRedis + injected WhatsApp transport, and records how many Redis
 * round-trips and WhatsApp sends one customer message costs.
 *
 * Numbers this file pins (after T2):
 *  - every static step costs exactly 2 Redis round-trips: the `begin`
 *    pipeline (dedupe + lock + rate limit + GET sess) and the `finish`
 *    pipeline (SET sess + token-checked unlock).
 *  - tier button press: 1 send.
 *  - unrecognised input at the tier step (reprompt): 1 send
 *    (COPY.genericReprompt merged into the menu body, T4).
 */

import "./support/testEnv.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeRedis } from "./support/fakeRedis.js";
import { __setRedisForTests } from "../src/session/redisClient.js";
import { __setTransportForTests } from "../src/whatsapp/metaClient.js";
import { loadDraft } from "../src/session/draftStore.js";
import { __setTimingSinkForTests, maskMsgId, type TimingLine } from "../src/shared/timing.js";
import { handleMessage } from "../src/bot/index.js";
import { COPY } from "../src/conversation/copy.js";
import type { OrderDraft } from "../src/conversation/draft.js";

const CHAT = "wa:919876543210";

let redis: FakeRedis;
let sends: Array<{ url: string; body: any }>;
let timingLines: TimingLine[];
let fetchCalls: number;
let originalFetch: typeof globalThis.fetch;

/** Draft with every field before the tier step filled in. */
function draftAtTierStep(): OrderDraft {
  return {
    orderType: "bulk",
    garmentSilhouette: "collar",
    qty: 100,
    city: "Bengaluru",
    name: "Suraj Kumar",
    phone: "9876543210",
    timeline: "standard",
    updatedAt: Date.now(),
  };
}

function buttonReply(msgId: string, id: string, title: string) {
  return {
    id: msgId,
    from: "919876543210",
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id, title } },
  };
}

function textMsg(msgId: string, body: string) {
  return { id: msgId, from: "919876543210", type: "text", text: { body } };
}

async function seedDraft(draft: OrderDraft): Promise<void> {
  await redis.set(`sess:${CHAT}`, draft, { ex: 86400 });
  redis.resetCounters();
}

beforeEach(() => {
  redis = new FakeRedis();
  __setRedisForTests(redis);
  sends = [];
  timingLines = [];
  fetchCalls = 0;
  __setTransportForTests(async (url, init) => {
    sends.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.fake" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  __setTimingSinkForTests((line) => timingLines.push(line));
  // Any send that bypasses the injected transport would show up here.
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  __setTransportForTests(undefined);
  __setTimingSinkForTests(undefined);
  __setRedisForTests(undefined);
  globalThis.fetch = originalFetch;
});

test("budget: tier button press = exactly 2 Redis round-trips (begin + finish pipelines), 1 send", async () => {
  await seedDraft(draftAtTierStep());

  await handleMessage(CHAT, buttonReply("wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgUM0EwQTEyMzQ1Njc4OUFCQ0RFRjAA", "tier:standard", "Standard"));

  assert.equal(redis.roundTrips, 2, "begin pipeline + finish pipeline, nothing else");
  assert.equal(redis.pipelineExecs, 2, "both round-trips are pipelines");
  assert.equal(sends.length, 1, "one WhatsApp send: the fabric menu");
  assert.equal(fetchCalls, 0, "all sends go through the injected transport");

  const menu = sends[0]!.body;
  assert.equal(menu.type, "interactive");
  assert.equal(menu.interactive.type, "button");
  assert.equal(menu.interactive.body.text, COPY.fabricAsk);

  const draft = await loadDraft(CHAT);
  assert.equal(draft?.tier, "standard");
});

test("budget: second message on a warm instance still = exactly 2 Redis round-trips", async () => {
  await seedDraft(draftAtTierStep());
  await handleMessage(CHAT, buttonReply("wamid.warm000000", "tier:standard", "Standard"));
  await seedDraft(draftAtTierStep());

  await handleMessage(CHAT, buttonReply("wamid.warm000001", "tier:basic", "Basic"));

  assert.equal(redis.roundTrips, 2, "no memory cache: draft always comes from the begin pipeline");
  assert.equal(sends.length, 2);
});

test("budget: reprompt at the tier step = exactly 2 Redis round-trips, 1 send", async () => {
  await seedDraft(draftAtTierStep());

  await handleMessage(CHAT, textMsg("wamid.reprompt0001", "something else"));

  assert.equal(redis.roundTrips, 2, "begin + finish (unlock only; nothing saved on reprompt)");
  assert.equal(sends.length, 1, "COPY.genericReprompt merged into the tier menu body");
  assert.equal(sends[0]!.body.interactive?.body?.text, `${COPY.genericReprompt}\n\n${COPY.welcome}`);
});

test("timing: exactly one structured line per message with masked msgId and the step", async () => {
  await seedDraft(draftAtTierStep());
  const rawId = "wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgUSECRET123456";

  await handleMessage(CHAT, buttonReply(rawId, "tier:standard", "Standard"));

  assert.equal(timingLines.length, 1);
  const line = timingLines[0]!;
  assert.deepEqual(Object.keys(line).sort(), ["cold", "msgId", "redisMs", "sendMs", "step", "totalMs"]);
  assert.equal(line.step, "tier");
  assert.equal(line.msgId, maskMsgId(rawId));
  assert.equal(line.msgId, "…123456");
  assert.ok(!JSON.stringify(line).includes("SECRET"), "raw msgId never logged");
  assert.equal(typeof line.cold, "boolean");
  for (const k of ["redisMs", "sendMs", "totalMs"] as const) {
    assert.ok(Number.isInteger(line[k]) && line[k] >= 0, `${k} is a non-negative integer`);
  }
  assert.ok(line.totalMs >= line.sendMs, "total covers the send");
});

test("timing: second message on the same instance reports cold=false", async () => {
  await seedDraft(draftAtTierStep());
  await handleMessage(CHAT, textMsg("wamid.first00001", "x"));
  await handleMessage(CHAT, textMsg("wamid.second0001", "y"));
  assert.equal(timingLines.length, 2);
  assert.equal(timingLines[1]!.cold, false);
});

test("failing sends (400) still record exactly one timing line; 3 attempts, none retried", async () => {
  await seedDraft(draftAtTierStep());
  let attempts = 0;
  __setTransportForTests(async () => {
    attempts++;
    return new Response("bad", { status: 400 });
  });

  await handleMessage(CHAT, buttonReply("wamid.fail000001", "tier:standard", "Standard"));

  // Interactive menu (400) → sendMenu's plain-text fallback (400, allowed
  // for 4xx) → processStep's generic error message (400). 400 is never retried.
  assert.equal(attempts, 3);
  assert.equal(timingLines.length, 1);
});

// --- FakeRedis harness contract ---------------------------------------------

test("fakeRedis: a pipeline exec counts as ONE round-trip and returns results in order", async () => {
  const r = new FakeRedis();
  const results = await r
    .pipeline()
    .set("upd:m1", 1, { nx: true, ex: 86400 })
    .set("lock:c1", "tok", { nx: true, ex: 30 })
    .incr("rl:c1:1")
    .expire("rl:c1:1", 120)
    .get("sess:c1")
    .exec();

  assert.deepEqual(results, ["OK", "OK", 1, 1, null]);
  assert.equal(r.roundTrips, 1);
  assert.equal(r.pipelineExecs, 1);
  assert.equal(r.commands, 5);

  const dup = await r.multi().set("upd:m1", 1, { nx: true }).exec();
  assert.deepEqual(dup, [null], "SET NX inside a pipeline respects existing keys");
  assert.equal(r.roundTrips, 2);
});

test("fakeRedis: eval lock-release deletes only for the token holder", async () => {
  const r = new FakeRedis();
  const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
  await r.set("lock:c1", "token-a", { nx: true, ex: 30 });

  assert.equal(await r.eval(RELEASE, ["lock:c1"], ["token-b"]), 0, "wrong token keeps the lock");
  assert.equal(await r.get("lock:c1"), "token-a");

  const [released] = await r.pipeline().eval(RELEASE, ["lock:c1"], ["token-a"]).exec();
  assert.equal(released, 1, "holder releases the lock (also inside a pipeline)");
  assert.equal(await r.get("lock:c1"), null);

  await assert.rejects(() => r.eval("return 1", [], []), /unsupported script/);
});

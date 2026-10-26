/**
 * T2 Redis hot path: cross-instance dedupe, per-chat lock, rate limit and
 * draft load happen in ONE pipeline (`begin`); draft save + token-checked
 * unlock in ONE pipeline (`finish`). Redis is the source of truth for drafts.
 */

import "./support/testEnv.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeRedis } from "./support/fakeRedis.js";
import { __setRedisForTests } from "../src/session/redisClient.js";
import { __setTransportForTests } from "../src/whatsapp/metaClient.js";
import { __setTimingSinkForTests } from "../src/shared/timing.js";
import { begin, finish, abort, RATE_LIMIT_PER_MINUTE } from "../src/session/hotPath.js";
import { handleMessage } from "../src/bot/index.js";
import { COPY } from "../src/conversation/copy.js";
import type { OrderDraft } from "../src/conversation/draft.js";

const CHAT = "wa:919876543210";

let redis: FakeRedis;
let sends: any[];
let sendDelayMs: number;

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

function sentText(body: any): string | undefined {
  return body.text?.body ?? body.interactive?.body?.text;
}

beforeEach(async () => {
  redis = new FakeRedis();
  __setRedisForTests(redis);
  sends = [];
  sendDelayMs = 0;
  __setTransportForTests(async (_url, init) => {
    if (sendDelayMs > 0) await new Promise((r) => setTimeout(r, sendDelayMs));
    sends.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.fake" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  __setTimingSinkForTests(() => {});
  await redis.set(`sess:${CHAT}`, draftAtTierStep(), { ex: 86400 });
  redis.resetCounters();
});

afterEach(() => {
  __setTransportForTests(undefined);
  __setTimingSinkForTests(undefined);
  __setRedisForTests(undefined);
});

test("begin: dedupe, lock, rate limit and draft load cost ONE round-trip", async () => {
  const r = await begin(CHAT, "wamid.begin1");
  assert.equal(redis.roundTrips, 1);
  assert.equal(r.isNew, true);
  assert.equal(r.locked, true);
  assert.equal(r.allowed, true);
  assert.ok(r.token);
  assert.equal(r.draft?.city, "Bengaluru");
});

test("lock is set with a 30s TTL and the dedupe marker with 24h", async () => {
  await begin(CHAT, "wamid.ttl1");
  assert.equal(await redis.ttl(`lock:${CHAT}`), 30);
  assert.equal(await redis.ttl("upd:wamid.ttl1"), 86400);
});

test("only the token holder can release the lock", async () => {
  const r = await begin(CHAT, "wamid.tok1");
  await finish(CHAT, "someone-else", undefined);
  assert.equal(await redis.get(`lock:${CHAT}`), r.token, "wrong token leaves the lock");
  await finish(CHAT, r.token!, undefined);
  assert.equal(await redis.get(`lock:${CHAT}`), null, "holder releases it");
});

test("finish: draft save + unlock in ONE round-trip; null deletes the draft", async () => {
  const r = await begin(CHAT, "wamid.fin1");
  redis.resetCounters();
  await finish(CHAT, r.token!, { ...draftAtTierStep(), tier: "basic" });
  assert.equal(redis.roundTrips, 1);
  assert.equal((await redis.get<OrderDraft>(`sess:${CHAT}`))?.tier, "basic");
  assert.equal(await redis.ttl(`sess:${CHAT}`), 86400);

  const r2 = await begin(CHAT, "wamid.fin2");
  await finish(CHAT, r2.token!, null);
  assert.equal(await redis.get(`sess:${CHAT}`), null);
});

test("rate limit: more than 20 messages a minute are not allowed", async () => {
  let last;
  for (let i = 0; i <= RATE_LIMIT_PER_MINUTE; i++) {
    last = await begin(CHAT, `wamid.rl${i}`);
    await finish(CHAT, last.token!, undefined);
  }
  assert.equal(RATE_LIMIT_PER_MINUTE, 20);
  assert.equal(last!.allowed, false);
});

test("abort deletes the dedupe marker", async () => {
  const r = await begin(CHAT, "wamid.ab1");
  await finish(CHAT, r.token!, undefined);
  await abort("wamid.ab1");
  assert.equal(await redis.get("upd:wamid.ab1"), null);
  assert.equal((await begin(CHAT, "wamid.ab1")).isNew, true);
});

test("duplicate message id is processed once (across instances: marker lives in Redis)", async () => {
  const msg = buttonReply("wamid.dup1", "tier:standard", "Standard");
  await handleMessage(CHAT, msg);
  await handleMessage(CHAT, msg);
  assert.equal(sends.length, 1, "second delivery is dropped");
  assert.equal(await redis.get(`lock:${CHAT}`), null, "duplicate does not leave the lock held");
});

test("concurrent messages for one chat are serialized and the second sees the first's draft", async () => {
  sendDelayMs = 200;
  await Promise.all([
    handleMessage(CHAT, buttonReply("wamid.c1", "tier:standard", "Standard")),
    (async () => {
      await new Promise((r) => setTimeout(r, 20));
      await handleMessage(CHAT, buttonReply("wamid.c2", "fabric:polyester", "Dry Fit"));
    })(),
  ]);
  assert.equal(sends.length, 2);
  assert.equal(sentText(sends[0]), COPY.fabricAsk, "first message's reply goes first");
  const draft = await redis.get<OrderDraft>(`sess:${CHAT}`);
  assert.equal(draft?.tier, "standard");
  assert.equal(draft?.fabric, "polyester", "second message ran after the first saved");
  assert.equal(await redis.get(`lock:${CHAT}`), null);
});

test("lock still held after 3 retries -> busy reprompt", async () => {
  await redis.set(`lock:${CHAT}`, "other-instance", { nx: true, ex: 30 });
  await handleMessage(CHAT, buttonReply("wamid.busy1", "tier:standard", "Standard"));
  assert.equal(sends.length, 1);
  assert.equal(sentText(sends[0]), COPY.busyReprompt);
  assert.equal(await redis.get(`lock:${CHAT}`), "other-instance", "foreign lock untouched");
});

test("failure deletes the dedupe marker and releases the lock so Meta's retry is processed", async () => {
  let explode = true;
  const msg: any = {
    id: "wamid.fail1",
    from: "919876543210",
    type: "interactive",
    get interactive() {
      if (explode) throw new Error("boom");
      return { type: "button_reply", button_reply: { id: "tier:standard", title: "Standard" } };
    },
  };
  await handleMessage(CHAT, msg);
  assert.equal(await redis.get("upd:wamid.fail1"), null, "marker removed on failure");
  assert.equal(await redis.get(`lock:${CHAT}`), null, "lock released on failure");

  explode = false;
  await handleMessage(CHAT, msg);
  assert.equal((await redis.get<OrderDraft>(`sess:${CHAT}`))?.tier, "standard", "retry processed");
});

test("draft is always fresh from Redis (another instance's write is seen)", async () => {
  await handleMessage(CHAT, buttonReply("wamid.f1", "tier:standard", "Standard"));
  // Another instance moves the draft back to the tier step.
  await redis.set(`sess:${CHAT}`, draftAtTierStep(), { ex: 86400 });
  await handleMessage(CHAT, buttonReply("wamid.f2", "tier:basic", "Basic"));
  assert.equal((await redis.get<OrderDraft>(`sess:${CHAT}`))?.tier, "basic");
  assert.equal(sentText(sends[1]), COPY.fabricAsk);
});

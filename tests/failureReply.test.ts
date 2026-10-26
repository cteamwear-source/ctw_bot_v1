/**
 * T8: every failure gets exactly one customer reply (COPY.genericError),
 * the chat lock is always released and the dedupe marker is cleared so a
 * redelivery is processed.
 */

import "./support/testEnv.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeRedis } from "./support/fakeRedis.js";
import { __setRedisForTests } from "../src/session/redisClient.js";
import { __setTransportForTests } from "../src/whatsapp/metaClient.js";
import { handleMessage } from "../src/bot/index.js";
import { handleWhatsAppMessage } from "../src/conversation/orderFlow.js";
import { COPY } from "../src/conversation/copy.js";
import { withTimeout } from "../src/shared/withTimeout.js";
import type { OrderDraft } from "../src/conversation/draft.js";

const CHAT = "wa:919876543210";

let redis: FakeRedis;
let sends: any[];
/** Number of leading transport calls that fail with HTTP 500. */
let failFirst: number;
let calls: number;

function apologies(): number {
  return sends.filter((b) => b.type === "text" && b.text?.body === COPY.genericError).length;
}

function textMsg(id: string, body: string) {
  return { id, from: "919876543210", type: "text", text: { body } };
}

function buttonReply(id: string, replyId: string, title: string) {
  return {
    id,
    from: "919876543210",
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: replyId, title } },
  };
}

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

beforeEach(() => {
  redis = new FakeRedis();
  __setRedisForTests(redis);
  sends = [];
  calls = 0;
  failFirst = 0;
  __setTransportForTests(async (_url, init) => {
    calls++;
    if (calls <= failFirst) return new Response("boom", { status: 500 });
    sends.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.fake" }] }), { status: 200 });
  });
});

afterEach(() => {
  __setTransportForTests(undefined);
  __setRedisForTests(undefined);
});

function assertCleanedUp(msgId: string, chatId = CHAT) {
  assert.equal(redis.keys().includes(`lock:${chatId}`), false, "lock released");
  assert.equal(redis.keys().includes(`upd:${msgId}`), false, "dedupe marker cleared for redelivery");
}

test("draft load failure (begin pipeline throws) → exactly one apology, no lock left", async () => {
  (redis as any).pipeline = () => {
    throw new Error("redis down");
  };
  await handleMessage(CHAT, textMsg("wamid.t8load1", "hi"));
  assert.equal(apologies(), 1);
  assert.equal(sends.length, 1);
});

test("draft load failure inside the order flow → exactly one apology", async () => {
  const realGet = redis.get.bind(redis);
  (redis as any).get = async (key: string) => {
    if (key.startsWith("sess:")) throw new Error("sess read failed");
    return realGet(key);
  };
  // Outside a request context loadDraft reads Redis directly.
  await assert.rejects(() => handleWhatsAppMessage(CHAT, textMsg("wamid.t8load2", "hi")));
  assert.equal(apologies(), 1);
  assert.equal(sends.length, 1);
});

test("cancel branch failure → exactly one apology, lock released", async () => {
  await redis.set(`sess:${CHAT}`, draftAtTierStep(), { ex: 86400 });
  failFirst = 1; // the cancel confirmation menu fails with 500 (no fallback, no retry)
  await handleMessage(CHAT, textMsg("wamid.t8cancel", "cancel"));
  assert.equal(apologies(), 1);
  assert.equal(sends.length, 1);
  assertCleanedUp("wamid.t8cancel");
  const draft = await redis.get<OrderDraft>(`sess:${CHAT}`);
  assert.equal(draft?.confirmingCancel, undefined, "failed message's draft change is dropped");
});

test("admin handler failure → exactly one apology, lock released", async () => {
  const admin = process.env.ADMIN_CHAT_IDS!.split(",")[0]!.trim();
  failFirst = 1; // the admin handler's own reply fails
  await handleMessage(admin, buttonReply("wamid.t8admin", "admin:confirm:CTW-260101-01", "Confirm"));
  assert.equal(apologies(), 1);
  assert.equal(sends.length, 1);
  assertCleanedUp("wamid.t8admin", admin);
});

test("processStep failure → exactly one apology, lock released", async () => {
  await redis.set(`sess:${CHAT}`, draftAtTierStep(), { ex: 86400 });
  failFirst = 1; // the next-step menu fails with 500
  await handleMessage(CHAT, buttonReply("wamid.t8step", "tier:standard", "Standard"));
  assert.equal(apologies(), 1);
  assert.equal(sends.length, 1);
  assertCleanedUp("wamid.t8step");
  const draft = await redis.get<OrderDraft>(`sess:${CHAT}`);
  assert.equal(draft?.tier, undefined, "failed message's draft change is dropped");
});

test("withTimeout rejects a hung Sheets-style call with TimeoutError", async () => {
  const hung = new Promise<void>(() => {});
  await assert.rejects(() => withTimeout(hung, 20, "Sheets addRow"), (err: Error) => err.name === "TimeoutError");
});

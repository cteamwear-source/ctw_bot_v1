/**
 * T4: send client reliability + one send per static screen.
 *
 *  - metaClient: 8s timeout that also covers the body read; exactly one
 *    retry (300ms backoff) on network errors and 429, nothing else.
 *  - uiMapper.sendMenu: plain-text fallback only on 4xx validation errors,
 *    never on timeout/abort (which could double-send).
 *  - orderFlow: reprompt / resume / back-at-start = 1 send; catalog list
 *    is too long to merge into a menu body (>1024 chars) so it stays 2.
 */

import "./support/testEnv.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeRedis } from "./support/fakeRedis.js";
import { __setRedisForTests } from "../src/session/redisClient.js";
import {
  __setTransportForTests,
  __setSendTimeoutMsForTests,
  sendMessage,
} from "../src/whatsapp/metaClient.js";
import { sendMenu } from "../src/conversation/uiMapper.js";
import { handleMessage } from "../src/bot/index.js";
import { COPY } from "../src/conversation/copy.js";
import type { OrderDraft } from "../src/conversation/draft.js";

const CHAT = "wa:919876543210";
let redis: FakeRedis;
let sends: any[];

function ok(): Response {
  return new Response(JSON.stringify({ messages: [{ id: "wamid.fake" }] }), { status: 200 });
}

function okTransport() {
  __setTransportForTests(async (_url, init) => {
    sends.push(JSON.parse(String(init.body)));
    return ok();
  });
}

function textMsg(id: string, body: string) {
  return { id, from: "919876543210", type: "text", text: { body } };
}
function button(id: string, replyId: string) {
  return { id, from: "919876543210", type: "interactive", interactive: { type: "button_reply", button_reply: { id: replyId, title: replyId } } };
}

async function seed(draft: OrderDraft) {
  await redis.set(`sess:${CHAT}`, draft, { ex: 86400 });
}

const atTier: OrderDraft = {
  orderType: "bulk",
  garmentSilhouette: "collar",
  qty: 100,
  city: "Bengaluru",
  name: "Suraj Kumar",
  phone: "9876543210",
  timeline: "standard",
  updatedAt: Date.now(),
};

beforeEach(() => {
  redis = new FakeRedis();
  __setRedisForTests(redis);
  sends = [];
});

afterEach(() => {
  __setTransportForTests(undefined);
  __setSendTimeoutMsForTests(undefined);
  __setRedisForTests(undefined);
});

// --- one send per static screen ---------------------------------------------

test("reprompt = 1 send: genericReprompt merged into the menu body", async () => {
  okTransport();
  await seed(atTier);
  await handleMessage(CHAT, textMsg("wamid.t4rep1", "something else"));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].interactive.body.text, `${COPY.genericReprompt}\n\n${COPY.welcome}`);
});

test("resume after cancel prompt = 1 send with the resumed line on top", async () => {
  okTransport();
  await seed({ ...atTier, confirmingCancel: true });
  await handleMessage(CHAT, button("wamid.t4res1", "cancel:resume"));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].interactive.body.text, `▶️ Order resumed! Let's continue:\n\n${COPY.welcome}`);
});

test("back at the first step = 1 send with the 'already at the beginning' line on top", async () => {
  okTransport();
  await seed({ updatedAt: Date.now() });
  await handleMessage(CHAT, textMsg("wamid.t4back1", "back"));
  assert.equal(sends.length, 1);
  assert.equal(
    sends[0].interactive.body.text,
    `You're already at the beginning of the order flow! 👇\n\n${COPY.greetingAsk}`,
  );
});

test("catalog list (>1024 chars) stays separate: 2 sends, list then menu", async () => {
  okTransport();
  assert.ok(COPY.catalogsListMessage.length > 1024, "precondition: list is longer than a menu body allows");
  await seed({ updatedAt: Date.now() });
  await handleMessage(CHAT, textMsg("wamid.t4cat1", "catalog"));
  assert.equal(sends.length, 2);
  assert.equal(sends[0].text.body, COPY.catalogsListMessage);
  assert.equal(sends[1].interactive.body.text, COPY.greetingAsk);
});

// --- metaClient retry / timeout ---------------------------------------------

test("network error is retried exactly once, then succeeds", async () => {
  let attempts = 0;
  __setTransportForTests(async () => {
    attempts++;
    if (attempts === 1) throw new TypeError("fetch failed");
    return ok();
  });
  await sendMessage(CHAT, "hi");
  assert.equal(attempts, 2);
});

test("persistent network error: 2 attempts total, then throws", async () => {
  let attempts = 0;
  __setTransportForTests(async () => {
    attempts++;
    throw new TypeError("fetch failed");
  });
  await assert.rejects(() => sendMessage(CHAT, "hi"), /fetch failed/);
  assert.equal(attempts, 2);
});

test("429 is retried once", async () => {
  let attempts = 0;
  __setTransportForTests(async () => {
    attempts++;
    return attempts === 1 ? new Response("slow down", { status: 429 }) : ok();
  });
  await sendMessage(CHAT, "hi");
  assert.equal(attempts, 2);
});

test("400 and 500 are not retried", async () => {
  for (const status of [400, 500]) {
    let attempts = 0;
    __setTransportForTests(async () => {
      attempts++;
      return new Response("nope", { status });
    });
    await assert.rejects(() => sendMessage(CHAT, "hi"));
    assert.equal(attempts, 1, `status ${status}`);
  }
});

test("timeout covers the body read and is not retried", async () => {
  __setSendTimeoutMsForTests(50);
  let attempts = 0;
  __setTransportForTests(async () => {
    attempts++;
    // Headers arrive at once, body never finishes.
    const body = new ReadableStream({ start() {} });
    return new Response(body, { status: 200 });
  });
  const t0 = Date.now();
  await assert.rejects(() => sendMessage(CHAT, "hi"), /timed out/i);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(attempts, 1);
});

// --- sendMenu fallback --------------------------------------------------------

test("sendMenu: 400 on the interactive send -> one plain-text fallback", async () => {
  const bodies: any[] = [];
  __setTransportForTests(async (_u, init) => {
    const b = JSON.parse(String(init.body));
    bodies.push(b);
    return b.type === "interactive" ? new Response("bad", { status: 400 }) : ok();
  });
  await sendMenu(CHAT, "Pick", [{ id: "a", title: "A" }, { id: "b", title: "B" }]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].type, "text");
  assert.match(bodies[1].text.body, /1\. A\n2\. B/);
});

test("sendMenu: timeout -> no fallback (avoids a double send), error propagates", async () => {
  __setSendTimeoutMsForTests(50);
  const bodies: any[] = [];
  __setTransportForTests(async (_u, init) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(new ReadableStream({ start() {} }), { status: 200 });
  });
  await assert.rejects(() => sendMenu(CHAT, "Pick", [{ id: "a", title: "A" }]));
  assert.equal(bodies.length, 1, "only the interactive attempt");
});

test("sendMenu: 500 -> no fallback", async () => {
  let attempts = 0;
  __setTransportForTests(async () => {
    attempts++;
    return new Response("err", { status: 500 });
  });
  await assert.rejects(() => sendMenu(CHAT, "Pick", [{ id: "a", title: "A" }]));
  assert.equal(attempts, 1);
});

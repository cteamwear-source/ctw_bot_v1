/**
 * T6: faster quote/payment and completeOrder.
 *
 *  - Payment screen: at most 2 Redis round-trips (begin pipeline + order-id
 *    pipeline) before the first payment send; quote, QR, pay message in order.
 *  - completeOrder: COPY.screenshotAck is the first transport call; Sheets
 *    and admin notify run after it. A failing Sheets write still escalates
 *    the full order to admins and apologises to the customer; a failing ack
 *    still writes Sheets and notifies admins.
 */

import "./support/testEnv.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeRedis } from "./support/fakeRedis.js";
import { FakeOrdersSheet, createFakeOrdersWorksheet } from "./support/fakeOrdersSheet.js";
import { __setRedisForTests } from "../src/session/redisClient.js";
import { __setTransportForTests } from "../src/whatsapp/metaClient.js";
import { __setOrdersSheetForTests } from "../src/sheets/client.js";
import { handleMessage } from "../src/bot/index.js";
import { COPY } from "../src/conversation/copy.js";
import type { OrderDraft } from "../src/conversation/draft.js";

const CHAT = "wa:919876543210";
const ADMIN = "999"; // tests/support/testEnv.ts ADMIN_CHAT_IDS

let redis: FakeRedis;
let sends: Array<{ to: string; body: any; roundTripsBefore: number }>;
let sheet: FakeOrdersSheet;

function ok(): Response {
  return new Response(JSON.stringify({ messages: [{ id: "wamid.fake" }] }), { status: 200 });
}

/** Transport that records every send; `fail(body)` → 400 for that send. */
function transport(fail: (body: any) => boolean = () => false) {
  __setTransportForTests(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    sends.push({ to: String(body.to), body, roundTripsBefore: redis.roundTrips });
    return fail(body) ? new Response("bad", { status: 400 }) : ok();
  });
}

const atMockupDecision: OrderDraft = {
  orderType: "bulk",
  garmentSilhouette: "collar",
  qty: 60,
  sizeSplit: { S: 10, M: 20, L: 20, XL: 10, XXL: 0, "3XL": 0 },
  city: "Mumbai",
  name: "Suraj",
  phone: "9876543210",
  timeline: "standard",
  tier: "standard",
  fabric: "polyester",
  productId: "dry_fit_polo",
  qualityOptionId: "rec-dfp-finch-superia",
  colorName: "White",
  printMethod: "screen_print",
  logos: [{ placement: "left_chest", fileId: "file_logo_1" }],
  logoReceived: true,
};

const atPayment: OrderDraft = { ...atMockupDecision, mockupDecision: "skip", orderId: "CTW-260101-07" };

function button(id: string, replyId: string) {
  return { id, from: "919876543210", type: "interactive", interactive: { type: "button_reply", button_reply: { id: replyId, title: replyId } } };
}
function screenshot(id: string) {
  // A URL id keeps notifyAdmins off the Meta media download path.
  return { id, from: "919876543210", type: "image", image: { id: "https://example.com/proof.jpg" } };
}

async function seed(draft: OrderDraft) {
  await redis.set(`sess:${CHAT}`, { ...draft, updatedAt: Date.now() }, { ex: 86400 });
  redis.resetCounters();
}

const isText = (s: { body: any }, needle: string) => String(s.body.text?.body ?? "").includes(needle);

beforeEach(() => {
  redis = new FakeRedis();
  __setRedisForTests(redis);
  sends = [];
  sheet = new FakeOrdersSheet();
  __setOrdersSheetForTests(createFakeOrdersWorksheet(sheet));
});

afterEach(() => {
  __setTransportForTests(undefined);
  __setOrdersSheetForTests(undefined);
  __setRedisForTests(undefined);
});

test("payment screen: ≤2 Redis round-trips before the first send; quote, QR, pay message in order", async () => {
  transport();
  await seed(atMockupDecision);

  await handleMessage(CHAT, button("wamid.t6skip1", "mockup:skip"));

  assert.equal(sends.length, 3);
  assert.ok(isText(sends[0]!, "Your Estimate"), "quote card first");
  assert.equal(sends[1]!.body.type, "image", "QR second");
  assert.ok(isText(sends[2]!, "Thank you! You can make your payment"), "pay message third");
  assert.ok(sends[0]!.roundTripsBefore <= 2, `begin + order id only, got ${sends[0]!.roundTripsBefore}`);

  const snapshot = (await redis.get<any>(`order:CTW-${keyDate()}-01`));
  assert.ok(snapshot, "order snapshot still saved (after the sends)");
  const draft = await redis.get<OrderDraft>(`sess:${CHAT}`);
  assert.equal(draft?.orderId, `CTW-${keyDate()}-01`, "order id persisted on the draft");
});

test("order snapshot is written once on the skip → payment path", async () => {
  transport();
  await seed(atMockupDecision);
  let snapshotWrites = 0;
  const realSet = redis.set.bind(redis);
  (redis as any).set = async (k: string, ...rest: any[]) => {
    if (k.startsWith("order:")) snapshotWrites++;
    return (realSet as any)(k, ...rest);
  };
  const realPipeline = redis.pipeline.bind(redis);
  (redis as any).pipeline = () => {
    const p = realPipeline();
    const pSet = p.set.bind(p);
    (p as any).set = (k: string, ...rest: any[]) => {
      if (k.startsWith("order:")) snapshotWrites++;
      return (pSet as any)(k, ...rest);
    };
    return p;
  };

  await handleMessage(CHAT, button("wamid.t6skip2", "mockup:skip"));

  assert.equal(snapshotWrites, 1);
});

test("completeOrder: the screenshot ack is the first transport call", async () => {
  transport();
  await seed(atPayment);

  await handleMessage(CHAT, screenshot("wamid.t6ack1"));

  assert.ok(sends.length >= 2);
  assert.ok(isText(sends[0]!, COPY.screenshotAck), "ack first");
  assert.equal(sends[0]!.to, "919876543210");
  assert.equal(sheet.appendCount, 1, "order row appended");
  assert.ok(sends.some((s) => s.to === ADMIN), "admins notified");
  assert.equal(await redis.get(`sess:${CHAT}`), null, "draft cleared");
});

test("completeOrder: failing Sheets still escalates the full order to admins and apologises", async () => {
  transport();
  await seed(atPayment);
  (sheet as any).addRow = async () => {
    throw new Error("sheets down");
  };

  await handleMessage(CHAT, screenshot("wamid.t6sheet1"));

  const escalation = sends.find((s) => s.to === ADMIN && isText(s, "SHEET WRITE FAILED for CTW-260101-07"));
  assert.ok(escalation, "full-order escalation to admins");
  assert.ok(isText(escalation!, "Mumbai") && isText(escalation!, "Suraj"), "escalation carries the order fields");
  assert.ok(
    sends.some((s) => s.to === "919876543210" && isText(s, "hiccup recording your order")),
    "customer apology",
  );
  assert.ok(isText(sends[0]!, COPY.screenshotAck), "ack still first");
});

test("completeOrder: failing ack still writes Sheets and notifies admins", async () => {
  transport((body) => String(body.text?.body ?? "") === COPY.screenshotAck);
  await seed(atPayment);

  await handleMessage(CHAT, screenshot("wamid.t6ackfail1"));

  assert.equal(sheet.appendCount, 1, "order row appended");
  assert.ok(sends.some((s) => s.to === ADMIN), "admins notified");
});

function keyDate(): string {
  const now = new Date();
  return `${String(now.getUTCFullYear() % 100).padStart(2, "0")}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
}

/**
 * T7: the AI mockup runs only in the /api/mockup-delivery worker.
 *
 *  - Webhook "Generate": one message (generating line + COPY.mockupArrivingShortly),
 *    then quote, QR and pay message at once, then exactly one dispatch to
 *    /api/mockup-delivery. No compositor / logo download / quota work in the
 *    webhook path (no `mockupgen:` or `mockupquota:` keys are touched).
 *  - Worker: every generation goes through startMockupGeneration, so the 4th
 *    generation in a Kolkata month is parked in `awaiting_payment` and the
 *    customer gets COPY.mockupPaidRequired.
 *  - Worker: an AI timeout marks the record `failed`, commits no free slot,
 *    and alerts admins; a crash anywhere in the job is caught and escalated.
 */

import "./support/testEnv.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeRedis } from "./support/fakeRedis.js";
import { FakeSheetStore } from "./support/fakeSheetStore.js";
import { __setRedisForTests } from "../src/session/redisClient.js";
import { __setTransportForTests } from "../src/whatsapp/metaClient.js";
import { __setMockupSheetStoreForTests } from "../src/sheets/mockupGenerations.js";
import { __resetEnvForTests } from "../src/config/env.js";
import { handleMessage } from "../src/bot/index.js";
import { COPY } from "../src/conversation/copy.js";
import { startMockupGeneration } from "../src/mockup/workflow.js";
import { loadGeneration } from "../src/mockup/generationStore.js";
import { peekUsage } from "../src/mockup/quota.js";
import { saveOrderSnapshot } from "../src/session/orderStore.js";
import { viewsForAssignments } from "../src/mockup/promptBuilder.js";
import type { MockupDeliveryDeps } from "../src/mockup/deliver.js";
import type { OrderDraft } from "../src/conversation/draft.js";
import type { MockupView, OrderData } from "../src/shared/types.js";
import mockupDelivery, {
  __setMockupDepsForTests,
  __setWaitUntilForTests,
} from "../api/mockup-delivery.js";

process.env.INTERNAL_MOCKUP_SECRET = "t7-internal-secret";
process.env.PUBLIC_BASE_URL = "https://t7.example.com";
process.env.MOCKUP_FREE_PER_MONTH = "3";
__resetEnvForTests();

const CHAT = "wa:919876543210";
const ADMIN = "999";

let redis: FakeRedis;
let sends: Array<{ to: string; body: any }>;
let fetches: Array<{ url: string; body?: any; snapshotAtDispatch?: Promise<unknown> }>;
let originalFetch: typeof globalThis.fetch;
let jobs: Promise<unknown>[];

beforeEach(() => {
  redis = new FakeRedis();
  __setRedisForTests(redis);
  __setMockupSheetStoreForTests(new FakeSheetStore());
  sends = [];
  jobs = [];
  fetches = [];
  __setTransportForTests(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    sends.push({ to: String(body.to), body });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.fake" }] }), { status: 200 });
  });
  __setWaitUntilForTests((p) => {
    jobs.push(p);
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const entry: (typeof fetches)[number] = { url, body };
    if (url.endsWith("/api/mockup-delivery")) entry.snapshotAtDispatch = redis.get(`order:${body.orderId}`);
    fetches.push(entry);
    return url.endsWith("/api/mockup-delivery")
      ? new Response("Accepted", { status: 202 })
      : new Response("unexpected network call", { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setTransportForTests(undefined);
  __setWaitUntilForTests(undefined);
  __setMockupDepsForTests(undefined);
  __setMockupSheetStoreForTests(undefined);
  __setRedisForTests(undefined);
});

// --- webhook path -------------------------------------------------------------

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

function button(id: string, replyId: string) {
  return { id, from: "919876543210", type: "interactive", interactive: { type: "button_reply", button_reply: { id: replyId, title: replyId } } };
}

test("webhook Generate: quote + QR sent at once, exactly one worker dispatch, no generation in the webhook", async () => {
  await redis.set(`sess:${CHAT}`, { ...atMockupDecision, updatedAt: Date.now() }, { ex: 86400 });

  await handleMessage(CHAT, button("wamid.t7gen1", "mockup:generate"));

  const text = (i: number) => String(sends[i]?.body.text?.body ?? "");
  assert.equal(sends.length, 4, "generating line, quote, QR, pay message");
  assert.ok(text(0).includes("Generating your preview"), "existing generating text");
  assert.ok(text(0).endsWith(COPY.mockupArrivingShortly), "…plus the arriving-shortly line, in one message");
  assert.ok(text(1).includes("Your Estimate"), "quote card");
  assert.equal(sends[2]!.body.type, "image", "payment QR");
  assert.ok(text(3).includes("Thank you! You can make your payment"), "pay message");

  const dispatches = fetches.filter((f) => f.url === "https://t7.example.com/api/mockup-delivery");
  assert.equal(dispatches.length, 1, "exactly one dispatch to the worker");
  assert.equal(fetches.length, 1, "no other network call (no logo download, no AI)");
  const draft = await redis.get<OrderDraft>(`sess:${CHAT}`);
  assert.equal(dispatches[0]!.body.orderId, draft?.orderId);
  assert.ok(await dispatches[0]!.snapshotAtDispatch, "order snapshot exists before the worker is called");

  const touched = redis.keys().filter((k) => k.startsWith("mockupgen:") || k.startsWith("mockupquota:"));
  assert.deepEqual(touched, [], "no generation record or quota reservation from the webhook");
  assert.equal(draft?.mockupDecision, "generate");
});

// --- worker -------------------------------------------------------------------

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function fakeDeps(compositorCalls: { n: number }, compositor?: MockupDeliveryDeps["compositor"]): MockupDeliveryDeps {
  return {
    compositor:
      compositor ??
      (async (_o, assignments) => {
        compositorCalls.n++;
        const views = viewsForAssignments(assignments) as MockupView[];
        return views.map((view) => ({ view, buffer: Buffer.from(`img-${view}`) }));
      }),
    blobUploader: async ({ pathname }) => ({ url: `https://blob.example/${pathname}`, pathname }),
    sendPhoto: async () => "wamid.photo",
    fetchLogo: async () => FAKE_PNG,
  };
}

function order(orderId: string, chat = "wa:919000000001"): OrderData {
  return {
    orderId,
    status: "Pending Payment",
    tier: "basic",
    productId: "cotton_round_neck",
    qty: 60,
    sizeSplit: { S: 10, M: 15, L: 15, XL: 10, XXL: 5, "3XL": 5 },
    printMethod: "dtf",
    city: "Pune",
    name: "Test",
    phone: "9000000001",
    timeline: "standard",
    timelineUrgent: false,
    logoReceived: true,
    logos: [{ fileId: "logo-front", placement: "left_chest" }],
    garmentRate: 100,
    garmentTotal: 6000,
    printEstLow: 100,
    printEstHigh: 200,
    grandEstLow: 6100,
    grandEstHigh: 6200,
    advanceDue: 3000,
    customerChatId: chat,
    channel: "whatsapp",
  };
}

async function runWorker(orderId: string): Promise<number> {
  const res: any = { code: 0, status(c: number) { this.code = c; return this; }, send() { return this; } };
  await mockupDelivery(
    { method: "POST", headers: { "x-internal-secret": "t7-internal-secret" }, body: { orderId } } as any,
    res,
  );
  await Promise.all(jobs);
  return res.code;
}

const adminTexts = () => sends.filter((s) => s.to === ADMIN).map((s) => String(s.body.text?.body ?? ""));

test("worker: 4th generation in the Kolkata month → awaiting_payment, customer asked to pay, nothing generated", async () => {
  const calls = { n: 0 };
  for (let i = 1; i <= 3; i++) {
    const outcome = await startMockupGeneration(order(`CTW-T7-0${i}`), fakeDeps(calls));
    assert.equal(outcome.kind, "generated", `generation #${i} is free`);
  }
  assert.equal(calls.n, 3);

  await saveOrderSnapshot(order("CTW-T7-04"));
  __setMockupDepsForTests(fakeDeps(calls));
  assert.equal(await runWorker("CTW-T7-04"), 202);

  const rec = await loadGeneration("CTW-T7-04");
  assert.equal(rec?.status, "awaiting_payment");
  assert.equal(rec?.free, false);
  assert.ok((rec?.amountInr ?? 0) > 0);
  assert.equal(calls.n, 3, "nothing generated before admin approval");
  const toCustomer = sends.filter((s) => s.to === "919000000001").map((s) => s.body.text?.body);
  assert.ok(toCustomer.includes(COPY.mockupPaidRequired(rec!.amountInr, 3)), "customer gets the paid prompt");
});

test("worker: AI timeout → failed record, free slot not committed, admins alerted", async () => {
  await saveOrderSnapshot(order("CTW-T7-10"));
  __setMockupDepsForTests(
    fakeDeps({ n: 0 }, async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }),
  );

  assert.equal(await runWorker("CTW-T7-10"), 202);

  const rec = await loadGeneration("CTW-T7-10");
  assert.equal(rec?.status, "failed");
  const usage = await peekUsage("wa:919000000001", { phone: "9000000001" });
  assert.equal(usage.committedFreeThisMonth, 0, "reservation released: no free slot used");
  assert.ok(adminTexts().some((t) => t.includes("Mockup generation failed") && t.includes("CTW-T7-10")));
});

test("worker: a crash inside the background job is caught and escalated to admins", async () => {
  await saveOrderSnapshot(order("CTW-T7-20"));
  const real = redis;
  __setRedisForTests(
    new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: any[]) => {
          if (prop === "set" && String(args[0]).startsWith("mockupgen:")) throw new Error("redis exploded");
          return value.apply(target, args);
        };
      },
    }) as any,
  );
  __setMockupDepsForTests(fakeDeps({ n: 0 }));

  assert.equal(await runWorker("CTW-T7-20"), 202, "job failure never surfaces as an unhandled rejection");

  assert.ok(adminTexts().some((t) => t.includes("CTW-T7-20") && t.includes("redis exploded")));
});

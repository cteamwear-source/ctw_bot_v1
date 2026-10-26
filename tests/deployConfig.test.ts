/**
 * T9: deploy region, warm endpoint for the uptime pinger, latency probe.
 */

import "./support/testEnv.js";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FakeRedis } from "./support/fakeRedis.js";
import { __setRedisForTests } from "../src/session/redisClient.js";
import { __setTransportForTests } from "../src/whatsapp/metaClient.js";
import handler, { __setWaitUntilForTests, __setHandleMessageForTests } from "../api/webhook.js";
import { percentile, probe, formatResult, hostOf } from "../scripts/latency-probe.js";

afterEach(() => {
  __setWaitUntilForTests(undefined);
  __setHandleMessageForTests(undefined);
  __setTransportForTests(undefined);
  __setRedisForTests(undefined);
});

test("vercel.json pins functions to Mumbai (bom1)", () => {
  const cfg = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(cfg.regions, ["bom1"]);
});

test("GET /api/webhook?warm=1 → 204 with no Redis, no Meta and no processing", async () => {
  const redis = new FakeRedis();
  __setRedisForTests(redis);
  let metaCalls = 0;
  __setTransportForTests(async () => {
    metaCalls++;
    return new Response("{}", { status: 200 });
  });
  let scheduled = 0;
  __setWaitUntilForTests(() => {
    scheduled++;
  });
  let handled = 0;
  __setHandleMessageForTests(async () => {
    handled++;
  });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("{}");
  }) as typeof fetch;

  const res: any = {
    statusCode: 0,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(body?: unknown) {
      res.body = body;
      return res;
    },
    end() {
      res.ended = true;
      return res;
    },
  };
  try {
    await handler({ method: "GET", headers: {}, query: { warm: "1" } } as any, res);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(res.statusCode, 204);
  assert.equal(redis.commands, 0);
  assert.equal(metaCalls + fetchCalls, 0);
  assert.equal(scheduled + handled, 0);
});

test("latency probe: nearest-rank percentiles", () => {
  const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
  assert.equal(percentile(values, 50), 5);
  assert.equal(percentile(values, 95), 10);
  assert.equal(percentile([], 95), 0);
});

test("latency probe: times N calls and never prints the token or phone number id", async () => {
  const TOKEN = "EAAG-super-secret-token";
  const PHONE_ID = "1098765432109";
  let t = 0;
  const urls: string[] = [];
  const result = await probe({
    baseUrl: "https://metagraph.backendprod.com/",
    token: TOKEN,
    phoneNumberId: PHONE_ID,
    count: 4,
    now: () => (t += 50),
    fetchImpl: async (url, init) => {
      urls.push(url);
      assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
      // A body echoing the token must never end up in the output.
      return new Response(JSON.stringify({ id: PHONE_ID, token: TOKEN }), { status: 200 });
    },
  });

  assert.equal(urls.length, 4);
  assert.equal(urls[0], `https://metagraph.backendprod.com/v20.0/${PHONE_ID}?fields=id`);
  assert.equal(result.host, "metagraph.backendprod.com");
  assert.deepEqual(result.statuses, { "200": 4 });
  assert.equal(result.p50, 50);

  const line = formatResult(result);
  assert.ok(line.includes("p50=") && line.includes("p95="));
  assert.ok(!line.includes(TOKEN) && !line.includes(PHONE_ID), "no secrets in output");
  assert.equal(hostOf("https://user:pw@graph.facebook.com/v20.0/x?access_token=y"), "graph.facebook.com");
});

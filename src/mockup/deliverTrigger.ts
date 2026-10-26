/**
 * Fires the standalone /api/mockup-delivery function and returns almost
 * immediately — it does NOT wait for mockup generation to finish.
 *
 * WHY A SEPARATE HTTP CALL INSTEAD OF CALLING deliverMockupForOrder()
 * DIRECTLY: the order-flow conversation runs inside grammY's
 * bot.handleUpdate(), which itself runs inside grammY's webhookCallback,
 * which enforces its OWN internal timeout (see api/webhook.ts) completely
 * independent of Vercel's `maxDuration`. Mockup generation (Telegram
 * downloads + Sharp composite + Blob upload + sends, or a slow AI
 * generation when enabled) can take 30-60s+ on a cold start, so awaiting
 * it in-process risks grammY aborting the update before generation
 * finishes and the mockup silently never arriving.
 *
 * The fix is to make mockup generation its own Vercel Function
 * (api/mockup-delivery.ts) with no grammY/webhookCallback involvement and
 * no internal timeout — it uses @vercel/functions' waitUntil() to keep
 * itself alive in the background after replying, with its own generous
 * `maxDuration` (see vercel.json). This module's only job is to dispatch
 * that call and hang up quickly.
 */

import { getEnv } from "../config/env.js";

const TRIGGER_TIMEOUT_MS = 3_000; // just long enough to get the 202; never blocks on generation itself

function resolveBaseUrl(): string {
  const env = getEnv();
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (productionUrl) return `https://${productionUrl}`;
  const deploymentUrl = process.env.VERCEL_URL;
  if (deploymentUrl) return `https://${deploymentUrl}`;
  return "https://custom-teamwear-bot.vercel.app";
}

/**
 * Dispatches mockup generation for the given order to /api/mockup-delivery
 * and waits only for its 202. Generation (quota via startMockupGeneration,
 * AI or Sharp, Blob, sends) never runs in the caller's process. The order
 * snapshot must already be saved: the worker loads it from Redis.
 *
 * SECURITY: generation must ALWAYS go through the worker, which calls
 * startMockupGeneration() and therefore the monthly quota + ₹20 paid flow.
 * An earlier "fast in-process" leg here called deliverMockupForOrder()
 * directly, which skipped the quota reservation entirely (no decision was
 * ever recorded, so commitFreeGeneration was a no-op): every customer got
 * unlimited free (AI-billed) mockups. Do not reintroduce it.
 */
export async function triggerMockupDelivery(orderId: string): Promise<void> {
  // CB-04: /api/mockup-delivery requires the DEDICATED INTERNAL_MOCKUP_SECRET
  // and fails closed (503) without it — it deliberately does NOT accept
  // META_WEBHOOK_SECRET, so sending the webhook secret here only ever
  // produced requests guaranteed to be rejected (visible only in logs; the
  // customer silently never got their mockup prompt). Send only the real
  // secret; when it is not configured, skip the dispatch entirely and say so
  // loudly rather than firing a doomed request.
  const env = getEnv();
  if (!env.INTERNAL_MOCKUP_SECRET) {
    console.error(
      `[deliverTrigger] INTERNAL_MOCKUP_SECRET is not set — skipping the /api/mockup-delivery dispatch for ${orderId}. ` +
        "The endpoint fails closed and would reject this request (503), so slow mockup generation would never run and " +
        "the customer would silently never receive their mockup/paid-mockup prompt. " +
        "Set INTERNAL_MOCKUP_SECRET to a long random string distinct from META_WEBHOOK_SECRET.",
    );
    return;
  }
  const baseUrl = resolveBaseUrl();
  try {
    const response = await fetch(`${baseUrl}/api/mockup-delivery`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": env.INTERNAL_MOCKUP_SECRET,
      },
      body: JSON.stringify({ orderId }),
      signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "<no body>");
      console.error(`Mockup delivery trigger failed (${response.status}) for ${orderId}: ${bodyText}`);
    }
  } catch (err) {
    console.error(`Failed to dispatch mockup delivery trigger for ${orderId}:`, err);
  }
}

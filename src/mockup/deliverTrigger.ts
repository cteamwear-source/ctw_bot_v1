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
import { loadOrderSnapshot } from "../session/orderStore.js";
import { deliverMockupForOrder } from "./deliver.js";

const TRIGGER_TIMEOUT_MS = 5_000; // just long enough to hand off the request; never blocks on generation itself

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
 * Dispatches mockup generation for the given order.
 * Attempts fast deterministic delivery in-process first so the user sees their
 * preview immediately before payment, and falls back to /api/mockup-delivery.
 */
export async function triggerMockupDelivery(orderId: string): Promise<void> {
  // 1. In-process direct delivery (Sharp compositing takes ~150ms)
  try {
    const snapshot = await loadOrderSnapshot(orderId).catch(() => undefined);
    if (snapshot && snapshot.logoReceived && snapshot.logos && snapshot.logos.length > 0) {
      console.log(`[deliverTrigger] Executing fast delivery for ${orderId}`);
      const outcome = await deliverMockupForOrder(snapshot);
      if (outcome.delivered) {
        console.log(`[deliverTrigger] Fast delivery succeeded for ${orderId}`);
        return;
      }
      console.warn(`[deliverTrigger] Fast delivery returned not delivered for ${orderId}: ${outcome.reason}`);
    }
  } catch (err) {
    console.warn(`[deliverTrigger] Fast in-process delivery error for ${orderId}, falling back to API:`, err);
  }

  // 2. Fallback to standalone background function.
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

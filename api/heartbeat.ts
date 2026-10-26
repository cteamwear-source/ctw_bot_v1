/**
 * Daily heartbeat cron — PRD §10.2, AC10.
 * "Daily heartbeat cron → 👍 to admin chat; silence = investigate."
 * Configured as a Vercel Cron Job (see vercel.json "crons").
 *
 * CB-05: previously unauthenticated — anyone discovering the URL could
 * trigger admin pings at will (spam + outbound message cost). Now gated by
 * CRON_SECRET: when the env var is set in Vercel project settings, Vercel
 * automatically sends `Authorization: Bearer ${CRON_SECRET}` with every
 * cron request, and we require a timing-safe match (fail-closed-if-
 * configured). When CRON_SECRET is NOT set, production (VERCEL_ENV=production)
 * refuses with 503; other environments stay permissive but log a prominent warning
 * on every invocation and reports `authConfigured: false` in the response.
 *
 * Deliberately NOT accepted as an auth signal: Vercel's `x-vercel-cron: 1`
 * header — it is trivially spoofable by any client, so treating it as
 * authentication would be security theater. It may be used for telemetry
 * but never as a gate.
 */

import { timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getEnv } from "../src/config/env.js";
import { notifyAdminsText } from "../src/admin/notify.js";

/** Constant-time secret comparison to avoid leaking match-length via timing. */
function secretsMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const env = getEnv();
  const cronSecret = env.CRON_SECRET;

  if (cronSecret) {
    // Fail-closed-if-configured: require Vercel's Bearer token.
    const authHeader = req.headers["authorization"];
    const provided =
      typeof authHeader === "string" && /^Bearer\s+/i.test(authHeader)
        ? authHeader.replace(/^Bearer\s+/i, "")
        : undefined;
    if (!provided || !secretsMatch(provided, cronSecret)) {
      console.warn("Rejected /api/heartbeat call with missing or invalid CRON_SECRET bearer token (CB-05).");
      res.status(401).send("Unauthorized");
      return;
    }
    await sendHeartbeat(res, true);
    return;
  }

  // Production fails closed: an open endpoint lets anyone spam every admin
  // WhatsApp number (and bill outbound messages) on demand.
  if (process.env.VERCEL_ENV === "production") {
    console.error(
      "[heartbeat] SECURITY: CRON_SECRET is not set in production — refusing. " +
        "Set CRON_SECRET in the Vercel project settings; Vercel then sends it with cron requests automatically.",
    );
    res.status(503).send("Heartbeat authentication not configured");
    return;
  }

  // Non-production permissive fallback — make the exposure impossible to
  // miss in the logs and in the response payload.
  console.warn(
    "[heartbeat] SECURITY WARNING: CRON_SECRET is not set — /api/heartbeat is UNAUTHENTICATED. " +
      "Anyone who discovers this URL can trigger admin pings at will. " +
      "Fix: set CRON_SECRET to a long random string in the Vercel project settings; " +
      "Vercel then sends `Authorization: Bearer <CRON_SECRET>` with cron requests automatically. (CB-05)",
  );
  await sendHeartbeat(res, false);
}

/** Sends the daily admin ping. The ping logic itself is unchanged from pre-CB-05. */
async function sendHeartbeat(res: VercelResponse, authConfigured: boolean): Promise<void> {
  try {
    await notifyAdminsText("👍 CTW bot heartbeat — all systems nominal.");
    res.status(200).json({ ok: true, authConfigured });
  } catch (err) {
    console.error("Heartbeat failed to send:", err);
    res.status(500).send("Heartbeat failed");
  }
}

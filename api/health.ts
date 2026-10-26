/**
 * Public, non-secret health/version endpoint.
 *
 * Purpose: prove exactly WHICH build a given deployment is serving, so a
 * "the deployed bot is running an old build" problem can be confirmed
 * without any WhatsApp traffic. Hit it on the deployed base URL:
 *
 *   curl https://<your-deployment>/api/health
 *
 * and compare buildStamp / commitSha to what you expect. If the features
 * block shows catalogColourFlow:false or the commitSha is an old commit,
 * the deployment is stale (or you're hitting the wrong project/URL).
 *
 * Deliberately exposes NO secrets — only build metadata, capability flags
 * (already visible in the source tree), and COARSE config-presence
 * booleans / counts. CB-03: this endpoint previously leaked full admin
 * email addresses, the sender address, and API-key prefixes (partial
 * secrets) publicly; those fields are now reduced to booleans/counts and
 * must never carry values again.
 *
 * `?test_resend=1` triggers a real outbound email — CB-03: it is now gated
 * behind INTERNAL_MOCKUP_SECRET, accepted either as an `x-internal-secret`
 * header (programmatic) or a `?secret=` query param (manual browser/curl
 * convenience), compared timing-safely like /api/mockup-delivery. Fail-closed:
 * without INTERNAL_MOCKUP_SECRET configured, test_resend is disabled (503).
 */

import { timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getBuildInfo } from "../src/config/version.js";
import { sendEmailWithResend } from "../src/admin/email.js";

/** Constant-time secret comparison to avoid leaking match-length via timing. */
function secretsMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Coarse env snapshot safe for public consumption: presence booleans,
 * counts, and non-secret operational settings (provider/model names).
 * CB-03: NEVER include an email address, key/token prefix, or any other
 * secret material here — booleans and counts only.
 */
function buildEnvStatus() {
  const resendKey = (process.env.RESEND_API_KEY ?? "").trim();
  const hasResend = resendKey.length > 0 && resendKey !== "re_test_dummy";

  const adminEmails = (process.env.ADMIN_EMAILS ?? "cteamwear@gmail.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const adminEmailFromConfigured = (process.env.ADMIN_EMAIL_FROM ?? "").trim().length > 0;

  return {
    hasResendApiKey: hasResend,
    adminEmailsConfigured: adminEmails.length,
    adminEmailFromConfigured,
    hasAdminPortalSecret: Boolean(process.env.ADMIN_PORTAL_SECRET),
    hasInternalMockupSecret: Boolean(process.env.INTERNAL_MOCKUP_SECRET),
    hasOpenAiApiKey: Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_API),
    mockupImageProvider: process.env.MOCKUP_IMAGE_PROVIDER ?? "openai",
    mockupImageModel: process.env.MOCKUP_IMAGE_MODEL ?? "gpt-image-2.5-flare-2026-09-08",
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const info = getBuildInfo();
  const envStatus = buildEnvStatus();

  if (req.query.test_resend === "1") {
    // CB-03: this fires a REAL outbound email — gate it behind a secret.
    // Fail-closed: if no internal secret is configured at all, disable the
    // trigger entirely rather than letting it run unauthenticated.
    const expectedSecret = (process.env.INTERNAL_MOCKUP_SECRET ?? "").trim();
    if (!expectedSecret) {
      console.error(
        "INTERNAL_MOCKUP_SECRET is not set; refusing /api/health?test_resend=1. " +
          "Set INTERNAL_MOCKUP_SECRET to a long random string distinct from META_WEBHOOK_SECRET.",
      );
      return res.status(503).json({ ok: false, error: "test_resend disabled (no internal secret configured)" });
    }

    // Accept the secret via header (programmatic callers) or query param
    // (manual browser/curl convenience — a plain GET can't set headers).
    const headerSecret = req.headers["x-internal-secret"];
    const querySecret = req.query.secret;
    const providedSecret =
      (typeof headerSecret === "string" && headerSecret) ||
      (typeof querySecret === "string" && querySecret) ||
      "";

    if (!providedSecret || !secretsMatch(providedSecret, expectedSecret)) {
      console.warn("Rejected /api/health?test_resend=1 call with invalid or missing internal secret.");
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const adminEmails = (process.env.ADMIN_EMAILS ?? "cteamwear@gmail.com")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const testResult = await sendEmailWithResend({
      to: adminEmails,
      subject: `[Vercel Live Test] Email Dispatch Verification - ${new Date().toISOString()}`,
      html: `<h2>Custom Teamwear - Live Production Test</h2><p>This test email confirms that <strong>RESEND_API_KEY</strong> is actively configured and dispatching from Vercel Production!</p><p>Timestamp: ${new Date().toISOString()}</p>`,
    });
    return res.status(200).json({
      ok: true,
      service: "custom-teamwear-bot",
      envStatus,
      testResult,
    });
  }

  return res.status(200).json({
    ok: true,
    service: "custom-teamwear-bot",
    time: new Date().toISOString(),
    ...info,
    envStatus,
  });
}

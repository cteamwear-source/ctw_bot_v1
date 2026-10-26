/**
 * Sentry error alerting (free tier) — PRD §10.4.
 * No-ops if SENTRY_DSN is not configured (e.g. local/dev testing).
 */

import { getEnv } from "./env.js";

// @sentry/node is heavy; load it only when a DSN is configured, off the
// cold-start import path (T5).
type SentryModule = typeof import("@sentry/node");
let sentry: SentryModule | undefined;
let loading: Promise<void> | undefined;

export function initSentry(): void {
  if (loading) return;
  const env = getEnv();
  if (!env.SENTRY_DSN) return;
  loading = import("@sentry/node")
    .then((S) => {
      S.init({ dsn: env.SENTRY_DSN, tracesSampleRate: 0 });
      sentry = S;
    })
    .catch((err) => console.error("[sentry] failed to load:", err));
}

export function captureException(err: unknown): void {
  if (!loading) return;
  if (sentry) {
    sentry.captureException(err);
    return;
  }
  void loading.then(() => sentry?.captureException(err));
}

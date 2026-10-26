/**
 * Vercel serverless webhook entry point for Meta WhatsApp Cloud API (or its
 * Tech-Provider wrapper, e.g. Emovur at metagraph.backendprod.com).
 *
 * Security posture (post-2026-10-06 audit, see
 * docs/superpowers/specs/2026-10-06-emovur-integration-design.md):
 *
 *  - GET handshake: standard Meta hub.verify_token echo.
 *  - POST verification (see authenticateWebhookPost):
 *      * META_APP_SECRET set → HMAC-SHA256 of the raw body must match the
 *        X-Hub-Signature-256 header (timingSafeEqual). Mismatch → 401.
 *      * else META_WEBHOOK_URL_TOKEN set → the webhook URL registered with
 *        the Tech Provider must carry `?token=<value>`. Mismatch → 401.
 *      * neither set → 503 in production (fail closed: admin actions are
 *        authorised by sender phone, so unsigned POSTs would let anyone
 *        impersonate an admin). Local/preview only: accepted with a WARN.
 *  - Bodies over 1 MB → 413.
 *  - Logging: never the raw body or headers. We log a structured summary
 *    with message-id / sender-id (masked) / type / timestamp / phone-id only.
 *
 * NOTE: bodyParser is disabled at the route level (see `config` below). We
 * need access to the *exact* bytes Meta sent for the HMAC; allowing Vercel
 * to JSON-parse then re-stringifying would lose key ordering / whitespace
 * and break the signature.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { getEnv } from "../src/config/env.js";
import { BUILD_STAMP } from "../src/config/version.js";
import { handleMessage } from "../src/bot/index.js";

let buildStampLogged = false;
let signatureWarningLogged = false;

/** Disable Vercel's automatic JSON body parsing; we parse after HMAC check. */
export const config = { api: { bodyParser: false } };

/**
 * Mask a phone number for log output. 1311223999 -> "131***999"
 * Avoids leaking a full PII number while keeping enough digits to debug
 * session / dedupe issues.
 */
function maskPhone(phone: string): string {
  if (!phone) return "";
  if (phone.length <= 6) return phone[0] + "***" + phone[phone.length - 1];
  return phone.slice(0, 3) + "***" + phone.slice(-3);
}

/**
 * Produce a redacted, structured summary of an inbound Meta Cloud API payload.
 * We deliberately exclude: customer message text, customer name, customer
 * wa_id beyond a prefix, profile/image URLs, raw headers.
 */
function summarizePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return { shape: "non-object" };
  const p = payload as Record<string, unknown>;
  const entries = Array.isArray(p["entry"]) ? (p["entry"] as Array<Record<string, unknown>>) : [];
  return {
    object: p["object"],
    entry: entries.map((e) => {
      const changes = Array.isArray(e["changes"]) ? (e["changes"] as Array<Record<string, unknown>>) : [];
      return {
        id: e["id"],
        changes: changes.map((c) => {
          const value = (c["value"] ?? {}) as Record<string, unknown>;
          const metadata = (value["metadata"] ?? {}) as Record<string, unknown>;
          const messages = Array.isArray(value["messages"]) ? (value["messages"] as Array<Record<string, unknown>>) : [];
          return {
            field: c["field"],
            phone_number_id: metadata["phone_number_id"],
            display_phone_number: metadata["display_phone_number"],
            contacts: Array.isArray(value["contacts"]) ? value["contacts"].length : 0,
            messages: messages.map((m) => ({
              id: m["id"],
              from: maskPhone(String(m["from"] ?? "")),
              type: m["type"],
              ts: m["timestamp"],
            })),
            statuses: Array.isArray(value["statuses"]) ? value["statuses"].length : 0,
          };
        }),
      };
    }),
  };
}

/**
 * Constant-time verification of Meta's X-Hub-Signature-256.
 *
 * Meta's spec: signature = "sha256=" + lowercase-hex HMAC-SHA256(appSecret, rawBody).
 * Returns false on any deviation: missing header, wrong algorithm prefix, wrong
 * length, or wrong bytes.
 */
function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader) return false;
  const expectedPrefix = "sha256=";
  if (!signatureHeader.startsWith(expectedPrefix)) return false;
  const providedHex = signatureHeader.slice(expectedPrefix.length).trim();
  if (!/^[0-9a-f]+$/i.test(providedHex)) return false;

  const computed = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  if (computed.length !== providedHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(providedHex, "hex"));
  } catch {
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!buildStampLogged) {
    console.log(
      `[webhook] build=${BUILD_STAMP} commit=${process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown"} ref=${process.env.VERCEL_GIT_COMMIT_REF ?? "unknown"}`,
    );
    buildStampLogged = true;
  }

  // Uptime-pinger warm-up: keeps an instance warm, touches no Redis/Meta/env.
  if (req.method === "GET" && req.query?.["warm"] === "1") {
    res.status(204).end();
    return;
  }

  // Meta Webhook Verification (GET request) — standard handshake.
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const env = getEnv();

    if (mode === "subscribe" && typeof token === "string" && secretsMatch(token, env.META_WEBHOOK_SECRET)) {
      console.log("[webhook] handshake verified");
      // Echo only a plain challenge value (Meta sends digits) — never reflect
      // arbitrary markup back to a browser.
      const safeChallenge = typeof challenge === "string" ? challenge.replace(/[^A-Za-z0-9_-]/g, "") : "";
      res.status(200).setHeader("Content-Type", "text/plain; charset=utf-8").send(safeChallenge);
      return;
    }
    res.status(403).send("Forbidden");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  // POST: read exact raw bytes (HMAC needs byte-exact body), capped in size.
  const rawBody = await readRawBody(req);
  if (rawBody === TOO_LARGE) {
    console.warn("[webhook] rejected POST: body exceeds size limit");
    res.status(413).send("Payload Too Large");
    return;
  }
  if (rawBody === null) {
    res.status(400).send("Bad Request");
    return;
  }

  const env = getEnv();
  const auth = authenticateWebhookPost(req, rawBody, env);
  if (auth !== "ok") {
    if (auth === "misconfigured") {
      console.error(
        "[webhook] SECURITY: refusing POST — neither META_APP_SECRET nor META_WEBHOOK_URL_TOKEN is set in production. " +
          "Unauthenticated webhooks would let anyone forge messages from admin numbers. Set one of them and redeploy.",
      );
      res.status(503).send("Webhook authentication not configured");
      return;
    }
    console.warn(`[webhook] rejected POST: ${auth}`);
    res.status(401).send("Unauthorized");
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    console.warn("[webhook] rejected POST: invalid JSON");
    res.status(400).send("Bad Request");
    return;
  }

  // Redacted summary only — no raw headers / body / message contents.
  console.log("[webhook] received", JSON.stringify(summarizePayload(payload)));

  const { messages, recognised } = collectMessages(payload);
  if (!recognised) {
    console.warn("[webhook] unrecognised payload shape", {
      type: typeof payload,
      keys: payload && typeof payload === "object" ? Object.keys(payload as object) : null,
    });
  }

  // Fast 200: Meta gets its ACK now; processing continues inside waitUntil.
  // Statuses-only payloads (delivered/read receipts) schedule nothing.
  res.status(200).send("EVENT_RECEIVED");
  if (messages.length === 0) return;
  waitUntilImpl(processBatch(messages));
}

interface InboundMessage {
  chatId: string;
  message: any;
}

/** Collect customer messages from both supported payload shapes. */
function collectMessages(payload: unknown): { messages: InboundMessage[]; recognised: boolean } {
  const p = payload as any;
  const raw: any[] = [];
  let recognised = false;
  // 1. Standard Meta entry payload (also used by Emovur and proxies)
  if (p?.object === "whatsapp_business_account" || Array.isArray(p?.entry)) {
    recognised = true;
    for (const entry of p.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        for (const message of change?.value?.messages ?? []) raw.push(message);
      }
    }
  } else if (Array.isArray(p?.messages)) {
    // 2. Direct messages array fallback
    recognised = true;
    raw.push(...p.messages);
  }
  const messages: InboundMessage[] = [];
  for (const message of raw) {
    // Dedupe (upd:<id>) happens inside handleMessage via hotPath.begin.
    const from = String(message?.from || "");
    if (!from) continue;
    messages.push({ chatId: `wa:${from}`, message });
  }
  return { messages, recognised };
}

/** Chats in parallel; messages within one chat strictly in order. */
async function processBatch(messages: InboundMessage[]): Promise<void> {
  const byChat = new Map<string, any[]>();
  for (const { chatId, message } of messages) {
    const list = byChat.get(chatId) ?? [];
    list.push(message);
    byChat.set(chatId, list);
  }
  await Promise.allSettled(
    [...byChat].map(async ([chatId, chatMessages]) => {
      for (const message of chatMessages) {
        try {
          await handleMessageImpl(chatId, message);
        } catch (err) {
          console.error(`[webhook] error processing message for ${maskPhone(chatId.slice(3))}:`, err);
        }
      }
    }),
  );
}

let waitUntilImpl: (p: Promise<unknown>) => void = waitUntil;
let handleMessageImpl: (chatId: string, message: any) => Promise<unknown> = handleMessage;

/** Test seam: capture background work instead of Vercel's waitUntil. */
export function __setWaitUntilForTests(fn: ((p: Promise<unknown>) => void) | undefined): void {
  waitUntilImpl = fn ?? waitUntil;
}

/** Test seam: stub the per-message handler. */
export function __setHandleMessageForTests(
  fn: ((chatId: string, message: any) => Promise<unknown>) | undefined,
): void {
  handleMessageImpl = fn ?? handleMessage;
}

/** Meta webhook payloads are a few KB; anything this large is abuse. */
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const TOO_LARGE = Symbol("too-large");

/** Constant-time string comparison (length mismatch → false). */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

type WebhookAuthResult = "ok" | "misconfigured" | "invalid or missing X-Hub-Signature-256" | "invalid or missing URL token";

/**
 * Authenticates an inbound POST.
 *  1. META_APP_SECRET set → Meta's X-Hub-Signature-256 HMAC is required.
 *  2. else META_WEBHOOK_URL_TOKEN set → `?token=` must match (for Tech
 *     Providers that don't forward Meta's signature).
 *  3. else → rejected in production; accepted with a one-time warning in
 *     local/preview/test environments only.
 */
function authenticateWebhookPost(
  req: VercelRequest,
  rawBody: Buffer,
  env: { META_APP_SECRET?: string; META_WEBHOOK_URL_TOKEN?: string },
): WebhookAuthResult {
  if (env.META_APP_SECRET) {
    const sig = headerString(req.headers || {}, "x-hub-signature-256");
    return verifyMetaSignature(rawBody, sig, env.META_APP_SECRET) ? "ok" : "invalid or missing X-Hub-Signature-256";
  }
  if (env.META_WEBHOOK_URL_TOKEN) {
    const provided = req.query?.["token"];
    return typeof provided === "string" && secretsMatch(provided, env.META_WEBHOOK_URL_TOKEN)
      ? "ok"
      : "invalid or missing URL token";
  }
  if (process.env.VERCEL_ENV === "production") return "misconfigured";
  if (!signatureWarningLogged) {
    signatureWarningLogged = true;
    console.warn(
      "[webhook] Neither META_APP_SECRET nor META_WEBHOOK_URL_TOKEN is set; accepting unverified POSTs (non-production only).",
    );
  }
  return "ok";
}

/**
 * Read the raw HTTP request body as a Buffer (HMAC needs exact bytes).
 * Tries Vercel's `req.rawBody` first (newer @vercel/node versions), then
 * falls back to streaming the request — works either way regardless of
 * whether bodyParser has consumed the stream. Returns TOO_LARGE once the
 * body exceeds MAX_WEBHOOK_BODY_BYTES.
 */
async function readRawBody(req: VercelRequest): Promise<Buffer | null | typeof TOO_LARGE> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyReq = req as any;
  if (anyReq.rawBody instanceof Buffer || typeof anyReq.rawBody === "string") {
    const buf = anyReq.rawBody instanceof Buffer ? anyReq.rawBody : Buffer.from(anyReq.rawBody);
    return buf.length > MAX_WEBHOOK_BODY_BYTES ? TOO_LARGE : buf;
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > MAX_WEBHOOK_BODY_BYTES) {
        settled = true;
        resolve(TOO_LARGE);
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on("error", () => {
      if (!settled) resolve(null);
    });
  });
}

/** Read a header value in a type-safe way across Vercel's mixed casing. */
function headerString(headers: Record<string, unknown>, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}
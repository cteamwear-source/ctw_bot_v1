import { getEnv } from '../config/env.js';
import { addSendMs } from '../shared/timing.js';

/** HTTP transport used for every outbound Cloud API call (fetch-compatible). */
export type MetaTransport = (url: string, init: RequestInit) => Promise<Response>;

// Resolve globalThis.fetch at call time so tests that patch fetch keep working.
const defaultTransport: MetaTransport = (url, init) => globalThis.fetch(url, init);
let transport: MetaTransport = defaultTransport;

/**
 * Test seam: replace the HTTP transport used by all sends, or pass undefined
 * to restore the default (global fetch). Never called in production code.
 */
export function __setTransportForTests(fn: MetaTransport | undefined): void {
  transport = fn ?? defaultTransport;
}

/**
 * Call Meta WhatsApp Cloud API (or a Tech Provider wrapper, e.g. Emovur).
 *
 * The base URL is configurable via META_API_BASE_URL. Meta-direct deployments
 * use https://graph.facebook.com; an approved Tech Provider's wrapper goes here
 * verbatim. The version segment (/v20.0) is folded into META_API_BASE_URL so
 * a BSP can supply its own routing surface without code changes.
 */
const DEFAULT_SEND_TIMEOUT_MS = 8000;
const RETRY_BACKOFF_MS = 300;
let sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS;

/** Test seam: shorten the per-attempt send timeout (undefined restores 8s). */
export function __setSendTimeoutMsForTests(ms: number | undefined): void {
  sendTimeoutMs = ms ?? DEFAULT_SEND_TIMEOUT_MS;
}

/** Non-2xx response from the Cloud API. `status` lets callers tell 4xx from 5xx. */
export class MetaApiError extends Error {
  constructor(readonly status: number, body: string) {
    super(`Meta API error ${status}: ${body}`);
    this.name = "MetaApiError";
  }
}

/** The send did not complete (headers + body) within the timeout. Never retried: it may have been delivered. */
export class MetaTimeoutError extends Error {
  constructor(ms: number) {
    super(`Meta API send timed out after ${ms}ms`);
    this.name = "MetaTimeoutError";
  }
}

/** 4xx other than 429: the request itself was rejected (e.g. invalid interactive payload). */
export function isMetaValidationError(err: unknown): boolean {
  return err instanceof MetaApiError && err.status >= 400 && err.status < 500 && err.status !== 429;
}

/** One attempt: request + body read under a single timeout. */
async function attemptOnce(url: string, init: RequestInit): Promise<{ status: number; ok: boolean; text: string }> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new MetaTimeoutError(sendTimeoutMs));
    }, sendTimeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const res = await transport(url, { ...init, signal: controller.signal });
        const text = await res.text();
        return { status: res.status, ok: res.ok, text };
      })(),
      timedOut,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function metaFetch(path: string, body: Record<string, unknown>): Promise<any> {
  const env = getEnv();
  const url = `${env.META_API_BASE_URL}/v20.0/${env.META_PHONE_NUMBER_ID}${path}`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.META_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(env.EMOVUR_CONNECTOR_ID ? { 'collector-id': env.EMOVUR_CONNECTOR_ID, 'connector-id': env.EMOVUR_CONNECTOR_ID } : {})
    },
    body: JSON.stringify(body),
  };
  const startedAt = performance.now();
  let attempts = 0;
  let status: number | "timeout" | "network" = "network";

  try {
    // At most 2 attempts; only network errors and 429 get the second one.
    for (;;) {
      attempts++;
      let result: { status: number; ok: boolean; text: string };
      try {
        result = await attemptOnce(url, init);
      } catch (err) {
        if (err instanceof MetaTimeoutError) {
          status = "timeout";
          throw err;
        }
        status = "network";
        if (attempts < 2) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
          continue;
        }
        throw err;
      }
      status = result.status;
      if (result.status === 429 && attempts < 2) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      if (!result.ok) {
        console.error(`[metaClient] ${path} failed ${result.status}: ${result.text}`);
        throw new MetaApiError(result.status, result.text);
      }
      try { return JSON.parse(result.text); } catch { return result.text; }
    }
  } finally {
    const sendMs = performance.now() - startedAt;
    addSendMs(sendMs);
    console.log(`[metaClient] send path=${path} status=${status} attempts=${attempts} sendMs=${Math.round(sendMs)}`);
  }
}

/** Mask phone/chat ID for logging — show only last 4 digits or "wa:***" */
function maskTo(to: string): string {
  const bare = to.replace(/^(wa:)+/gi, "").replace(/^\+/, "").trim();
  if (bare.length <= 4) return "***";
  return `***${bare.slice(-4)}`;
}

/** Strip the "wa:" prefix if present and return bare phone number for Meta API */
function phone(to: string): string {
  return to.replace(/^(wa:)+/gi, "").replace(/^\+/, "").trim();
}

/** Send a plain text message */
export async function sendMessage(to: string, text: string) {
  console.log(`[metaClient] sendMessage to=${maskTo(to)} type=text len=${text.length}`);
  return metaFetch('/messages', {
    messaging_product: 'whatsapp',
    to: phone(to),
    type: 'text',
    text: { body: text }
  });
}

/** Send an image with optional caption */
export async function sendMedia(to: string, mediaUrl: string, caption?: string) {
  console.log(`[metaClient] sendMedia to=${maskTo(to)} type=image hasCaption=${Boolean(caption)}`);
  return metaFetch('/messages', {
    messaging_product: 'whatsapp',
    to: phone(to),
    type: 'image',
    image: {
      link: mediaUrl,
      ...(caption ? { caption } : {}),
    }
  });
}

/** Send interactive reply buttons (max 3) */
export async function sendInteractiveButtons(
  to: string,
  text: string,
  buttons: Array<{ id: string; title: string }>,
  footerText?: string,
) {
  console.log(`[metaClient] sendInteractiveButtons to=${maskTo(to)} type=button buttons=${buttons.length}`);
  // WhatsApp Cloud API enforces: max 3 buttons, max 20 chars per title, max 256 chars per id
  const validButtons = buttons.slice(0, 3).map(b => ({
    type: 'reply' as const,
    reply: {
      id: b.id.slice(0, 256),
      title: b.title.slice(0, 20)
    }
  }));

  return metaFetch('/messages', {
    messaging_product: 'whatsapp',
    to: phone(to),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      ...(footerText ? { footer: { text: footerText.slice(0, 60) } } : {}),
      action: {
        buttons: validButtons
      }
    }
  });
}

/** Send interactive list (more than 3 options) */
export async function sendInteractiveList(
  to: string,
  text: string,
  buttonText: string,
  sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }>,
  footerText?: string,
) {
  console.log(`[metaClient] sendInteractiveList to=${maskTo(to)} type=list rows=${sections.reduce((n, s) => n + s.rows.length, 0)}`);
  // WhatsApp Cloud API enforces: max 20 chars button text, max 24 chars row title, max 72 chars description, max 200 chars id
  return metaFetch('/messages', {
    messaging_product: 'whatsapp',
    to: phone(to),
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: text.slice(0, 1024) },
      ...(footerText ? { footer: { text: footerText.slice(0, 60) } } : {}),
      action: {
        button: buttonText.slice(0, 20),
        sections: sections.slice(0, 10).map(section => ({
          ...(section.title ? { title: section.title.slice(0, 24) } : {}),
          rows: section.rows.slice(0, 10).map(row => ({
            id: row.id.slice(0, 200),
            title: row.title.slice(0, 24),
            ...(row.description ? { description: row.description.slice(0, 72) } : {})
          }))
        }))
      }
    }
  });
}

/** Send a template message */
export async function sendTemplate(to: string, templateName: string, languageCode: string = 'en') {
  return metaFetch('/messages', {
    messaging_product: 'whatsapp',
    to: phone(to),
    type: 'template',
    template: {
      name: templateName,
      language: {
        code: languageCode
      }
    }
  });
}

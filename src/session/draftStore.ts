/**
 * Explicit session snapshot — PRD §9.1 `sess:<chat_id>`, 24h TTL.
 * Mirrors the conversation's collected fields so we can:
 *  (a) offer an accurate "Resume my quote?" prompt on /start, and
 *  (b) write an accurate Lead row if the customer abandons mid-flow.
 *
 * Redis is the source of truth (no in-memory cache, so drafts are never
 * stale across instances). Inside a request opened by `runWithDraft()`
 * (src/bot/index.ts), `loadDraft` returns the draft `hotPath.begin()`
 * already fetched, and `saveDraft`/`clearDraft` only record the change;
 * `hotPath.finish()` writes it in the same round-trip as the unlock.
 * `persistToRedis=true` still writes immediately. Outside a request
 * context every call goes straight to Redis (awaited).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getRedis } from "./redisClient.js";
import type { OrderDraft } from "../conversation/draft.js";

const TTL_SECONDS = 24 * 60 * 60;

export interface DraftContext {
  chatId: string;
  /** Current draft (as loaded, then as last saved). */
  draft: OrderDraft | undefined;
  /** Change for `finish()`: draft = save, null = delete, undefined = none. */
  pending: OrderDraft | null | undefined;
}

const storage = new AsyncLocalStorage<DraftContext>();

function key(chatId: string): string {
  return `sess:${chatId}`;
}

function contextFor(chatId: string): DraftContext | undefined {
  const ctx = storage.getStore();
  return ctx && ctx.chatId === chatId ? ctx : undefined;
}

/** Run `fn` with `draft` (pre-fetched by hotPath.begin) as the chat's draft. */
export async function runWithDraft<T>(
  chatId: string,
  draft: OrderDraft | undefined,
  fn: (ctx: DraftContext) => Promise<T>,
): Promise<T> {
  const ctx: DraftContext = { chatId, draft, pending: undefined };
  return storage.run(ctx, () => fn(ctx));
}

export async function loadDraft(chatId: string): Promise<OrderDraft | undefined> {
  const ctx = contextFor(chatId);
  if (ctx) return ctx.draft ? structuredClone(ctx.draft) : undefined;
  const value = await getRedis().get<OrderDraft>(key(chatId));
  return value ?? undefined;
}

export async function saveDraft(chatId: string, draft: OrderDraft, persistToRedis = false): Promise<void> {
  const updated = { ...draft, updatedAt: Date.now() };
  const ctx = contextFor(chatId);
  if (ctx) {
    ctx.draft = structuredClone(updated);
    if (!persistToRedis) {
      ctx.pending = ctx.draft;
      return;
    }
    ctx.pending = undefined;
  }
  await getRedis().set(key(chatId), updated, { ex: TTL_SECONDS });
}

export async function clearDraft(chatId: string): Promise<void> {
  const ctx = contextFor(chatId);
  if (ctx) {
    ctx.draft = undefined;
    ctx.pending = null;
    return;
  }
  await getRedis().del(key(chatId));
}

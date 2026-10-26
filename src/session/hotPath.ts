/**
 * Redis hot path for one inbound message (plan.md T2).
 *
 * `begin()` costs ONE Upstash round-trip (pipeline):
 *   SET upd:<msgId> 1 NX EX 86400     cross-instance webhook dedupe
 *   SET lock:<chatId> <token> NX EX 30 per-chat lock (token-owned)
 *   INCR rl:<chatId>:<epochMinute> + EXPIRE 120   flood control, 20/min
 *   GET sess:<chatId>                  the draft (Redis is the source of truth)
 *
 * `finish()` costs ONE round-trip: SET/DEL sess:<chatId> + token-checked
 * lock release (Lua compare-and-delete), so only the holder unlocks.
 *
 * `abort()` deletes the dedupe marker so Meta's retry is processed after a
 * failure.
 */

import crypto from "node:crypto";
import { getRedis } from "./redisClient.js";
import { addRedisMs } from "../shared/timing.js";
import type { OrderDraft } from "../conversation/draft.js";

export const RATE_LIMIT_PER_MINUTE = 20;
export const DEDUPE_TTL_SECONDS = 24 * 60 * 60;
export const LOCK_TTL_SECONDS = 30;
export const DRAFT_TTL_SECONDS = 24 * 60 * 60;
const RATE_WINDOW_TTL_SECONDS = 120;
const LOCK_RETRIES = 3;
const LOCK_RETRY_MS = 150;

const RELEASE_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export const dedupeKey = (msgId: string) => `upd:${msgId}`;
export const lockKey = (chatId: string) => `lock:${chatId}`;
export const draftKey = (chatId: string) => `sess:${chatId}`;
const rateKey = (chatId: string, epochMinute: number) => `rl:${chatId}:${epochMinute}`;

export interface BeginResult {
  /** false when this message id was already claimed (duplicate delivery). */
  isNew: boolean;
  /** true when this request holds the chat lock. */
  locked: boolean;
  /** lock token, set when `locked`. */
  token: string | undefined;
  /** false when the chat is over the flood limit. */
  allowed: boolean;
  /** the chat's draft as stored in Redis. */
  draft: OrderDraft | undefined;
}

/** Minimal pipeline surface shared by @upstash/redis and the test fake. */
interface PipelineLike {
  get(key: string): PipelineLike;
  set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }): PipelineLike;
  incr(key: string): PipelineLike;
  expire(key: string, seconds: number): PipelineLike;
  del(...keys: string[]): PipelineLike;
  eval(script: string, keys: string[], args: unknown[]): PipelineLike;
  exec<T extends unknown[] = unknown[]>(): Promise<T>;
}

function pipeline(): PipelineLike {
  return (getRedis() as unknown as { pipeline(): PipelineLike }).pipeline();
}

async function exec<T extends unknown[]>(p: PipelineLike): Promise<T> {
  const startedAt = performance.now();
  try {
    return await p.exec<T>();
  } finally {
    addRedisMs(performance.now() - startedAt);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Claim dedupe + lock + rate-limit slot and load the draft in one round-trip. */
export async function begin(chatId: string, msgId: string | undefined): Promise<BeginResult> {
  const token = crypto.randomUUID();
  const minute = Math.floor(Date.now() / 60_000);
  const p = pipeline();
  if (msgId) p.set(dedupeKey(msgId), 1, { nx: true, ex: DEDUPE_TTL_SECONDS });
  p.set(lockKey(chatId), token, { nx: true, ex: LOCK_TTL_SECONDS })
    .incr(rateKey(chatId, minute))
    .expire(rateKey(chatId, minute), RATE_WINDOW_TTL_SECONDS)
    .get(draftKey(chatId));
  const results = await exec<unknown[]>(p);
  const offset = msgId ? 1 : 0;
  const isNew = msgId ? results[0] === "OK" : true;
  let locked = results[offset] === "OK";
  const count = Number(results[offset + 1]);
  let draft = (results[offset + 3] as OrderDraft | null) ?? undefined;

  if (!isNew) {
    if (locked) await finish(chatId, token, undefined);
    return { isNew, locked: false, token: undefined, allowed: true, draft: undefined };
  }

  // Another request holds the lock: retry briefly, re-reading the draft with
  // the lock so we never act on a draft the holder was still changing.
  for (let i = 0; !locked && i < LOCK_RETRIES; i++) {
    await sleep(LOCK_RETRY_MS);
    const [set, fresh] = await exec<[unknown, unknown]>(
      pipeline().set(lockKey(chatId), token, { nx: true, ex: LOCK_TTL_SECONDS }).get(draftKey(chatId)),
    );
    locked = set === "OK";
    if (locked) draft = (fresh as OrderDraft | null) ?? undefined;
  }

  return {
    isNew,
    locked,
    token: locked ? token : undefined,
    allowed: count <= RATE_LIMIT_PER_MINUTE,
    draft,
  };
}

/**
 * Persist the draft change (draft = save, null = delete, undefined = no
 * change) and release the lock if `token` still owns it. One round-trip;
 * none at all when there is nothing to do.
 */
export async function finish(
  chatId: string,
  token: string | undefined,
  draft: OrderDraft | null | undefined,
): Promise<void> {
  if (!token && draft === undefined) return;
  const p = pipeline();
  if (draft === null) p.del(draftKey(chatId));
  else if (draft !== undefined) p.set(draftKey(chatId), draft, { ex: DRAFT_TTL_SECONDS });
  if (token) p.eval(RELEASE_LOCK_SCRIPT, [lockKey(chatId)], [token]);
  await exec(p);
}

/** Delete the dedupe marker so a redelivery of `msgId` is processed. */
export async function abort(msgId: string | undefined): Promise<void> {
  if (!msgId) return;
  await getRedis().del(dedupeKey(msgId));
}

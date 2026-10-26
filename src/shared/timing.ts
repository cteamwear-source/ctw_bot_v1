/**
 * Per-message latency tracing.
 *
 * `runWithTiming()` opens a trace for one inbound WhatsApp message (via
 * AsyncLocalStorage, so nothing has to be threaded through call sites).
 * The Redis client wrapper (`session/redisClient.ts`) and the WhatsApp send
 * client (`whatsapp/metaClient.ts`) add their elapsed time to the active
 * trace. When the message finishes, exactly one structured log line is
 * written:
 *
 *   [timing] {"msgId":"…AbC123","step":"tier","redisMs":12,"sendMs":180,"totalMs":205,"cold":false}
 *
 * The msgId is masked (last 6 chars only). No message content or phone
 * numbers are logged.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface TimingLine {
  msgId: string;
  step: string;
  redisMs: number;
  sendMs: number;
  totalMs: number;
  cold: boolean;
}

interface Trace {
  msgId: string;
  step: string;
  redisMs: number;
  sendMs: number;
  startedAt: number;
}

const storage = new AsyncLocalStorage<Trace>();
let firstMessage = true;
let logSink: (line: TimingLine) => void = (line) => {
  console.log(`[timing] ${JSON.stringify(line)}`);
};

/** Mask a WhatsApp message id for logs: keep only the last 6 characters. */
export function maskMsgId(msgId: string | undefined | null): string {
  const id = String(msgId ?? "").trim();
  if (!id) return "unknown";
  if (id.length <= 6) return "…";
  return `…${id.slice(-6)}`;
}

/**
 * Run `fn` inside a timing trace for one message and log one line when it
 * settles (also on error; the error is rethrown unchanged).
 */
export async function runWithTiming<T>(msgId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const cold = firstMessage;
  firstMessage = false;
  const trace: Trace = {
    msgId: maskMsgId(msgId),
    step: "unknown",
    redisMs: 0,
    sendMs: 0,
    startedAt: performance.now(),
  };
  try {
    return await storage.run(trace, fn);
  } finally {
    logSink({
      msgId: trace.msgId,
      step: trace.step,
      redisMs: Math.round(trace.redisMs),
      sendMs: Math.round(trace.sendMs),
      totalMs: Math.round(performance.now() - trace.startedAt),
      cold,
    });
  }
}

/** Label the active trace with the conversation step being handled. */
export function setTimingStep(step: string): void {
  const trace = storage.getStore();
  if (trace) trace.step = step;
}

/** Add Redis time (ms) to the active trace. No-op outside a trace. */
export function addRedisMs(ms: number): void {
  const trace = storage.getStore();
  if (trace) trace.redisMs += ms;
}

/** Add WhatsApp send time (ms) to the active trace. No-op outside a trace. */
export function addSendMs(ms: number): void {
  const trace = storage.getStore();
  if (trace) trace.sendMs += ms;
}

/** True when called inside `runWithTiming()`. */
export function hasActiveTiming(): boolean {
  return storage.getStore() !== undefined;
}

/** Test seam: capture timing lines instead of logging; pass undefined to restore. */
export function __setTimingSinkForTests(sink: ((line: TimingLine) => void) | undefined): void {
  logSink =
    sink ??
    ((line) => {
      console.log(`[timing] ${JSON.stringify(line)}`);
    });
}

/** Test seam: make the next traced message report cold=true again. */
export function __resetColdForTests(): void {
  firstMessage = true;
}

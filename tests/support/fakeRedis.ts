/**
 * In-memory fake of the RedisLike surface used by the app, faithful enough
 * for the mockup quota / generation-store idempotency tests:
 *  - SET with { nx } only writes when the key is absent (returns "OK" or null).
 *  - SET with { ex } records a TTL (not expired in-test unless advanced);
 *    { px } is accepted too (milliseconds, recorded as a frozen TTL).
 *  - INCR treats a missing key as 0.
 *  - Values round-trip through JSON, mirroring @upstash/redis auto-JSON.
 *  - pipeline()/multi() queue commands and run them on exec(), returning the
 *    results array in order (like @upstash/redis).
 *  - eval() supports the token-checked lock-release script
 *    (GET KEYS[1] == ARGV[1] → DEL KEYS[1], else 0).
 *
 * Latency accounting: `roundTrips` counts HTTP round-trips the real Upstash
 * REST client would make. Each direct command is one; a pipeline/multi
 * exec() is ONE regardless of how many commands it carries. `commands`
 * counts individual commands (direct + inside pipelines).
 */

import type { RedisLike } from "../../src/session/redisClient.js";

type SetOpts = { nx?: boolean; ex?: number; px?: number };

/** Chainable command queue returned by pipeline()/multi(). */
export interface FakePipeline {
  get(key: string): FakePipeline;
  set(key: string, value: unknown, opts?: SetOpts): FakePipeline;
  incr(key: string): FakePipeline;
  expire(key: string, seconds: number): FakePipeline;
  ttl(key: string): FakePipeline;
  del(...keys: string[]): FakePipeline;
  eval(script: string, keys: string[], args: unknown[]): FakePipeline;
  exec<T extends unknown[] = unknown[]>(): Promise<T>;
}

export class FakeRedis implements RedisLike {
  private store = new Map<string, string>();
  private ttlMap = new Map<string, number>();

  /** HTTP round-trips the real REST client would make (pipeline exec = 1). */
  roundTrips = 0;
  /** Individual commands executed (direct or inside a pipeline). */
  commands = 0;
  /** Round-trips made via pipeline()/multi() exec(). */
  pipelineExecs = 0;

  /** Test helper: zero the latency counters. */
  resetCounters(): void {
    this.roundTrips = 0;
    this.commands = 0;
    this.pipelineExecs = 0;
  }

  // --- direct commands (one round-trip each) -------------------------------

  async get<T = unknown>(key: string): Promise<T | null> {
    this.direct();
    return this.doGet<T>(key);
  }

  async set(key: string, value: unknown, opts?: SetOpts): Promise<string | null> {
    this.direct();
    return this.doSet(key, value, opts);
  }

  async incr(key: string): Promise<number> {
    this.direct();
    return this.doIncr(key);
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.direct();
    return this.doExpire(key, seconds);
  }

  async ttl(key: string): Promise<number> {
    this.direct();
    return this.doTtl(key);
  }

  async del(...keys: string[]): Promise<number> {
    this.direct();
    return this.doDel(keys);
  }

  async eval(script: string, keys: string[], args: unknown[]): Promise<unknown> {
    this.direct();
    return this.doEval(script, keys, args);
  }

  // --- pipelines (one round-trip per exec) ---------------------------------

  pipeline(): FakePipeline {
    const ops: Array<() => unknown> = [];
    const p: FakePipeline = {
      get: (key) => (ops.push(() => this.doGet(key)), p),
      set: (key, value, opts) => (ops.push(() => this.doSet(key, value, opts)), p),
      incr: (key) => (ops.push(() => this.doIncr(key)), p),
      expire: (key, seconds) => (ops.push(() => this.doExpire(key, seconds)), p),
      ttl: (key) => (ops.push(() => this.doTtl(key)), p),
      del: (...keys) => (ops.push(() => this.doDel(keys)), p),
      eval: (script, keys, args) => (ops.push(() => this.doEval(script, keys, args)), p),
      exec: async <T extends unknown[] = unknown[]>() => {
        this.roundTrips++;
        this.pipelineExecs++;
        this.commands += ops.length;
        // Synchronous run: no other command interleaves, like MULTI/EXEC.
        return ops.map((op) => op()) as T;
      },
    };
    return p;
  }

  /** Same as pipeline(); the fake already runs queued commands atomically. */
  multi(): FakePipeline {
    return this.pipeline();
  }

  // --- implementations (no counting) ---------------------------------------

  private direct(): void {
    this.roundTrips++;
    this.commands++;
  }

  private doGet<T>(key: string): T | null {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  private doSet(key: string, value: unknown, opts?: SetOpts): string | null {
    if (opts?.nx && this.store.has(key)) return null;
    this.store.set(key, JSON.stringify(value));
    if (opts?.ex !== undefined) this.ttlMap.set(key, opts.ex);
    // CB-07: px (milliseconds) is recorded as a frozen TTL like ex — the fake
    // has no clock, so expiry is simulated via __expire() in tests.
    if (opts?.px !== undefined) this.ttlMap.set(key, opts.px / 1000);
    return "OK";
  }

  private doIncr(key: string): number {
    const raw = this.store.get(key);
    const current = raw === undefined ? 0 : Number(JSON.parse(raw));
    const next = current + 1;
    this.store.set(key, JSON.stringify(next));
    return next;
  }

  private doExpire(key: string, seconds: number): number {
    if (!this.store.has(key)) return 0;
    this.ttlMap.set(key, seconds);
    return 1;
  }

  private doTtl(key: string): number {
    const val = this.ttlMap.get(key);
    return val !== undefined ? val : -2;
  }

  private doDel(keys: string[]): number {
    let removed = 0;
    for (const k of keys) {
      if (this.store.delete(k)) removed++;
      this.ttlMap.delete(k);
    }
    return removed;
  }

  /**
   * Only the compare-and-delete lock-release script is supported:
   *   if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end
   * Any other script throws so tests notice an unsupported fake path.
   */
  private doEval(script: string, keys: string[], args: unknown[]): number {
    const s = script.toLowerCase();
    const isCompareAndDelete =
      /redis\.call\(\s*["']get["']\s*,\s*keys\[1\]\s*\)/.test(s) &&
      /redis\.call\(\s*["']del["']\s*,\s*keys\[1\]\s*\)/.test(s) &&
      s.includes("argv[1]");
    if (!isCompareAndDelete) {
      throw new Error(`FakeRedis.eval: unsupported script: ${script}`);
    }
    const key = keys[0];
    if (key === undefined) return 0;
    const current = this.doGet<unknown>(key);
    if (current === null || String(current) !== String(args[0])) return 0;
    return this.doDel([key]);
  }

  // --- test helpers ---------------------------------------------------------

  /** Test helper: raw view of stored keys. */
  keys(): string[] {
    return [...this.store.keys()];
  }

  /**
   * Test helper (CB-07): simulate a key's PX/EX TTL elapsing. The fake has no
   * clock (TTLs are frozen), so tests call this to model expiry — e.g. an
   * abandoned quota lock self-healing after its short PX TTL.
   */
  __expire(key: string): void {
    this.store.delete(key);
    this.ttlMap.delete(key);
  }
}

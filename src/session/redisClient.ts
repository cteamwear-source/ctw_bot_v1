import { Redis } from "@upstash/redis";
import { getEnv } from "../config/env.js";
import { addRedisMs } from "../shared/timing.js";

/**
 * The minimal subset of the Upstash Redis surface the mockup quota /
 * generation-store modules use. Declaring it lets tests inject a
 * lightweight in-memory fake (tests/support/fakeRedis.ts) without a real
 * Upstash instance or network. The real @upstash/redis client is a
 * structural superset, so a fake typed as RedisLike is accepted wherever
 * these modules call getRedis().
 */
export interface RedisLike {
  get<T = unknown>(key: string): Promise<T | null>;
  set(
    key: string,
    value: unknown,
    opts?: { nx?: boolean; ex?: number },
  ): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number | boolean>;
  del(...keys: string[]): Promise<number>;
}

let realClient: Redis | undefined;
let testOverride: RedisLike | undefined;

/**
 * Wrap a client so every awaited command adds its elapsed time to the
 * active per-message timing trace (src/shared/timing.ts). Outside a trace
 * the wrapper only forwards. One wrapper per client, so identity is stable.
 */
const timedClients = new WeakMap<object, object>();
function withTiming<T extends object>(client: T): T {
  const cached = timedClients.get(client);
  if (cached) return cached as T;
  const proxy = new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const startedAt = performance.now();
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).finally(() => addRedisMs(performance.now() - startedAt));
        }
        return result;
      };
    },
  });
  timedClients.set(client, proxy);
  return proxy;
}

export function getRedis(): Redis {
  if (testOverride) return withTiming(testOverride) as unknown as Redis;
  if (!realClient) {
    const env = getEnv();
    realClient = new Redis({
      url: env.REDIS_REST_URL,
      token: env.REDIS_REST_TOKEN,
    });
  }
  return withTiming(realClient);
}

/**
 * Test seam: replace the Redis client with an in-memory fake, or pass
 * undefined to restore the real client. Never called in production code.
 */
export function __setRedisForTests(fake: RedisLike | undefined): void {
  testOverride = fake;
}

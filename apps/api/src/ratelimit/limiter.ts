// Rate limiting with counters shared through Redis, and an explicit policy for when Redis is down.
//
// WHY SHARED COUNTERS. With two API instances behind a balancer, a counter kept in each process
// lets a client send `limit` requests to EACH instance: the real limit is `limit x instances`, and
// it changes every time an instance is added or removed. The counter must live where every
// instance sees it. Redis is the shared place that is already in the stack (ADR-031).
//
// ALGORITHM: fixed window. The first request starts a window of `windowMs`; every request in it
// increments one counter; more than `limit` is refused until the window ends. One atomic Lua
// script does INCR + set-expiry + read-TTL, so two instances can never both think they were the
// first or leave a counter without an expiry. Known weakness of fixed windows: a client can use
// `limit` requests at the very end of one window and `limit` more at the start of the next, so
// the worst burst is 2 x limit in a short time. Accepted: the limits protect the system from
// floods, they are not a billing meter. (A sliding window removes it at the cost of more state.)
//
// WHEN REDIS FAILS (the policy, per rate-limit policy):
//   - `fallback`: count in this process only, against a CONSERVATIVE `fallbackLimit` (a fraction
//     of `limit`, so a handful of instances together stay near the real limit). Used for bids and
//     authentication: dropping the limit would let a flood through exactly when the system is
//     already degraded, and refusing everyone would stop bidding because of a cache.
//   - `allow`: let the request through. Used for plain reads, where blocking users because a
//     helper is down is worse than the load.
// Correctness never depends on the limiter: the bid transaction, the row lock and idempotency
// protect the data whatever this module decides.

import type { Redis } from 'ioredis';

export interface Policy {
  /** Short stable name (a metric label and part of the Redis key). */
  name: string;
  limit: number;
  windowMs: number;
  onRedisFailure: 'fallback' | 'allow';
  /** Limit used by the per-process fallback (only for `fallback`). */
  fallbackLimit: number;
}

export interface Decision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the window ends (when limited, how long to wait). */
  retryAfterMs: number;
  /** True if Redis could not be used and this decision came from the fallback. */
  degraded: boolean;
}

export interface Hit {
  count: number;
  ttlMs: number;
}

export interface CounterStore {
  hit: (key: string, windowMs: number) => Promise<Hit>;
}

// Atomic: increment, make sure the key expires, report the time left.
const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export function redisCounterStore(redis: Redis, keyPrefix = 'bidflow:rl:'): CounterStore {
  return {
    hit: async (key, windowMs) => {
      const reply = (await redis.eval(SCRIPT, 1, `${keyPrefix}${key}`, String(windowMs))) as [
        number,
        number,
      ];
      return { count: reply[0], ttlMs: reply[1] };
    },
  };
}

/**
 * Per-process counters, used as the fallback and when no Redis is configured at all (single
 * process). Memory is bounded: expired entries are pruned, and past `maxKeys` the oldest go.
 */
export function memoryCounterStore(
  now: () => number = Date.now,
  maxKeys = 10_000,
): CounterStore & { size: () => number } {
  const entries = new Map<string, { count: number; resetAt: number }>();
  return {
    size: () => entries.size,
    hit: (key, windowMs) => {
      const t = now();
      let e = entries.get(key);
      if (!e || e.resetAt <= t) {
        if (entries.size >= maxKeys) {
          for (const [k, v] of entries) if (v.resetAt <= t) entries.delete(k);
          // Still full of live windows (many distinct clients): drop the oldest inserted.
          while (entries.size >= maxKeys) {
            const first = entries.keys().next();
            if (first.done) break;
            entries.delete(first.value);
          }
        }
        e = { count: 0, resetAt: t + windowMs };
        entries.set(key, e);
      }
      e.count += 1;
      return Promise.resolve({ count: e.count, ttlMs: e.resetAt - t });
    },
  };
}

export interface RateLimiter {
  check: (policy: Policy, subject: string) => Promise<Decision>;
}

export interface LimiterOptions {
  /** The shared store. Absent: this process counts alone, with the normal limit (not degraded). */
  shared?: CounterStore;
  /** Called once per decision, for metrics. */
  onDecision?: (
    policy: string,
    decision: 'allowed' | 'limited' | 'fallback_allowed' | 'fallback_limited',
  ) => void;
  /** Called when the shared store fails (state change only is the caller's job). */
  onStoreError?: (error: unknown) => void;
  now?: () => number;
  /** A shared-store call slower than this counts as a failure (default 200 ms). */
  timeoutMs?: number;
  /** After a failure, skip the shared store for this long (default 2 s), so an outage costs no latency. */
  cooldownMs?: number;
  fallback?: CounterStore;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('rate limit store timeout'));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function createRateLimiter(options: LimiterOptions = {}): RateLimiter {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 200;
  const cooldownMs = options.cooldownMs ?? 2000;
  const fallback = options.fallback ?? memoryCounterStore(now);
  const local = options.shared ? undefined : fallback;
  let skipSharedUntil = 0;

  const decide = (hit: Hit, limit: number, degraded: boolean): Decision => ({
    allowed: hit.count <= limit,
    limit,
    remaining: Math.max(0, limit - hit.count),
    retryAfterMs: Math.max(0, hit.ttlMs),
    degraded,
  });

  return {
    check: async (policy, subject) => {
      const key = `${policy.name}:${subject}`;

      // No shared store configured: a single process, the normal limit.
      if (local) {
        const d = decide(await local.hit(key, policy.windowMs), policy.limit, false);
        options.onDecision?.(policy.name, d.allowed ? 'allowed' : 'limited');
        return d;
      }

      if (options.shared && now() >= skipSharedUntil) {
        try {
          const hit = await withTimeout(options.shared.hit(key, policy.windowMs), timeoutMs);
          const d = decide(hit, policy.limit, false);
          options.onDecision?.(policy.name, d.allowed ? 'allowed' : 'limited');
          return d;
        } catch (error) {
          skipSharedUntil = now() + cooldownMs;
          options.onStoreError?.(error);
        }
      }

      // The shared store is unavailable (or being skipped during the cooldown).
      if (policy.onRedisFailure === 'allow') {
        options.onDecision?.(policy.name, 'fallback_allowed');
        return {
          allowed: true,
          limit: policy.limit,
          remaining: policy.limit,
          retryAfterMs: 0,
          degraded: true,
        };
      }
      const hit = await fallback.hit(key, policy.windowMs);
      const d = decide(hit, policy.fallbackLimit, true);
      options.onDecision?.(policy.name, d.allowed ? 'fallback_allowed' : 'fallback_limited');
      return d;
    },
  };
}

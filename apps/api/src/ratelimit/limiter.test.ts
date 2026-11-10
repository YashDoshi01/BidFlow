import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createRateLimiter,
  memoryCounterStore,
  type CounterStore,
  type Policy,
} from './limiter.ts';
import { buildPolicies, DEFAULT_RATE_LIMITS } from './policies.ts';

const policy = (over: Partial<Policy> = {}): Policy => ({
  name: 'p',
  limit: 3,
  windowMs: 1000,
  onRedisFailure: 'fallback',
  fallbackLimit: 1,
  ...over,
});

/** A controllable clock. */
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('memory counter store', () => {
  it('counts within a window and starts a new window after it ends', async () => {
    const c = clock();
    const s = memoryCounterStore(c.now);
    assert.equal((await s.hit('k', 1000)).count, 1);
    assert.equal((await s.hit('k', 1000)).count, 2);
    c.advance(1001);
    assert.equal((await s.hit('k', 1000)).count, 1);
  });

  it('keys are independent', async () => {
    const s = memoryCounterStore();
    await s.hit('a', 1000);
    assert.equal((await s.hit('b', 1000)).count, 1);
  });

  it('is bounded: many distinct keys do not grow memory without limit', async () => {
    const s = memoryCounterStore(Date.now, 100);
    for (let i = 0; i < 1000; i += 1) await s.hit(`k${String(i)}`, 60_000);
    assert.ok(s.size() <= 100);
  });
});

describe('rate limiter (no shared store: one process, normal limit)', () => {
  it('allows `limit` requests then refuses, with a retry time', async () => {
    const c = clock();
    const l = createRateLimiter({ now: c.now, fallback: memoryCounterStore(c.now) });
    const p = policy();
    for (let i = 0; i < 3; i += 1) assert.equal((await l.check(p, 'u')).allowed, true);
    const refused = await l.check(p, 'u');
    assert.equal(refused.allowed, false);
    assert.equal(refused.remaining, 0);
    assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 1000);
    assert.equal(refused.degraded, false);
  });

  it('subjects do not share a budget; the window resets', async () => {
    const c = clock();
    const l = createRateLimiter({ now: c.now, fallback: memoryCounterStore(c.now) });
    const p = policy({ limit: 1 });
    assert.equal((await l.check(p, 'a')).allowed, true);
    assert.equal((await l.check(p, 'a')).allowed, false);
    assert.equal((await l.check(p, 'b')).allowed, true);
    c.advance(1001);
    assert.equal((await l.check(p, 'a')).allowed, true);
  });

  it('different policies with the same subject do not share a counter', async () => {
    const l = createRateLimiter();
    assert.equal((await l.check(policy({ name: 'x', limit: 1 }), 'u')).allowed, true);
    assert.equal((await l.check(policy({ name: 'y', limit: 1 }), 'u')).allowed, true);
  });
});

describe('rate limiter with a shared store', () => {
  /** A store shared by two limiters = two API instances using one Redis. */
  const sharedStore = (): CounterStore => memoryCounterStore();

  it('two limiters on one shared store enforce ONE limit, not one each', async () => {
    const shared = sharedStore();
    const a = createRateLimiter({ shared });
    const b = createRateLimiter({ shared });
    const p = policy({ limit: 4 });
    let allowed = 0;
    for (let i = 0; i < 5; i += 1) {
      if ((await a.check(p, 'user')).allowed) allowed += 1;
      if ((await b.check(p, 'user')).allowed) allowed += 1;
    }
    assert.equal(allowed, 4, 'the budget is shared between the instances');
  });

  it('control: two limiters with PRIVATE counters allow limit x instances', async () => {
    const a = createRateLimiter();
    const b = createRateLimiter();
    const p = policy({ limit: 4 });
    let allowed = 0;
    for (let i = 0; i < 5; i += 1) {
      if ((await a.check(p, 'user')).allowed) allowed += 1;
      if ((await b.check(p, 'user')).allowed) allowed += 1;
    }
    assert.equal(allowed, 8);
  });

  const failing: CounterStore = {
    hit: () => Promise.reject(new Error('redis down')),
  };

  it('store failure + `fallback` policy: per-process conservative limit, marked degraded', async () => {
    const events: string[] = [];
    const l = createRateLimiter({
      shared: failing,
      onDecision: (_p, d) => events.push(d),
      onStoreError: () => events.push('store-error'),
    });
    const p = policy({ limit: 100, fallbackLimit: 2 });
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await l.check(p, 'u'));
    assert.deepEqual(
      results.map((r) => r.allowed),
      [true, true, false, false],
    );
    assert.ok(results.every((r) => r.degraded));
    assert.ok(events.includes('store-error'));
    assert.ok(events.includes('fallback_limited'));
  });

  it('store failure + `allow` policy: the request goes through, never counted, never refused', async () => {
    const l = createRateLimiter({ shared: failing });
    const p = policy({ onRedisFailure: 'allow', limit: 1 });
    for (let i = 0; i < 10; i += 1) {
      const d = await l.check(p, 'u');
      assert.equal(d.allowed, true);
      assert.equal(d.degraded, true);
    }
  });

  it('a slow store counts as a failure (timeout), and an outage is not retried on every request (cooldown)', async () => {
    const c = clock();
    let calls = 0;
    const slow: CounterStore = {
      hit: () => {
        calls += 1;
        return new Promise(() => undefined); // never answers
      },
    };
    const l = createRateLimiter({
      shared: slow,
      now: c.now,
      timeoutMs: 20,
      cooldownMs: 1000,
      fallback: memoryCounterStore(c.now),
    });
    const p = policy({ fallbackLimit: 5 });
    const first = await l.check(p, 'u');
    assert.equal(first.degraded, true);
    assert.equal(calls, 1);
    await l.check(p, 'u');
    await l.check(p, 'u');
    assert.equal(calls, 1, 'during the cooldown the shared store is not called');
    c.advance(1001);
    await l.check(p, 'u');
    assert.equal(calls, 2, 'after the cooldown it is tried again');
  });

  it('recovers: once the store works again, decisions use it and are not degraded', async () => {
    const c = clock();
    let down = true;
    const inner = memoryCounterStore(c.now);
    const flaky: CounterStore = {
      hit: (k, w) => (down ? Promise.reject(new Error('down')) : inner.hit(k, w)),
    };
    const l = createRateLimiter({
      shared: flaky,
      now: c.now,
      cooldownMs: 100,
      fallback: memoryCounterStore(c.now),
    });
    assert.equal((await l.check(policy(), 'u')).degraded, true);
    down = false;
    c.advance(101);
    assert.equal((await l.check(policy(), 'u')).degraded, false);
  });
});

describe('policies', () => {
  it('fallback limits are a quarter of the limit (at least 1); reads are allowed through', () => {
    const p = buildPolicies(DEFAULT_RATE_LIMITS);
    assert.equal(p.bidUser.fallbackLimit, 5);
    assert.equal(p.bidAuction.fallbackLimit, 75);
    assert.equal(p.loginEmail.fallbackLimit, 3);
    assert.equal(p.readIp.onRedisFailure, 'allow');
    for (const k of ['bidUser', 'bidAuction', 'loginIp', 'loginEmail', 'registerIp'] as const) {
      assert.equal(p[k].onRedisFailure, 'fallback');
    }
    assert.equal(buildPolicies({ ...DEFAULT_RATE_LIMITS, bidUserMax: 1 }).bidUser.fallbackLimit, 1);
  });

  it('policy names are unique (they are metric labels and key prefixes)', () => {
    const p = buildPolicies(DEFAULT_RATE_LIMITS);
    const names = [p.bidUser, p.bidAuction, p.loginIp, p.loginEmail, p.registerIp, p.readIp].map(
      (x) => x.name,
    );
    assert.equal(new Set(names).size, names.length);
  });
});

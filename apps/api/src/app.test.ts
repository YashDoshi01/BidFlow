import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createApp } from './app.ts';
import { createPool } from './db/pool.ts';
import type { DependencyCheck } from './health/dependencies.ts';
import { createLogger } from './logging/logger.ts';

const up: DependencyCheck = { name: 'up', run: () => Promise.resolve() };
const down: DependencyCheck = {
  name: 'down',
  run: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:1 password=hunter2')),
};
const hangs: DependencyCheck = { name: 'hangs', run: () => new Promise<void>(() => undefined) };

async function withServer<T>(
  checks: DependencyCheck[],
  fn: (base: string) => Promise<T>,
  instanceId?: string,
): Promise<T> {
  // The pool never connects unless a query runs; health tests run none.
  const db = createPool('postgres://unused:unused@127.0.0.1:1/unused');
  const server = createApp({
    db,
    checks,
    logger: createLogger('error', () => undefined),
    sessionTtlSeconds: 3600,
    ...(instanceId === undefined ? {} : { instanceId }),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.end();
  }
}

describe('health endpoints', () => {
  it('liveness answers 200 even when every dependency is down', async () => {
    await withServer([down], async (base) => {
      const res = await fetch(`${base}/health/live`);
      assert.equal(res.status, 200);
    });
  });

  it('readiness is 200 when all dependencies are reachable', async () => {
    await withServer([up], async (base) => {
      const res = await fetch(`${base}/health/ready`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        status: 'ready',
        checks: [{ name: 'up', ok: true, critical: true }],
      });
    });
  });

  it('readiness is 503 when a dependency fails, and does not leak the error text', async () => {
    await withServer([up, down], async (base) => {
      const res = await fetch(`${base}/health/ready`);
      assert.equal(res.status, 503);
      const text = await res.text();
      assert.ok(!text.includes('hunter2'));
      const body = JSON.parse(text) as { status: string };
      assert.equal(body.status, 'unavailable');
    });
  });

  // Redis is optional (ADR-033): bids commit to PostgreSQL without it, so an instance with
  // Redis down must stay in the load balancer. Otherwise a Redis outage would stop all bidding.
  it('readiness stays 200 ("degraded") when only an OPTIONAL dependency is down', async () => {
    const optionalDown: DependencyCheck = { ...down, name: 'redis-like', critical: false };
    await withServer([up, optionalDown], async (base) => {
      const res = await fetch(`${base}/health/ready`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        status: string;
        checks: { name: string; critical: boolean; ok: boolean }[];
      };
      assert.equal(body.status, 'degraded');
      assert.deepEqual(
        body.checks.map((c) => [c.name, c.critical, c.ok]),
        [
          ['up', true, true],
          ['redis-like', false, false],
        ],
      );
    });
  });

  it('a critical failure is still 503 even if the optional dependency is fine', async () => {
    const optionalUp: DependencyCheck = { ...up, name: 'redis-like', critical: false };
    await withServer([down, optionalUp], async (base) => {
      assert.equal((await fetch(`${base}/health/ready`)).status, 503);
    });
  });

  it('names the instance in X-Instance-Id and in the readiness body when configured', async () => {
    await withServer(
      [up],
      async (base) => {
        const live = await fetch(`${base}/health/live`);
        assert.equal(live.headers.get('x-instance-id'), 'api-7');
        const ready = (await (await fetch(`${base}/health/ready`)).json()) as { instance: string };
        assert.equal(ready.instance, 'api-7');
      },
      'api-7',
    );
    await withServer([up], async (base) => {
      assert.equal((await fetch(`${base}/health/live`)).headers.get('x-instance-id'), null);
    });
  });

  it('readiness is 503 (not a hang) when a dependency never answers', async () => {
    await withServer([hangs], async (base) => {
      const res = await fetch(`${base}/health/ready`);
      assert.equal(res.status, 503);
    });
  });

  it('does not advertise the framework', async () => {
    await withServer([], async (base) => {
      const res = await fetch(`${base}/health/live`);
      assert.equal(res.headers.get('x-powered-by'), null);
    });
  });
});

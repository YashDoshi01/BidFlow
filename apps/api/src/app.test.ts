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
): Promise<T> {
  // The pool never connects unless a query runs; health tests run none.
  const db = createPool('postgres://unused:unused@127.0.0.1:1/unused');
  const server = createApp({
    db,
    checks,
    logger: createLogger('error', () => undefined),
    sessionTtlSeconds: 3600,
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
      assert.deepEqual(await res.json(), { status: 'ready', checks: [{ name: 'up', ok: true }] });
    });
  });

  it('readiness is 503 when a dependency fails, and does not leak the error text', async () => {
    await withServer([up, down], async (base) => {
      const res = await fetch(`${base}/health/ready`);
      assert.equal(res.status, 503);
      const text = await res.text();
      assert.ok(!text.includes('hunter2'));
      const body = JSON.parse(text) as { status: string };
      assert.equal(body.status, 'degraded');
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

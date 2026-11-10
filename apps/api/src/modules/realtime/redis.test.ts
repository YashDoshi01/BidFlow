import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '../../logging/logger.ts';
import { createRedisPair } from './redis.ts';

// Nothing listens on port 1: every connection attempt fails, as when Redis is down.
const DEAD = 'redis://127.0.0.1:1';
const quiet = createLogger('error', () => undefined);

describe('Redis connections when Redis is unreachable', () => {
  it('the subscriber never gives up its queued SUBSCRIBE (a rejection would be unhandled inside the adapter and kill the process)', async () => {
    const pair = createRedisPair(DEAD, quiet);
    try {
      // ioredis's default (20) rejects a queued command after about a minute of failed retries.
      // Waiting a minute here would make the suite slow, so the setting itself is asserted; the
      // crash it prevents was observed once (docs/BUGS_FOUND.md, ADR-068).
      assert.equal(pair.sub.options.maxRetriesPerRequest, null);
    } finally {
      await pair.close();
    }
  });

  it('the publisher and the limiter fail FAST instead of queueing (no offline queue)', async () => {
    const pair = createRedisPair(DEAD, quiet);
    try {
      assert.equal(pair.pub.options.enableOfflineQueue, false);
      assert.equal(pair.limiter.options.enableOfflineQueue, false);
      const started = Date.now();
      await assert.rejects(pair.limiter.get('x'));
      assert.ok(Date.now() - started < 1500, 'a limiter call on a dead connection must not wait');
      assert.equal(pair.isUp(), false);
    } finally {
      await pair.close();
    }
  });

  it('close() returns promptly on dead connections (QUIT on a dead connection would wait for ever)', async () => {
    const pair = createRedisPair(DEAD, quiet);
    const started = Date.now();
    await pair.close();
    assert.ok(Date.now() - started < 3000, 'close() hung');
  });

  it('a publish while Redis is down is a counted drop, never an exception', async () => {
    const pair = createRedisPair(DEAD, quiet);
    try {
      const reply = await pair.pub.publish('channel', 'message');
      assert.equal(reply, 0);
      assert.ok(pair.droppedPublishes() >= 1);
    } finally {
      await pair.close();
    }
  });
});

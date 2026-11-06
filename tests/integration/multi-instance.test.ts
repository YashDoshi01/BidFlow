// Two API instances in one test process, sharing the real PostgreSQL and a real Redis, plus TWO outbox
// workers in the production shape: no Socket.IO server, a Redis connection, the Socket.IO Redis EMITTER.
// The API instances run no publisher of their own. So every event below travels
//   bid transaction -> outbox row -> worker -> Redis -> each instance's adapter -> its sockets.
// Real processes behind NGINX are tested separately in tests/cluster.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, afterEach, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { bidAcceptedEventSchema } from '../../apps/api/src/events/events.ts';
import {
  liveAuction,
  makeClient,
  newUser,
  placeBid,
  resetData,
  sleep,
  startApp,
  startEmitterWorker,
  type Api,
  type EmitterWorker,
  type TestApp,
} from './helpers.ts';
import { TestSocket } from './realtime-helpers.ts';

const run = promisify(execFile);

function redisUrl(): string {
  const url = process.env['TEST_REDIS_URL'];
  if (!url) throw new Error('TEST_REDIS_URL is not set. Run: npm run test:integration');
  return url;
}

/** Stops or starts ONLY the test stack's Redis container. */
async function redisContainer(action: 'stop' | 'start'): Promise<void> {
  const project = process.env['TEST_COMPOSE_PROJECT'];
  const file = process.env['TEST_COMPOSE_FILE'];
  if (!project || !file) throw new Error('TEST_COMPOSE_PROJECT / TEST_COMPOSE_FILE are not set');
  await run('docker', ['compose', '-p', project, '-f', file, action, 'redis'], {
    env: process.env,
  });
}

async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  ms = 30_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

interface User {
  token: string;
  id: string;
}

describe('two API instances + two outbox workers, real PostgreSQL, real Redis', () => {
  let a: TestApp;
  let b: TestApp;
  let apiA: Api;
  let apiB: Api;
  let seller: User;
  let buyers: User[];
  let w1: EmitterWorker;
  let w2: EmitterWorker;
  const workerLogs: Record<string, unknown>[] = [];
  const sockets: TestSocket[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  // Both instances have subscribed to Redis once each of them counts two servers.
  const clusterFormed = async (): Promise<void> => {
    await until('both instances see each other through Redis', async () => {
      const [x, y] = await Promise.all([
        a.io.of('/').adapter.serverCount(),
        b.io.of('/').adapter.serverCount(),
      ]);
      return x === 2 && y === 2;
    });
  };

  before(async () => {
    process.on('unhandledRejection', onUnhandled);
    a = await startApp({ redisUrl: redisUrl(), instanceId: 'inst-a', outbox: false });
    b = await startApp({ redisUrl: redisUrl(), instanceId: 'inst-b', outbox: false });
    apiA = makeClient(a.base);
    apiB = makeClient(b.base);
    await resetData(a.db);
    seller = await newUser(apiA, 'seller');
    buyers = [];
    for (let i = 0; i < 4; i += 1) {
      buyers.push(await newUser(i % 2 === 0 ? apiA : apiB, `buyer${String(i)}`));
    }
    await clusterFormed();
    w1 = startEmitterWorker({ redisUrl: redisUrl(), workerId: 'worker-1', logs: workerLogs });
    w2 = startEmitterWorker({ redisUrl: redisUrl(), workerId: 'worker-2', logs: workerLogs });
    w1.publisher.start();
    w2.publisher.start();
  });
  afterEach(() => {
    sockets.splice(0).forEach((s) => {
      s.close();
    });
  });
  after(async () => {
    process.off('unhandledRejection', onUnhandled);
    await w1.close();
    await w2.close();
    await a.close();
    await b.close();
  });

  const buyer = (i = 0): User => buyers[i] as User;
  const connectTo = async (app: TestApp): Promise<TestSocket> => {
    const s = await TestSocket.connect(app.base);
    sockets.push(s);
    return s;
  };

  it('a client on each instance receives the same event, whichever instance took the bid (worker -> Redis -> adapters)', async () => {
    const id = await liveAuction(apiA, seller.token);
    const onA = await connectTo(a);
    const onB = await connectTo(b);
    await onA.join(id);
    await onB.join(id);

    assert.equal((await placeBid(apiB, buyer(0).token, id, '10.00')).status, 201);
    const eventA = bidAcceptedEventSchema.parse(await onA.next('bid.accepted'));
    const eventB = bidAcceptedEventSchema.parse(await onB.next('bid.accepted'));
    assert.equal(eventA.eventId, eventB.eventId);
    assert.equal(eventA.data.amount, '10.00');
    assert.equal(eventA.schemaVersion, 2);

    assert.equal((await placeBid(apiA, buyer(1).token, id, '12.00')).status, 201);
    assert.equal(bidAcceptedEventSchema.parse(await onA.next('bid.accepted')).sequence, 2);
    assert.equal(bidAcceptedEventSchema.parse(await onB.next('bid.accepted')).sequence, 2);

    // Exactly once per socket: neither the worker nor the adapters deliver it twice.
    assert.equal((await onA.quiet(400, 'bid.accepted')).length, 0);
    assert.equal((await onB.quiet(10, 'bid.accepted')).length, 0);

    // Both workers are running, and each row records that exactly one claim published it.
    const { rows } = await a.db.query<{ status: string; attempt_count: number }>(
      'SELECT status, attempt_count FROM outbox_events WHERE auction_id = $1 ORDER BY auction_event_sequence',
      [id],
    );
    assert.deepEqual(rows, [
      { status: 'published', attempt_count: 1 },
      { status: 'published', attempt_count: 1 },
    ]);
  });

  it('a socket on another instance and in another auction hears nothing', async () => {
    const watched = await liveAuction(apiA, seller.token);
    const other = await liveAuction(apiA, seller.token);
    const elsewhere = await connectTo(b);
    await elsewhere.join(other);
    const watcher = await connectTo(b);
    await watcher.join(watched);
    await placeBid(apiA, buyer(0).token, watched, '10.00');
    await watcher.next('bid.accepted');
    assert.equal((await elsewhere.quiet(400, 'bid.accepted')).length, 0);
  });

  it('participant.count is cluster-wide and follows joins, leaves and disconnects across instances', async () => {
    const id = await liveAuction(apiA, seller.token);
    const onA = await connectTo(a);
    const onB = await connectTo(b);
    await onA.join(id);
    await onB.join(id);
    assert.equal((await onA.next('participant.count', (p) => p.data.count === 2)).data.count, 2);
    assert.equal((await onB.next('participant.count', (p) => p.data.count === 2)).data.count, 2);

    const second = await connectTo(a);
    await second.join(id);
    assert.equal((await onB.next('participant.count', (p) => p.data.count === 3)).data.count, 3);

    await onB.disconnectAndWait();
    assert.equal((await onA.next('participant.count', (p) => p.data.count === 2)).data.count, 2);
    await second.leave(id);
    assert.equal((await onA.next('participant.count', (p) => p.data.count === 1)).data.count, 1);
  });

  it('bids sent to both instances at once, two workers: one global order, and every event arrives once, in order, everywhere', async () => {
    const id = await liveAuction(apiA, seller.token);
    const onA = await connectTo(a);
    const onB = await connectTo(b);
    await onA.join(id);
    await onB.join(id);

    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        placeBid(i % 2 === 0 ? apiA : apiB, buyer(i % 4).token, id, `${String(11 + i)}.00`),
      ),
    );
    const accepted = results.filter((r) => r.status === 201);
    assert.ok(accepted.length >= 2);
    assert.ok(results.every((r) => r.status === 201 || r.status === 409));

    // PostgreSQL (not either instance) decided: contiguous sequence, increasing prices.
    const { rows } = await a.db.query<{ amount: string; bid_sequence: string }>(
      'SELECT amount, bid_sequence FROM bids WHERE auction_id = $1 ORDER BY bid_sequence',
      [id],
    );
    assert.equal(rows.length, accepted.length);
    rows.forEach((r, i) => {
      assert.equal(r.bid_sequence, String(i + 1));
      if (i > 0) {
        assert.ok(Number(r.amount) >= Number((rows[i - 1] as { amount: string }).amount) + 1);
      }
    });

    // Two workers competed for the events; the per-auction order still holds at every client.
    const expected = Array.from({ length: accepted.length }, (_, i) => i + 1);
    for (const socket of [onA, onB]) {
      const arrived: number[] = [];
      for (let i = 0; i < accepted.length; i += 1) {
        arrived.push(bidAcceptedEventSchema.parse(await socket.next('bid.accepted')).sequence);
      }
      assert.deepEqual(arrived, expected);
      assert.equal((await socket.quiet(300, 'bid.accepted')).length, 0);
    }
  });

  it('every log line carries the instance id, and connections are logged for tracing', async () => {
    const id = await liveAuction(apiA, seller.token);
    const s = await connectTo(b);
    await s.join(id);
    assert.ok(a.logs.length > 0 && b.logs.length > 0);
    assert.ok(a.logs.every((l) => l['instance'] === 'inst-a'));
    assert.ok(b.logs.every((l) => l['instance'] === 'inst-b'));
    const connected = b.logs.find(
      (l) => l['msg'] === 'socket connected' && l['socketId'] === s.socket.id,
    );
    assert.ok(connected, 'the socket is traceable to the instance that holds it');
    assert.ok(!a.logs.some((l) => l['socketId'] === s.socket.id));
  });

  describe('Redis outage: the outbox turns "lost" into "late"', () => {
    after(async () => {
      await redisContainer('start').catch(() => undefined);
    });

    it('bids commit, their events wait in the outbox (retrying with backoff), nothing is lost: after Redis returns EVERY event is delivered, to both instances, in order', async () => {
      const id = await liveAuction(apiA, seller.token);
      const onA = await connectTo(a);
      const onB = await connectTo(b);
      await onA.join(id);
      await onB.join(id);
      await placeBid(apiA, buyer(0).token, id, '10.00');
      await onA.next('bid.accepted');
      await onB.next('bid.accepted');
      const rejectionsBefore = unhandled.length;

      await redisContainer('stop');
      await until(
        'both instances notice Redis is gone',
        () => a.redis?.isUp() === false && b.redis?.isUp() === false,
      );

      // Accepting a bid never touches Redis.
      assert.equal((await placeBid(apiA, buyer(1).token, id, '12.00')).status, 201);
      assert.equal((await placeBid(apiB, buyer(2).token, id, '14.00')).status, 201);

      // Nobody hears them. (Phase 4: same-instance sockets did. Now delivery is the worker's job,
      // and the worker cannot reach Redis.)
      assert.equal((await onA.quiet(1200, 'bid.accepted')).length, 0);
      assert.equal((await onB.quiet(10, 'bid.accepted')).length, 0);

      // But the events are DURABLE and being retried: pending, attempted, with the reason and a
      // retry time in the future. The worker, not the API, owns this retry.
      const waiting = await a.db.query<{
        auction_event_sequence: string;
        status: string;
        attempt_count: number;
        last_error: string | null;
      }>(
        `SELECT auction_event_sequence, status, attempt_count, last_error
           FROM outbox_events WHERE auction_id = $1 AND auction_event_sequence > 1
          ORDER BY auction_event_sequence`,
        [id],
      );
      assert.equal(waiting.rows.length, 2);
      const head = waiting.rows[0];
      assert.ok(head);
      assert.equal(head.status, 'pending');
      assert.ok(head.attempt_count >= 1, 'the worker tried');
      assert.ok(head.last_error, 'the reason is recorded');
      assert.ok(!head.last_error.includes('redis://'), 'no connection string in last_error');
      // The second event keeps waiting behind the first: per-auction order is held while it fails.
      assert.equal(waiting.rows[1]?.attempt_count, 0);

      await redisContainer('start');
      await until(
        'both instances reconnect to Redis',
        () => a.redis?.isUp() === true && b.redis?.isUp() === true,
      );
      await clusterFormed();

      // Delivered late, in order, to BOTH instances, exactly once each.
      for (const socket of [onA, onB]) {
        const arrived: number[] = [];
        for (let i = 0; i < 2; i += 1) {
          const event = await socket.next('bid.accepted', undefined, 30_000);
          arrived.push(bidAcceptedEventSchema.parse(event).sequence);
        }
        assert.deepEqual(arrived, [2, 3]);
        assert.equal((await socket.quiet(500, 'bid.accepted')).length, 0);
      }
      await until('the outbox is empty again', async () => {
        const left = await a.db.query("SELECT 1 FROM outbox_events WHERE status <> 'published'");
        return left.rows.length === 0;
      });
      assert.equal(
        unhandled.length,
        rejectionsBefore,
        'a Redis outage must not cause an unhandled rejection',
      );
      assert.ok(
        workerLogs.some(
          (l) => l['msg'] === 'redis connection lost (events stay in the outbox until it returns)',
        ),
        'the outage is visible in the worker log',
      );
    });
  });
});
